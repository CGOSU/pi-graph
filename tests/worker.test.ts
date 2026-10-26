import assert from "node:assert/strict";
import { getEventListeners, once } from "node:events";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { GraphClient } from "../src/core/client.js";
import { scanSources } from "../src/core/files.js";
import { GraphStore } from "../src/core/store.js";
import type { GraphOperation, GraphStatus, WorkerResponse } from "../src/core/types.js";
import { TypeScriptGraph } from "../src/languages/typescript.js";
import { featureFiles, fixture } from "./helpers.js";

test("pre-dispatch and queued cancellations skip rebuilding and leave later requests usable", async () => {
  const f = await fixture(featureFiles);
  const client = new GraphClient(f.root);
  try {
    const before = await client.status();
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(client.rebuild(cancelled.signal), /aborted/);
    assert.equal(getEventListeners(cancelled.signal, "abort").length, 0);
    assert.equal((await client.status()).revision, before.revision);

    const running = client.rebuild();
    const queued = new AbortController();
    const pending = client.rebuild(queued.signal);
    const rejected = assert.rejects(pending, /aborted/);
    queued.abort();
    await rejected;
    assert.equal(getEventListeners(queued.signal, "abort").length, 0);
    const rebuilt = await running;
    assert.equal(rebuilt.revision, before.revision + 1);
    assert.equal((await client.status()).revision, rebuilt.revision);
    const located = await client.locate({ query: "cancelGeneration" });
    assert(located.results.some((symbol) => symbol.name === "cancelGeneration"));
  } finally {
    await client.close();
    await f.cleanup();
  }
});

test("timeouts cancel worker work, release listeners and do not force a snapshot commit", async (t) => {
  const f = await fixture(featureFiles);
  const client = new GraphClient(f.root);
  try {
    const before = await client.status();
    const controller = new AbortController();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = client.rebuild(controller.signal);
    const rejected = assert.rejects(pending, /timed out after 120 seconds/);
    t.mock.timers.tick(120_000);
    await rejected;
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    t.mock.timers.reset();
    assert.equal((await client.status()).revision, before.revision);
    assert((await client.locate({ query: "cancelGeneration" })).results.length > 0);
  } finally {
    t.mock.timers.reset();
    await client.close();
    await f.cleanup();
  }
});

test("completed and rejected requests clean listeners and tolerate late cancellation", async (t) => {
  const f = await fixture(featureFiles);
  const client = new GraphClient(f.root);
  try {
    const controller = new AbortController();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const result = await client.locate({ query: "cancelGeneration" }, controller.signal);
    assert(result.results.length > 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    controller.abort();
    t.mock.timers.tick(120_000);
    t.mock.timers.reset();
    assert.equal((await client.status()).revision, result.revision);

    const failed = new AbortController();
    await assert.rejects(
      client.inspect({ id: "missing-symbol" }, failed.signal),
      /Symbol not found/,
    );
    assert.equal(getEventListeners(failed.signal, "abort").length, 0);
    failed.abort();
    assert.equal((await client.status()).revision, result.revision);
  } finally {
    t.mock.timers.reset();
    await client.close();
    await f.cleanup();
  }
});

test("dispatch failure and shutdown reject pending requests without leaking listeners", async () => {
  const f = await fixture(featureFiles);
  const client = new GraphClient(f.root);
  try {
    const invalid = new AbortController();
    await assert.rejects(
      client.locate({ query: (() => "uncloneable") as unknown as string }, invalid.signal),
      { name: "DataCloneError" },
    );
    assert.equal(getEventListeners(invalid.signal, "abort").length, 0);
    assert((await client.status()).files > 0);
    const controller = new AbortController();
    const pending = client.rebuild(controller.signal);
    const rejected = assert.rejects(pending, /Graph session closed/);
    await client.close();
    await rejected;
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    await assert.rejects(client.status(), /Graph worker is closed/);
  } finally {
    await client.close();
    await f.cleanup();
  }
});

test("shared cancellation reaches a busy worker before commit without dropping other requests", {
  timeout: 20_000,
}, async () => {
  const f = await fixture(featureFiles);
  const gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  // Hold a synchronous compiler frame until the parent cancels, avoiding timing-based tests.
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { TypeScriptGraph } = await import(${JSON.stringify(new URL("../src/languages/typescript.js", import.meta.url).href)});
      const gate = new Int32Array(workerData.gate);
      const build = TypeScriptGraph.prototype.build;
      TypeScriptGraph.prototype.build = function (...args) {
        const graph = build.apply(this, args);
        if (Atomics.load(gate, 0) === 1) {
          parentPort.postMessage({ stage: 'compiled' });
          if (Atomics.wait(gate, 0, 1, 10000) === 'timed-out')
            throw new Error('Test compiler gate timed out');
        }
        return graph;
      };
      await import(${JSON.stringify(new URL("../src/core/worker.js", import.meta.url).href)});
    })().catch(error => { throw error; });
  `,
    { eval: true, workerData: { root: f.root, gate: gate.buffer } },
  );
  function request(
    id: number,
    operation: GraphOperation,
    flag = new Int32Array(new SharedArrayBuffer(4)),
  ) {
    return new Promise<WorkerResponse>((resolve, reject) => {
      const cleanup = () => {
        worker.off("message", message);
        worker.off("error", error);
      };
      const message = (response: WorkerResponse) => {
        if (response.id !== id) return;
        cleanup();
        resolve(response);
      };
      const error = (failure: Error) => {
        cleanup();
        reject(failure);
      };
      worker.on("message", message);
      worker.on("error", error);
      worker.postMessage({ id, operation, cancellation: flag.buffer });
    });
  }
  try {
    const before = (await request(1, "status")).result as GraphStatus;
    const flag = new Int32Array(new SharedArrayBuffer(4));
    Atomics.store(gate, 0, 1);
    const compiled = once(worker, "message");
    const active = request(2, "rebuild", flag);
    const following = request(3, "status");
    assert.equal((await compiled)[0].stage, "compiled");
    Atomics.store(flag, 0, 1);
    Atomics.store(gate, 0, 0);
    Atomics.notify(gate, 0);
    const cancelled = await active;
    assert.match(cancelled.error ?? "", /aborted/);
    assert.equal(cancelled.result, undefined);
    const after = await following;
    assert.equal(after.error, undefined);
    assert.equal((after.result as GraphStatus).revision, before.revision);
    assert.equal((after.result as GraphStatus).files, before.files);
    assert.equal(((await request(4, "status")).result as GraphStatus).revision, before.revision);
  } finally {
    await worker.terminate();
    await f.cleanup();
  }
});

test("an active scan cancels at an I/O boundary and subsequent scans remain complete", async () => {
  const f = await fixture(featureFiles);
  try {
    const controller = new AbortController();
    const pending = scanSources(f.root, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    const next = await scanSources(f.root);
    assert.deepEqual(
      Object.fromEntries(next.files.map((file) => [file.path, file.content])),
      featureFiles,
    );
  } finally {
    await f.cleanup();
  }
});

test("cancellation during synchronous compilation preserves disk and memory snapshots", async (t) => {
  const f = await fixture(featureFiles);
  try {
    const before = await f.engine.refresh();
    await f.write("generation.ts", "export function replacementGeneration() { return 42; }");
    await f.write("new.rs", "pub fn new_rust_symbol() {}");
    const controller = new AbortController();
    const build = TypeScriptGraph.prototype.build;
    const compiler = t.mock.method(
      TypeScriptGraph.prototype,
      "build",
      function (this: TypeScriptGraph, ...args: Parameters<TypeScriptGraph["build"]>) {
        const graph = build.apply(this, args);
        controller.abort();
        return graph;
      },
    );
    await assert.rejects(f.engine.refresh(false, controller.signal), { name: "AbortError" });
    compiler.mock.restore();
    assert.deepEqual(f.engine.status(), before);
    const persisted = new GraphStore(join(f.root, ".pi-graph", "index.sqlite"));
    try {
      assert.equal(Number(persisted.metadata("revision")), before.revision);
      assert(persisted.search(["cancel"]).length > 0);
      assert.equal(persisted.search(["replacement"]).length, 0);
      assert.equal(persisted.search(["rust"]).length, 0);
    } finally {
      persisted.close();
    }
    const recovered = await f.engine.locate({ query: "replacementGeneration" });
    assert(recovered.results.some((symbol) => symbol.name === "replacementGeneration"));
    assert.equal(recovered.revision, before.revision + 1);
    assert.equal(f.engine.status().files, before.files + 1);
    assert((await f.engine.locate({ query: "new_rust_symbol" })).results.length > 0);
  } finally {
    await f.cleanup();
  }
});
