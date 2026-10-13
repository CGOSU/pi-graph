import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { GraphEngine } from "../src/core/engine.js";

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
  await writeFile(
    join(root, "src", "generation.ts"),
    "\n\nimport { resetGeneration } from './state.js'; export function cancelGeneration() { resetGeneration(); }",
  );
  start = performance.now();
  const updated = await engine.locate(query);
  const updateMs = performance.now() - start;
  const relevant = new Set([
    "generationState",
    "resetGeneration",
    "cancelGeneration",
    "renderGenerateButton",
    "onCancelClick",
  ]);
  const precise = result.results.filter((symbol) => relevant.has(symbol.name)).length;
  console.log(
    JSON.stringify(
      {
        synthetic: true,
        sourceLines: moduleCount * 300 + 3,
        files: before.files,
        symbols: before.symbols,
        coldMs: Math.round(coldMs),
        warmP95Ms: Math.round(times[18] ?? 0),
        singleFileUpdateMs: Math.round(updateMs),
        precision: result.results.length ? precise / result.results.length : 0,
        resultCount: result.results.length,
        resultCharacters: JSON.stringify(result).length,
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
