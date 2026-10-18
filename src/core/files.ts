import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import type { SourceFile } from "./types.js";

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
): Promise<{ files: SourceFile[]; warnings: string[] }> {
  const files: SourceFile[] = [];
  const warnings: string[] = [];
  async function visit(directory: string, inherited: IgnoreRule[]): Promise<void> {
    const rules = [...inherited];
    for (const name of [".gitignore", ".graphignore"]) {
      try {
        rules.push({
          base: directory,
          matcher: ignore().add(await readFile(join(directory, name), "utf8")),
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
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
      try {
        const content = await readFile(absolutePath, "utf8");
        if (content.length > 2_000_000) {
          warnings.push(
            `${normalizePath(relative(root, absolutePath))}: exceeds 2 MB source limit`,
          );
          continue;
        }
        files.push({
          path: normalizePath(relative(root, absolutePath)),
          absolutePath,
          content,
          hash: hashContent(content),
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  await visit(root, []);
  return { files, warnings };
}
