import assert from "node:assert/strict";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { GraphClient } from "../src/core/client.js";
import { relevantSourceChange, scanSources } from "../src/core/files.js";
import { GraphStore } from "../src/core/store.js";
import { languageConfiguration } from "../src/languages/typescript.js";
import { fixture } from "./helpers.js";

const syntaxSamples = [
  {
    language: "Dart",
    path: "lib/counter.dart",
    method: "reset",
    helper: "clear",
    type: "class",
    source: `// 中文🌏\r\nclass Counter {\r\n  int value = 0;\r\n  void reset() { clear(); this.clean(); }\r\n  void clean() {}\r\n}\r\nvoid clear() {}\r\nvoid shadow(void Function() clear) { clear(); }\r\nvoid local() { final clear = () {}; clear(); }\r\nvoid unknown(dynamic other) { other.clear(); }\r\n`,
  },
  {
    language: "Go",
    path: "core/counter.go",
    method: "Reset",
    helper: "Clear",
    type: "struct",
    source: `// 中文🌏\r\npackage core\r\ntype Counter struct { Value int }\r\nfunc (c *Counter) Reset() { Clear(); c.Clean() }\r\nfunc (c *Counter) Clean() {}\r\nfunc Clear() {}\r\nfunc shadow(Clear func()) { Clear() }\r\nfunc local() { Clear := func() {}; Clear() }\r\nfunc unknown(other any) { other.Clear() }\r\n`,
  },
  {
    language: "Kotlin",
    path: "android/Counter.kt",
    method: "reset",
    helper: "clear",
    type: "class",
    source: `// 中文🌏\r\npackage app\r\nclass Counter {\r\n  val value = 0\r\n  fun reset() { clear(); this.clean() }\r\n  fun clean() {}\r\n}\r\nfun clear() {}\r\nfun shadow(clear: () -> Unit) { clear() }\r\nfun local() { val clear = {}; clear() }\r\nfun unknown(other: Any) { other.clear() }\r\n`,
  },
] as const;

for (const sample of syntaxSamples) {
  test(`${sample.language} symbols, source ranges, containment and conservative calls`, async () => {
    const f = await fixture({ [sample.path]: sample.source });
    try {
      const located = await f.engine.locate({ query: sample.method });
      const method = located.results.find((item) => item.name === `Counter.${sample.method}`);
      assert(method, `${sample.language} methods must be indexed`);
      const detail = await f.engine.inspect({ id: method.id, neighbors: 10 });
      assert.equal(detail.symbol.kind, "method");
      assert(detail.source.includes(`${sample.method}()`));
      assert(!detail.source.includes(sample.language === "Go" ? "func Clear" : "void clear"));
      assert.equal(detail.source, sample.source.slice(detail.symbol.start, detail.symbol.end));
      const calls = detail.relations.filter(
        (edge) => edge.kind === "calls" && edge.source === method.id,
      );
      assert.equal(calls.length, 2);
      assert(calls.every((edge) => edge.evidence === "syntax"));
      assert(
        calls.some((edge) =>
          detail.neighbors.some(
            (neighbor) => neighbor.id === edge.target && neighbor.name === sample.helper,
          ),
        ),
      );
      const type = (await f.engine.locate({ query: "Counter" })).results.find(
        (item) => item.name === "Counter",
      );
      assert(type);
      const container = await f.engine.inspect({ id: type.id, neighbors: 10 });
      assert.equal(container.symbol.kind, sample.type);
      assert(
        container.relations.some((edge) => edge.kind === "contains" && edge.target === method.id),
      );
      for (const name of ["shadow", "local", "unknown"]) {
        const symbol = (await f.engine.locate({ query: name })).results.find(
          (item) => item.name === name,
        );
        assert(symbol);
        const inspected = await f.engine.inspect({ id: symbol.id, neighbors: 10 });
        assert(
          !inspected.relations.some((edge) => edge.kind === "calls" && edge.source === symbol.id),
          name,
        );
      }
      assert.deepEqual(f.engine.status().warnings, []);
    } finally {
      await f.cleanup();
    }
  });
}

test("new language files participate in mixed worker queries, scopes, changes and deletion", async () => {
  const f = await fixture({
    ...Object.fromEntries(syntaxSamples.map((sample) => [sample.path, sample.source])),
    "ui.ts": "export function oldTypeScript() {}",
    "task.kts": "fun scriptTask() {}\n",
    "ignored.dart": "void neverIndexed() {}",
    ".graphignore": "ignored.dart\n",
  });
  const client = new GraphClient(f.root);
  try {
    for (const sample of syntaxSamples) {
      assert(relevantSourceChange(f.root, sample.path));
      const found = await client.locate({ query: sample.method, scope: sample.path });
      const symbol = found.results.find((item) => item.name === `Counter.${sample.method}`);
      assert(symbol);
      assert.equal((await client.inspect({ id: symbol.id })).symbol.path, sample.path);
    }
    assert(
      (await client.locate({ query: "scriptTask" })).results.some(
        (item) => item.name === "scriptTask",
      ),
    );
    assert(
      (await client.locate({ query: "oldTypeScript" })).results.some(
        (item) => item.name === "oldTypeScript",
      ),
    );
    assert.equal((await client.locate({ query: "neverIndexed" })).results.length, 0);
    await f.write("lib/counter.dart", "void changedDart() {}\n");
    assert(
      (await client.locate({ query: "changedDart" })).results.some(
        (item) => item.name === "changedDart",
      ),
    );
    await rename(join(f.root, "core/counter.go"), join(f.root, "core/renamed.go"));
    assert(
      (await client.locate({ query: "Reset", scope: "core/renamed.go" })).results.some(
        (item) => item.name === "Counter.Reset",
      ),
    );
    await rm(join(f.root, "android/Counter.kt"));
    assert.equal(
      (await client.locate({ query: "reset", scope: "android/Counter.kt" })).results.length,
      0,
    );
  } finally {
    await client.close();
    await f.cleanup();
  }
});

test("old configuration rebuilds new-language symbols even when file hashes match", async () => {
  const f = await fixture({ "main.dart": "void migratedDart() {}\n" });
  try {
    const scan = await scanSources(f.root);
    const legacy = new GraphStore(join(f.root, ".pi-graph", "index.sqlite"));
    try {
      legacy.commit(
        scan.files,
        [],
        [],
        `frameworks-v2:rust-wasm-v1:${languageConfiguration(f.root).hash}`,
      );
    } finally {
      legacy.close();
    }
    const before = f.engine.status();
    const located = await f.engine.locate({ query: "migratedDart" });
    assert(located.results.some((item) => item.name === "migratedDart"));
    assert.equal(located.revision, before.revision + 1);
    assert.equal(f.engine.status().changedFiles, 0);
    assert.equal((await f.engine.refresh()).revision, located.revision);
  } finally {
    await f.cleanup();
  }
});
