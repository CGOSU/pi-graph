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
export class GraphStore {
  private db: DatabaseSync;
  private statements = new Map<string, StatementSync>();
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS symbols (id TEXT PRIMARY KEY, path TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS symbols_path ON symbols(path); CREATE TABLE IF NOT EXISTS edges (source TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(source,target,kind)); CREATE INDEX IF NOT EXISTS edges_target ON edges(target); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE VIRTUAL TABLE IF NOT EXISTS documents USING fts5(id UNINDEXED, document, tokenize='unicode61');",
    );
  }
  private prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
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
    const addDocument = this.prepare("INSERT INTO documents(id,document) VALUES (?,?)");
    const removeDocument = this.prepare("DELETE FROM documents WHERE id=?");
    for (const symbol of symbols) {
      const data = JSON.stringify(symbol);
      const previous = old.get(symbol.id);
      old.delete(symbol.id);
      if (previous === data) continue;
      upsert.run(symbol.id, symbol.path, data);
      if (!previous || (JSON.parse(previous) as GraphSymbol).document !== symbol.document) {
        removeDocument.run(symbol.id);
        addDocument.run(symbol.id, symbol.document);
      }
    }
    const removeSymbol = this.prepare("DELETE FROM symbols WHERE id=?");
    for (const id of old.keys()) {
      removeSymbol.run(id);
      removeDocument.run(id);
    }
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
  search(terms: string[], scope?: string): GraphSymbol[] {
    if (!terms.length) return [];
    const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    const escapedScope = scope?.replace(/[\\%_]/g, "\\$&");
    const rows = this.prepare(
      "SELECT s.data FROM documents d JOIN symbols s ON s.id=d.id WHERE documents MATCH ? AND (? IS NULL OR s.path=? OR s.path LIKE ? ESCAPE '\\') ORDER BY bm25(documents) LIMIT 80",
    ).all(
      match,
      scope ?? null,
      scope ?? null,
      escapedScope ? `${escapedScope}/%` : null,
    ) as unknown as SymbolRow[];
    return rows.map((row) => JSON.parse(row.data) as GraphSymbol);
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
