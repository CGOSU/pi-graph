import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  DefaultResourceLoader,
  type ExtensionToolContext,
  InteractiveMode,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { featureFiles, fixture } from "./helpers.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
test("real pi install in an isolated profile loads callable tools without touching user settings", async () => {
  const f = await fixture(featureFiles);
  let shutdown: (() => Promise<void>) | undefined;
  try {
    const agentDir = join(f.root, ".agent");
    const cli = join(
      dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
      "bundle",
      "cli.js",
    );
    await promisify(execFile)(process.execPath, [cli, "install", packageRoot], {
      cwd: f.root,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      timeout: 30_000,
    });
    const settings = SettingsManager.create(f.root, agentDir);
    assert.equal(settings.getPackages().length, 1);
    const loader = new DefaultResourceLoader({
      cwd: f.root,
      agentDir,
      settingsManager: settings,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal(loader.getExtensions().extensions.length, 1);
    const extension = loader.getExtensions().extensions[0];
    assert(extension);
    const ctx = { cwd: f.root, hasUI: false } as ExtensionToolContext;
    shutdown = async () => {
      for (const handler of extension.handlers.get("session_shutdown") ?? [])
        await handler({ type: "session_shutdown", reason: "quit" }, ctx);
    };
    const locate = extension.tools.get("graph_locate");
    assert(locate);
    const result = await locate.definition.execute(
      "locate",
      { query: "取消生成后按钮一直转圈" },
      undefined,
      undefined,
      ctx,
    );
    const data = result.details as { results: { id: string; name: string }[] };
    assert(data.results.some((symbol) => symbol.name === "cancelGeneration"));
    assert(result.structuredContent);
    const inspect = extension.tools.get("graph_inspect");
    assert(inspect);
    const detail = await inspect.definition.execute(
      "inspect",
      { id: data.results[0]?.id, neighbors: 2 },
      undefined,
      undefined,
      ctx,
    );
    assert(
      detail.content.some(
        (content) => content.type === "text" && content.text.includes("generation"),
      ),
    );
    const renderer = Object.create(InteractiveMode.prototype) as LabelRenderer;
    assert.deepEqual(renderer.getCompactExtensionLabels([extension]), ["pi-graph"]);
  } finally {
    await shutdown?.();
    await f.cleanup();
  }
});
interface LabelRenderer {
  getCompactExtensionLabel(
    path: string,
    source: { source: string; scope: string; origin: string; baseDir: string },
  ): string;
  getCompactExtensionLabels(extensions: unknown[]): string[];
}
test("pi package loads exactly one root extension and uses a suffix-free package label", async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
  assert(!manifest.dependencies["@earendil-works/pi-coding-agent"]);
  assert(!manifest.dependencies.typebox);
  const f = await fixture({});
  try {
    const loader = new DefaultResourceLoader({
      cwd: f.root,
      agentDir: join(f.root, ".agent"),
      settingsManager: SettingsManager.inMemory({ packages: [packageRoot] }),
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const extension = loaded.extensions[0];
    assert(extension);
    assert.equal(extension.path, join(packageRoot, "index.ts"));
    assert.deepEqual([...extension.tools.keys()].sort(), ["graph_inspect", "graph_locate"]);
    assert(extension.commands.has("graph"));
    const renderer = Object.create(InteractiveMode.prototype) as LabelRenderer;
    const gitSource = {
      source: "git:github.com/CGOSU/pi-graph",
      scope: "user",
      origin: "package",
      baseDir: packageRoot,
    };
    assert.equal(renderer.getCompactExtensionLabel(extension.path, gitSource), "CGOSU/pi-graph");
    assert.equal(
      renderer.getCompactExtensionLabel(join(packageRoot, "src", "index.ts"), gitSource),
      "CGOSU/pi-graph:src",
    );
    const npmSource = { ...gitSource, source: "npm:pi-graph" };
    assert.equal(renderer.getCompactExtensionLabel(extension.path, npmSource), "pi-graph");
    assert.deepEqual(renderer.getCompactExtensionLabels(loaded.extensions), ["pi-graph"]);
  } finally {
    await f.cleanup();
  }
});
