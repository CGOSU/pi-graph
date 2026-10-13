import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FileRecord, GraphEdge, GraphSymbol } from "./types.js";

interface SymbolRow {
  data: string;
  id: string;
}
export class GraphStore {
  private db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS symbols (id TEXT PRIMARY KEY, path TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS symbols_path ON symbols(path); CREATE TABLE IF NOT EXISTS edges (source TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(source,target,kind)); CREATE INDEX IF NOT EXISTS edges_target ON edges(target); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE VIRTUAL TABLE IF NOT EXISTS documents USING fts5(id UNINDEXED, document, tokenize='unicode61');",
    );
  }
  files(): FileRecord[] {
    return this.db.prepare("SELECT path, hash FROM files").all() as unknown as FileRecord[];
  }
  metadata(key: string): string | undefined {
    return (
      this.db.prepare("SELECT value FROM metadata WHERE key=?").get(key) as
        | { value: string }
        | undefined
    )?.value;
  }
  symbol(id: string): GraphSymbol | undefined {
    const row = this.db.prepare("SELECT data FROM symbols WHERE id=?").get(id) as
      | SymbolRow
      | undefined;
    return row ? (JSON.parse(row.data) as GraphSymbol) : undefined;
  }
  commit(
    files: FileRecord[],
    symbols: GraphSymbol[],
    edges: GraphEdge[],
    configHash: string,
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = new Map(
        (this.db.prepare("SELECT id,data FROM symbols").all() as unknown as SymbolRow[]).map(
          (row) => [row.id, row.data],
        ),
      );
      const upsert = this.db.prepare(
        "INSERT INTO symbols(id,path,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,data=excluded.data",
      );
      const addDocument = this.db.prepare("INSERT INTO documents(id,document) VALUES (?,?)");
      const removeDocument = this.db.prepare("DELETE FROM documents WHERE id=?");
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
      const removeSymbol = this.db.prepare("DELETE FROM symbols WHERE id=?");
      for (const id of old.keys()) {
        removeSymbol.run(id);
        removeDocument.run(id);
      }
      this.db.exec("DELETE FROM edges; DELETE FROM files;");
      const addFile = this.db.prepare("INSERT INTO files(path,hash) VALUES (?,?)");
      for (const file of files) addFile.run(file.path, file.hash);
      const addEdge = this.db.prepare(
        "INSERT INTO edges(source,target,kind,data) VALUES (?,?,?,?)",
      );
      for (const edge of edges)
        addEdge.run(edge.source, edge.target, edge.kind, JSON.stringify(edge));
      const metadata = this.db.prepare(
        "INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
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
  search(terms: string[], scope?: string): GraphSymbol[] {
    if (!terms.length) return [];
    const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    const escapedScope = scope?.replace(/[\\%_]/g, "\\$&");
    const rows = this.db
      .prepare(
        "SELECT s.data FROM documents d JOIN symbols s ON s.id=d.id WHERE documents MATCH ? AND (? IS NULL OR s.path=? OR s.path LIKE ? ESCAPE '\\') ORDER BY bm25(documents) LIMIT 80",
      )
      .all(
        match,
        scope ?? null,
        scope ?? null,
        escapedScope ? `${escapedScope}/%` : null,
      ) as unknown as SymbolRow[];
    return rows.map((row) => JSON.parse(row.data) as GraphSymbol);
  }
  neighbors(id: string, limit = 24): GraphEdge[] {
    const rows = this.db
      .prepare(
        "SELECT data FROM edges WHERE source=? OR target=? ORDER BY CASE kind WHEN 'calls' THEN 0 WHEN 'references' THEN 1 ELSE 2 END,source,target LIMIT ?",
      )
      .all(id, id, limit) as unknown as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as GraphEdge);
  }
  counts(): { files: number; symbols: number; edges: number } {
    const count = (table: string) =>
      Number(
        (this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
          .count,
      );
    return { files: count("files"), symbols: count("symbols"), edges: count("edges") };
  }
  close(): void {
    this.db.close();
  }
}
