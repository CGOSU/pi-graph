import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./helpers.js";

test("changes to extended tsconfig invalidate resolved relationships", async () => {
  const base = (target: string) =>
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@feature": [target] } } });
  const f = await fixture({
    "tsconfig.json": JSON.stringify({ extends: "./base.json" }),
    "base.json": base("first.ts"),
    "first.ts": "export function implementation() { return 'first'; }",
    "second.ts": "export function implementation() { return 'second'; }",
    "entry.ts":
      "import { implementation } from '@feature'; export function entryFeature() { return implementation(); }",
  });
  try {
    const result = await f.engine.locate({ query: "entryFeature" });
    const id = result.results.find((s) => s.name === "entryFeature")?.id ?? "";
    assert((await f.engine.inspect({ id })).neighbors.some((s) => s.path === "first.ts"));
    await f.write("base.json", base("second.ts"));
    const updated = await f.engine.inspect({ id });
    assert(updated.neighbors.some((s) => s.path === "second.ts"));
    assert(!updated.neighbors.some((s) => s.path === "first.ts"));
    assert(updated.revision > result.revision);
  } finally {
    await f.cleanup();
  }
});
