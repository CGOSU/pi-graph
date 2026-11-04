import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

test("reopening an unchanged index restores its revision's coverage warnings", async () => {
  const f = await fixture({
    "Panel.vue":
      '<template lang="pug">div hello</template>\n<script setup>const label = "hi";</script>',
    "large.rs": " ".repeat(2_000_001),
  });
  let reopened: GraphEngine | undefined;
  try {
    const before = await f.engine.refresh();
    assert(before.warnings.some((warning) => warning.includes("preprocessed template")));
    assert(before.warnings.some((warning) => warning.includes("2 MB")));
    reopened = new GraphEngine(f.root);
    const after = await reopened.refresh();
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.warnings, before.warnings);
    assert.deepEqual((await reopened.locate({ query: "label" })).warnings, before.warnings);
  } finally {
    reopened?.close();
    await f.cleanup();
  }
});

test("warning-only source changes publish a new revision and cleared warnings persist", async () => {
  const f = await fixture({ "lib.rs": "pub fn value() {}" });
  let reopened: GraphEngine | undefined;
  try {
    const initial = await f.engine.refresh();
    await f.write("large.rs", " ".repeat(2_000_001));
    const added = await f.engine.refresh();
    assert.equal(added.changedFiles, 0);
    assert.equal(added.revision, initial.revision + 1);
    assert(added.warnings.some((warning) => warning.includes("2 MB")));
    await rm(join(f.root, "large.rs"));
    const removed = await f.engine.refresh();
    assert.equal(removed.revision, added.revision + 1);
    assert.deepEqual(removed.warnings, []);
    reopened = new GraphEngine(f.root);
    assert.deepEqual((await reopened.refresh()).warnings, []);
    assert.equal(reopened.status().revision, removed.revision);
  } finally {
    reopened?.close();
    await f.cleanup();
  }
});

test("legacy warning metadata is rebuilt once and failed commits retain the old warnings", async () => {
  const f = await fixture({ "Panel.vue": '<template lang="pug">div hello</template>' });
  try {
    const initial = await f.engine.refresh();
    const path = join(f.root, ".pi-graph", "index.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec("DELETE FROM metadata WHERE key IN ('warnings','scanWarnings')");
    legacy.close();
    const repaired = await f.engine.refresh();
    assert.equal(repaired.revision, initial.revision + 1);
    assert.deepEqual(repaired.warnings, initial.warnings);
    assert.equal((await f.engine.refresh()).revision, repaired.revision);
    const store = new GraphStore(path);
    try {
      const files = store.files();
      assert.throws(() => store.commit([...files, ...files], [], [], "invalid", ["wrong warning"]));
      assert.equal(Number(store.metadata("revision")), repaired.revision);
      assert.deepEqual(store.warnings(), repaired.warnings);
    } finally {
      store.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("refresh rebuilds a persisted native Rust index after migrating to WASM", async () => {
  const f = await fixture({
    "src/lib.rs": "mod caller; mod target;",
    "src/caller.rs": "use crate::target::work; pub fn invoke() { work(); }",
    "src/target.rs": "pub fn work() {}",
  });
  try {
    const files = await scanSources(f.root);
    const parser = new RustGraph();
    const rust = await parser.build(files.files.filter((file) => /\.rs$/i.test(file.path)));
    parser.close();
    const invoke = rust.symbols.find((symbol) => symbol.name === "invoke");
    assert(invoke);

    const legacy = new GraphStore(join(f.root, ".pi-graph", "index.sqlite"));
    try {
      legacy.commit(
        files.files,
        rust.symbols,
        rust.edges.filter((edge) => edge.source !== invoke.id || edge.kind !== "calls"),
        `frameworks-v2:rust-v2:${languageConfiguration(f.root).hash}`,
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
