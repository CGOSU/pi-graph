import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import type { GraphCancellation, SourceFile } from "./types.js";

const excluded = new Set([
  "node_modules",
  ".git",
  ".pi-graph",
  ".empryo",
  ".pi",
  "dist",
  "build",
  "coverage",
  ".next",
  ".cache",
  "target",
]);
const sourcePattern = /\.(?:[cm]?[jt]sx?|rs|vue)$/i;
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
export function normalizePath(path: string): string {
  return path.split(sep).join("/");
}
export function safeScope(scope: string | undefined): string | undefined {
  if (!scope) return undefined;
  const normalized = scope.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (isAbsolute(scope) || /^[a-z]:/i.test(normalized) || normalized.split("/").includes(".."))
    throw new Error("scope must be a repository-relative path");
  return normalized;
}
export function projectPath(root: string, path: string): string {
  const absolute = resolve(root, path);
  const local = relative(root, absolute);
  if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`))
    throw new Error("Path outside repository");
  return absolute;
}
interface IgnoreRule {
  base: string;
  matcher: Ignore;
}
export async function scanSources(
  root: string,
  cancellation?: GraphCancellation,
): Promise<{ files: SourceFile[]; warnings: string[] }> {
  const paths: string[] = [];
  const files: SourceFile[] = [];
  const warnings: string[] = [];
  async function visit(directory: string, inherited: IgnoreRule[]): Promise<void> {
    cancellation?.throwIfAborted();
    const rules = [...inherited];
    for (const name of [".gitignore", ".graphignore"]) {
      cancellation?.throwIfAborted();
      try {
        rules.push({
          base: directory,
          matcher: ignore().add(await readFile(join(directory, name), "utf8")),
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    cancellation?.throwIfAborted();
    const entries = await readdir(directory, { withFileTypes: true });
    cancellation?.throwIfAborted();
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      cancellation?.throwIfAborted();
      if (entry.isSymbolicLink() || excluded.has(entry.name)) continue;
      const absolutePath = join(directory, entry.name);
      const suffix = entry.isDirectory() ? "/" : "";
      let ignored = false;
      for (const { base, matcher } of rules) {
        const match = matcher.test(normalizePath(relative(base, absolutePath)) + suffix);
        if (match.ignored) ignored = true;
        else if (match.unignored) ignored = false;
      }
      if (ignored) continue;
      if (entry.isDirectory()) {
        await visit(absolutePath, rules);
        continue;
      }
      if (!entry.isFile() || !sourcePattern.test(entry.name) || /\.d\.[cm]?ts$/.test(entry.name))
        continue;
      paths.push(absolutePath);
    }
  }
  await visit(root, []);
  let next = 0;
  async function readSources(): Promise<void> {
    while (next < paths.length) {
      cancellation?.throwIfAborted();
      const index = next++;
      const absolutePath = paths[index];
      if (!absolutePath) continue;
      try {
        const content = await readFile(absolutePath, "utf8");
        cancellation?.throwIfAborted();
        if (content.length > 2_000_000) {
          warnings[index] =
            `${normalizePath(relative(root, absolutePath))}: exceeds 2 MB source limit`;
          continue;
        }
        files[index] = {
          path: normalizePath(relative(root, absolutePath)),
          absolutePath,
          content,
          hash: hashContent(content),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  const reads = await Promise.allSettled(
    Array.from({ length: Math.min(8, paths.length) }, () => readSources()),
  );
  const failed = reads.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  cancellation?.throwIfAborted();
  return { files: files.filter(Boolean), warnings: warnings.filter(Boolean) };
}
