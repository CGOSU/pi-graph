import assert from "node:assert/strict";
import test from "node:test";
import { GraphEngine } from "../src/core/engine.js";
import { featureFiles, fixture } from "./helpers.js";

test("reopening a persisted snapshot keeps revision and current symbol content", async () => {
  const f = await fixture(featureFiles);
  let reopened: GraphEngine | undefined;
  try {
    const first = await f.engine.locate({ query: "cancelGeneration" });
    reopened = new GraphEngine(f.root);
    const second = await reopened.locate({ query: "cancelGeneration" });
    assert.equal(second.revision, first.revision);
    assert.deepEqual(second.results, first.results);
    const inspected = await reopened.inspect({ id: first.results[0]?.id ?? "" });
    assert(inspected.source.length > 0);
  } finally {
    reopened?.close();
    await f.cleanup();
  }
});
