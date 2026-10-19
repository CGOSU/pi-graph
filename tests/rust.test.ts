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

type RustFixture = Awaited<ReturnType<typeof fixture>>;
async function rustCalls(f: RustFixture, name: string): Promise<string[]> {
  const symbol = (await f.engine.locate({ query: name, limit: 10 })).results.find(
    (item) => item.name === name || item.name.endsWith(`::${name}`),
  );
  assert(symbol, name);
  const detail = await f.engine.inspect({ id: symbol.id, neighbors: 10 });
  return detail.relations
    .filter((edge) => edge.source === symbol.id && edge.kind === "calls")
    .map((edge) => detail.neighbors.find((neighbor) => neighbor.id === edge.target)?.name ?? "")
    .sort();
}

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
fn inferred_receiver() { let task = Task::new(); task.finish(); }
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
    ])
      assert.deepEqual(await calls(name), [], name);
    assert.deepEqual(await calls("arbitrary_receiver"), ["Task::finish"]);
    assert.deepEqual(await calls("inferred_receiver"), ["Task::new"]);
    assert.deepEqual(await calls("generic"), ["finish"]);
    const drop = (await f.engine.locate({ query: "drop", limit: 10 })).results.find(
      (s) => s.name === "Task as Drop::drop",
    );
    assert(drop);
  } finally {
    await f.cleanup();
  }
});

test("Rust resolves crate module files, nested uses, aliases and explicit paths", async () => {
  const f = await fixture({
    "src/lib.rs": `mod parent;
use crate::parent::{self, target as renamed, Widget as Alias};
use crate::parent::{nested::{self, run as nested_run}};
mod inline { pub fn inlined() { crate::parent::target(); super::parent::target(); } }
pub fn root_call() { renamed(); parent::target(); crate::parent::target(); Alias::new(); parent::nested::run(); nested_run(); nested::run(); }
`,
    "src/parent/mod.rs": `pub fn target() {}
pub struct Widget;
impl Widget { pub fn new() -> Self { Widget } pub fn run(&self) {} }
pub mod nested;
`,
    "src/parent/nested.rs": `use super::target as imported;
fn local() {}
pub fn run() { imported(); super::target(); crate::parent::target(); self::local(); }
`,
  });
  try {
    assert.deepEqual(await rustCalls(f, "root_call"), [
      "parent::Widget::new",
      "parent::nested::run",
      "parent::target",
    ]);
    assert.deepEqual(await rustCalls(f, "inline::inlined"), ["parent::target"]);
    assert.deepEqual(await rustCalls(f, "parent::nested::run"), [
      "parent::nested::local",
      "parent::target",
    ]);
    const root = (await f.engine.locate({ query: "root_call", limit: 10 })).results.find(
      (item) => item.name === "root_call",
    );
    assert(root);
    const detail = await f.engine.inspect({ id: root.id, neighbors: 10 });
    assert(
      detail.relations
        .filter((edge) => edge.source === root.id && edge.kind === "calls")
        .every((edge) => edge.evidence === "syntax"),
    );
  } finally {
    await f.cleanup();
  }
});

test("Rust resolves only explicit parameter and let types, respecting shadowing and generics", async () => {
  const f = await fixture({
    "src/lib.rs": `mod types;
use crate::types::{Widget as Alias, State};
fn parameter(widget: &Alias) { widget.run(); }
fn annotated_let() { let mut widget: crate::types::Widget = todo!(); widget.run(); }
fn enum_parameter(state: State) { state.reset(); }
fn shadowed(widget: Alias) { { let widget: u32 = 0; widget.run(); } }
fn unannotated_shadow(widget: Alias) { let widget = 0; widget.run(); }
fn closure_shadow(widget: Alias) { let run = |widget| widget.run(); }
fn match_shadow(widget: Alias, other: Option<Alias>) { match other { Some(widget) => widget.run(), _ => () } }
fn for_shadow(widget: Alias, values: Vec<Alias>) { for widget in values { widget.run(); } }
fn inferred() { let widget = Alias::new(); widget.run(); }
fn generic<Widget>(widget: Widget) { widget.run(); }
`,
    "src/types.rs": `pub struct Widget;
impl Widget { pub fn new() -> Self { Widget } pub fn run(&self) {} }
pub enum State { Ready }
impl State { pub fn reset(&self) {} }
`,
  });
  try {
    assert.deepEqual(await rustCalls(f, "parameter"), ["types::Widget::run"]);
    assert.deepEqual(await rustCalls(f, "annotated_let"), ["types::Widget::run"]);
    assert.deepEqual(await rustCalls(f, "enum_parameter"), ["types::State::reset"]);
    assert.deepEqual(await rustCalls(f, "shadowed"), []);
    assert.deepEqual(await rustCalls(f, "unannotated_shadow"), []);
    assert.deepEqual(await rustCalls(f, "closure_shadow"), [], "closure parameter shadows outer type");
    assert.deepEqual(await rustCalls(f, "match_shadow"), [], "match binding shadows outer type");
    assert.deepEqual(await rustCalls(f, "for_shadow"), [], "loop binding shadows outer type");
    assert.deepEqual(await rustCalls(f, "inferred"), ["types::Widget::new"]);
    assert.deepEqual(await rustCalls(f, "generic"), []);
  } finally {
    await f.cleanup();
  }
});

test("Rust leaves ambiguous, missing, glob and re-export targets unresolved", async () => {
  const f = await fixture({
    "src/lib.rs": `mod left;
mod right;
mod missing;
use crate::left::work as duplicate;
use crate::right::work as duplicate;
use crate::left::*;
pub use crate::right::forwarded as forwarded;
fn ambiguous() { duplicate(); work(); forwarded(); crate::missing::absent(); }
fn direct() { crate::left::work(); crate::right::work(); }
`,
    "src/left.rs": "pub fn work() {}",
    "src/right.rs": "pub fn work() {} pub fn forwarded() {}",
  });
  try {
    assert.deepEqual(await rustCalls(f, "ambiguous"), []);
    assert.deepEqual(await rustCalls(f, "direct"), ["left::work", "right::work"]);
  } finally {
    await f.cleanup();
  }
});

test("Rust does not link a module file shared by separate crate roots", async () => {
  const f = await fixture({
    "src/lib.rs": "mod shared; pub fn library_call() { shared::run(); }",
    "src/main.rs": "mod shared; pub fn binary_call() { shared::run(); }",
    "src/shared.rs": "pub fn run() {}",
  });
  try {
    assert.deepEqual(await rustCalls(f, "library_call"), []);
    assert.deepEqual(await rustCalls(f, "binary_call"), []);
  } finally {
    await f.cleanup();
  }
});

test("Rust rebuilds cross-file edges after imports, target edits, renames and deletion", async () => {
  const f = await fixture({
    "src/lib.rs": "mod caller; mod target;",
    "src/caller.rs": "use crate::target::work as call; pub fn invoke() { call(); }",
    "src/target.rs": "pub fn work() {}",
  });
  try {
    assert.deepEqual(await rustCalls(f, "invoke"), ["target::work"]);

    await f.write("src/target.rs", "pub fn updated() {}");
    assert.deepEqual(await rustCalls(f, "invoke"), []);

    await f.write(
      "src/caller.rs",
      "use crate::target::updated as call; pub fn invoke() { call(); }",
    );
    assert.deepEqual(await rustCalls(f, "invoke"), ["target::updated"]);

    await rm(join(f.root, "src/target.rs"));
    await f.write("src/renamed.rs", "pub fn renamed_work() {}");
    await f.write("src/lib.rs", "mod caller; mod renamed;");
    await f.write(
      "src/caller.rs",
      "use crate::renamed::renamed_work as call; pub fn invoke() { call(); }",
    );
    assert.deepEqual(await rustCalls(f, "invoke"), ["renamed::renamed_work"]);

    await rm(join(f.root, "src/renamed.rs"));
    assert.deepEqual(await rustCalls(f, "invoke"), []);
  } finally {
    await f.cleanup();
  }
});
