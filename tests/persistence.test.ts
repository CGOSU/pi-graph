import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { GraphEngine } from "../src/core/engine.js";
import { scanSources } from "../src/core/files.js";
import { GraphStore } from "../src/core/store.js";
import { RustGraph } from "../src/languages/rust.js";
import { languageConfiguration } from "../src/languages/typescript.js";
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

test("refresh rebuilds a persisted Rust v1 index after Rust parser configuration changes", async () => {
  const f = await fixture({
    "src/lib.rs": "mod caller; mod target;",
    "src/caller.rs": "use crate::target::work; pub fn invoke() { work(); }",
    "src/target.rs": "pub fn work() {}",
  });
  try {
    const files = await scanSources(f.root);
    const rust = new RustGraph().build(files.files.filter((file) => /\.rs$/i.test(file.path)));
    const invoke = rust.symbols.find((symbol) => symbol.name === "invoke");
    assert(invoke);

    const legacy = new GraphStore(join(f.root, ".pi-graph", "index.sqlite"));
    try {
      legacy.commit(
        files.files,
        rust.symbols,
        rust.edges.filter((edge) => edge.source !== invoke.id || edge.kind !== "calls"),
        `frameworks-v2:rust-v1:${languageConfiguration(f.root).hash}`,
      );
    } finally {
      legacy.close();
    }

    const before = f.engine.status();
    const rebuilt = await f.engine.refresh();
    assert.equal(rebuilt.changedFiles, 0);
    assert.equal(rebuilt.deletedFiles, 0);
    assert.equal(rebuilt.revision, before.revision + 1);

    const located = await f.engine.locate({ query: "invoke" });
    const caller = located.results.find((symbol) => symbol.name.endsWith("::invoke"));
    assert(caller);
    const detail = await f.engine.inspect({ id: caller.id, neighbors: 10 });
    const call = detail.relations.find(
      (edge) => edge.source === caller.id && edge.kind === "calls",
    );
    assert(call);
    assert.equal(call.evidence, "syntax");
    assert.equal(
      detail.neighbors.find((symbol) => symbol.id === call.target)?.name,
      "target::work",
    );

    const stableRevision = rebuilt.revision;
    const reused = await f.engine.refresh();
    assert.equal(reused.revision, stableRevision);
  } finally {
    await f.cleanup();
  }
});
