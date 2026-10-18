import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { GraphClient } from "../src/core/client.js";
import { fixture } from "./helpers.js";

const rustSource = `// 中文😀 ensures source offsets use UTF-16, not bytes.
/// Tracks generation loading state.
pub struct GenerationState { pub loading: bool }
pub trait Reset { fn reset(&mut self); }
impl GenerationState {
    pub fn cancel_generation(&mut self) { self.reset(); clear_loading(); }
    fn reset(&mut self) { self.loading = false; }
}
/// Clear the loading spinner after cancellation.
pub fn clear_loading() {}
pub enum GenerationMode { Idle, Busy(u8) }
pub type GenerationId = u64;
pub const GENERATION_LIMIT: usize = 4;
pub static GENERATION_ACTIVE: bool = false;
mod nested { pub fn clear_loading() {} pub fn stop() { clear_loading(); } }
macro_rules! cancel_log { () => {} }
`;

test("Rust symbols, syntax calls, containment and Unicode source survive locate/inspect", async () => {
  const f = await fixture({ "src/lib.rs": rustSource });
  try {
    const result = await f.engine.locate({ query: "cancel_generation", limit: 10 });
    const cancel = result.results.find((s) => s.name === "GenerationState::cancel_generation");
    assert(cancel, "Rust methods must be indexed");
    const detail = await f.engine.inspect({ id: cancel.id, neighbors: 10 });
    assert.equal(
      detail.source,
      "pub fn cancel_generation(&mut self) { self.reset(); clear_loading(); }",
    );
    assert.equal(detail.symbol.kind, "method");
    assert.equal(detail.symbol.startLine, 6);
    assert(detail.symbol.exported);
    assert(detail.neighbors.some((s) => s.name === "GenerationState::reset"));
    assert(detail.neighbors.some((s) => s.name === "clear_loading"));
    assert(!detail.neighbors.some((s) => s.name === "nested::clear_loading"));
    assert(
      detail.relations.filter((e) => e.kind === "calls").every((e) => e.evidence === "syntax"),
    );
    for (const [query, name, kind] of [
      ["GenerationState", "GenerationState", "struct"],
      ["Reset", "Reset", "trait"],
      ["GenerationMode", "GenerationMode", "enum"],
      ["Idle", "GenerationMode::Idle", "variant"],
      ["GenerationId", "GenerationId", "type"],
      ["GENERATION_LIMIT", "GENERATION_LIMIT", "variable"],
      ["GENERATION_ACTIVE", "GENERATION_ACTIVE", "variable"],
      ["cancel_log", "cancel_log", "macro"],
    ]) {
      const match = (await f.engine.locate({ query: query ?? "", limit: 10 })).results.find(
        (s) => s.name === name,
      );
      assert.equal(match?.kind, kind, name);
    }
    const state = (await f.engine.locate({ query: "GenerationState" })).results.find(
      (s) => s.name === "GenerationState",
    );
    assert(state);
    assert((await f.engine.inspect({ id: state.id })).relations.some((e) => e.kind === "contains"));
    assert.equal((await f.engine.locate({ query: "cancel_generation" })).revision, result.revision);
    assert.equal(f.engine.status().warnings.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("Rust integrates with JS/TS, scope, ignores, refresh, rename and deletion", async () => {
  const f = await fixture({
    "src/lib.rs": "pub fn cancel_rust() {}",
    "src/ui.ts": "export function cancelTypeScript() {}",
    "target/generated.rs": "pub fn cancel_generated() {}",
    ".graphignore": "private.rs\n",
    "private.rs": "pub fn cancel_private() {}",
  });
  try {
    const first = await f.engine.locate({ query: "cancel", limit: 10 });
    assert(first.results.some((s) => s.name === "cancel_rust"));
    assert(first.results.some((s) => s.name === "cancelTypeScript"));
    assert.equal(f.engine.status().files, 2);
    const id = first.results.find((s) => s.name === "cancel_rust")?.id ?? "";
    await f.write("src/lib.rs", "\n\npub fn cancel_rust() {}");
    assert.equal((await f.engine.inspect({ id })).symbol.startLine, 3);
    assert.equal(
      (await f.engine.locate({ query: "cancel", scope: "src/lib.rs" })).results.length,
      1,
    );
    await rm(join(f.root, "src/lib.rs"));
    await f.write("src/renamed.rs", "pub fn cancel_renamed() {}");
    await assert.rejects(f.engine.inspect({ id }), /Symbol not found/);
    assert(
      (await f.engine.locate({ query: "cancel_renamed" })).results.some(
        (s) => s.path === "src/renamed.rs",
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test("Rust syntax errors warn without hiding valid symbols or indexing comment/string functions", async () => {
  const f = await fixture({
    "lib.rs":
      'pub fn healthy() { let text = "fn fake() {}"; } // fn phantom() {}\npub fn broken( {',
  });
  try {
    const result = await f.engine.locate({ query: "healthy" });
    assert(result.results.some((s) => s.name === "healthy"));
    assert(result.warnings.some((w) => w.includes("lib.rs") && w.includes("syntax")));
    assert.equal(
      (await f.engine.locate({ query: "phantom fake" })).results.filter(
        (s) => s.name === "fake" || s.name === "phantom",
      ).length,
      0,
    );
  } finally {
    await f.cleanup();
  }
});

test("Rust worker loads the parser and returns source", async () => {
  const f = await fixture({ "lib.rs": "pub fn worker_cancel() {}" });
  const client = new GraphClient(f.root);
  try {
    const result = await client.locate({ query: "worker_cancel" });
    assert(result.results[0]);
    assert.equal(
      (await client.inspect({ id: result.results[0].id })).source,
      "pub fn worker_cancel() {}",
    );
  } finally {
    await client.close();
    await f.cleanup();
  }
});

test("Rust resolves only unambiguous local syntax calls, respecting modules and shadowing", async () => {
  const f = await fixture({
    "lib.rs": `fn finish() {}
struct Task;
impl Task { fn new() -> Self { Task } fn stop(&self) { Self::new(); self.finish(); } fn finish(&self) {} }
impl Drop for Task { fn drop(&mut self) {} }
mod inner { pub fn local() {} pub fn run() { local(); crate::finish(); super::finish(); self::local(); } pub fn isolated() { finish(); } }
fn entry() { inner::local(); Task::new(); }
fn shadow_parameter(finish: fn()) { finish(); }
fn shadow_local() { let finish = || {}; finish(); }
fn arbitrary_receiver(task: Task) { task.finish(); }
fn generic() { finish::<u8>(); }
`,
  });
  try {
    async function calls(name: string) {
      const symbol = (await f.engine.locate({ query: name, limit: 10 })).results.find(
        (s) => s.name === name,
      );
      assert(symbol, name);
      const detail = await f.engine.inspect({ id: symbol.id, neighbors: 10 });
      return detail.relations
        .filter((e) => e.source === symbol.id && e.kind === "calls")
        .map((edge) => detail.neighbors.find((s) => s.id === edge.target)?.name)
        .sort();
    }
    assert.deepEqual(await calls("entry"), ["Task::new", "inner::local"]);
    assert.deepEqual(await calls("Task::stop"), ["Task::finish", "Task::new"]);
    assert.deepEqual(await calls("inner::run"), ["finish", "inner::local"]);
    for (const name of [
      "inner::isolated",
      "shadow_parameter",
      "shadow_local",
      "arbitrary_receiver",
    ])
      assert.deepEqual(await calls(name), [], name);
    assert.deepEqual(await calls("generic"), ["finish"]);
    const drop = (await f.engine.locate({ query: "drop", limit: 10 })).results.find(
      (s) => s.name === "Task as Drop::drop",
    );
    assert(drop);
  } finally {
    await f.cleanup();
  }
});
