import { join, resolve } from "node:path";
import { RustGraph } from "../languages/rust.js";
import { languageConfiguration, TypeScriptGraph } from "../languages/typescript.js";
import { projectPath, scanSources } from "./files.js";
import { locate, located } from "./retrieval.js";
import { GraphStore } from "./store.js";
import type {
  GraphStatus,
  InspectInput,
  InspectResult,
  LocateInput,
  LocateResult,
  SourceFile,
} from "./types.js";

export class GraphEngine {
  readonly root: string;
  private store: GraphStore;
  private parser = new TypeScriptGraph();
  private sources = new Map<string, SourceFile>();
  private warnings: string[] = [];
  private lastChanged = 0;
  private lastDeleted = 0;
  constructor(root: string, databasePath?: string) {
    this.root = resolve(root);
    this.store = new GraphStore(databasePath ?? join(this.root, ".pi-graph", "index.sqlite"));
  }
  async refresh(force = false): Promise<GraphStatus> {
    const scan = await scanSources(this.root);
    const previous = new Map(this.store.files().map((file) => [file.path, file.hash]));
    const changed = scan.files.filter((file) => previous.get(file.path) !== file.hash);
    const current = new Set(scan.files.map((file) => file.path));
    const deleted = [...previous.keys()].filter((path) => !current.has(path));
    const configHash = `frameworks-v2:rust-v2:${languageConfiguration(this.root).hash}`;
    this.lastChanged = changed.length;
    this.lastDeleted = deleted.length;
    if (
      force ||
      changed.length ||
      deleted.length ||
      this.store.metadata("configHash") !== configHash
    ) {
      const graph = this.parser.build(
        this.root,
        scan.files.filter((file) => !/\.rs$/i.test(file.path)),
      );
      const rust = this.rustParser.build(scan.files.filter((file) => /\.rs$/i.test(file.path)));
      graph.symbols.push(...rust.symbols);
      graph.edges.push(...rust.edges);
      graph.warnings.push(...rust.warnings);
      this.store.commit(scan.files, graph.symbols, graph.edges, configHash);
      this.warnings = [...scan.warnings, ...graph.warnings].slice(0, 12);
    }
    this.sources = new Map(scan.files.map((file) => [file.path, file]));
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
  async locate(input: LocateInput): Promise<LocateResult> {
    await this.refresh();
    return locate(this.store, input, this.warnings);
  }
  async inspect(input: InspectInput): Promise<InspectResult> {
    await this.refresh();
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
    const seen = new Set<string>();
    const neighbors = [];
    for (const edge of relations) {
      const id = edge.source === symbol.id ? edge.target : edge.source;
      if (seen.has(id) || neighbors.length >= neighborLimit) continue;
      seen.add(id);
      const other = this.store.symbol(id);
      if (other) neighbors.push(located(other, 0, `${edge.kind} (${edge.evidence})`, edge));
    }
    const ids = new Set(neighbors.map((neighbor) => neighbor.id));
    const publicSymbol: InspectResult["symbol"] & { document?: string } = { ...symbol };
    delete publicSymbol.document;
    return {
      symbol: publicSymbol,
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
    this.store.close();
  }

  private rustParser = new RustGraph();
}
