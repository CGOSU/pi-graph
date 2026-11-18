import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { type AgentTask, agentTasks } from "./agent-benchmark-fixtures.js";

type TrialOptions = {
  executable: string;
  prefixArgs?: string[];
  provider: string;
  model: string;
  thinking: string;
  timeoutMs: number;
};

type RunStatus =
  | "completed"
  | "timeout"
  | "launch-error"
  | "nonzero-exit"
  | "invalid-json"
  | "missing-settlement"
  | "aborted"
  | "agent-error";

function piArgs(task: AgentTask, graph: boolean, options: TrialOptions) {
  const tools = ["read", "grep", "find", "ls", "edit"];
  const extension = fileURLToPath(new URL("../../index.ts", import.meta.url));
  if (graph) tools.push("graph_locate", "graph_inspect");
  return [
    ...(options.prefixArgs ?? []),
    "--mode",
    "json",
    "--no-session",
    "--no-extensions",
    "--no-mcp",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--tools",
    tools.join(","),
    "--provider",
    options.provider,
    "--model",
    options.model,
    "--thinking",
    options.thinking,
    ...(graph ? ["--extension", extension] : []),
    task.prompt,
  ];
}

function runPi(cwd: string, args: string[], options: TrialOptions) {
  const start = performance.now();
  const child = spawn(options.executable, args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
  const lines = createInterface({ input: child.stdout });
  const calls = new Map<string, string>();
  let settlement: { elapsedMs: number; aborted: boolean } | undefined;
  let issue: RunStatus | undefined;
  let assistantFailed = false;
  const timer = setTimeout(() => {
    issue = "timeout";
    child.kill("SIGKILL");
  }, options.timeoutMs);
  lines.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
        if (typeof event.toolCallId === "string" && typeof event.toolName === "string")
          calls.set(event.toolCallId, event.toolName);
      } else if (event.type === "message_end" && event.message?.role === "assistant") {
        assistantFailed = ["error", "aborted"].includes(event.message.stopReason);
      } else if (event.type === "agent_settled") {
        settlement = { elapsedMs: performance.now() - start, aborted: event.aborted === true };
      }
    } catch {
      issue ??= "invalid-json";
    }
  });
  return new Promise<{
    status: RunStatus;
    elapsedMs: number;
    toolCalls: number;
    tools: Record<string, number>;
  }>((resolve) => {
    child.once("error", () => {
      issue ??= "launch-error";
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      lines.close();
      const counts = new Map<string, number>();
      for (const name of calls.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
      let status = issue;
      if (!status) {
        if (code !== 0) status = "nonzero-exit";
        else if (!settlement) status = "missing-settlement";
        else if (settlement.aborted) status = "aborted";
        else if (assistantFailed) status = "agent-error";
        else status = "completed";
      }
      resolve({
        status,
        elapsedMs: Math.round(settlement?.elapsedMs ?? performance.now() - start),
        toolCalls: calls.size,
        tools: Object.fromEntries(counts),
      });
    });
  });
}

async function diffMismatches(root: string, expected: Record<string, string>, graph: boolean) {
  const remaining = new Map(Object.entries(expected));
  const mismatches: string[] = [];
  async function check(prefix: string) {
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (graph && path === ".pi-graph" && entry.isDirectory()) continue;
      if (entry.isDirectory()) {
        await check(path);
        continue;
      }
      const content = remaining.get(path);
      remaining.delete(path);
      if (
        content === undefined ||
        !entry.isFile() ||
        !(await readFile(join(root, path))).equals(Buffer.from(content))
      ) {
        mismatches.push(path);
      }
    }
  }
  await check("");
  return [...mismatches, ...remaining.keys()].sort();
}

export async function runAgentTrial(task: AgentTask, graph: boolean, options: TrialOptions) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-graph-agent-bench-"));
  try {
    for (const [path, content] of Object.entries(task.files)) {
      const file = join(cwd, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    const run = await runPi(cwd, piArgs(task, graph, options), options);
    const mismatches = await diffMismatches(cwd, { ...task.files, ...task.changes }, graph);
    return { ...run, correct: run.status === "completed" && !mismatches.length, mismatches };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

type Trial = Awaited<ReturnType<typeof runAgentTrial>>;
type TrialPair = { task: string; repeat: number; first: "on" | "off"; off: Trial; on: Trial };

function median(values: number[]) {
  values.sort((a, b) => a - b);
  const first = values[Math.floor((values.length - 1) / 2)];
  const second = values[Math.floor(values.length / 2)];
  return first === undefined || second === undefined ? null : (first + second) / 2;
}

export function summarize(pairs: TrialPair[]) {
  const correctPairs = pairs.filter(({ off, on }) => off.correct && on.correct);
  function summarizeArm(arm: "off" | "on") {
    const successes = pairs.filter((pair) => pair[arm].correct).length;
    return {
      successes,
      successRate: pairs.length ? successes / pairs.length : null,
      pairedMedianMs: median(correctPairs.map((pair) => pair[arm].elapsedMs)),
      pairedMedianToolCalls: median(correctPairs.map((pair) => pair[arm].toolCalls)),
    };
  }
  return {
    pairs: pairs.length,
    correctPairs: correctPairs.length,
    off: summarizeArm("off"),
    on: summarizeArm("on"),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      thinking: { type: "string", default: "low" },
      repeats: { type: "string", default: "1" },
      "timeout-ms": { type: "string", default: "180000" },
      help: { type: "boolean", short: "h" },
    },
  });
  const usage =
    "Usage: pnpm benchmark:agent --provider <provider> --model <model> [--thinking low] [--repeats 1] [--timeout-ms 180000]";
  if (values.help) {
    console.log(usage);
    return;
  }
  const { provider, model, thinking } = values;
  if (!provider?.trim() || !model?.trim()) throw new Error(usage);
  const repeats = Number(values.repeats);
  const timeoutMs = Number(values["timeout-ms"]);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20)
    throw new Error("--repeats must be an integer from 1 to 20");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
    throw new Error("--timeout-ms must be a positive 32-bit integer");
  const options = {
    executable: process.env.PI_BENCHMARK_BIN || "pi",
    provider,
    model,
    thinking,
    timeoutMs,
  };
  const pairs: TrialPair[] = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const task of agentTasks) {
      const first = pairs.length % 2 === 0 ? "off" : "on";
      const a = await runAgentTrial(task, first === "on", options);
      const b = await runAgentTrial(task, first === "off", options);
      pairs.push({
        task: task.id,
        repeat,
        first,
        off: first === "off" ? a : b,
        on: first === "on" ? a : b,
      });
    }
  }
  const byTask = Object.fromEntries(
    agentTasks.map(({ id }) => [id, summarize(pairs.filter((pair) => pair.task === id))]),
  );
  console.log(
    JSON.stringify(
      { provider, model, thinking, repeats, timeoutMs, summary: summarize(pairs), byTask, pairs },
      null,
      2,
    ),
  );
  if (pairs.some(({ off, on }) => off.status !== "completed" || on.status !== "completed"))
    process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
