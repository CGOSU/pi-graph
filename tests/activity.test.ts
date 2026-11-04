import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GraphActivity } from "../src/pi/activity.js";

function display() {
  const updates: (string | undefined)[] = [];
  const ctx = {
    hasUI: true,
    ui: {
      setStatus(key: string, text: string | undefined) {
        assert.equal(key, "pi-graph");
        updates.push(text);
      },
    },
  } as ExtensionContext;
  return { ctx, updates, current: () => updates.at(-1) ?? "" };
}

test("activity refreshes elapsed time only while waiting and labels completed results", (t) => {
  let now = 100;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const status = new GraphActivity();
  const view = display();
  const finish = status.start("locate", view.ctx);
  assert.match(view.current(), /locate #1 · pending 0\.0s/);
  now += 2500;
  t.mock.timers.tick(2000);
  assert.match(view.current(), /pending 2\.5s/);
  finish({ kind: "success", summary: "10 results" });
  assert.match(view.current(), /last locate #1 · 10 results · 2\.5s/);
  const updates = view.updates.length;
  t.mock.timers.tick(3000);
  assert.equal(view.updates.length, updates);
});

test("overlapping requests remain pending and older completion cannot replace the newer result", () => {
  const status = new GraphActivity();
  const view = display();
  const first = status.start("locate", view.ctx);
  const second = status.start("inspect", view.ctx);
  assert.match(view.current(), /inspect #2 .*2 pending/);
  second({ kind: "success", summary: "2 neighbors" });
  assert.match(view.current(), /locate #1 · pending/);
  first({ kind: "success", summary: "10 results" });
  assert.match(view.current(), /last inspect #2 · 2 neighbors/);
});

test("session reset clears timers and ignores late results even after the sequence restarts", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const status = new GraphActivity();
  const view = display();
  const old = status.start("locate", view.ctx);
  status.reset(view.ctx);
  assert.equal(view.updates.at(-1), undefined);
  const updates = view.updates.length;
  t.mock.timers.tick(3000);
  assert.equal(view.updates.length, updates);
  const current = status.start("rebuild", view.ctx);
  old({ kind: "failed" });
  assert.match(view.current(), /rebuild #1 · pending/);
  current({ kind: "success", summary: "20 symbols" });
  old({ kind: "success", summary: "10 results" });
  assert.match(view.current(), /last rebuild #1 · 20 symbols/);
});

test("failure and cancellation replace prior success and end the waiting display", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const status = new GraphActivity();
  const view = display();
  status.start("status", view.ctx)({ kind: "success", summary: "20 symbols" });
  status.start("inspect", view.ctx)({ kind: "failed" });
  assert.match(view.current(), /last inspect #2 · failed/);
  status.start("locate", view.ctx)({ kind: "cancelled" });
  assert.match(view.current(), /last locate #3 · cancelled/);
  const updates = view.updates.length;
  t.mock.timers.tick(3000);
  assert.equal(view.updates.length, updates);
});

test("headless activity never accesses UI or starts a display timer", (t) => {
  t.mock.method(globalThis, "setInterval", () => {
    throw new Error("headless timer");
  });
  const ctx = {
    hasUI: false,
    get ui() {
      throw new Error("headless UI");
    },
  } as unknown as ExtensionContext;
  const status = new GraphActivity();
  status.start("locate", ctx)({ kind: "success", summary: "0 results" });
  status.reset(ctx);
});
