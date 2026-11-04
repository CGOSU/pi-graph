import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { FileRecord, GraphEdge, GraphSymbol } from "./types.js";

interface SymbolRow {
  data: string;
  id: string;
}
interface EdgeRow {
  source: string;
  target: string;
  kind: string;
  data: string;
}
function edgeKey(edge: Pick<GraphEdge, "source" | "target" | "kind"> | EdgeRow): string {
  return JSON.stringify([edge.source, edge.target, edge.kind]);
}

const scopePredicate = "s.path=? OR (s.path>=? AND s.path<?)";
function scopeBounds(scope: string): [string, string, string] {
  // In SQLite's BINARY collation, '0' immediately follows '/'.
  return [scope, `${scope}/`, `${scope}0`];
}

export class GraphStore {
  private db: DatabaseSync;
  private statements = new Map<string, StatementSync>();
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS symbols (id TEXT PRIMARY KEY, path TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS symbols_path ON symbols(path); CREATE TABLE IF NOT EXISTS edges (source TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(source,target,kind)); CREATE INDEX IF NOT EXISTS edges_target ON edges(target); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE VIRTUAL TABLE IF NOT EXISTS documents USING fts5(id UNINDEXED, document, tokenize='unicode61');",
      );
      this.initializeNames();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  private initializeNames(): void {
    const nameTable = this.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='symbol_names'",
    );
    if (nameTable.get()) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // A concurrent opener may have already migrated the index while we waited for the lock.
      if (!nameTable.get()) {
        this.db.exec(`CREATE TABLE symbol_names (
          symbol_id TEXT NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          folded_name TEXT NOT NULL,
          qualified INTEGER NOT NULL,
          PRIMARY KEY(symbol_id, qualified)
        ) WITHOUT ROWID`);
        for (const row of this.prepare("SELECT data FROM symbols").iterate()) {
          this.insertNames(JSON.parse(row.data as string) as GraphSymbol);
        }
        this.db.exec("CREATE INDEX symbol_names_folded ON symbol_names(folded_name, name)");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private insertNames({ id, name, qualifiedName }: GraphSymbol): void {
    const insert = this.prepare(
      "INSERT INTO symbol_names(symbol_id,name,folded_name,qualified) VALUES (?,?,?,?)",
    );
    insert.run(id, name, name.toLowerCase(), 0);
    if (qualifiedName !== name) insert.run(id, qualifiedName, qualifiedName.toLowerCase(), 1);
  }
  files(): FileRecord[] {
    return this.prepare("SELECT path, hash FROM files").all() as unknown as FileRecord[];
  }
  metadata(key: string): string | undefined {
    return (
      this.prepare("SELECT value FROM metadata WHERE key=?").get(key) as
        | { value: string }
        | undefined
    )?.value;
  }
  warnings(): string[] | undefined {
    const value = this.metadata("warnings");
    if (value === undefined) return undefined;
    try {
      const warnings: unknown = JSON.parse(value);
      return Array.isArray(warnings) && warnings.every((item) => typeof item === "string")
        ? warnings
        : undefined;
    } catch {
      return undefined;
    }
  }
  symbol(id: string): GraphSymbol | undefined {
    const row = this.prepare("SELECT data FROM symbols WHERE id=?").get(id) as
      | SymbolRow
      | undefined;
    return row ? (JSON.parse(row.data) as GraphSymbol) : undefined;
  }
  symbols(ids: string[]): Map<string, GraphSymbol> {
    if (!ids.length) return new Map();
    const rows = this.prepare(
      "SELECT id,data FROM symbols WHERE id IN (SELECT value FROM json_each(?))",
    ).all(JSON.stringify(ids)) as unknown as SymbolRow[];
    return new Map(rows.map((row) => [row.id, JSON.parse(row.data) as GraphSymbol]));
  }
  commit(
    files: FileRecord[],
    symbols: GraphSymbol[],
    edges: GraphEdge[],
    configHash: string,
    warnings: string[] = [],
    scanWarnings: string[] = [],
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.writeSymbols(symbols);
      this.writeFiles(files);
      this.writeEdges(edges);
      const metadata = this.prepare(
        "INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value",
      );
      metadata.run("revision", String(Number(this.metadata("revision") ?? "0") + 1));
      metadata.run("indexedAt", new Date().toISOString());
      metadata.run("configHash", configHash);
      metadata.run("warnings", JSON.stringify(warnings));
      metadata.run("scanWarnings", JSON.stringify(scanWarnings));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private writeSymbols(symbols: GraphSymbol[]): void {
    const old = new Map(
      (this.prepare("SELECT id,data FROM symbols").all() as unknown as SymbolRow[]).map((row) => [
        row.id,
        row.data,
      ]),
    );
    const upsert = this.prepare(
      "INSERT INTO symbols(id,path,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,data=excluded.data",
    );
    const removeNames = this.prepare("DELETE FROM symbol_names WHERE symbol_id=?");
    const addDocument = this.prepare("INSERT INTO documents(id,document) VALUES (?,?)");
    const removedDocuments: string[] = [];
    const changedDocuments: GraphSymbol[] = [];
    for (const symbol of symbols) {
      const data = JSON.stringify(symbol);
      const previous = old.get(symbol.id);
      old.delete(symbol.id);
      if (previous === data) continue;
      upsert.run(symbol.id, symbol.path, data);
      const previousSymbol =
        previous === undefined ? undefined : (JSON.parse(previous) as GraphSymbol);
      if (
        !previousSymbol ||
        previousSymbol.name !== symbol.name ||
        previousSymbol.qualifiedName !== symbol.qualifiedName
      ) {
        if (previousSymbol) removeNames.run(symbol.id);
        this.insertNames(symbol);
      }
      if (previousSymbol?.document !== symbol.document) {
        if (previousSymbol) removedDocuments.push(symbol.id);
        changedDocuments.push(symbol);
      }
    }
    const removeSymbol = this.prepare("DELETE FROM symbols WHERE id=?");
    for (const id of old.keys()) {
      removeSymbol.run(id);
      removedDocuments.push(id);
    }
    if (removedDocuments.length) {
      // FTS5 cannot index id equality: batch removals into one scan, not one per symbol.
      this.prepare("DELETE FROM documents WHERE id IN (SELECT value FROM json_each(?))").run(
        JSON.stringify(removedDocuments),
      );
    }
    for (const symbol of changedDocuments) addDocument.run(symbol.id, symbol.document);
  }
  private writeFiles(files: FileRecord[]): void {
    const old = new Map(this.files().map((file) => [file.path, file.hash]));
    const add = this.prepare("INSERT INTO files(path,hash) VALUES (?,?)");
    const update = this.prepare("UPDATE files SET hash=? WHERE path=?");
    const remove = this.prepare("DELETE FROM files WHERE path=?");
    for (const file of files) {
      const previous = old.get(file.path);
      old.delete(file.path);
      if (previous === undefined) add.run(file.path, file.hash);
      else if (previous !== file.hash) update.run(file.hash, file.path);
    }
    for (const path of old.keys()) remove.run(path);
  }
  private writeEdges(edges: GraphEdge[]): void {
    const old = new Map(
      (this.prepare("SELECT source,target,kind,data FROM edges").all() as unknown as EdgeRow[]).map(
        (row) => [edgeKey(row), row],
      ),
    );
    const add = this.prepare("INSERT INTO edges(source,target,kind,data) VALUES (?,?,?,?)");
    const update = this.prepare("UPDATE edges SET data=? WHERE source=? AND target=? AND kind=?");
    const remove = this.prepare("DELETE FROM edges WHERE source=? AND target=? AND kind=?");
    for (const edge of edges) {
      const key = edgeKey(edge);
      const previous = old.get(key);
      old.delete(key);
      const data = JSON.stringify(edge);
      if (!previous) add.run(edge.source, edge.target, edge.kind, data);
      else if (previous.data !== data) update.run(data, edge.source, edge.target, edge.kind);
    }
    for (const edge of old.values()) remove.run(edge.source, edge.target, edge.kind);
  }
  search(terms: string[], scope?: string, identifiers: string[] = []): GraphSymbol[] {
    const symbols = new Map<string, GraphSymbol>();
    const rows = [...this.searchText(terms, scope), ...this.searchNames(terms, identifiers, scope)];
    for (const row of rows) {
      const symbol = JSON.parse(row.data) as GraphSymbol;
      symbols.set(symbol.id, symbol);
    }
    return [...symbols.values()];
  }
  private searchText(terms: string[], scope?: string): SymbolRow[] {
    if (!terms.length) return [];
    const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    // With a scope, FTS rank can sort the entire corpus before the path filter fills the limit.
    const scopeFilter = scope ? ` AND (${scopePredicate})` : "";
    const order = scope ? "bm25(documents)" : "d.rank";
    return this.prepare(
      `SELECT s.data FROM documents d JOIN symbols s ON s.id=d.id
       WHERE documents MATCH ?${scopeFilter} ORDER BY ${order} LIMIT 80`,
    ).all(match, ...(scope ? scopeBounds(scope) : [])) as unknown as SymbolRow[];
  }
  private searchNames(terms: string[], identifiers: string[], scope?: string): SymbolRow[] {
    if (!terms.length && !identifiers.length) return [];
    const foldedNames = identifiers.map((name) => name.toLowerCase());
    const hints = terms.slice(0, 32).map((term) => term.toLowerCase());
    const foldedCandidates = [...new Set([...foldedNames, ...hints])];
    const scopeFilter = scope ? ` WHERE ${scopePredicate}` : "";
    return this.prepare(
      `WITH matches AS (
         SELECT symbol_id, max(CASE
           WHEN name IN (SELECT value FROM json_each(?)) THEN 3 + qualified
           WHEN folded_name IN (SELECT value FROM json_each(?)) THEN 1 + qualified
           ELSE 0 END) AS priority
         FROM symbol_names
         WHERE folded_name IN (SELECT value FROM json_each(?))
         GROUP BY symbol_id
       )
       SELECT s.data FROM matches JOIN symbols s ON s.id=matches.symbol_id${scopeFilter}
       ORDER BY matches.priority DESC,
         CASE json_extract(s.data,'$.kind') WHEN 'function' THEN 0 WHEN 'method' THEN 0 ELSE 1 END,
         s.id LIMIT 40`,
    ).all(
      JSON.stringify(identifiers),
      JSON.stringify(foldedNames),
      JSON.stringify(foldedCandidates),
      ...(scope ? scopeBounds(scope) : []),
    ) as unknown as SymbolRow[];
  }
  containers(ids: string[]): GraphEdge[] {
    if (!ids.length) return [];
    const rows = this.prepare(
      "SELECT e.data FROM edges e JOIN symbols s ON s.id=e.target WHERE e.kind='contains' AND e.target IN (SELECT value FROM json_each(?)) AND e.source=json_extract(s.data,'$.parentId')",
    ).all(JSON.stringify(ids)) as unknown as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as GraphEdge);
  }
  neighbors(id: string, limit = 24): GraphEdge[] {
    const rows = this.prepare(
      "SELECT data FROM edges WHERE source=? OR target=? ORDER BY CASE kind WHEN 'calls' THEN 0 WHEN 'references' THEN 1 ELSE 2 END,source,target LIMIT ?",
    ).all(id, id, limit) as unknown as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as GraphEdge);
  }
  counts(): { files: number; symbols: number; edges: number } {
    const row = this.prepare(
      "SELECT (SELECT COUNT(*) FROM files) AS files,(SELECT COUNT(*) FROM symbols) AS symbols,(SELECT COUNT(*) FROM edges) AS edges",
    ).get() as unknown as { files: number; symbols: number; edges: number };
    return { files: row.files, symbols: row.symbols, edges: row.edges };
  }
  close(): void {
    this.db.close();
  }
}
