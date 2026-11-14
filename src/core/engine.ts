import { join, resolve } from "node:path";
import { RustGraph } from "../languages/rust.js";
import { SyntaxGraph } from "../languages/syntax.js";
import { syntaxLanguage } from "../languages/tree-sitter.js";
import { languageConfiguration, TypeScriptGraph } from "../languages/typescript.js";
import {
  projectPath,
  relevantSourceChange,
  repositoryHead,
  type SourceScan,
  scanSources,
} from "./files.js";
import { locate, located } from "./retrieval.js";
import { GraphStore } from "./store.js";
import type {
  GraphCancellation,
  GraphEdge,
  GraphStatus,
  GraphSymbol,
  InspectInput,
  InspectResult,
  LocateInput,
  LocateResult,
  SourceFile,
} from "./types.js";

const CONFIG_VERSION = "syntax-v3:frameworks-v4:rust-wasm-v2";

interface DomainWarnings {
  ts: string[];
  rust: string[];
  syntax: Record<string, string[]>;
}

function isRustPath(path: string): boolean {
  return /\.rs$/i.test(path);
}

function isSyntaxPath(path: string): boolean {
  return Boolean(syntaxLanguage(path));
}

function isTsPath(path: string): boolean {
  return !isRustPath(path) && !isSyntaxPath(path);
}

function readDomainWarnings(raw: string | undefined): DomainWarnings | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<DomainWarnings>;
    if (
      Array.isArray(parsed.ts) &&
      Array.isArray(parsed.rust) &&
      parsed.syntax !== null &&
      typeof parsed.syntax === "object" &&
      !Array.isArray(parsed.syntax)
    ) {
      return {
        ts: parsed.ts,
        rust: parsed.rust,
        syntax: parsed.syntax as Record<string, string[]>,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export class GraphEngine {
  readonly root: string;
  private store: GraphStore;
  private parser = new TypeScriptGraph();
  private sources = new Map<string, SourceFile>();
  private warnings: string[] = [];
  private lastChanged = 0;
  private lastDeleted = 0;
  private refreshTail: Promise<void> = Promise.resolve();
  private watching = false;
  private changes = 0;
  private scannedChanges = -1;
  private lastScan = 0;
  private publishedRevision = 0;
  private head: string | undefined;
  private scan?: SourceScan;
  constructor(root: string, databasePath?: string) {
    this.root = resolve(root);
    this.store = new GraphStore(databasePath ?? join(this.root, ".pi-graph", "index.sqlite"));
    this.warnings = this.store.warnings() ?? [];
  }
  setWatching(active: boolean): void {
    this.watching = active;
    this.changes++;
  }
  sourceChanged(path: string): boolean {
    if (!relevantSourceChange(this.root, path, this.scan)) return false;
    this.changes++;
    return true;
  }
  refresh(force = false, cancellation?: GraphCancellation): Promise<GraphStatus> {
    const pending = this.refreshTail.then(() => this.refreshCurrent(force, cancellation));
    this.refreshTail = pending.then(
      () => {},
      () => {},
    );
    return pending;
  }
  private async refreshCurrent(
    force: boolean,
    cancellation?: GraphCancellation,
    attempt = 0,
  ): Promise<GraphStatus> {
    cancellation?.throwIfAborted();
    const config = languageConfiguration(this.root);
    const configHash = `${CONFIG_VERSION}:${config.hash}`;
    const head = repositoryHead(this.root);
    const now = Date.now();
    if (
      !force &&
      this.watching &&
      this.scan &&
      this.scannedChanges === this.changes &&
      now >= this.lastScan &&
      now - this.lastScan < 30_000 &&
      this.publishedRevision === Number(this.store.metadata("revision")) &&
      this.store.metadata("configHash") === configHash &&
      head !== undefined &&
      head === this.head &&
      this.scan.isCurrent()
    ) {
      this.lastChanged = 0;
      this.lastDeleted = 0;
      return this.status();
    }
    const changes = this.changes;
    const scan = await scanSources(this.root, cancellation);
    cancellation?.throwIfAborted();
    const retryIfChanged = (): Promise<GraphStatus> | undefined => {
      if (
        scan.isCurrent() &&
        repositoryHead(this.root) === head &&
        `${CONFIG_VERSION}:${languageConfiguration(this.root).hash}` === configHash
      )
        return;
      if (attempt >= 2) throw new Error("Sources changed while indexing; retry the graph query.");
      return this.refreshCurrent(force, cancellation, attempt + 1);
    };
    const retry = retryIfChanged();
    if (retry) return retry;
    const previous = new Map(this.store.files().map((file) => [file.path, file.hash]));
    const changed = scan.files.filter((file) => previous.get(file.path) !== file.hash);
    const current = new Set(scan.files.map((file) => file.path));
    const deleted = [...previous.keys()].filter((path) => !current.has(path));
    cancellation?.throwIfAborted();
    const storedDomainWarnings = readDomainWarnings(this.store.metadata("domainWarnings"));
    const configChanged = this.store.metadata("configHash") !== configHash;
    const warningsMissing = this.store.warnings() === undefined;
    const scanWarningsChanged =
      JSON.stringify(scan.warnings) !== this.store.metadata("scanWarnings");
    if (
      force ||
      changed.length ||
      deleted.length ||
      configChanged ||
      warningsMissing ||
      scanWarningsChanged ||
      !storedDomainWarnings
    ) {
      const fullRebuild = force || configChanged || warningsMissing || !storedDomainWarnings;
      const tsDirty =
        fullRebuild || changed.some((file) => isTsPath(file.path)) || deleted.some(isTsPath);
      const rustDirty =
        fullRebuild || changed.some((file) => isRustPath(file.path)) || deleted.some(isRustPath);
      const syntaxDirty =
        fullRebuild ||
        changed.some((file) => isSyntaxPath(file.path)) ||
        deleted.some(isSyntaxPath);

      const symbols: GraphSymbol[] = [];
      const edges: GraphEdge[] = [];
      const domainWarnings: DomainWarnings = storedDomainWarnings
        ? {
            ts: [...storedDomainWarnings.ts],
            rust: [...storedDomainWarnings.rust],
            syntax: { ...storedDomainWarnings.syntax },
          }
        : { ts: [], rust: [], syntax: {} };
      const scopePaths = fullRebuild ? undefined : ([] as string[]);

      if (tsDirty) {
        const tsFiles = scan.files.filter((file) => isTsPath(file.path));
        if (scopePaths) {
          scopePaths.push(...tsFiles.map((file) => file.path), ...deleted.filter(isTsPath));
        }
        const ts = this.parser.build(this.root, tsFiles, config);
        symbols.push(...ts.symbols);
        edges.push(...ts.edges);
        domainWarnings.ts = ts.warnings;
        // Synchronous compilers cannot be preempted; cancellation is checked between phases.
        cancellation?.throwIfAborted();
      }

      if (rustDirty) {
        const rustFiles = scan.files.filter((file) => isRustPath(file.path));
        if (scopePaths) {
          scopePaths.push(...rustFiles.map((file) => file.path), ...deleted.filter(isRustPath));
        }
        const rust = await this.rustParser.build(rustFiles);
        symbols.push(...rust.symbols);
        edges.push(...rust.edges);
        domainWarnings.rust = rust.warnings;
        cancellation?.throwIfAborted();
      }

      if (syntaxDirty) {
        const syntaxInput = fullRebuild
          ? scan.files.filter((file) => isSyntaxPath(file.path))
          : changed.filter((file) => isSyntaxPath(file.path));
        const syntaxDeleted = deleted.filter(isSyntaxPath);
        if (fullRebuild) domainWarnings.syntax = {};
        else if (scopePaths) {
          scopePaths.push(...syntaxInput.map((file) => file.path), ...syntaxDeleted);
        }
        const syntax = await this.syntaxParser.update(syntaxInput, syntaxDeleted);
        for (const path of syntaxDeleted) delete domainWarnings.syntax[path];
        for (const [path, fileGraph] of syntax.files) {
          symbols.push(...fileGraph.symbols);
          edges.push(...fileGraph.edges);
          if (fileGraph.warnings.length) domainWarnings.syntax[path] = fileGraph.warnings;
          else delete domainWarnings.syntax[path];
        }
        cancellation?.throwIfAborted();
      }

      const retry = retryIfChanged();
      if (retry) return retry;
      // Commit and in-memory publication must finish together once the transaction starts.
      const warnings = [
        ...scan.warnings,
        ...domainWarnings.ts,
        ...domainWarnings.rust,
        ...Object.values(domainWarnings.syntax).flat(),
      ].slice(0, 12);
      this.store.commit(scan.files, symbols, edges, configHash, warnings, scan.warnings, {
        scopePaths,
        extraMetadata: { domainWarnings: JSON.stringify(domainWarnings) },
      });
      this.warnings = warnings;
    } else {
      this.warnings = this.store.warnings() ?? [];
    }
    this.lastChanged = changed.length;
    this.lastDeleted = deleted.length;
    this.sources = new Map(scan.files.map((file) => [file.path, file]));
    this.scan = scan;
    this.scannedChanges = changes;
    this.lastScan = now;
    this.head = head;
    this.publishedRevision = Number(this.store.metadata("revision"));
    return this.status();
  }
  status(): GraphStatus {
    return {
      root: this.root,
      ...this.store.counts(),
      revision: Number(this.store.metadata("revision") ?? 0),
      indexedAt: this.store.metadata("indexedAt") ?? null,
      changedFiles: this.lastChanged,
      deletedFiles: this.lastDeleted,
      warnings: this.warnings,
    };
  }
  async locate(input: LocateInput, cancellation?: GraphCancellation): Promise<LocateResult> {
    await this.refresh(false, cancellation);
    cancellation?.throwIfAborted();
    return locate(this.store, input, this.warnings);
  }
  async inspect(input: InspectInput, cancellation?: GraphCancellation): Promise<InspectResult> {
    await this.refresh(false, cancellation);
    cancellation?.throwIfAborted();
    const symbol = this.store.symbol(input.id);
    if (!symbol) throw new Error("Symbol not found in current index; run graph_locate again.");
    projectPath(this.root, symbol.path);
    const file = this.sources.get(symbol.path);
    if (!file) throw new Error("Source no longer indexed; run graph_locate again.");
    const maxCharacters = input.maxCharacters ?? 8000;
    const neighborLimit = input.neighbors ?? 6;
    if (!Number.isInteger(maxCharacters) || maxCharacters < 200 || maxCharacters > 20000)
      throw new Error("maxCharacters must be an integer from 200 to 20000");
    if (!Number.isInteger(neighborLimit) || neighborLimit < 0 || neighborLimit > 10)
      throw new Error("neighbors must be an integer from 0 to 10");
    const text = file.content.slice(symbol.start, symbol.end);
    const relations = neighborLimit ? this.store.neighbors(symbol.id, 32) : [];
    const related = this.store.symbols([
      ...new Set(relations.map((edge) => (edge.source === symbol.id ? edge.target : edge.source))),
    ]);
    const seen = new Set<string>();
    const neighbors = [];
    for (const edge of relations) {
      const id = edge.source === symbol.id ? edge.target : edge.source;
      if (seen.has(id) || neighbors.length >= neighborLimit) continue;
      seen.add(id);
      const other = related.get(id);
      if (other) neighbors.push(located(other, 0, `${edge.kind} (${edge.evidence})`, edge));
    }
    const ids = new Set(neighbors.map((neighbor) => neighbor.id));
    return {
      symbol,
      source: text.slice(0, maxCharacters),
      truncated: text.length > maxCharacters,
      neighbors,
      relations: relations.filter((edge) =>
        ids.has(edge.source === symbol.id ? edge.target : edge.source),
      ),
      revision: Number(this.store.metadata("revision") ?? 0),
    };
  }
  close(): void {
    this.rustParser.close();
    this.syntaxParser.close();
    this.store.close();
  }

  private rustParser = new RustGraph();
  private syntaxParser = new SyntaxGraph();
}
