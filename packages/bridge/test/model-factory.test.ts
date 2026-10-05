/**
 * Both model factories must return a model `ai@6` can actually drive.
 *
 * ai@6's `LanguageModel` is `LanguageModelV3 | LanguageModelV2`. The V1 model
 * the old workers-ai-provider@0.1.3 returned was in neither union, and the
 * `as unknown as LanguageModel` cast in getModel() hid it until a real chat
 * turn. Same hazard for the OpenAI-compatible branch, added so a self-hosted
 * FrogNano can be bound.
 *
 * A version bump that silently moves a provider to V4 would reintroduce exactly
 * that failure with no type error — so this is asserted, not assumed.
 */
import { test, describe } from "node:test";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createWorkersAI } from "workers-ai-provider";
import { resolveModelBinding } from "../src/core.ts";

/** Never invoked — we only inspect the model object built around it. */
const fakeAi = new Proxy(
  {},
  { get: (_t, p) => (p === "toString" ? () => "fake" : () => Promise.reject(new Error("unused"))) },
);

/** Spec versions ai@6 accepts, per `type LanguageModel` in ai@6's index.d.ts. */
const AI6_ACCEPTS = new Set(["v2", "v3"]);

function assertAi6Compatible(label: string, model: unknown) {
  const m = model as {
    specificationVersion?: string;
    doGenerate?: unknown;
    doStream?: unknown;
    supportedUrls?: unknown;
  };
  assert.ok(
    m.specificationVersion && AI6_ACCEPTS.has(m.specificationVersion),
    `${label}: specificationVersion must be v2 or v3 for ai@6, got ${String(m.specificationVersion)}`,
  );
  assert.equal(typeof m.doGenerate, "function", `${label}: missing doGenerate`);
  assert.equal(typeof m.doStream, "function", `${label}: missing doStream`);
  assert.ok(m.supportedUrls, `${label}: missing supportedUrls`);
}

describe("model factories are compatible with ai@6", () => {
  test("workers-ai branch produces an ai@6-usable model", () => {
    const binding = resolveModelBinding({});
    assert.equal(binding.kind, "workers-ai");
    assertAi6Compatible(
      "workers-ai",
      createWorkersAI({ binding: fakeAi as never })((binding as { model: string }).model),
    );
  });

  test("openai-compatible branch produces an ai@6-usable model", () => {
    const binding = resolveModelBinding({
      MODEL: "https://frog.internal/v1",
      MODEL_API_KEY: "sk-test",
    });
    assert.equal(binding.kind, "openai-compatible");
    const b = binding as { baseURL: string; apiKey: string; model: string };
    assertAi6Compatible(
      "openai-compatible",
      createOpenAICompatible({
        name: "self-hosted",
        baseURL: b.baseURL,
        apiKey: b.apiKey,
      }).chatModel(b.model),
    );
  });

  test("the installed openai-compatible package targets provider V3, not V4", () => {
    // Guards the dependency choice: 3.x pulls @ai-sdk/provider@4 (V4 models),
    // which ai@6 cannot consume. We pin 2.0.81 for this reason.
    const prov = createRequire(import.meta.url)("@ai-sdk/provider/package.json");
    assert.match(String(prov.version), /^3\./, `expected @ai-sdk/provider@3.x, got ${prov.version}`);
  });
});
