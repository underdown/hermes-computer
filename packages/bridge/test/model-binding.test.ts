/**
 * Model-binding resolution.
 *
 * Ryan asked to bind FrogNano-4B-2609. That model has no Workers AI catalog
 * entry and no first-party endpoint, so the binding had to become configurable
 * before it could be pointed anywhere. These tests pin the resolution rules so
 * a misconfiguration fails loudly at the first chat turn instead of silently
 * degrading to a default.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveModelBinding, DEFAULT_WORKERS_AI_MODEL } from "../src/core.ts";

describe("resolveModelBinding", () => {
  describe("workers-ai (catalog) mode", () => {
    test("defaults to the catalog model when MODEL is unset", () => {
      const b = resolveModelBinding({});
      assert.deepEqual(b, { kind: "workers-ai", model: DEFAULT_WORKERS_AI_MODEL });
    });

    test("uses a plain catalog id verbatim", () => {
      const b = resolveModelBinding({ MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
      assert.deepEqual(b, {
        kind: "workers-ai",
        model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      });
    });

    test("trims surrounding whitespace", () => {
      const b = resolveModelBinding({ MODEL: "  @cf/zai-org/glm-4.7-flash  " });
      assert.equal(b.kind, "workers-ai");
      assert.equal((b as { model: string }).model, "@cf/zai-org/glm-4.7-flash");
    });

    test("an empty MODEL falls back to the default rather than resolving to ''", () => {
      // A blank env var must not produce a model literally named "".
      const b = resolveModelBinding({ MODEL: "   " });
      assert.deepEqual(b, { kind: "workers-ai", model: DEFAULT_WORKERS_AI_MODEL });
    });
  });

  describe("openai-compatible mode", () => {
    test("a URL in MODEL switches mode and uses the 'default' model alias", () => {
      const b = resolveModelBinding({
        MODEL: "https://frog.internal/v1",
        MODEL_API_KEY: "sk-test",
      });
      assert.deepEqual(b, {
        kind: "openai-compatible",
        baseURL: "https://frog.internal/v1",
        apiKey: "sk-test",
        model: "default",
      });
    });

    test("strips a trailing slash so base URLs don't double up", () => {
      const b = resolveModelBinding({
        MODEL: "https://frog.internal/v1///",
        MODEL_API_KEY: "sk-test",
      });
      assert.equal((b as { baseURL: string }).baseURL, "https://frog.internal/v1");
    });

    test("MODEL_BASE_URL + MODEL id keeps the id, taking precedence over URL-detection", () => {
      const b = resolveModelBinding({
        MODEL: "FrogNano-4B-2609",
        MODEL_BASE_URL: "https://gateway.example/v1/",
        MODEL_API_KEY: "sk-test",
      });
      assert.deepEqual(b, {
        kind: "openai-compatible",
        baseURL: "https://gateway.example/v1",
        apiKey: "sk-test",
        model: "FrogNano-4B-2609",
      });
    });

    test("MODEL_BASE_URL without an id still resolves via the default id", () => {
      const b = resolveModelBinding({
        MODEL_BASE_URL: "https://gateway.example/v1",
        MODEL_API_KEY: "sk-test",
      });
      assert.equal(b.kind, "openai-compatible");
      assert.equal((b as { model: string }).model, DEFAULT_WORKERS_AI_MODEL);
    });
  });

  describe("misconfiguration fails loudly", () => {
    // Silent fallback is the failure mode worth guarding: a wrong binding looks
    // exactly like a model that refuses to follow instructions.
    test("URL in MODEL with no key throws instead of defaulting", () => {
      assert.throws(
        () => resolveModelBinding({ MODEL: "https://frog.internal/v1" }),
        /MODEL_API_KEY is unset/,
      );
    });

    test("MODEL_BASE_URL with no key throws instead of defaulting", () => {
      assert.throws(
        () => resolveModelBinding({ MODEL_BASE_URL: "https://gateway.example/v1" }),
        /MODEL_API_KEY is unset/,
      );
    });

    test("an empty key is treated as missing, not as a valid credential", () => {
      assert.throws(
        () => resolveModelBinding({ MODEL: "https://frog.internal/v1", MODEL_API_KEY: "" }),
        /MODEL_API_KEY is unset/,
      );
    });
  });
});
