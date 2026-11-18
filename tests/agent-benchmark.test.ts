import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgentTrial, summarize } from "../scripts/agent-benchmark.js";

const task = {
  id: "fixture",
  prompt: "Change the limit from 1 to 2",
  files: { "src/limit.ts": "export const limit = 1;\n" },
  changes: { "src/limit.ts": "export const limit = 2;\n" },
};

function run(script: string, graph: boolean, timeoutMs = 5000) {
  return runAgentTrial(task, graph, {
    executable: process.execPath,
    prefixArgs: ["--input-type=module", "--eval", script, "--"],
    provider: "test-provider",
    model: "test-model",
    thinking: "low",
    timeoutMs,
  });
}

const edit = `
  import { mkdirSync, writeFileSync } from "node:fs";
  writeFileSync("src/limit.ts", ${JSON.stringify(task.changes["src/limit.ts"])});
  const emit = (event) => console.log(JSON.stringify(event));
  const call = { toolName: "edit", toolCallId: "edit-1" };
  emit({ type: "tool_execution_start", ...call });
  emit({ type: "tool_execution_end", ...call });
`;

test("isolates trial files and counts each tool call once without counting its start and end twice", async () => {
  const trial = await run(
    `${edit}
    const args = process.argv.slice(1);
    if (!args.includes("--no-extensions") || !args.includes("--extension") ||
        !args[args.indexOf("--tools") + 1].split(",").includes("graph_locate")) process.exit(2);
    mkdirSync(".pi-graph");
    writeFileSync(".pi-graph/index.sqlite", "index");
    emit({ type: "tool_execution_end", toolName: "graph_locate", toolCallId: "locate-1" });
    emit({ type: "agent_settled", aborted: false });
  `,
    true,
  );
  assert.equal(trial.correct, true);
  assert.equal(trial.toolCalls, 2);
  assert.deepEqual(trial.tools, { edit: 1, graph_locate: 1 });

  const extraChange = await run(
    `${edit}
    const args = process.argv.slice(1);
    if (args.includes("--extension") ||
        args[args.indexOf("--tools") + 1].includes("graph_locate")) process.exit(2);
    writeFileSync("extra.ts", "unexpected");
    emit({ type: "agent_settled", aborted: false });
  `,
    false,
  );
  assert.equal(extraChange.status, "completed");
  assert.equal(extraChange.correct, false);
  assert.deepEqual(extraChange.mismatches, ["extra.ts"]);
});

test("a correct file without agent settlement is not a successful trial", async () => {
  const trial = await run(edit, false);
  assert.equal(trial.status, "missing-settlement");
  assert.equal(trial.correct, false);
  assert.deepEqual(trial.mismatches, []);

  const timeout = await run("setInterval(() => {}, 1000)", false, 250);
  assert.equal(timeout.status, "timeout");
  assert.equal(timeout.correct, false);
});

test("latency and tool count compare only pairs where both produced the expected diff", () => {
  const correct = {
    status: "completed" as const,
    elapsedMs: 100,
    toolCalls: 3,
    tools: {},
    correct: true,
    mismatches: [],
  };
  const wrong = {
    ...correct,
    elapsedMs: 1,
    toolCalls: 1,
    correct: false,
    mismatches: ["src/limit.ts"],
  };
  const paired = {
    task: task.id,
    repeat: 1,
    first: "off" as const,
    off: correct,
    on: { ...correct, elapsedMs: 80, toolCalls: 2 },
  };
  assert.deepEqual(summarize([paired, { ...paired, repeat: 2, on: wrong }]), {
    pairs: 2,
    correctPairs: 1,
    off: { successes: 2, successRate: 1, pairedMedianMs: 100, pairedMedianToolCalls: 3 },
    on: { successes: 1, successRate: 0.5, pairedMedianMs: 80, pairedMedianToolCalls: 2 },
  });
  assert.equal(summarize([{ ...paired, on: wrong }]).off.pairedMedianMs, null);
});
