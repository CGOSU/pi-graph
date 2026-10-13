import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { GraphClient } from "../src/core/client.js";
import { hashContent, safeScope } from "../src/core/files.js";
import { queryTokens, tokens } from "../src/core/text.js";
import { featureFiles, fixture } from "./helpers.js";

test("identifier splitting and Chinese query expansion", () => {
  assert.deepEqual(tokens("HTTPClient cancelGeneration"), [
    "http",
    "client",
    "cancel",
    "generation",
  ]);
  assert(queryTokens("取消生成按钮转圈").includes("cancel"));
  assert(queryTokens("取消生成按钮转圈").includes("spinner"));
  assert.notEqual(hashContent("a"), hashContent("b"));
  assert.throws(() => safeScope("../outside"));
  assert.throws(() => safeScope("C:\\outside"));
  assert.equal(safeScope("./src\\auth/"), "src/auth");
});
test("a single Chinese query finds the feature, not unrelated utilities", async () => {
  const f = await fixture(featureFiles);
  try {
    const result = await f.engine.locate({ query: "取消生成后按钮一直转圈", limit: 6 });
    assert(result.results.length >= 3 && result.results.length <= 6);
    assert(result.results.some((s) => s.name === "cancelGeneration"));
    assert(result.results.some((s) => s.name === "renderGenerateButton"));
    assert(!result.results.some((s) => s.name === "calculateInvoiceTax"));
    assert(
      result.relations.some((edge) => edge.kind === "calls" && edge.evidence === "type-resolved"),
    );
    const revision = result.revision;
    assert.equal((await f.engine.locate({ query: "cancelGeneration" })).revision, revision);
    const inspect = await f.engine.inspect({
      id: result.results.find((s) => s.name === "cancelGeneration")?.id ?? "",
    });
    assert(inspect.source.includes("resetGeneration()"));
    assert(inspect.neighbors.some((s) => s.name === "resetGeneration"));
  } finally {
    await f.cleanup();
  }
});
test("hash reconciliation handles changed contents, current lines, deletion and rename", async () => {
  const f = await fixture(featureFiles);
  try {
    const first = await f.engine.locate({ query: "cancelGeneration" });
    const original = first.results.find((s) => s.name === "cancelGeneration");
    assert(original);
    await f.write("generation.ts", `\n\n${featureFiles["generation.ts"]}`);
    const moved = await f.engine.locate({ query: "cancelGeneration" });
    assert(moved.revision > first.revision);
    assert.equal(moved.results.find((s) => s.id === original.id)?.lines[0], 3);
    await f.write("generation.ts", "export function haltStream() { return 'halt'; }");
    await assert.rejects(f.engine.inspect({ id: original.id }), /Symbol not found/);
    await rm(join(f.root, "generation.ts"));
    const after = await f.engine.locate({ query: "haltStream" });
    assert(!after.results.some((s) => s.path === "generation.ts"));
    assert.equal(f.engine.status().deletedFiles, 1);
    await f.write("renamed.ts", "export function haltStream() { return 'halt'; }");
    assert(
      (await f.engine.locate({ query: "haltStream" })).results.some((s) => s.path === "renamed.ts"),
    );
  } finally {
    await f.cleanup();
  }
});
test("scope, ignored files, declaration files and SQL metacharacters stay bounded", async () => {
  const f = await fixture({
    ".gitignore": "ignored/\n",
    ".graphignore": "private.ts\n",
    "src/safe.ts": "export function lookupToken() { return 'lookup'; }",
    "src/nested/.gitignore": "hidden.ts\n",
    "src/nested/hidden.ts": "export function lookupHidden() {}",
    "ignored/leak.ts": "export function lookupSecret() {}",
    "private.ts": "export function lookupPrivate() {}",
    "node_modules/lib.ts": "export function lookupVendor() {}",
    "types.d.ts": "declare function lookupDeclaration(): void;",
    "outside.ts": "export function lookupOutside() {}",
  });
  try {
    const result = await f.engine.locate({ query: "lookup", scope: "src" });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.name, "lookupToken");
    assert.equal(
      (await f.engine.locate({ query: '" OR * ; DROP TABLE symbols; --' })).results.length,
      0,
    );
    await assert.rejects(f.engine.locate({ query: "lookup", scope: "../" }), /relative/);
    await assert.rejects(f.engine.locate({ query: "lookup", limit: 11 }), /limit/);
    assert.equal((await f.engine.locate({ query: "qzxvbnUnrelated" })).results.length, 0);
  } finally {
    await f.cleanup();
  }
});
test("re-exported aliases and class methods resolve to declarations", async () => {
  const f = await fixture({
    "service.ts":
      "export class SessionService { resetLoading() { return false; } } export function clearLoading() { return false; }",
    "index.ts": "export { clearLoading as resetBusy } from './service.js';",
    "entry.ts":
      "import { resetBusy } from './index.js'; import { SessionService } from './service.js'; export function cancelJob() { resetBusy(); new SessionService().resetLoading(); }",
  });
  try {
    const result = await f.engine.locate({ query: "cancelJob resetLoading", limit: 10 });
    assert(result.results.some((s) => s.name === "SessionService.resetLoading"));
    const inspect = await f.engine.inspect({
      id: result.results.find((s) => s.name === "cancelJob")?.id ?? "",
      neighbors: 10,
    });
    assert(inspect.neighbors.some((s) => s.name === "clearLoading"));
    assert(inspect.neighbors.some((s) => s.name === "SessionService.resetLoading"));
  } finally {
    await f.cleanup();
  }
});
test("persisted index survives reopening and rebuild advances snapshot", async () => {
  const f = await fixture(featureFiles);
  try {
    const before = await f.engine.refresh();
    const after = await f.engine.refresh(true);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.symbols, before.symbols);
  } finally {
    await f.cleanup();
  }
});
test("worker client serves concurrent requests and cancellation", async () => {
  const f = await fixture(featureFiles);
  const client = new GraphClient(f.root);
  try {
    const [a, b] = await Promise.all([
      client.locate({ query: "cancel generation" }),
      client.locate({ query: "render button" }),
    ]);
    assert(a.results.length > 0 && b.results.length > 0);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(client.locate({ query: "cancel" }, controller.signal), /aborted/);
    assert.equal((await client.status()).files, 4);
  } finally {
    await client.close();
    await f.cleanup();
  }
  await assert.rejects(client.status(), /closed/);
});
