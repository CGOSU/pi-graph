import { Worker } from "node:worker_threads";
import type {
  GraphOperation,
  GraphStatus,
  InspectInput,
  InspectResult,
  LocateInput,
  LocateResult,
  WorkerRequest,
  WorkerResponse,
} from "./types.js";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}
export class GraphClient {
  private worker: Worker;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private closed = false;
  constructor(readonly root: string) {
    this.worker = new Worker(new URL("./worker.js", import.meta.url), { workerData: { root } });
    this.worker.on("message", (response: WorkerResponse) => {
      const request = this.pending.get(response.id);
      if (!request) return;
      this.pending.delete(response.id);
      request.cleanup();
      if (response.error) request.reject(new Error(response.error));
      else request.resolve(response.result);
    });
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", (code) => {
      if (!this.closed) this.fail(new Error(`Graph worker exited (${code})`));
    });
  }
  private fail(error: Error): void {
    this.closed = true;
    for (const request of this.pending.values()) {
      request.cleanup();
      request.reject(error);
    }
    this.pending.clear();
  }
  private request<T>(
    operation: GraphOperation,
    input?: LocateInput | InspectInput,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Graph worker is closed"));
    if (signal?.aborted) return Promise.reject(new Error("Graph request aborted"));
    return new Promise<T>((resolve, reject) => {
      const id = ++this.nextId;
      const cancellation = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      const cancel = (error: Error) => {
        const request = this.pending.get(id);
        if (!request) return;
        Atomics.store(cancellation, 0, 1);
        this.pending.delete(id);
        request.cleanup();
        request.reject(error);
      };
      const abort = () => cancel(new Error("Graph request aborted"));
      const timer = setTimeout(
        () => cancel(new Error("Graph request timed out after 120 seconds")),
        120_000,
      );
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.worker.postMessage({
          id,
          operation,
          input,
          cancellation: cancellation.buffer,
        } satisfies WorkerRequest);
      } catch (error) {
        cancel(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  locate(input: LocateInput, signal?: AbortSignal): Promise<LocateResult> {
    return this.request("locate", input, signal);
  }
  inspect(input: InspectInput, signal?: AbortSignal): Promise<InspectResult> {
    return this.request("inspect", input, signal);
  }
  status(signal?: AbortSignal): Promise<GraphStatus> {
    return this.request("status", undefined, signal);
  }
  rebuild(signal?: AbortSignal): Promise<GraphStatus> {
    return this.request("rebuild", undefined, signal);
  }
  async close(): Promise<void> {
    this.fail(new Error("Graph session closed"));
    await this.worker.terminate();
  }
}
