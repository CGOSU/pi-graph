import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { GraphEngine } from "../src/core/engine.js";
import { GraphStore } from "../src/core/store.js";
import type { FileRecord, GraphEdge, GraphSymbol } from "../src/core/types.js";
import { locateText } from "../src/pi/extension.js";

function snapshot(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = (table: string) =>
      (db.prepare(`SELECT data FROM ${table}`).all() as { data: string }[]).map((row) =>
        JSON.parse(row.data),
      );
    const config = db.prepare("SELECT value FROM metadata WHERE key='configHash'").get() as
      | { value: string }
      | undefined;
    if (!config) throw new Error("Benchmark snapshot has no configuration hash");
    return {
      files: db.prepare("SELECT path,hash FROM files").all() as unknown as FileRecord[],
      symbols: rows("symbols") as GraphSymbol[],
      edges: rows("edges") as GraphEdge[],
      configHash: config.value,
    };
  } finally {
    db.close();
  }
}
function commitTimings(
  path: string,
  before: ReturnType<typeof snapshot>,
  after: ReturnType<typeof snapshot>,
) {
  const store = new GraphStore(path);
  const commit = (data: ReturnType<typeof snapshot>) =>
    store.commit(data.files, data.symbols, data.edges, data.configHash);
  try {
    commit(before);
    const unchanged: number[] = [];
    const changed: number[] = [];
    for (let i = 0; i < 20; i++) {
      let start = performance.now();
      commit(before);
      unchanged.push(performance.now() - start);
      start = performance.now();
      commit(after);
      changed.push(performance.now() - start);
      commit(before);
    }
    const median = (times: number[]) => {
      times.sort((a, b) => a - b);
      return Math.round(((times[9] ?? 0) + (times[10] ?? 0)) * 50) / 100;
    };
    return {
      unchangedCommitMedianMs: median(unchanged),
      singleFileCommitMedianMs: median(changed),
    };
  } finally {
    store.close();
  }
}

const requested = Number(process.argv[2] ?? 50000);
if (!Number.isInteger(requested) || requested < 1000 || requested > 500000)
  throw new Error("Line count must be an integer from 1000 to 500000");
const root = await mkdtemp(join(tmpdir(), "pi-graph-bench-"));
let engine: GraphEngine | undefined;
try {
  await mkdir(join(root, "src"));
  const moduleCount = Math.ceil(requested / 300);
  for (let file = 0; file < moduleCount; file++) {
    const lines: string[] = [];
    for (let symbol = 0; symbol < 30; symbol++)
      lines.push(
        `export function calculateInvoice${file}Value${symbol}(value: number) {`,
        "  const rate = 0.2;",
        `  const subtotal = value + ${symbol};`,
        "  const tax = subtotal * rate;",
        "  const discount = subtotal * 0.01;",
        "  const gross = subtotal + tax;",
        "  const net = gross - discount;",
        "  const rounded = Math.round(net);",
        "  return rounded;",
        "}",
      );
    await writeFile(join(root, "src", `invoice${file}.ts`), lines.join("\n"));
  }
  await writeFile(
    join(root, "src", "state.ts"),
    "export const generationState = { loading: false }; export function resetGeneration() { generationState.loading = false; }",
  );
  await writeFile(
    join(root, "src", "generation.ts"),
    "import { resetGeneration } from './state.js'; export function cancelGeneration() { resetGeneration(); }",
  );
  await writeFile(
    join(root, "src", "button.ts"),
    "import { cancelGeneration } from './generation.js'; import { generationState } from './state.js'; export function renderGenerateButton() { return generationState.loading ? 'spinner' : 'Generate'; } export function onCancelClick() { cancelGeneration(); }",
  );
  engine = new GraphEngine(root);
  const query = { query: "取消生成后按钮一直转圈", limit: 6 };
  let start = performance.now();
  const result = await engine.locate(query);
  const coldMs = performance.now() - start;
  const times: number[] = [];
  for (let i = 0; i < 20; i++) {
    start = performance.now();
    await engine.locate(query);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const before = engine.status();
  const databasePath = join(root, ".pi-graph", "index.sqlite");
  const beforeSnapshot = snapshot(databasePath);
  await writeFile(
    join(root, "src", "generation.ts"),
    "\n\nimport { resetGeneration } from './state.js'; export function cancelGeneration() { resetGeneration(); }",
  );
  start = performance.now();
  const updated = await engine.locate(query);
  const updateMs = performance.now() - start;
  const commits = commitTimings(
    join(root, ".pi-graph", "commit-benchmark.sqlite"),
    beforeSnapshot,
    snapshot(databasePath),
  );
  const relevant = new Set([
    "generationState",
    "resetGeneration",
    "cancelGeneration",
    "renderGenerateButton",
    "onCancelClick",
  ]);
  const precise = result.results.filter((symbol) => relevant.has(symbol.name)).length;
  const modelText = locateText(result);
  console.log(
    JSON.stringify(
      {
        synthetic: true,
        sourceLines: moduleCount * 300 + 3,
        files: before.files,
        symbols: before.symbols,
        coldMs: Math.round(coldMs),
        warmMedianMs: Math.round(((times[9] ?? 0) + (times[10] ?? 0)) / 2),
        warmP95Ms: Math.round(times[18] ?? 0),
        singleFileUpdateMs: Math.round(updateMs),
        ...commits,
        precision: result.results.length ? precise / result.results.length : 0,
        resultCount: result.results.length,
        resultCharacters: JSON.stringify(result).length,
        modelTextCharacters: modelText.length,
        modelTextUtf8Bytes: Buffer.byteLength(modelText, "utf8"),
        currentLinesVerified:
          updated.results.find((symbol) => symbol.name === "cancelGeneration")?.lines[0] === 3,
        results: result.results.map((symbol) => symbol.name),
      },
      null,
      2,
    ),
  );
  if (
    !result.results.some((symbol) => symbol.name === "cancelGeneration") ||
    !result.results.some((symbol) => symbol.name === "renderGenerateButton") ||
    precise !== result.results.length
  )
    throw new Error("Synthetic feature localization regression");
} finally {
  engine?.close();
  await rm(root, { recursive: true, force: true });
}
