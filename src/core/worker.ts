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
try {
  watcher = watch(engine.root, { recursive: true }, (_event, filename) => {
    const path = filename?.toString().replaceAll("\\", "/") ?? "";
    if (/(?:^|\/)(?:node_modules|\.pi-graph|\.empryo|dist|build|coverage)(?:\/|$)/.test(path))
      return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      queue = queue
        .then(async () => {
          await engine.refresh();
        })
        .catch(() => {});
    }, 300);
  });
  watcher.on("error", () => {
    watcher?.close();
  });
} catch {
  /* Queries reconcile hashes when recursive watching is unavailable. */
}
port.on("message", (request: WorkerRequest) => {
  queue = queue.then(async () => {
    const response: WorkerResponse = { id: request.id };
    try {
      if (request.operation === "locate")
        response.result = await engine.locate(request.input as LocateInput);
      else if (request.operation === "inspect")
        response.result = await engine.inspect(request.input as InspectInput);
      else response.result = await engine.refresh(request.operation === "rebuild");
    } catch (error) {
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
