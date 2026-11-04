import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GraphOperation } from "../core/types.js";

type Outcome = { kind: "success"; summary: string } | { kind: "failed" | "cancelled" };
interface Request {
  id: number;
  operation: GraphOperation;
  startedAt: number;
}
interface Completed extends Request {
  elapsed: number;
  outcome: Outcome;
}

function seconds(milliseconds: number): string {
  return `${(Math.max(0, milliseconds) / 1000).toFixed(1)}s`;
}

export class GraphActivity {
  private generation = 0;
  private sequence = 0;
  private pending = new Map<number, Request>();
  private completed?: Completed;
  private context?: ExtensionContext;
  private timer?: ReturnType<typeof setInterval>;

  reset(ctx: ExtensionContext): void {
    this.generation++;
    this.sequence = 0;
    this.pending.clear();
    this.completed = undefined;
    this.context = undefined;
    this.stopTimer();
    if (ctx.hasUI) ctx.ui.setStatus("pi-graph", undefined);
  }

  start(operation: GraphOperation, ctx: ExtensionContext): (outcome: Outcome) => void {
    const generation = this.generation;
    const request = { id: ++this.sequence, operation, startedAt: performance.now() };
    this.pending.set(request.id, request);
    this.context = ctx;
    this.render();
    if (ctx.hasUI && !this.timer) {
      this.timer = setInterval(() => this.render(), 1000);
      this.timer.unref();
    }
    return (outcome) => {
      if (generation !== this.generation || !this.pending.delete(request.id)) return;
      if (!this.completed || request.id > this.completed.id)
        this.completed = { ...request, elapsed: performance.now() - request.startedAt, outcome };
      if (!this.pending.size) this.stopTimer();
      this.render();
    };
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private render(): void {
    if (!this.context?.hasUI) return;
    const request = [...this.pending.values()].at(-1);
    if (request) {
      const concurrent = this.pending.size > 1 ? ` · ${this.pending.size} pending` : "";
      this.context.ui.setStatus(
        "pi-graph",
        `graph: ${request.operation} #${request.id} · pending ${seconds(performance.now() - request.startedAt)}${concurrent}`,
      );
      return;
    }
    const completed = this.completed;
    if (!completed) return;
    const { operation, id, elapsed, outcome } = completed;
    const result = outcome.kind === "success" ? outcome.summary : outcome.kind;
    this.context.ui.setStatus(
      "pi-graph",
      `graph: last ${operation} #${id} · ${result} · ${seconds(elapsed)}`,
    );
  }
}
