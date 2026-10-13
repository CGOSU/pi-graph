import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GraphEngine } from "../src/core/engine.js";
export async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "pi-graph-test-"));
  async function write(path: string, content: string) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  for (const [path, content] of Object.entries(files)) await write(path, content);
  const engine = new GraphEngine(root);
  return {
    root,
    engine,
    write,
    async cleanup() {
      engine.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
export const featureFiles = {
  "state.ts":
    "export const generationState = { loading: false }; export function resetGeneration() { generationState.loading = false; }",
  "generation.ts":
    "import { resetGeneration } from './state.js'; export function cancelGeneration() { /* cancel generation and clear loading spinner */ resetGeneration(); }",
  "button.ts":
    "import { cancelGeneration } from './generation.js'; import { generationState } from './state.js'; export function renderGenerateButton() { return generationState.loading ? 'spinner' : 'Generate'; } export function onCancelClick() { cancelGeneration(); }",
  "other.ts": "export function calculateInvoiceTax(total: number) { return total * 0.2; }",
};
