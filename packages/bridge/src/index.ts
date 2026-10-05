/**
 * hermes-computer Bridge Worker
 *
 * Maps Hermes tool calls to Cloudflare Computer workspace backends.
 * Each tool endpoint routes to the appropriate execution backend:
 *   - Container: terminal, browser, heavy compute, npm/pip installs
 *   - Isolate JS: execute_code (fast, sandboxed, no network)
 *   - DOFS directly: read_file, write_file, patch, search_files
 *
 * Architecture:
 *   Hermes (Lennox) → POST /tools/:name → Bridge Worker
 *     → Tool Optimizer DO (/select for backend routing)
 *     → Computer Workspace (Container | Isolate JS | Shell)
 *     → Response back to Hermes
 */

import {
  type DurableObjectStorageLike,
  Workspace,
  WorkspaceProxy,
  WorkspaceServiceProxy,
  WorkspaceStub,
  type WorkspaceClient,
  type WorkspaceHandle,
  getWorkspace,
} from "@cloudflare/computer";
import {
  CloudflareContainerBackend,
  withWorkspaceContainer,
} from "@cloudflare/computer/backends/container";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { Think } from "@cloudflare/think";
import { createWorkersAI } from "workers-ai-provider";
import { dirsToCreate, normalizeExecResult, pickBackend, type Backend } from "./core";
import { createAITools } from "@cloudflare/computer/tools";
import { DurableObject } from "cloudflare:workers";
import type { LanguageModel } from "ai";

export { WorkspaceProxy, WorkspaceServiceProxy };

// ── Types ───────────────────────────────────────────────────────

/**
 * The loader contract @cloudflare/computer backends expect. Their bundled
 * WorkerStub is structurally narrower than the one in @cloudflare/workers-types
 * (it lacks a numeric index signature), so this is declared locally rather than
 * pulled from either package. Runtime shape is unaffected -- only the compile-time
 * view is.
 */
interface LoaderStub {
  getEntrypoint(name?: string): unknown;
  [x: number]: (() => void) | undefined;
}

interface HermesWorkerLoaderLike {
  get(
    name: string | null,
    getCode: () => unknown | Promise<unknown>,
  ): LoaderStub;
  load(code: unknown): LoaderStub;
}

interface Env {
  AI: Ai;
  // Backs the worker_loaders "LOADER" binding in wrangler.jsonc. The SDK backends
  // (WorkerShellBackend / WorkerJavaScriptBackend) call .get()/.load() on it, so
  // this is a WorkerLoader -- NOT a Fetcher.
  LOADER: HermesWorkerLoaderLike;
  OPTIMIZER: DurableObjectNamespace;
  HermesWorkspace: DurableObjectNamespace;
  Assistant: DurableObjectNamespace;
  AgentDO: DurableObjectNamespace;
  /** Bearer token for the Tool Optimizer service. Set via `wrangler secret put
   *  OPTIMIZER_TOKEN` -- never committed. */
  OPTIMIZER_TOKEN: string;
}

interface ToolRequest {
  userRequest?: string;
  args?: Record<string, unknown>;
}

// ── Tool Optimizer DO Integration ───────────────────────────────
//
// Tools: POST /select → best backend for request
//        POST /trace  → report outcome + latency
//        Fail-open: if DO unreachable, fall back to "shell"

const OPTIMIZER_URL = "https://tools.arapaholabs.com";

interface OptimizerSelectResponse {
  selected: { tool: string; score: number; confidence: string; traceCount?: number };
  rankings: Array<{ tool: string; score: number }>;
  explore: boolean;
}

/**
 * Query the Tool Optimizer DO for the best backend (shell vs container).
 * Scans the full rankings for shell/container scores, compares them.
 * Fail-open: returns "shell" on any error.
 */
async function selectBackend(
  env: Env,
  userRequest: string,
  tool: string,
): Promise<"shell" | "container"> {
  try {
    const res = await fetch(`${OPTIMIZER_URL}/select`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPTIMIZER_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userRequest: `[${tool}] ${userRequest}` }),
    });
    if (!res.ok) return "shell";

    const data = (await res.json()) as OptimizerSelectResponse;

    // Find shell and container in rankings
    let shellScore = 0.5;
    let containerScore = 0.5;
    for (const r of data.rankings) {
      if (r.tool === "shell") shellScore = r.score;
      if (r.tool === "container") containerScore = r.score;
    }

    return containerScore > shellScore ? "container" : "shell";
  } catch {
    return "shell"; // fail-open
  }
}

/**
 * Report tool execution outcome to the Optimizer DO for learning.
 * Fire-and-forget: failures are silently ignored.
 */
async function traceOutcome(
  env: Env,
  userRequest: string,
  tool: string,
  backend: string,
  outcome: "success" | "failure" | "partial",
  latency: number,
): Promise<void> {
  try {
    await fetch(`${OPTIMIZER_URL}/trace`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPTIMIZER_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userRequest: `[${tool}] ${userRequest}`,
        tool: backend,
        outcome,
        latency,
      }),
    });
  } catch {
    // silent — tracing is best-effort
  }
}

// ── Agent DO (Think + Computer Workspace) ───────────────────────

class AgentBase extends Think<Env> {
  // Think reads step limits through getMaxSteps(); assigning `maxSteps = 20`
  // created a dead property the base class never reads (the default stayed 10).
  override getMaxSteps(): number {
    return 20;
  }
}

export class AgentDO extends withWorkspaceContainer(AgentBase) {
  readonly #containerBackend = new CloudflareContainerBackend({
    id: "container",
    container: () => this,
    workspace: { binding: "AgentDO", id: this.ctx.id.toString() },
  });

  workspace = new Workspace({
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    backends: [
      new WorkerShellBackend({
        id: "shell",
        loader: this.env.LOADER,
        workspace: { binding: "AgentDO", id: this.ctx.id.toString() },
        ctx: this.ctx,
      }),
      new WorkerJavaScriptBackend({
        id: "js",
        loader: this.env.LOADER,
      }),
      this.#containerBackend,
    ],
    useThink: true,
    // Required: WorkerJavaScriptBackend declares protocol="module", and the
    // Workspace constructor refuses to build without a waitUntil to keep
    // in-flight module calls alive past the response. Without this every
    // /tools call 503s with "Workspace module backend requires waitUntil".
    waitUntil: this.ctx.waitUntil.bind(this.ctx),
  }) as Workspace & any;

  // Not an `override`: `fetch` is not declared on Think_base's constructor type,
  // so the modifier does not apply even though the base does handle fetch at
  // runtime (super.fetch routes non-/ws requests to onChatMessage).
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") return this.#containerBackend.handleFetch(request);
    return super.fetch(request);
  }

  // Must return the SDK's RPC-safe WorkspaceStub, not the raw Workspace.
  // A raw Workspace is not structured-cloneable, so Workers RPC rejects
  // it with 'Could not serialize object of type "Workspace"'.
  async __getWorkspaceStub(): Promise<WorkspaceStub> {
    return new WorkspaceStub(this.workspace);
  }

  // Think calls getModel()/getTools(), NOT this.model / this.tools. Assigning
  // those properties type-checked as "override" against the wrong base but were
  // never read, so getModel() hit its default implementation and threw
  // "Override getModel() to return a LanguageModel" on any real chat turn.
  //
  // workers-ai-provider@3.3.1 targets ai@^6, matching this project's ai@6, so
  // its WorkersAIChatLanguageModel is assignable to Think's LanguageModel with
  // no cast. It was previously 0.1.3 (ai@^4 / LanguageModelV1), which needed
  // `as unknown as LanguageModel` and was a genuine runtime mismatch.
  override getModel(): LanguageModel {
    return createWorkersAI({ binding: this.env.AI })("@cf/zai-org/glm-4.7-flash");
  }

  // SDK 0.1.x takes a SINGLE options object, not (workspace, options).
  // The old two-arg call left options.workspace undefined and threw
  // "Cannot read properties of undefined (reading 'assets')" in the DO
  // constructor, so every /tools request 503'd.
  override getTools() {
    return createAITools({
      workspace: this.workspace as any,
      shell: {
        // A Record keyed by backend id, NOT an array: the SDK derives
        // defaultBackend from Object.keys(backends), so an array yields
        // ids "0"/"1"/"2" and the default lookup throws.
        backends: {
          js: {
            description:
              "Sandboxed JavaScript execution. No network access. Returns structured results, not just stdout. Fast cold start.",
          },
          shell: { description: "Fast just-bash shell for text tooling" },
          container: {
            description:
              "Full Linux userland (npm, pip, git, python, node, Playwright). Slower cold start.",
          },
        },
        defaultBackend: "shell",
      },
      read: {},
      write: {},
      edit: {},
    }) as any;
  }
}

// ── Direct Tool Execution Endpoints ─────────────────────────────

/**
 * Resolve the Workspace for a session.
 *
 * getWorkspace() takes a WorkspaceHandle (an object carrying the SDK's
 * WORKSPACE brand or a WorkspaceStubHost). A DurableObjectStub for AgentDO
 * satisfies that at runtime — it exposes __getWorkspaceStub, which returns the
 * RPC-safe WorkspaceStub — but the brand is not visible to the type checker,
 * so the cast is confined to this one helper instead of being repeated (and
 * subtly varied) at every call site.
 */
async function resolveWorkspace(
  env: Env,
  sessionId: string,
): Promise<WorkspaceClient> {
  const agentId = env.AgentDO.idFromName(sessionId);
  const agent = env.AgentDO.get(agentId);
  return getWorkspace(agent as unknown as WorkspaceHandle);
}

/**
 * Execute a shell command in the workspace.
 * Uses the shell backend by default, container for heavy ops.
 */
async function handleTerminal(
  workspace: WorkspaceClient,
  args: Record<string, unknown>,
  // Typed as Backend (includes "js"), not "shell" | "container": the route
  // always accepted "js" but the old signature hid that behind a
  // `requested as "shell" | "container"` cast, which is why the js path was
  // never type-checked.
  backend: Backend = "shell",
): Promise<Response> {
  const command = String(args.command || "");
  if (!command) return Response.json({ error: "Missing command" }, { status: 400 });

  // The "js" backend is a Worker isolate running an ES MODULE, not a shell.
  // runtime.exec() still takes the code as `source`, but the module's result
  // arrives in result.value — stdout is legitimately empty, so reading only
  // stdout made every js call look like it did nothing.
  try {
    // exec() resolves to a HANDLE, not the output. The actual
    // {stdout, stderr, exitCode} only exists on handle.result(). Reading
    // .stdout off the handle yields an empty object. encoding:"utf8" is
    // required or stdout/stderr come back as Uint8Array and serialize as
    // {"0":72,"1":69,...} instead of text.
    const handle = await (workspace.runtime as any).exec(command, {
      backend,
      encoding: "utf8",
    });
    const result = await handle.result();
    // Normalization (stdout-vs-value fallback, Uint8Array coercion, handle
    // backend fallback) lives in core.ts so it is unit-testable; the three
    // bugs it guards against are documented there.
    return Response.json(normalizeExecResult(result, backend, (handle as any)?.backend));
  } catch (err: any) {
    return Response.json({ error: err.message, output: "" }, { status: 500 });
  }
}

/**
 * Read a file from the workspace filesystem.
 */
async function handleReadFile(
  workspace: WorkspaceClient,
  args: Record<string, unknown>
): Promise<Response> {
  const path = String(args.path || "");
  if (!path) return Response.json({ error: "Missing path" }, { status: 400 });

  try {
    const content = await workspace.fs.readFile(path, "utf8");
    return Response.json({ content });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 404 });
  }
}

/**
 * Write content to a file in the workspace.
 */
async function handleWriteFile(
  workspace: WorkspaceClient,
  args: Record<string, unknown>
): Promise<Response> {
  const path = String(args.path || "");
  const content = String(args.content || "");
  if (!path) return Response.json({ error: "Missing path" }, { status: 400 });

  try {
    // The workspace VFS is rooted at "/" and does NOT pre-create /workspace.
    // writeFile refuses to create intermediate directories, so any nested path
    // failed with ENOENT "parent directory missing". Create the parents first
    // (recursive mkdir is idempotent, so EEXIST needs no handling).
    for (const dir of dirsToCreate(path)) {
      await workspace.fs.mkdir(dir, { recursive: true });
    }
    await workspace.fs.writeFile(path, content);
    return Response.json({ ok: true, bytes: content.length, path });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

/**
 * Execute JavaScript in the Isolate JS sandbox.
 * Safe, sandboxed, no network access. Returns structured output.
 */
async function handleExecuteCode(
  workspace: WorkspaceClient,
  args: Record<string, unknown>,
): Promise<Response> {
  const code = String(args.code || "");
  if (!code) return Response.json({ error: "Missing code" }, { status: 400 });

  try {
    const handle = await workspace.runtime.exec(code, {
      backend: "js",
      encoding: "utf8",
    });
    const result = await handle.result();
    return Response.json({
      output: result.stdout || "",
      result: result.value ?? null,
      exitCode: result.exitCode,
      stderr: result.stderr || "",
    });
  } catch (err: any) {
    return Response.json({ error: err.message, output: "" }, { status: 500 });
  }
}

// ── Browser Tools (Container + Playwright) ──────────────────────

/**
 * Build an inline Playwright Node.js script for a browser operation.
 * Each call is self-contained — launches Chromium, does the work, returns JSON.
 * Cold start: container may need several seconds to start the first time.
 */
function buildBrowserScript(
  op: "navigate" | "console" | "snapshot" | "click" | "type",
  params: Record<string, unknown>,
): string {
  const { url, selector, text, timeout } = params;
  const timeoutMs = (timeout as number) || 15000;

  const common = `
const { chromium } = require("playwright");

(async () => {
  let exitCode = 0;
  const result = { ok: false, error: null };
  const start = Date.now();

  try {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Collect console messages
    const consoleMessages = [];
    page.on("console", (msg) => {
      consoleMessages.push({
        type: msg.type(),
        text: msg.text(),
        timestamp: Date.now(),
      });
    });
`;

  const navigateBlock = url
    ? `
    await page.goto(${JSON.stringify(url)}, {
      waitUntil: "domcontentloaded",
      timeout: ${timeoutMs},
    });
`
    : "";

  let opBlock = "";
  switch (op) {
    case "navigate":
      opBlock = `
    result.url = page.url();
    result.title = await page.title();
    result.contentSnippet = (await page.textContent("body") || "").trim().slice(0, 500);
    result.ok = true;
`;
      break;
    case "console":
      opBlock = `
    // Wait a moment for console to fire
    await page.waitForTimeout(1000);
    result.messages = consoleMessages;
    result.url = page.url();
    result.title = await page.title();
    result.ok = true;
`;
      break;
    case "snapshot":
      opBlock = `
    // Use Playwright's accessibility snapshot
    const snapshot = await page.accessibility.snapshot({ interestingOnly: false });
    result.snapshot = snapshot;
    result.url = page.url();
    result.title = await page.title();

    // Also grab basic page content for fallback
    const textContent = await page.textContent("body");
    result.textContent = (textContent || "").trim().slice(0, 2000);

    // Grab interactive elements
    const elements = await page.$$eval(
      "a, button, input, textarea, select, [role]",
      (els) =>
        els.slice(0, 200).map((el, i) => ({
          index: i,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || "",
          text: (el.textContent || "").trim().slice(0, 100),
          id: el.id || "",
          name: (el as HTMLInputElement).name || "",
          type: el.getAttribute("type") || "",
          href: (el as HTMLAnchorElement).href || "",
        })),
    );
    result.elements = elements;
    result.ok = true;
`;
      break;
    case "click":
      if (!selector)
        throw new Error("Missing selector for browser_click");
      opBlock = `
    await page.click(${JSON.stringify(selector)}, { timeout: ${timeoutMs} });
    await page.waitForTimeout(500);
    result.url = page.url();
    result.title = await page.title();
    result.ok = true;
`;
      break;
    case "type":
      if (!selector || !text)
        throw new Error("Missing selector or text for browser_type");
      opBlock = `
    await page.fill(${JSON.stringify(selector)}, ${JSON.stringify(text)}, { timeout: ${timeoutMs} });
    result.url = page.url();
    result.ok = true;
`;
      break;
  }

  const footer = `
    await browser.close();
  } catch (err) {
    result.ok = false;
    result.error = err.message;
    exitCode = 1;
  }

  result.elapsedMs = Date.now() - start;
  // Prefix output with marker so we can extract clean JSON from mixed output
  process.stdout.write("\\n__BROWSER_RESULT__" + JSON.stringify(result) + "__BROWSER_RESULT__\\n");
  process.exit(exitCode);
})();
`;

  return common + navigateBlock + opBlock + footer;
}

/**
 * Parse a browser script result from potentially messy stdout.
 * Look for the __BROWSER_RESULT__ markers we embed.
 */
function parseBrowserResult(stdout: string): Record<string, unknown> {
  const match = stdout.match(/__BROWSER_RESULT__([\s\S]*?)__BROWSER_RESULT__/);
  if (match) {
    try {
      return JSON.parse(match[1]);
    } catch {
      return { ok: false, error: "Failed to parse browser result JSON", raw: stdout.slice(0, 500) };
    }
  }
  return { ok: false, error: "No result marker found in output", raw: stdout.slice(0, 500) };
}

/**
 * Execute a browser operation inside the container.
 * Handles cold start, timeouts, and error extraction.
 */
async function handleBrowserOp(
  workspace: WorkspaceClient,
  op: "navigate" | "console" | "snapshot" | "click" | "type",
  args: Record<string, unknown>,
): Promise<Response> {
  const script = buildBrowserScript(op, args);
  const timeoutMs = (args.timeout as number) || 30000;

  try {
    const handle = await (workspace.runtime as any).exec(script, {
      backend: "container",
      encoding: "utf8",
    });

    // Wait for result with timeout
    const resultPromise = handle.result();
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), timeoutMs),
    );

    const result = await Promise.race([resultPromise, timeoutPromise]);

    if (!result) {
      // Timeout — likely cold start
      // Still try to kill the handle
      try { handle.kill(); } catch {}
      return Response.json(
        {
          error: "Browser operation timed out. Container may be cold-starting.",
          hint: "Retry — subsequent calls will be faster once the container is warm.",
          ok: false,
        },
        { status: 504 },
      );
    }

    const parsed = parseBrowserResult(result.stdout || "");

    return Response.json({
      ...parsed,
      exitCode: result.exitCode ?? (parsed.ok ? 0 : 1),
      stderr: result.stderr || "",
      stdoutSnippet: (result.stdout || "").replace(/__BROWSER_RESULT__[\s\S]*?__BROWSER_RESULT__/g, "").trim().slice(0, 200),
    });
  } catch (err: any) {
    const msg = err.message || String(err);
    // Detect common cold-start / connection errors
    const isColdStart =
      msg.includes("connect") ||
      msg.includes("timeout") ||
      msg.includes("ECONNREFUSED") ||
      msg.includes("not running");

    return Response.json(
      {
        error: isColdStart
          ? `Container not ready (${msg}). It may be cold-starting — retry in a few seconds.`
          : msg,
        ok: false,
        coldStart: isColdStart,
      },
      { status: isColdStart ? 503 : 500 },
    );
  }
}

// ── Worker Entrypoint ───────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", version: "0.3.0" });
    }

    // Tool execution endpoints
    if (url.pathname.startsWith("/tools/") && request.method === "POST") {
      const tool = url.pathname.replace("/tools/", "");
      const body = (await request.json().catch(() => ({}))) as ToolRequest;
      const args = body.args || {};

      // Route to known tools
      switch (tool) {
        case "terminal": {
          const command = String(args.command || "");
          if (!command) return Response.json({ error: "Missing command" }, { status: 400 });
          try {
            const sessionId = request.headers.get("X-Session-Id") || "default";
            const workspace = await resolveWorkspace(env, sessionId);

            // An explicit backend in the request body wins; otherwise ask the
            // Optimizer to pick. Previously selectBackend always overrode it,
            // so "backend":"container" was silently ignored.
            const backend = await pickBackend(
              args.backend,
              (cmd, tool) => selectBackend(env, cmd, tool) as Promise<Backend>,
              command,
              "terminal",
            );
            const start = Date.now();
            const response = await handleTerminal(workspace, args, backend);
            traceOutcome(env, command, "terminal", backend, response.ok ? "success" : "failure", Date.now() - start);
            return response;
          } catch (err: any) {
            traceOutcome(env, String(args.command || ""), "terminal", "shell", "failure", 0);
            return Response.json({ error: `Workspace unavailable: ${err.message}`, command }, { status: 503 });
          }
        }
        case "read_file": {
          const path = String(args.path || "");
          if (!path) return Response.json({ error: "Missing path" }, { status: 400 });
          try {
            const sessionId = request.headers.get("X-Session-Id") || "default";
            const workspace = await resolveWorkspace(env, sessionId);
            const start = Date.now();
            const response = await handleReadFile(workspace, args);
            traceOutcome(env, path, "read_file", "fs", response.ok ? "success" : "failure", Date.now() - start);
            return response;
          } catch (err: any) {
            traceOutcome(env, String(args.path || ""), "read_file", "fs", "failure", 0);
            return Response.json({ error: `Workspace unavailable: ${err.message}` }, { status: 503 });
          }
        }
        case "write_file": {
          const path = String(args.path || "");
          if (!path) return Response.json({ error: "Missing path" }, { status: 400 });
          try {
            const sessionId = request.headers.get("X-Session-Id") || "default";
            const workspace = await resolveWorkspace(env, sessionId);
            const start = Date.now();
            const response = await handleWriteFile(workspace, args);
            traceOutcome(env, path, "write_file", "fs", response.ok ? "success" : "failure", Date.now() - start);
            return response;
          } catch (err: any) {
            traceOutcome(env, String(args.path || ""), "write_file", "fs", "failure", 0);
            return Response.json({ error: `Workspace unavailable: ${err.message}` }, { status: 503 });
          }
        }
        case "execute_code": {
          const code = String(args.code || "");
          if (!code) return Response.json({ error: "Missing code" }, { status: 400 });
          try {
            const sessionId = request.headers.get("X-Session-Id") || "default";
            const workspace = await resolveWorkspace(env, sessionId);

            const start = Date.now();
            const response = await handleExecuteCode(workspace, args);
            traceOutcome(env, code.slice(0, 100), "execute_code", "js", response.ok ? "success" : "failure", Date.now() - start);
            return response;
          } catch (err: any) {
            traceOutcome(env, String(args.code || "").slice(0, 100), "execute_code", "js", "failure", 0);
            return Response.json({ error: `Workspace unavailable: ${err.message}` }, { status: 503 });
          }
        }
        case "browser_navigate": {
          const url = String(args.url || "");
          if (!url) return Response.json({ error: "Missing url" }, { status: 400 });
          try {
            const sessionId = request.headers.get("X-Session-Id") || "default";
            const workspace = await resolveWorkspace(env, sessionId);
            const start = Date.now();
            const response = await handleBrowserOp(workspace, "navigate", args);
            traceOutcome(env, url, "browser_navigate", "container", response.ok ? "success" : "failure", Date.now() - start);
            return response;
          } catch (err: any) {
            traceOutcome(env, String(args.url || ""), "browser_navigate", "container", "failure", 0);
            return Response.json({ error: `Workspace unavailable: ${err.message}` }, { status: 503 });
          }
        }
        case "browser_console": {
          const url = args.url ? String(args.url) : undefined;
          try {
            const sessionId = request.headers.get("X-Session-Id") || "default";
            const workspace = await resolveWorkspace(env, sessionId);
            const start = Date.now();
            const response = await handleBrowserOp(workspace, "console", args);
            traceOutcome(env, url || "(no url)", "browser_console", "container", response.ok ? "success" : "failure", Date.now() - start);
            return response;
          } catch (err: any) {
            traceOutcome(env, String(args.url || ""), "browser_console", "container", "failure", 0);
            return Response.json({ error: `Workspace unavailable: ${err.message}` }, { status: 503 });
          }
        }
        case "browser_snapshot": {
          const url = args.url ? String(args.url) : undefined;
          try {
            const sessionId = request.headers.get("X-Session-Id") || "default";
            const workspace = await resolveWorkspace(env, sessionId);
            const start = Date.now();
            const response = await handleBrowserOp(workspace, "snapshot", args);
            traceOutcome(env, url || "(no url)", "browser_snapshot", "container", response.ok ? "success" : "failure", Date.now() - start);
            return response;
          } catch (err: any) {
            traceOutcome(env, String(args.url || ""), "browser_snapshot", "container", "failure", 0);
            return Response.json({ error: `Workspace unavailable: ${err.message}` }, { status: 503 });
          }
        }
        case "browser_click": {
          const selector = String(args.selector || "");
          if (!selector) return Response.json({ error: "Missing selector" }, { status: 400 });
          try {
            const sessionId = request.headers.get("X-Session-Id") || "default";
            const workspace = await resolveWorkspace(env, sessionId);
            const start = Date.now();
            const response = await handleBrowserOp(workspace, "click", args);
            traceOutcome(env, selector, "browser_click", "container", response.ok ? "success" : "failure", Date.now() - start);
            return response;
          } catch (err: any) {
            traceOutcome(env, String(args.selector || ""), "browser_click", "container", "failure", 0);
            return Response.json({ error: `Workspace unavailable: ${err.message}` }, { status: 503 });
          }
        }
        case "browser_type": {
          const selector = String(args.selector || "");
          if (!selector) return Response.json({ error: "Missing selector" }, { status: 400 });
          try {
            const sessionId = request.headers.get("X-Session-Id") || "default";
            const workspace = await resolveWorkspace(env, sessionId);
            const start = Date.now();
            const response = await handleBrowserOp(workspace, "type", args);
            traceOutcome(env, selector, "browser_type", "container", response.ok ? "success" : "failure", Date.now() - start);
            return response;
          } catch (err: any) {
            traceOutcome(env, String(args.selector || ""), "browser_type", "container", "failure", 0);
            return Response.json({ error: `Workspace unavailable: ${err.message}` }, { status: 503 });
          }
        }
        default:
          return Response.json({ error: `Unknown tool: ${tool}` }, { status: 404 });
      }
    }

    // Route agent requests to the DO
    if (url.pathname.startsWith("/agents/")) {
      const name = url.pathname.split("/")[2] || "default";
      const id = env.AgentDO.idFromName(name);
      const stub = env.AgentDO.get(id);
      return stub.fetch(request);
    }

    return new Response("Hermes Computer Bridge v0.3.0\nPOST /tools/:name\nBrowser tools: browser_navigate, browser_console, browser_snapshot, browser_click, browser_type", { status: 200 });
  },
};
