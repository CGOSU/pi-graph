import { join, resolve } from "node:path";
import type { RustGraph } from "../languages/rust.js";
import type { SyntaxGraph } from "../languages/syntax.js";
import type { LanguageConfiguration, TypeScriptGraph } from "../languages/typescript.js";
import {
  fileIdentity,
  hashContent,
  hydrateSourceFiles,
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

const SYNTAX_VERSION = "syntax-v4";
const TS_VERSION = "frameworks-v5";
const RUST_VERSION = "rust-wasm-v3";
const CONFIG_VERSION = `${SYNTAX_VERSION}:${TS_VERSION}:${RUST_VERSION}`;

interface DomainWarnings {
  ts: string[];
  rust: string[];
  syntax: Record<string, string[]>;
}
interface DomainVersions {
  ts: string;
  rust: string;
  syntax: string;
}
interface WatchedEntry {
  path: string;
  stat: string;
}

function isRustPath(path: string): boolean {
  return /\.rs$/i.test(path);
}

function isSyntaxPath(path: string): boolean {
  return /\.(?:dart|go|kts?)$/i.test(path);
}

function isTsPath(path: string): boolean {
  return !isRustPath(path) && !isSyntaxPath(path);
}

function isWatchedCurrent(entries: WatchedEntry[] | undefined): boolean {
  if (!entries?.length) return false;
  for (const entry of entries) {
    if (fileIdentity(entry.path) !== entry.stat) return false;
  }
  return true;
}

function readWatched(raw: string | undefined): WatchedEntry[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every(
        (item) =>
          item !== null &&
          typeof item === "object" &&
          typeof (item as WatchedEntry).path === "string" &&
          typeof (item as WatchedEntry).stat === "string",
      )
    ) {
      return parsed as WatchedEntry[];
    }
    return undefined;
  } catch {
    return undefined;
  }
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

function readDomainVersions(raw: string | undefined): DomainVersions | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<DomainVersions>;
    if (
      typeof parsed.ts === "string" &&
      typeof parsed.rust === "string" &&
      typeof parsed.syntax === "string"
    ) {
      return { ts: parsed.ts, rust: parsed.rust, syntax: parsed.syntax };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export class GraphEngine {
  readonly root: string;
  private store: GraphStore;
  private parser?: TypeScriptGraph;
  private rustParser?: RustGraph;
  private syntaxParser?: SyntaxGraph;
  private cachedConfig?: LanguageConfiguration;
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
  private async getConfigSnapshot(): Promise<{
    configHash: string;
    tsConfigHash: string;
    watched: WatchedEntry[];
    config?: LanguageConfiguration;
  }> {
    if (this.cachedConfig && isWatchedCurrent(this.cachedConfig.watched)) {
      return {
        configHash: `${CONFIG_VERSION}:${this.cachedConfig.hash}`,
        tsConfigHash: `${TS_VERSION}:${this.cachedConfig.hash}`,
        watched: this.cachedConfig.watched ?? [],
        config: this.cachedConfig,
      };
    }
    const storedHash = this.store.metadata("configHash");
    const storedPrefix = storedHash?.split(":").slice(0, 3).join(":");
    const storedWatched = readWatched(this.store.metadata("configWatched"));
    if (storedHash && storedPrefix === CONFIG_VERSION && isWatchedCurrent(storedWatched)) {
      const rawHash = storedHash.slice(CONFIG_VERSION.length + 1);
      return {
        configHash: storedHash,
        tsConfigHash: `${TS_VERSION}:${rawHash}`,
        watched: storedWatched ?? [],
      };
    }
    const { languageConfiguration } = await import("../languages/typescript.js");
    this.cachedConfig = languageConfiguration(this.root);
    return {
      configHash: `${CONFIG_VERSION}:${this.cachedConfig.hash}`,
      tsConfigHash: `${TS_VERSION}:${this.cachedConfig.hash}`,
      watched: this.cachedConfig.watched ?? [],
      config: this.cachedConfig,
    };
  }
  private async ensureConfig(): Promise<LanguageConfiguration> {
    if (this.cachedConfig && isWatchedCurrent(this.cachedConfig.watched)) {
      return this.cachedConfig;
    }
    const { languageConfiguration } = await import("../languages/typescript.js");
    this.cachedConfig = languageConfiguration(this.root);
    return this.cachedConfig;
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
    const configSnap = await this.getConfigSnapshot();
    const configHash = configSnap.configHash;
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
    const storedFiles = this.store.files();
    const canReuseStat =
      !force &&
      this.watching &&
      storedFiles.length > 0 &&
      (!this.scan || (now >= this.lastScan && now - this.lastScan < 30_000));
    const knownFiles = canReuseStat
      ? new Map(storedFiles.map((file) => [file.path, file]))
      : undefined;
    const scan = await scanSources(
      this.root,
      cancellation,
      knownFiles ? { knownFiles } : undefined,
    );
    cancellation?.throwIfAborted();
    const retryIfChanged = (): Promise<GraphStatus> | undefined => {
      if (
        scan.isCurrent() &&
        repositoryHead(this.root) === head &&
        isWatchedCurrent(configSnap.watched)
      )
        return;
      if (attempt >= 2) throw new Error("Sources changed while indexing; retry the graph query.");
      return this.refreshCurrent(force, cancellation, attempt + 1);
    };
    const retry = retryIfChanged();
    if (retry) return retry;
    const previous = new Map(storedFiles.map((file) => [file.path, file.hash]));
    const changed = scan.files.filter((file) => previous.get(file.path) !== file.hash);
    const current = new Set(scan.files.map((file) => file.path));
    const deleted = [...previous.keys()].filter((path) => !current.has(path));
    cancellation?.throwIfAborted();
    const storedDomainWarnings = readDomainWarnings(this.store.metadata("domainWarnings"));
    const storedDomainVersions = readDomainVersions(this.store.metadata("domainVersions"));
    const currentDomainVersions: DomainVersions = {
      ts: configSnap.tsConfigHash,
      rust: RUST_VERSION,
      syntax: SYNTAX_VERSION,
    };
    const storedConfigHash = this.store.metadata("configHash");
    const configChanged = storedConfigHash !== configHash;
    const storedPrefix = storedConfigHash?.split(":").slice(0, 3).join(":");
    const versionMismatch = storedPrefix !== CONFIG_VERSION;
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
      !storedDomainWarnings ||
      !storedDomainVersions
    ) {
      const fullRebuild =
        force ||
        versionMismatch ||
        warningsMissing ||
        !storedDomainWarnings ||
        !storedDomainVersions;
      const tsConfigChanged = !fullRebuild && storedDomainVersions.ts !== currentDomainVersions.ts;
      const tsDirty =
        fullRebuild ||
        tsConfigChanged ||
        changed.some((file) => isTsPath(file.path)) ||
        deleted.some(isTsPath);
      const rustDirty =
        fullRebuild ||
        storedDomainVersions.rust !== currentDomainVersions.rust ||
        changed.some((file) => isRustPath(file.path)) ||
        deleted.some(isRustPath);
      const syntaxDirty =
        fullRebuild ||
        storedDomainVersions.syntax !== currentDomainVersions.syntax ||
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
        await hydrateSourceFiles(tsFiles, cancellation);
        const { TypeScriptGraph } = await import("../languages/typescript.js");
        const resolvedConfig = configSnap.config ?? (await this.ensureConfig());
        this.parser ??= new TypeScriptGraph();
        const tsChangedPaths = tsConfigChanged
          ? new Set(tsFiles.map((file) => file.path))
          : new Set(changed.filter((file) => isTsPath(file.path)).map((file) => file.path));
        const tsDeletedPaths = deleted.filter(isTsPath);
        const ts = this.parser.build(this.root, tsFiles, resolvedConfig, {
          dirtyPaths: tsChangedPaths,
          deletedPaths: tsDeletedPaths,
        });
        if (
          scopePaths &&
          !tsConfigChanged &&
          ts.scopePaths !== undefined &&
          ts.deltaSymbols &&
          ts.deltaEdges
        ) {
          scopePaths.push(...ts.scopePaths);
          symbols.push(...ts.deltaSymbols);
          edges.push(...ts.deltaEdges);
        } else {
          if (scopePaths) {
            scopePaths.push(...tsFiles.map((file) => file.path), ...tsDeletedPaths);
          }
          symbols.push(...ts.symbols);
          edges.push(...ts.edges);
        }
        domainWarnings.ts = ts.warnings;
        // Synchronous compilers cannot be preempted; cancellation is checked between phases.
        cancellation?.throwIfAborted();
      }

      if (rustDirty) {
        const rustFiles = scan.files.filter((file) => isRustPath(file.path));
        await hydrateSourceFiles(rustFiles, cancellation);
        if (scopePaths) {
          scopePaths.push(...rustFiles.map((file) => file.path), ...deleted.filter(isRustPath));
        }
        if (!this.rustParser) {
          const { RustGraph } = await import("../languages/rust.js");
          this.rustParser = new RustGraph();
        }
        const rust = await this.rustParser.build(rustFiles);
        symbols.push(...rust.symbols);
        edges.push(...rust.edges);
        domainWarnings.rust = rust.warnings;
        cancellation?.throwIfAborted();
      }

      if (syntaxDirty) {
        const syntaxFull =
          fullRebuild ||
          (storedDomainVersions && storedDomainVersions.syntax !== currentDomainVersions.syntax);
        const syntaxInput = syntaxFull
          ? scan.files.filter((file) => isSyntaxPath(file.path))
          : changed.filter((file) => isSyntaxPath(file.path));
        await hydrateSourceFiles(syntaxInput, cancellation);
        const syntaxDeleted = deleted.filter(isSyntaxPath);
        if (syntaxFull) {
          domainWarnings.syntax = {};
          if (scopePaths) {
            scopePaths.push(...syntaxInput.map((file) => file.path), ...syntaxDeleted);
          }
        } else if (scopePaths) {
          scopePaths.push(...syntaxInput.map((file) => file.path), ...syntaxDeleted);
        }
        if (!this.syntaxParser) {
          const { SyntaxGraph } = await import("../languages/syntax.js");
          this.syntaxParser = new SyntaxGraph();
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
        extraMetadata: {
          domainWarnings: JSON.stringify(domainWarnings),
          domainVersions: JSON.stringify(currentDomainVersions),
          configWatched: JSON.stringify(configSnap.watched),
        },
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
    let symbol = this.store.symbol(input.id);
    if (!symbol) throw new Error("Symbol not found in current index; run graph_locate again.");
    projectPath(this.root, symbol.path);
    let file = this.sources.get(symbol.path);
    if (!file) throw new Error("Source no longer indexed; run graph_locate again.");
    if (file.contentLoaded === false) {
      await hydrateSourceFiles([file], cancellation);
      const expectedHash = this.store.fileHash(symbol.path);
      if (expectedHash && hashContent(file.content) !== expectedHash) {
        await this.refresh(true, cancellation);
        symbol = this.store.symbol(input.id);
        if (!symbol) throw new Error("Symbol not found in current index; run graph_locate again.");
        file = this.sources.get(symbol.path);
        if (!file) throw new Error("Source no longer indexed; run graph_locate again.");
        await hydrateSourceFiles([file], cancellation);
      }
    }
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
      if (other) {
        const relationLabel =
          edge.source === symbol.id
            ? `${edge.kind} (${edge.evidence})`
            : `${edge.kind === "calls" ? "called by" : edge.kind === "references" ? "referenced by" : "contained in"} (${edge.evidence})`;
        neighbors.push(located(other, 0, relationLabel, edge));
      }
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
    this.rustParser?.close();
    this.syntaxParser?.close();
    this.store.close();
  }
}
