import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
function isSourcePath(path: string): boolean {
  return sourcePattern.test(path) && !/\.d\.[cm]?ts$/i.test(path);
}
export interface SourceScan {
  files: SourceFile[];
  warnings: string[];
  directories: Set<string>;
  accepts(path: string, directory: boolean): boolean;
  isCurrent(): boolean;
}
function fileIdentity(path: string): string {
  try {
    const stat = lstatSync(path, { bigint: true });
    return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}
// Match the scanner's exclusions before scheduling work, including deleted directories.
export function relevantSourceChange(root: string, path: string, scan?: SourceScan): boolean {
  path = path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!path) return true; // Missing filenames are not evidence that nothing changed.
  const parts = path.split("/");
  if (parts.some((part) => excluded.has(part))) return false;
  const name = parts.at(-1);
  if (name === ".gitignore" || name === ".graphignore") {
    const parent = parts.slice(0, -1).join("/");
    return !parent || (scan?.accepts(parent, true) ?? true);
  }
  let directory = scan?.directories.has(path) ?? false;
  try {
    const entry = lstatSync(projectPath(root, path));
    if (entry.isSymbolicLink()) return false;
    directory ||= entry.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
  }
  if (!directory && !isSourcePath(path)) return false;
  return scan?.accepts(path, directory) ?? true;
}
// Also handles subdirectory roots and git worktrees whose metadata lives outside the watcher.
export function repositoryHead(root: string): string | undefined {
  const read = (path: string): string => {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  };
  try {
    let directory = root;
    while (true) {
      let git = join(directory, ".git");
      try {
        if (!lstatSync(git).isDirectory()) {
          const target = /^gitdir:\s*(.+)$/m.exec(read(git))?.[1];
          if (!target) return undefined;
          git = resolve(directory, target.trim());
        }
        const head = read(join(git, "HEAD"));
        const common = read(join(git, "commondir")).trim();
        const shared = common ? resolve(git, common) : git;
        const ref = /^ref:\s*(.+)$/m.exec(head)?.[1]?.trim();
        const value = ref ? read(join(shared, ref)) : "";
        // Packed refs matter only when the current branch has no loose ref.
        const packed = ref && !value ? read(join(shared, "packed-refs")) : "";
        return JSON.stringify([git, head, value, packed]);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const parent = dirname(directory);
      if (parent === directory) return "no-git-repository";
      directory = parent;
    }
  } catch {
    // Unreadable metadata cannot justify snapshot reuse.
    return undefined;
  }
}
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
): Promise<SourceScan> {
  const paths: string[] = [];
  const files: SourceFile[] = [];
  const warnings: string[] = [];
  const directories = new Set<string>();
  const directoryRules = new Map<string, IgnoreRule[]>();
  const identities = new Map<string, string>();
  const remember = (path: string) => identities.set(path, fileIdentity(path));
  function accepts(path: string, directory: boolean): boolean {
    const absolutePath = projectPath(root, path);
    let parent = path.split("/").slice(0, -1).join("/");
    while (parent && !directoryRules.has(parent)) parent = parent.split("/").slice(0, -1).join("/");
    let ignored = false;
    for (const { base, matcher } of directoryRules.get(parent) ?? []) {
      const match = matcher.test(
        normalizePath(relative(base, absolutePath)) + (directory ? "/" : ""),
      );
      if (match.ignored) ignored = true;
      else if (match.unignored) ignored = false;
    }
    return !ignored;
  }
  async function visit(directory: string, inherited: IgnoreRule[]): Promise<void> {
    cancellation?.throwIfAborted();
    // Capture before reading: an edit during asynchronous I/O must invalidate the snapshot.
    remember(directory);
    const rules = [...inherited];
    for (const name of [".gitignore", ".graphignore"]) {
      cancellation?.throwIfAborted();
      remember(join(directory, name));
      try {
        rules.push({
          base: directory,
          matcher: ignore().add(await readFile(join(directory, name), "utf8")),
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const local = normalizePath(relative(root, directory));
    directories.add(local);
    directoryRules.set(local, rules);
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
      if (!entry.isFile() || !isSourcePath(entry.name)) continue;
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
        remember(absolutePath);
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
  return {
    files: files.filter(Boolean),
    warnings: warnings.filter(Boolean),
    directories,
    accepts,
    isCurrent() {
      try {
        for (const [path, identity] of identities)
          if (fileIdentity(path) !== identity) return false;
        return true;
      } catch {
        return false;
      }
    },
  };
}
