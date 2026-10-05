/**
 * Live check: bind the exact provider config getModel() builds, point it at a
 * real FrogNano, and drive an actual tool call.
 *
 * Why this exists separately from the unit tests: the unit tests assert the
 * model object is shaped correctly for ai@6. This asserts a real model actually
 * completes and emits a parseable tool call through that same provider.
 *
 * FrogNano is a tool-use model (Leaf harness: read/write/edit/glob/bash), so
 * tool calling is the load-bearing capability -- a provider that returns prose
 * where a tool call belongs would pass every shape assertion and fail in use.
 *
 * Usage: node --experimental-strip-types scripts/frognano-live-check.mts
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";

const BASE = process.env.LMS_BASE ?? "http://100.105.114.43:11435/v1";
const KEY = process.env.LMS_KEY ?? "none";
const MODEL = process.env.LMS_MODEL ?? "frognano-4b-2609@q4_k_s";

// Identical shape to the openai-compatible branch in src/index.ts getModel().
const provider = createOpenAICompatible({ name: "self-hosted", baseURL: BASE, apiKey: KEY });
const model = provider.chatModel(MODEL);

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// 1. Plain completion
const t0 = Date.now();
const plain = await generateText({
  model,
  prompt: "What is 17 * 23? Reply with only the number.",
  maxOutputTokens: 512,
});
check(
  "plain completion",
  /\b391\b/.test(plain.text),
  `${plain.text.trim().slice(0, 60).replace(/\n/g, " ")} (${Date.now() - t0}ms)`,
);

// 2. Tool call -- the capability that actually matters for a computer agent
const tools = {
  bash: tool({
    description: "Run a shell command",
    inputSchema: z.object({ command: z.string().describe("shell command to run") }),
    execute: async () => "",
  }),
};
const t1 = Date.now();
const withTool = await generateText({
  model,
  tools,
  prompt: "List the 5 largest files in the current directory. Use the bash tool.",
  maxOutputTokens: 512,
  stopWhen: stepCountIs(3),
});
const calls = withTool.steps.flatMap((s) => s.toolCalls);
check(
  "tool call emitted + parsed",
  calls.length > 0 && calls.some((c) => c.toolName === "bash" && typeof c.input?.command === "string"),
  calls.length
    ? `${calls.length} call(s): ${calls.map((c) => `${c.toolName}(${JSON.stringify(c.input).slice(0, 50)})`).join(", ")}`
    : `NO TOOL CALLS — text was: ${withTool.text.trim().slice(0, 90).replace(/\n/g, " ")}`,
);
check(
  "tool round-trip terminates",
  Date.now() - t1 < 120000,
  `${Date.now() - t1}ms, ${withTool.steps.length} step(s)`,
);

// 3. Streaming -- agent loops consume the stream, not the buffered result.
// Long prompt on purpose: a short one can legitimately arrive as a single
// chunk, which makes a chunk-count assertion measure the prompt, not streaming.
let chunks = 0;
let streamed = "";
const s = streamText({
  model,
  prompt: "Write a 120 word paragraph about why recursion is useful in programming.",
  maxOutputTokens: 600,
});
for await (const part of s.textStream) {
  chunks++;
  streamed += part;
}
check(
  "streaming yields incremental text",
  chunks > 1 && streamed.trim().length > 100,
  `${chunks} chunks, ${streamed.length} chars`,
);

console.log(`\nmodel=${MODEL} base=${BASE}`);
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
