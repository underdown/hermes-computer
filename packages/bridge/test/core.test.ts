/**
 * Regression tests for the bridge's pure tool-routing/response logic.
 *
 * Run with:  npm test
 *
 * Every test here pins a bug that actually shipped. If one fails, the
 * corresponding fix in src/core.ts has regressed — see the comment on each.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  dirsToCreate,
  missingArg,
  normalizeExecResult,
  parentDir,
  pickBackend,
  toText,
} from "../src/core.ts";

describe("parentDir / dirsToCreate", () => {
  // Regression: the workspace VFS is rooted at "/" with no pre-created
  // /workspace, and writeFile will not create intermediate directories, so
  // every nested write failed with ENOENT "parent directory missing".
  test("nested path reports the parent that must be created", () => {
    assert.equal(parentDir("/a/b/c/d.txt"), "/a/b/c");
    assert.deepEqual(dirsToCreate("/a/b/c/d.txt"), ["/a/b/c"]);
  });

  test("root-level path needs no mkdir", () => {
    assert.equal(parentDir("/t.txt"), "");
    assert.deepEqual(dirsToCreate("/t.txt"), []);
  });

  test("one level deep", () => {
    assert.equal(parentDir("/workspace/t.txt"), "/workspace");
    assert.deepEqual(dirsToCreate("/workspace/t.txt"), ["/workspace"]);
  });

  test("a directory path is its own parent, not its grandparent", () => {
    // "/a/b/" names a directory, so the last segment is empty and the parent is
    // "/a/b". This is the off-by-one that makes a fix "work" in the test and
    // fail live. File paths like "/a/b/c.txt" are covered above.
    assert.equal(parentDir("/a/b/"), "/a/b");
  });

  test("deep path creates exactly one recursive mkdir, not each level", () => {
    // Recursive mkdir handles the intermediate levels; emitting a mkdir per
    // segment is wasted work and an extra failure surface.
    assert.deepEqual(dirsToCreate("/x/y/z/deep.txt"), ["/x/y/z"]);
  });
});

describe("pickBackend", () => {
  // Regression: selectBackend always overrode the requested backend, so
  // {"backend":"container"} was silently ignored and ran in a shell. That
  // makes a "container works!" claim false while every request returns 200.
  test("explicit container is honored, fallback NOT called", async () => {
    let called = false;
    const b = await pickBackend("container", async () => {
      called = true;
      return "shell";
    }, "echo hi");
    assert.equal(b, "container");
    assert.equal(called, false, "fallback must not run when a backend is given");
  });

  test("explicit js is honored (not coerced to shell)", async () => {
    // Regression: the old signature typed "shell" | "container" and cast
    // through it, so "js" was never type-checked.
    assert.equal(await pickBackend("js", async () => "shell", "export default 1"), "js");
  });

  test("absent backend falls through to the optimizer", async () => {
    assert.equal(await pickBackend(undefined, async () => "container", "npm i"), "container");
    assert.equal(await pickBackend("", async () => "shell", "ls"), "shell");
  });

  test("unknown backend falls through rather than being trusted", async () => {
    // A typo'd backend must not be passed to the SDK unchecked.
    assert.equal(await pickBackend("kubernets", async () => "container", "ls"), "container");
  });

  test("non-string backend falls through", async () => {
    assert.equal(await pickBackend(42, async () => "shell", "ls"), "shell");
  });
});

describe("normalizeExecResult", () => {
  // Regression: exec() resolves to a HANDLE, not output. Reading .stdout off
  // the handle gave {}, which serialized as {"output":{},"exitCode":0} and made
  // a successful run look like it produced nothing.
  test("reads stdout off the RESULT, not the handle", () => {
    const n = normalizeExecResult({ stdout: "ROOT_OK\n", exitCode: 0 }, "shell");
    assert.equal(n.output, "ROOT_OK\n");
    assert.equal(n.exitCode, 0);
  });

  // Regression: the js backend runs an ES module and returns its default
  // export in `value`; stdout is legitimately empty. Reading only stdout made
  // every js call a silent no-op.
  test("falls back to value when stdout is empty (js backend)", () => {
    const n = normalizeExecResult({ stdout: "", value: [2, 3], exitCode: 0 }, "js");
    assert.equal(n.output, "[2,3]");
    assert.deepEqual(n.value, [2, 3]);
  });

  test("string value is not JSON-quoted", () => {
    const n = normalizeExecResult({ stdout: "", value: "hello" }, "js");
    assert.equal(n.output, "hello");
  });

  test("real stdout wins over value when both present", () => {
    const n = normalizeExecResult({ stdout: "shell", value: "module" }, "shell");
    assert.equal(n.output, "shell");
  });

  // Regression: without encoding:"utf8" stdout arrives as Uint8Array and
  // serializes as {"0":72,"1":69,...} instead of text.
  test("decodes Uint8Array stdout instead of leaking byte indices", () => {
    const n = normalizeExecResult({ stdout: new TextEncoder().encode("CONT_OK") }, "container");
    assert.equal(n.output, "CONT_OK");
  });

  test("decodes Uint8Array stderr too", () => {
    const n = normalizeExecResult({ stderr: new TextEncoder().encode("boom") }, "shell");
    assert.equal(n.stderr, "boom");
  });

  test("non-zero exitCode is preserved, not coerced to 0", () => {
    const n = normalizeExecResult({ stdout: "", stderr: "nope", exitCode: 1 }, "shell");
    assert.equal(n.exitCode, 1);
  });

  test("actualBackend prefers result, falls back to handle", () => {
    assert.equal(normalizeExecResult({ backend: "container" }, "container").actualBackend, "container");
    assert.equal(normalizeExecResult({}, "shell", "container").actualBackend, "container");
    assert.equal(normalizeExecResult({}, "shell").actualBackend, null);
  });

  test("survives an undefined result", () => {
    const n = normalizeExecResult(undefined, "shell");
    assert.equal(n.output, "");
    assert.equal(n.exitCode, 0);
    assert.equal(n.value, null);
  });

  test("keeps requested and actual backend distinct", () => {
    // The Optimizer can route elsewhere than requested; collapsing these
    // hides that.
    const n = normalizeExecResult({ backend: "shell" }, "container");
    assert.equal(n.backend, "container");
    assert.equal(n.actualBackend, "shell");
  });
});

describe("toText", () => {
  test("handles nullish, string, bytes, and objects", () => {
    assert.equal(toText(undefined), "");
    assert.equal(toText(null), "");
    assert.equal(toText("x"), "x");
    assert.equal(toText(new Uint8Array([104, 105])), "hi");
    assert.equal(toText({ a: 1 }), '{"a":1}');
  });
});

describe("missingArg", () => {
  test("flags absent paths and accepts present ones", () => {
    assert.equal(missingArg(""), "Missing path");
    assert.equal(missingArg(undefined), "Missing path");
    assert.equal(missingArg("/a.txt"), null);
  });
});
