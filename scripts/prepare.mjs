import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = join(root, "src");
const outputRoot = join(root, "dist", "src");
const outputs = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile() && entry.name.endsWith(".ts")) {
      const result = ts.transpileModule(await readFile(path, "utf8"), {
        fileName: path,
        reportDiagnostics: true,
        compilerOptions: {
          target: ts.ScriptTarget.ES2023,
          module: ts.ModuleKind.ESNext,
          verbatimModuleSyntax: true,
        },
      });
      const errors = (result.diagnostics ?? []).filter(
        (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
      );
      if (errors.length)
        throw new Error(
          errors
            .map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"))
            .join("\n"),
        );
      outputs.push({
        path: join(outputRoot, `${relative(sourceRoot, path).slice(0, -3)}.js`),
        text: result.outputText,
      });
    }
  }
}
await collect(sourceRoot);
await rm(outputRoot, { recursive: true, force: true });
for (const output of outputs) {
  await mkdir(dirname(output.path), { recursive: true });
  await writeFile(output.path, output.text);
}
console.log(
  `Prepared ${outputs.length} runtime modules (typechecking runs separately in development).`,
);
