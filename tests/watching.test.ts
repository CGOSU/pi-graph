import assert from "node:assert/strict";
import { once } from "node:events";
import { rename, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { MessageChannel, Worker } from "node:worker_threads";
import type {
  GraphOperation,
  GraphStatus,
  LocateResult,
  WorkerResponse,
} from "../src/core/types.js";
import { fixture } from "./helpers.js";

// Real source I/O with a controllable watcher and debounce clock; only temporary indexes.
async function watchedWorker(root: string) {
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    const fs = require('node:fs');
    const promises = require('node:fs/promises');
    const { EventEmitter } = require('node:events');
    const { syncBuiltinESMExports } = require('node:module');
    const identities = new Map();
    let freezeIdentity = false;
    const lstat = fs.lstatSync;
    fs.lstatSync = function(path, ...args) {
      const key = String(path);
      if (freezeIdentity && key.endsWith('.rs') && identities.has(key)) return identities.get(key);
      const value = lstat.call(this, path, ...args);
      if (args[0]?.bigint && key.endsWith('.rs')) identities.set(key, value);
      return value;
    };
    let callback;
    const watcher = new EventEmitter();
    watcher.close = () => {};
    fs.watch = (_root, _options, listener) => { callback = listener; return watcher; };
    let reads = 0;
    const read = promises.readFile;
    promises.readFile = function(path, ...args) {
      if (String(path).endsWith('.rs')) reads++;
      return read.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    let clock = Date.now();
    Date.now = () => clock;
    const timers = new Map();
    const originalTimeout = global.setTimeout;
    const originalClear = global.clearTimeout;
    global.setTimeout = (fn, ms, ...args) => {
      if (ms !== 300) return originalTimeout(fn, ms, ...args);
      const key = {};
      timers.set(key, fn);
      return key;
    };
    global.clearTimeout = key => timers.delete(key) || originalClear(key);
    (async () => {
      await import(${JSON.stringify(new URL("../src/core/worker.js", import.meta.url).href)});
      workerData.control.on('message', message => {
        for (const action of message.actions ?? []) {
          if (action.event) callback(action.event, action.path);
          if (action.flush) { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); }
          if (action.error) watcher.emit('error', new Error('watcher unavailable'));
          if (action.advance) clock += action.advance;
          if (action.freeze !== undefined) freezeIdentity = action.freeze;
        }
        workerData.control.postMessage({ reads, timers: timers.size });
      });
      workerData.control.postMessage({ ready: true });
    })().catch(error => { throw error; });
  `,
    { eval: true, workerData: { root, control: port2 }, transferList: [port2] },
  );
  await once(port1, "message");
  let id = 0;
  return {
    async control(actions: Record<string, unknown>[] = []) {
      const reply = once(port1, "message");
      port1.postMessage({ actions });
      return (await reply)[0] as { reads: number; timers: number };
    },
    async request(operation: GraphOperation, input?: unknown) {
      const requestId = ++id;
      const reply = new Promise<WorkerResponse>((resolve, reject) => {
        const message = (response: WorkerResponse) => {
          if (response.id !== requestId) return;
          worker.off("message", message);
          worker.off("error", reject);
          resolve(response);
        };
        worker.on("message", message);
        worker.once("error", reject);
      });
      worker.postMessage({
        id: requestId,
        operation,
        input,
        cancellation: new SharedArrayBuffer(4),
      });
      const response = await reply;
      assert.equal(response.error, undefined);
      return response.result;
    },
    async close() {
      port1.close();
      await worker.terminate();
    },
  };
}

test("healthy watched queries reuse a snapshot and ignore scanner-excluded noise", async () => {
  const f = await fixture({ "src/lib.rs": "pub fn current_value() -> i32 { 1 }" });
  const worker = await watchedWorker(f.root);
  try {
    await worker.request("status");
    const initial = await worker.control();
    const located = (await worker.request("locate", { query: "current_value" })) as LocateResult;
    await worker.request("inspect", { id: located.results[0]?.id });
    assert.equal(
      (await worker.control()).reads,
      initial.reads,
      "unchanged queries must not reread every source",
    );
    const noise = [
      ".pi/diagnostics/runtime.jsonl",
      ".git/index.lock",
      "target/debug/new.rs",
      ".next/a.ts",
      ".cache/a.ts",
      "node_modules/a.ts",
      ".pi-graph/index.sqlite-wal",
      "README.md",
      "types.d.ts",
    ];
    const after = await worker.control(noise.map((path) => ({ event: "change", path })));
    assert.equal(after.timers, 0, "excluded and unsupported files must not schedule scans");
  } finally {
    await worker.close();
    await f.cleanup();
  }
});

test("watch bursts queue one reconciliation and queries see the new source", async () => {
  const f = await fixture({ "lib.rs": "pub fn before() {}" });
  const worker = await watchedWorker(f.root);
  try {
    await worker.request("status");
    const initial = await worker.control();
    await f.write("lib.rs", "pub fn afterx() {}");
    await worker.control([
      { event: "change", path: "lib.rs" },
      { flush: true },
      { event: "change", path: "lib.rs" },
      { flush: true },
      { event: "change", path: "lib.rs" },
      { flush: true },
    ]);
    const result = (await worker.request("locate", { query: "afterx" })) as LocateResult;
    assert.equal(result.results[0]?.name, "afterx");
    assert.equal((await worker.control()).reads - initial.reads, 1);
  } finally {
    await worker.close();
    await f.cleanup();
  }
});

test("watcher loss and periodic reconciliation detect missed same-size same-mtime changes", async () => {
  const f = await fixture({ "lib.rs": "pub fn before() {}" });
  const worker = await watchedWorker(f.root);
  try {
    await worker.request("status");
    const path = join(f.root, "lib.rs");
    const metadata = await stat(path);
    // Model a filesystem without changed identities, separately from normal stat detection.
    await worker.control([{ freeze: true }]);
    await f.write("lib.rs", "pub fn afterx() {}");
    await utimes(path, metadata.atime, metadata.mtime);
    await worker.control([{ advance: 30_001 }]);
    const periodic = (await worker.request("locate", { query: "afterx" })) as LocateResult;
    assert.equal(periodic.results[0]?.name, "afterx");
    await worker.control([{ freeze: false }]);
    await f.write("lib.rs", "pub fn newerx() {}");
    await utimes(path, metadata.atime, metadata.mtime);
    await worker.control([{ error: true }]);
    const fallback = (await worker.request("locate", { query: "newerx" })) as LocateResult;
    assert.equal(fallback.results[0]?.name, "newerx");
  } finally {
    await worker.close();
    await f.cleanup();
  }
});

test("queries before event delivery detect source, new directory and ignore changes", async () => {
  const f = await fixture({ "src/lib.rs": "pub fn value() -> i32 { 1 }" });
  const worker = await watchedWorker(f.root);
  try {
    const initial = (await worker.request("locate", { query: "value" })) as LocateResult;
    const path = join(f.root, "src/lib.rs");
    const metadata = await stat(path);
    await f.write("src/lib.rs", "pub fn value() -> i32 { 2 }");
    await utimes(path, metadata.atime, metadata.mtime);
    const detail = (await worker.request("inspect", { id: initial.results[0]?.id })) as {
      source: string;
    };
    assert(detail.source.includes("{ 2 }"));
    await f.write("new/nested.rs", "pub fn newly_created() {}");
    const added = (await worker.request("locate", { query: "newly_created" })) as LocateResult;
    assert.equal(added.results[0]?.path, "new/nested.rs");
    await f.write("new/.graphignore", "*.rs\n");
    assert.equal(
      ((await worker.request("locate", { query: "newly_created" })) as LocateResult).results.length,
      0,
    );
    await f.write("new/.graphignore", "");
    assert.equal(
      ((await worker.request("locate", { query: "newly_created" })) as LocateResult).results[0]
        ?.path,
      "new/nested.rs",
    );
  } finally {
    await worker.close();
    await f.cleanup();
  }
});

test("watched queries reconcile inherited configuration and other writers' revisions", async () => {
  const base = (target: string) =>
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@feature": [target] } } });
  const f = await fixture({
    "tsconfig.json": JSON.stringify({ extends: "./base.json" }),
    "base.json": base("first.ts"),
    "first.ts": "export function implementation() { return 'first'; }",
    "second.ts": "export function implementation() { return 'second'; }",
    "entry.ts":
      "import { implementation } from '@feature'; export function entryFeature() { return implementation(); }",
    "lib.rs": "pub fn old_value() {}",
  });
  const worker = await watchedWorker(f.root);
  try {
    const located = (await worker.request("locate", { query: "entryFeature" })) as LocateResult;
    const id = located.results.find((symbol) => symbol.name === "entryFeature")?.id;
    await f.write("base.json", base("second.ts"));
    const detail = (await worker.request("inspect", { id })) as { neighbors: { path: string }[] };
    assert(detail.neighbors.some((symbol) => symbol.path === "second.ts"));
    assert(!detail.neighbors.some((symbol) => symbol.path === "first.ts"));
    await f.write("lib.rs", "pub fn new_value() {}");
    const written = await f.engine.locate({ query: "new_value" });
    const current = (await worker.request("locate", { query: "new_value" })) as LocateResult;
    assert.equal(current.revision, written.revision);
    const source = (await worker.request("inspect", { id: current.results[0]?.id })) as {
      source: string;
    };
    assert(source.source.includes("new_value"));
  } finally {
    await worker.close();
    await f.cleanup();
  }
});

test("watch filters inherit nested ignore rules and retain unknown events", async () => {
  const f = await fixture({
    ".gitignore": "*.rs\nignored/\n",
    "src/.graphignore": "!keep.rs\n",
    "src/keep.rs": "pub fn keep() {}",
    "src/hidden.rs": "pub fn hidden() {}",
    "ignored/.graphignore": "!*.rs\n",
  });
  const worker = await watchedWorker(f.root);
  try {
    await worker.request("status");
    assert.equal((await worker.control([{ event: "change", path: "src/hidden.rs" }])).timers, 0);
    assert.equal(
      (await worker.control([{ event: "change", path: "ignored/.graphignore" }])).timers,
      0,
    );
    assert.equal((await worker.control([{ event: "change", path: "src/keep.rs" }])).timers, 1);
    await worker.control([{ flush: true }]);
    await worker.request("status");
    assert.equal((await worker.control([{ event: "rename" }])).timers, 1);
  } finally {
    await worker.close();
    await f.cleanup();
  }
});

test("watched snapshots reconcile ignore rules, directory renames and branch changes", async () => {
  const f = await fixture({
    "src/lib.rs": "pub fn feature() {}",
    ".git/HEAD": "ref: refs/heads/main\n",
  });
  const worker = await watchedWorker(f.root);
  try {
    const first = (await worker.request("status")) as GraphStatus;
    await f.write(".graphignore", "src/\n");
    await worker.control([{ event: "change", path: ".graphignore" }]);
    assert.equal(((await worker.request("status")) as GraphStatus).files, 0);
    await f.write(".graphignore", "");
    await worker.control([{ event: "change", path: ".graphignore" }]);
    await worker.request("status");
    await rename(join(f.root, "src"), join(f.root, "renamed.dir"));
    await worker.control([
      { event: "rename", path: "src" },
      { event: "rename", path: "renamed.dir" },
    ]);
    const moved = (await worker.request("locate", { query: "feature" })) as LocateResult;
    assert.equal(moved.results[0]?.path, "renamed.dir/lib.rs");
    await f.write("renamed.dir/lib.rs", "pub fn branch_feature() {}");
    await f.write(".git/HEAD", "ref: refs/heads/other\n");
    const branch = (await worker.request("locate", { query: "branch_feature" })) as LocateResult;
    assert.equal(branch.results[0]?.name, "branch_feature");
    assert(branch.revision > first.revision);
  } finally {
    await worker.close();
    await f.cleanup();
  }
});
