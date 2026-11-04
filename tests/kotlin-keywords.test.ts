import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { GraphEngine } from "../src/core/engine.js";
import { languageConfiguration } from "../src/languages/typescript.js";
import { fixture } from "./helpers.js";

const source = `open class Resource : AutoCloseable {
  var open = true
  override fun close() {
    open = false
    record()
  }
  private fun record() {}
  open fun reopen() {
    open = true
  }
}
class SessionTest {
  fun stopDuringStart() {
    val resource = Resource()
    resource.close()
  }
}
fun afterResource() { completion() }
fun completion() {}
`;

test("Kotlin open identifiers do not corrupt classes, later declarations or call edges", async () => {
  const f = await fixture({ "SessionTest.kt": source });
  try {
    const result = await f.engine.locate({ query: "Resource", limit: 10 });
    assert.deepEqual(result.warnings, []);
    const resource = result.results.find((item) => item.name === "Resource");
    assert(resource);
    const detail = await f.engine.inspect({ id: resource.id });
    assert.equal(detail.symbol.kind, "class");
    const property = (await f.engine.locate({ query: "Resource.open" })).results.find(
      (item) => item.name === "Resource.open",
    );
    assert(property);
    assert.equal((await f.engine.inspect({ id: property.id })).source, "var open = true");
    for (const [caller, callee] of [
      ["Resource.close", "Resource.record"],
      ["afterResource", "completion"],
    ] as const) {
      const found = (await f.engine.locate({ query: caller })).results.find(
        (item) => item.name === caller,
      );
      assert(found, caller);
      const inspected = await f.engine.inspect({ id: found.id, neighbors: 10 });
      assert(
        inspected.relations.some(
          (edge) =>
            edge.kind === "calls" &&
            edge.source === found.id &&
            edge.target.includes(`#${callee}:`),
        ),
        `${caller} must call ${callee}`,
      );
    }
    for (const name of ["Resource.reopen", "SessionTest.stopDuringStart"]) {
      assert((await f.engine.locate({ query: name })).results.some((item) => item.name === name));
    }
  } finally {
    await f.cleanup();
  }
});

test("the Kotlin grammar fix rebuilds unchanged snapshots from the old grammar revision", async () => {
  const f = await fixture({ "SessionTest.kt": source });
  let reopened: GraphEngine | undefined;
  try {
    const initial = await f.engine.refresh();
    const db = new DatabaseSync(join(f.root, ".pi-graph", "index.sqlite"));
    try {
      db.prepare("UPDATE metadata SET value=? WHERE key='configHash'").run(
        `syntax-v1:frameworks-v2:rust-wasm-v1:${languageConfiguration(f.root).hash}`,
      );
      db.prepare("UPDATE metadata SET value=? WHERE key='warnings'").run(
        JSON.stringify(["SessionTest.kt: kotlin parse errors; index may be incomplete"]),
      );
      db.exec(
        "UPDATE symbols SET data=json_set(data,'$.kind','enum') WHERE json_extract(data,'$.name')='Resource'",
      );
    } finally {
      db.close();
    }
    reopened = new GraphEngine(f.root);
    const after = await reopened.refresh();
    assert.equal(after.changedFiles, 0);
    assert.equal(after.revision, initial.revision + 1);
    assert.deepEqual(after.warnings, []);
    const resource = (await reopened.locate({ query: "Resource" })).results.find(
      (item) => item.name === "Resource",
    );
    assert(resource);
    assert.equal((await reopened.inspect({ id: resource.id })).symbol.kind, "class");
    assert.equal((await reopened.refresh()).revision, after.revision);
  } finally {
    reopened?.close();
    await f.cleanup();
  }
});
