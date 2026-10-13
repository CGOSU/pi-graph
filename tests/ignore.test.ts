import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./helpers.js";

test("nested ignore negation overrides parent file patterns", async () => {
  const f = await fixture({
    ".gitignore": "*.ts\n",
    "src/.gitignore": "!keep.ts\n",
    "src/keep.ts": "export function keepFeature() {}",
    "src/hidden.ts": "export function hiddenFeature() {}",
  });
  try {
    const result = await f.engine.locate({ query: "keepFeature" });
    assert.equal(result.results[0]?.name, "keepFeature");
    assert.equal(f.engine.status().files, 1);
  } finally {
    await f.cleanup();
  }
});
