import assert from "node:assert/strict";
import { chmod, rename, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { scanSources } from "../src/core/files.js";
import { fixture } from "./helpers.js";

test("bounded scans keep source contents coherent and reapply ignore changes", async () => {
  const expected = Object.fromEntries(
    Array.from({ length: 25 }, (_, i) => [`src/file${i}.ts`, `export const item${i} = ${i};`]),
  );
  const f = await fixture({
    ...expected,
    ".graphignore": "hidden.ts\n",
    "src/hidden.ts": "export const hidden = true;",
    "src/large.ts": " ".repeat(2_000_001),
  });
  try {
    const first = await scanSources(f.root);
    assert.deepEqual(
      Object.fromEntries(first.files.map((file) => [file.path, file.content])),
      expected,
    );
    assert(first.warnings.some((warning) => warning.startsWith("src/large.ts:")));
    await f.write("src/file12.ts", "export const item12 = 99;");
    await f.write(".graphignore", "file0.ts\nlarge.ts\n");
    const second = await scanSources(f.root);
    const byPath = new Map(second.files.map((file) => [file.path, file]));
    assert(!byPath.has("src/file0.ts"));
    assert.equal(byPath.get("src/hidden.ts")?.content, "export const hidden = true;");
    assert.equal(byPath.get("src/file12.ts")?.content, "export const item12 = 99;");
    assert.notEqual(
      byPath.get("src/file12.ts")?.hash,
      first.files.find((file) => file.path === "src/file12.ts")?.hash,
    );
    assert.equal(
      byPath.get("src/file24.ts")?.hash,
      first.files.find((file) => file.path === "src/file24.ts")?.hash,
    );
  } finally {
    await f.cleanup();
  }
});

test("queries without a watcher detect same-size same-mtime edits and branch-like replacements", async () => {
  const f = await fixture({ "feature.rs": "pub fn before() {}\n" });
  try {
    const first = await f.engine.locate({ query: "before" });
    const old = first.results.find((symbol) => symbol.path === "feature.rs");
    assert(old);
    assert.equal((await f.engine.refresh()).revision, first.revision);
    const path = join(f.root, "feature.rs");
    const metadata = await stat(path);
    await f.write("feature.rs", "pub fn afterx() {}\n");
    await utimes(path, metadata.atime, metadata.mtime);
    const edited = await f.engine.locate({ query: "afterx" });
    assert(edited.revision > first.revision);
    assert.equal(edited.results[0]?.path, "feature.rs");
    await assert.rejects(f.engine.inspect({ id: old.id }), /Symbol not found/);
    await rename(path, join(f.root, "renamed.rs"));
    const renamed = await f.engine.locate({ query: "afterx" });
    assert.equal(renamed.results[0]?.path, "renamed.rs");
    assert.equal(f.engine.status().files, 1);
    await f.write(".graphignore", "renamed.rs\n");
    assert.equal((await f.engine.locate({ query: "afterx" })).results.length, 0);
    assert.equal(f.engine.status().files, 0);
    await rm(join(f.root, "renamed.rs"));
    await f.write("feature.rs", "pub fn before() {}\n");
    const restored = await f.engine.locate({ query: "before" });
    assert.equal(restored.results[0]?.id, old.id);
    const current = await f.engine.inspect({ id: old.id });
    await f.engine.refresh(true);
    const rebuilt = await f.engine.inspect({ id: old.id });
    assert.deepEqual({ ...current, revision: 0 }, { ...rebuilt, revision: 0 });
  } finally {
    await f.cleanup();
  }
});

test("queued refreshes and queries publish complete matching source snapshots", async () => {
  const f = await fixture({ "lib.rs": "pub fn current_value() -> i32 { 1 }" });
  try {
    const first = await f.engine.locate({ query: "current_value" });
    const id = first.results[0]?.id;
    assert(id);
    await f.write("lib.rs", "pub fn current_value() -> i32 { 2 }");
    const [background, located, inspected, rebuilt] = await Promise.all([
      f.engine.refresh(true),
      f.engine.locate({ query: "current_value" }),
      f.engine.inspect({ id }),
      f.engine.refresh(true),
    ]);
    assert.equal(located.results[0]?.id, id);
    assert.equal(located.revision, background.revision);
    assert.equal(inspected.revision, background.revision);
    assert(inspected.source.includes("{ 2 }"));
    assert.equal(rebuilt.revision, background.revision + 1);
  } finally {
    await f.cleanup();
  }
});

test("failed parallel reads preserve the persisted snapshot and allow later queued queries to recover", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async () => {
  const f = await fixture({
    "first.rs": "pub fn first() {}",
    "last.rs": "pub fn last() {}",
  });
  const path = join(f.root, "last.rs");
  try {
    const before = await f.engine.refresh();
    await f.write("new.rs", "pub fn recovered() {}");
    await chmod(path, 0);
    const failed = await Promise.allSettled([
      f.engine.refresh(),
      f.engine.locate({ query: "recovered" }),
    ]);
    for (const result of failed) {
      assert.equal(result.status, "rejected");
      if (result.status === "rejected") assert.equal(result.reason.code, "EACCES");
    }
    assert.equal(f.engine.status().revision, before.revision);
    assert.equal(f.engine.status().files, before.files);
    await chmod(path, 0o600);
    const recovered = await f.engine.locate({ query: "recovered" });
    assert.equal(recovered.results[0]?.path, "new.rs");
    assert(recovered.revision > before.revision);
    assert.equal(f.engine.status().files, 3);
  } finally {
    await chmod(path, 0o600);
    await f.cleanup();
  }
});
