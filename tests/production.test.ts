import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fixture } from "./helpers.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
test("production-only Git-style installation builds without host, dev, or native dependencies", async () => {
  const source = "// 中文🌏\npub fn android_probe() {}";
  const f = await fixture({
    "project/src/lib.rs": source,
    "project/view.dart": "void dartProbe() {}\n",
    "project/core.go": "package core\nfunc GoProbe() {}\n",
    "project/service.kt":
      "private class Resource : AutoCloseable {\n var open = true\n override fun close() { open = false }\n}\nfun kotlinProbe() {}\n",
  });
  try {
    const destination = join(f.root, "package");
    await mkdir(destination);
    for (const path of [
      "src",
      "scripts",
      "grammars",
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
        "--os=android",
        "--cpu=arm64",
      ],
      { cwd: destination, timeout: 60_000 },
    );
    const packed = await promisify(execFile)(
      process.execPath,
      [process.env.npm_execpath ?? "", "pack", "--dry-run", "--json", "--ignore-scripts"],
      { cwd: destination, timeout: 60_000 },
    );
    type Package = { files: { path: string }[] };
    const raw: Package[] | Record<string, Package> = JSON.parse(packed.stdout);
    const packages = Array.isArray(raw) ? raw : Object.values(raw);
    const paths = packages[0]?.files.map((file) => file.path) ?? [];
    for (const path of [
      "grammars/dart.wasm",
      "grammars/kotlin.wasm",
      "grammars/dart.LICENSE",
      "grammars/dart-upstream.LICENSE",
      "grammars/kotlin.LICENSE",
      "grammars/kotlin-open-identifier.patch",
      "grammars/sources.json",
    ])
      assert(paths.includes(path), `Published package must include ${path}`);
    const dependencies = await readdir(join(destination, "node_modules"));
    assert(!dependencies.includes("@earendil-works"));
    assert(!dependencies.includes("typebox"));
    const nativeAddons = (
      await readdir(join(destination, "node_modules"), { recursive: true })
    ).filter((path) => path.endsWith(".node"));
    assert.deepEqual(nativeAddons, [], "Android installation must not require native Node addons");
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
    const installed: typeof import("../src/core/client.js") = await import(
      pathToFileURL(join(destination, "dist", "src", "core", "client.js")).href
    );
    const project = join(f.root, "project");
    const client = new installed.GraphClient(project);
    try {
      const located = await client.locate({ query: "android_probe" });
      const symbol = located.results.find((item) => item.name === "android_probe");
      assert(symbol);
      assert.equal((await client.inspect({ id: symbol.id })).source, "pub fn android_probe() {}");
      for (const name of ["dartProbe", "GoProbe", "kotlinProbe"]) {
        const result = await client.locate({ query: name });
        const found = result.results.find((item) => item.name === name);
        assert(found, name);
        assert.deepEqual(result.warnings, []);
        assert((await client.inspect({ id: found.id })).source.includes(`${name}()`));
      }
    } finally {
      await client.close();
    }

    const grammar = join(
      destination,
      "node_modules",
      "@vscode",
      "tree-sitter-wasm",
      "wasm",
      "tree-sitter-rust.wasm",
    );
    const recovery = new installed.GraphClient(project);
    try {
      await rename(grammar, `${grammar}.missing`);
      await assert.rejects(recovery.rebuild(), /ENOENT.*tree-sitter-rust\.wasm/);
      await rename(`${grammar}.missing`, grammar);
      await recovery.rebuild();
      const located = await recovery.locate({ query: "android_probe" });
      assert(located.results.some((item) => item.name === "android_probe"));
    } finally {
      await recovery.close();
    }
    for (const language of ["dart", "kotlin"]) {
      const asset = join(destination, "grammars", `${language}.wasm`);
      const original = await readFile(asset);
      const invalid = new installed.GraphClient(project);
      try {
        await rename(asset, `${asset}.missing`);
        await assert.rejects(invalid.rebuild(), new RegExp(`ENOENT.*${language}\\.wasm`));
        await rename(`${asset}.missing`, asset);
        await writeFile(asset, "corrupt grammar");
        await assert.rejects(invalid.rebuild(), /grammar checksum mismatch/);
        await writeFile(asset, original);
        await invalid.rebuild();
        const name = language === "dart" ? "dartProbe" : "kotlinProbe";
        assert((await invalid.locate({ query: name })).results.some((item) => item.name === name));
      } finally {
        await writeFile(asset, original);
        await invalid.close();
      }
    }
  } finally {
    await f.cleanup();
  }
});
