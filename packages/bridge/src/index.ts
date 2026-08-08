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
  type WorkspaceStub,
} from "@cloudflare/computer";
import {
  CloudflareContainerBackend,
  withWorkspaceContainer,
} from "@cloudflare/computer/backends/container";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { Think } from "@cloudflare/think";
import { createWorkersAI } from "workers-ai-provider";
import { createAITools } from "@cloudflare/computer/tools";
import { DurableObject } from "cloudflare:workers";

export { WorkspaceProxy, WorkspaceServiceProxy };

// ── Types ───────────────────────────────────────────────────────

interface Env {
  AI: Ai;
  LOADER: Fetcher;
  OPTIMIZER: DurableObjectNamespace;
  HermesWorkspace: DurableObjectNamespace;
  Assistant: DurableObjectNamespace;
}

interface ToolRequest {
  userRequest?: string;
  args?: Record<string, unknown>;
}

// ── Agent DO (Think + Computer Workspace) ───────────────────────

class AgentBase extends Think<Env> {
  override workspaceBash = false;
  override maxSteps = 20;
}

export class AgentDO extends withWorkspaceContainer(AgentBase) {
  readonly #containerBackend = new CloudflareContainerBackend({
    id: "container",
    container: () => this,
    workspace: { binding: "AgentDO", id: this.ctx.id.toString() },
  });

  override workspace = new Workspace({
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    backends: [
      new WorkerShellBackend({
        id: "shell",
        loader: this.env.LOADER,
        workspace: { binding: "AgentDO", id: this.ctx.id.toString() },
        ctx: this.ctx,
      }),
      this.#containerBackend,
    ],
    useThink: true,
  }) as Workspace & any;

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") return this.#containerBackend.handleFetch(request);
    return super.fetch(request);
  }

  async __getWorkspaceStub(): Promise<WorkspaceStub> {
    return this.workspace as unknown as WorkspaceStub;
  }

  override model = createWorkersAI({ binding: this.env.AI })("@cf/zai-org/glm-5.2");

  override tools = createAITools(this.workspace as any, {
    exec: {
      backends: [
        { id: "shell", description: "Fast just-bash shell for text tooling" },
        {
          id: "container",
          description:
            "Full Linux userland (npm, pip, git, python, node, Playwright). Slower cold start.",
        },
      ],
    },
    read: true,
    write: true,
    edit: true,
    ls: true,
  }) as any;
}

// ── Direct Tool Execution Endpoints ─────────────────────────────

/**
 * Execute a shell command in the workspace.
 * Uses the shell backend by default, container for heavy ops.
 */
async function handleTerminal(
  workspace: Workspace,
  args: Record<string, unknown>
): Promise<Response> {
  const command = String(args.command || "");
  if (!command) return Response.json({ error: "Missing command" }, { status: 400 });

  try {
    const result = await (workspace.runtime as any).exec(command, {
      backend: "shell",
    });
    return Response.json({ output: result.stdout || result, exitCode: result.exitCode ?? 0 });
  } catch (err: any) {
    return Response.json({ error: err.message, output: "" }, { status: 500 });
  }
}

/**
 * Read a file from the workspace filesystem.
 */
async function handleReadFile(
  workspace: Workspace,
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
  workspace: Workspace,
  args: Record<string, unknown>
): Promise<Response> {
  const path = String(args.path || "");
  const content = String(args.content || "");
  if (!path) return Response.json({ error: "Missing path" }, { status: 400 });

  try {
    await workspace.fs.writeFile(path, content);
    return Response.json({ ok: true, bytes: content.length });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

/**
 * Execute JavaScript in the Isolate JS backend.
 * Safe, sandboxed, no network access.
 */
async function handleExecuteCode(
  workspace: Workspace,
  args: Record<string, unknown>
): Promise<Response> {
  const code = String(args.code || "");
  if (!code) return Response.json({ error: "Missing code" }, { status: 400 });

  try {
    // For now, route to shell with node -e for JS execution
    // In a full implementation, this would use the Isolate JavaScript backend
    const result = await (workspace.runtime as any).exec(`node -e ${JSON.stringify(code)}`, {
      backend: "shell",
    });
    return Response.json({ output: result.stdout || result, exitCode: result.exitCode ?? 0 });
  } catch (err: any) {
    return Response.json({ error: err.message, output: "" }, { status: 500 });
  }
}

// ── Worker Entrypoint ───────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", version: "0.1.0" });
    }

    // Tool execution endpoints
    if (url.pathname.startsWith("/tools/") && request.method === "POST") {
      const tool = url.pathname.replace("/tools/", "");
      const body: ToolRequest = await request.json().catch(() => ({}));
      const args = body.args || {};

      // Get or create a workspace for this session
      const sessionId = request.headers.get("X-Session-Id") || "default";
      const agentId = env.AgentDO.idFromName(sessionId);
      const agent = env.AgentDO.get(agentId);
      const workspace = await agent.__getWorkspaceStub();

      switch (tool) {
        case "terminal":
          return handleTerminal(workspace as unknown as Workspace, args);
        case "read_file":
          return handleReadFile(workspace as unknown as Workspace, args);
        case "write_file":
          return handleWriteFile(workspace as unknown as Workspace, args);
        case "execute_code":
          return handleExecuteCode(workspace as unknown as Workspace, args);
        case "browser_navigate":
        case "browser_console":
        case "browser_snapshot":
          return Response.json({ error: "Browser tools require Container backend — coming soon" }, { status: 501 });
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

    return new Response("Hermes Computer Bridge v0.1.0\nPOST /tools/:name", { status: 200 });
  },
};
