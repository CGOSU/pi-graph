import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fixture } from "./helpers.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
test("production-only Git-style installation builds without host or dev dependencies", async () => {
  const f = await fixture({});
  try {
    const destination = join(f.root, "package");
    await mkdir(destination);
    for (const path of [
      "src",
      "scripts",
      "package.json",
      "package-lock.json",
      "index.ts",
      "tsconfig.json",
      "tsconfig.build.json",
    ])
      await cp(join(packageRoot, path), join(destination, path), { recursive: true });
    await promisify(execFile)(
      process.execPath,
      [
        process.env.npm_execpath ?? "",
        "install",
        "--omit=dev",
        "--legacy-peer-deps",
        "--offline",
        "--no-audit",
        "--no-fund",
      ],
      { cwd: destination, timeout: 60_000 },
    );
    const dependencies = await readdir(join(destination, "node_modules"));
    assert(!dependencies.includes("@earendil-works"));
    assert(!dependencies.includes("typebox"));
    assert(
      (await readFile(join(destination, "dist", "src", "core", "worker.js"), "utf8")).includes(
        "GraphEngine",
      ),
    );
    const loader = new DefaultResourceLoader({
      cwd: f.root,
      agentDir: join(f.root, ".agent"),
      settingsManager: SettingsManager.inMemory({ packages: [destination] }),
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal(loader.getExtensions().extensions.length, 1);
  } finally {
    await f.cleanup();
  }
});
