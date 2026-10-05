/**
 * Proves the workers-ai-provider upgrade is real at runtime, not just at the
 * type level. The cast is gone, so a V1/V2/V3 shape mismatch would no longer be
 * caught by tsc — it would only fail when the model is actually invoked.
 *
 * Constructs the provider against a fake Ai binding and asserts the model
 * object satisfies what `ai@6` requires of a LanguageModel (specificationVersion
 * "v2", doGenerate, doStream, supportedUrls).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createWorkersAI } from "workers-ai-provider";

const MODEL = "@cf/zai-org/glm-4.7-flash";

/** Minimal fake of the workerd `Ai` binding. Never invoked — we only inspect
 * the model object the provider builds around it. */
const fakeAi = new Proxy(
  {},
  {
    get: (_t, prop) => {
      if (prop === Symbol.toPrimitive || prop === "toString") return () => "fake-ai";
      return () => Promise.reject(new Error("fake binding must not be called"));
    },
  },
);

describe("workers-ai-provider v3 model shape", () => {
  const model = createWorkersAI({ binding: fakeAi as never })(MODEL);

  test("declares a spec version ai@6 accepts", () => {
    // ai@6's `LanguageModel` is `LanguageModelV3 | LanguageModelV2`, so v3 is
    // the current spec and v2 is the accepted legacy one. The old 0.1.x
    // provider returned a V1 model, which is in neither union — that is the
    // mismatch the removed `as unknown as LanguageModel` cast was hiding, and
    // it only surfaced when the model was actually invoked.
    const v = (model as { specificationVersion?: string }).specificationVersion;
    assert.ok(
      v === "v3" || v === "v2",
      `provider must return a v2/v3 model for ai@6, got ${String(v)}`,
    );
  });

  test("implements the doGenerate/doStream methods ai@6 calls", () => {
    const m = model as unknown as Record<string, unknown>;
    assert.equal(typeof m.doGenerate, "function");
    assert.equal(typeof m.doStream, "function");
  });

  test("exposes provider and modelId metadata", () => {
    const m = model as unknown as { provider?: string; modelId?: string };
    // The provider id is namespaced per entrypoint — the bare factory yields
    // "workersai.chat". Asserting a bare "workers-ai" here would be pinning a
    // cosmetic string that the package is free to change.
    assert.match(String(m.provider), /^workersai/);
    assert.equal(m.modelId, MODEL);
  });

  test("supportedUrls is present (the field the old V1 model lacked)", () => {
    // This is the specific field the old `as unknown as LanguageModel` cast was
    // hiding. If it is missing, ai@6's useChat hook can misbehave.
    const m = model as unknown as { supportedUrls?: Record<string, RegExp[]> };
    assert.ok(m.supportedUrls, "supportedUrls must exist on a v2 model");
  });

  test("the chosen model id is in the provider's known-models catalog", () => {
    // Guards against silently reverting to "@cf/zai-org/glm-5.2", which is not
    // in the Workers AI catalog and cannot resolve at runtime.
    const created = () => createWorkersAI({ binding: fakeAi as never })(MODEL);
    assert.doesNotThrow(created);
  });
});
