/**
 * Pure, Workers-free helpers extracted from the tool handlers in index.ts.
 *
 * These are the parts that were actually wrong before and are easy to get
 * wrong again, so they live here where a plain Node test can reach them.
 * Nothing in this file may import workerd globals (Response is fine, it exists
 * in Node 18+).
 */

/** Backends the /tools/terminal route accepts. Anything else is ignored. */
export type Backend = "shell" | "container" | "js";

/** Default when MODEL is unset. */
export const DEFAULT_WORKERS_AI_MODEL = "@cf/zai-org/glm-4.7-flash";

export type ModelBinding =
  /** Workers AI catalog id, e.g. "@cf/zai-org/glm-4.7-flash". */
  | { kind: "workers-ai"; model: string }
  /**
   * Any OpenAI-compatible /chat/completions endpoint. Escape hatch for models
   * Workers AI does not host — notably FrogNano-4B-2609, which has no
   * first-party endpoint and must be self-hosted (vLLM/SGLang/Ollama) behind a
   * gateway, then pointed at here.
   */
  | { kind: "openai-compatible"; baseURL: string; apiKey: string; model: string };

/**
 * Resolves the model binding from env, defaulting to the Workers AI catalog.
 *
 * MODEL is a plain catalog id. When MODEL is an absolute URL the binding
 * switches to OpenAI-compatible mode, so a self-hosted endpoint can be adopted
 * without a code change. MODEL_BASE_URL is the explicit alternative for a
 * hosted gateway where the model id and the URL are separate values.
 *
 * Throws rather than silently falling back: a misconfigured model should fail
 * loudly at the first chat turn, not look like a bad prompt.
 */
export function resolveModelBinding(env: {
  MODEL?: string;
  MODEL_BASE_URL?: string;
  MODEL_API_KEY?: string;
}): ModelBinding {
  const raw = env.MODEL?.trim() || DEFAULT_WORKERS_AI_MODEL;

  if (/^https?:\/\//i.test(raw)) {
    if (!env.MODEL_API_KEY) {
      throw new Error(
        "MODEL is a URL (OpenAI-compatible mode) but MODEL_API_KEY is unset. " +
          "Set it, or set MODEL to a Workers AI catalog id instead.",
      );
    }
    return {
      kind: "openai-compatible",
      baseURL: raw.replace(/\/+$/, ""),
      apiKey: env.MODEL_API_KEY,
      // A bare-URL binding serves one model; "default" is the convention
      // gateways use to mean "the only one you have".
      model: "default",
    };
  }

  if (env.MODEL_BASE_URL) {
    if (!env.MODEL_API_KEY) {
      throw new Error(
        "MODEL_BASE_URL is set but MODEL_API_KEY is unset. Both are required " +
          "for OpenAI-compatible mode.",
      );
    }
    return {
      kind: "openai-compatible",
      baseURL: env.MODEL_BASE_URL.replace(/\/+$/, ""),
      apiKey: env.MODEL_API_KEY,
      model: raw,
    };
  }

  return { kind: "workers-ai", model: raw };
}

const VALID_BACKENDS: ReadonlySet<string> = new Set<Backend>(["shell", "container", "js"]);

/**
 * An explicit `backend` in the request body wins; otherwise fall back to the
 * Optimizer's pick. Previously selectBackend always overrode the requested
 * backend, so `"backend":"container"` was silently ignored and the call ran in
 * a shell — which is how a "container works!" claim can be false.
 */
export function pickBackend(
  requested: unknown,
  fallback: (command: string, tool: string) => Promise<Backend>,
  command: string,
  tool = "terminal",
): Promise<Backend> {
  if (typeof requested === "string" && VALID_BACKENDS.has(requested)) {
    return Promise.resolve(requested as Backend);
  }
  return fallback(command, tool);
}

/**
 * Normalize a workspace exec result for the JSON response.
 *
 * Three separate bugs lived here:
 *
 *  1. `exec()` resolves to a HANDLE, not the output. The real
 *     {stdout, stderr, exitCode} only exists on `handle.result()`. Reading
 *     `.stdout` off the handle yields `{}` — which is what made a successful
 *     run look like it produced nothing.
 *  2. The `js` backend runs an ES module and returns its default export in
 *     `value`; stdout is legitimately empty. Reading only stdout made every js
 *     call a silent no-op with exitCode 0.
 *  3. Without `encoding: "utf8"` stdout/stderr arrive as Uint8Array and
 *     serialize as {"0":72,"1":69,...} instead of text.
 */
export interface ExecResultLike {
  stdout?: unknown;
  stderr?: unknown;
  value?: unknown;
  exitCode?: unknown;
  status?: unknown;
  backend?: unknown;
}

export interface NormalizedExec {
  output: string;
  stdout: string;
  value: unknown;
  stderr: string;
  exitCode: number;
  status: unknown;
  backend: Backend;
  actualBackend: string | null;
}

/** Coerce a Uint8Array / ArrayBuffer / string / value to display text. */
export function toText(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "string") return raw;
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
  if (raw instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(raw));
  return JSON.stringify(raw) ?? String(raw);
}

export function normalizeExecResult(
  result: ExecResultLike | undefined,
  backend: Backend,
  handleBackend?: unknown,
): NormalizedExec {
  const stdout = toText(result?.stdout);
  const stderr = toText(result?.stderr);
  const value = result?.value ?? null;
  // `output` is the human-facing field: prefer real stdout, fall back to the
  // js module's value so those calls aren't reported as empty.
  const output = stdout || toText(value);
  const exitCode = typeof result?.exitCode === "number" ? result.exitCode : 0;
  const actual = result?.backend ?? handleBackend ?? null;
  return {
    output,
    stdout,
    value,
    stderr,
    exitCode,
    status: result?.status,
    backend,
    actualBackend: typeof actual === "string" ? actual : null,
  };
}

/**
 * The parent directory of an absolute path, or "" when there is none to
 * create ("/f" -> "", "/a/b/f" -> "/a/b").
 *
 * The workspace VFS is rooted at "/" and does NOT pre-create /workspace, and
 * writeFile refuses to create intermediate directories — so any nested write
 * failed with ENOENT "parent directory missing". Callers must mkdir this
 * first; recursive mkdir is idempotent so EEXIST needs no handling.
 */
export function parentDir(path: string): string {
  const slash = path.lastIndexOf("/");
  if (slash <= 0) return "";
  return path.slice(0, slash);
}

/**
 * Directories that must exist before a write. Returns [] for root-level paths.
 */
export function dirsToCreate(path: string): string[] {
  const parent = parentDir(path);
  return parent ? [parent] : [];
}

/** Validate the tool's required string arg, returning null when OK. */
export function missingArg(value: unknown): string | null {
  const s = String(value ?? "");
  return s ? null : "Missing path";
}
