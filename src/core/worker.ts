import { type FSWatcher, watch } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { GraphEngine } from "./engine.js";
import type { InspectInput, LocateInput, WorkerRequest, WorkerResponse } from "./types.js";

const port = parentPort;
if (!port) throw new Error("Graph worker requires a parent port");
const engine = new GraphEngine((workerData as { root: string }).root);
let queue = Promise.resolve();
let timer: ReturnType<typeof setTimeout> | undefined;
let watcher: FSWatcher | undefined;
let refreshQueued = false;
function scheduleRefresh(): void {
  if (refreshQueued) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    refreshQueued = true;
    queue = queue
      .then(async () => {
        // Events arriving during a refresh may schedule one following reconciliation.
        refreshQueued = false;
        await engine.refresh();
      })
      .catch(() => {});
  }, 300);
}
try {
  watcher = watch(engine.root, { recursive: true }, (_event, filename) => {
    const path = filename?.toString().replaceAll("\\", "/") ?? "";
    if (engine.sourceChanged(path)) scheduleRefresh();
  });
  engine.setWatching(true);
  watcher.on("error", () => {
    engine.setWatching(false);
    watcher?.close();
  });
  watcher.on("close", () => engine.setWatching(false));
} catch {
  /* Queries reconcile hashes when recursive watching is unavailable. */
}
port.on("message", (request: WorkerRequest) => {
  queue = queue.then(async () => {
    const response: WorkerResponse = { id: request.id };
    const flag = new Int32Array(request.cancellation);
    const cancellation = {
      throwIfAborted() {
        if (Atomics.load(flag, 0)) throw new Error("Graph request aborted");
      },
    };
    try {
      cancellation.throwIfAborted();
      if (request.operation === "locate")
        response.result = await engine.locate(request.input as LocateInput, cancellation);
      else if (request.operation === "inspect")
        response.result = await engine.inspect(request.input as InspectInput, cancellation);
      else response.result = await engine.refresh(request.operation === "rebuild", cancellation);
      cancellation.throwIfAborted();
    } catch (error) {
      delete response.result;
      response.error = error instanceof Error ? error.message : String(error);
    }
    port.postMessage(response);
  });
});
port.on("close", () => {
  if (timer) clearTimeout(timer);
  watcher?.close();
  engine.close();
});
