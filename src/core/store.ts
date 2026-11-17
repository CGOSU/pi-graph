import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { unicodeTokens } from "./text.js";
import type { FileRecord, GraphEdge, GraphSymbol, PublicSymbol } from "./types.js";

interface SymbolRow {
  data: string;
  document: string;
  id: string;
}
interface SymbolRecordRow {
  id: string;
  data: string;
  document: string;
}
interface EdgeRow {
  source: string;
  target: string;
  kind: string;
  data: string;
}
export interface CommitOptions {
  scopePaths?: string[];
  extraMetadata?: Record<string, string>;
}
export interface SearchContext {
  symbols: GraphSymbol[];
  docFreqs: Map<string, number>;
  totalSymbols: number;
  expansions: Map<string, string[]>;
}
function edgeKey(edge: Pick<GraphEdge, "source" | "target" | "kind"> | EdgeRow): string {
  return JSON.stringify([edge.source, edge.target, edge.kind]);
}
function encodeSymbol({ document, ...publicSymbol }: GraphSymbol): {
  data: string;
  document: string;
} {
  return { data: JSON.stringify(publicSymbol), document };
}
function decodeSymbol(data: string, document: string): GraphSymbol {
  return { ...(JSON.parse(data) as PublicSymbol), document };
}
function isCallableKind(kind: string): number {
  return kind === "function" || kind === "method" ? 1 : 0;
}
function qualifiedAlias(name: string, qualifiedName: string): string | undefined {
  if (qualifiedName === name || !qualifiedName.includes("::")) return undefined;
  const parts = qualifiedName.split("::");
  if (parts.length < 2) return undefined;
  const tail = parts.slice(-2).join("::");
  const normalized = tail.replace(/\s+as\s+[^:]+::/, "::");
  if (normalized !== qualifiedName && normalized !== name && normalized.includes("::"))
    return normalized;
  const asIndex = qualifiedName.indexOf(" as ");
  if (asIndex !== -1) {
    const typePart = qualifiedName.slice(0, asIndex).split("::").at(-1);
    const memberPart = qualifiedName.slice(asIndex).split("::").slice(1).join("::");
    if (typePart && memberPart) {
      const candidate = `${typePart}::${memberPart}`;
      if (candidate !== qualifiedName && candidate !== name) return candidate;
    }
  }
  return undefined;
}
function escapeFtsTerm(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}
function safeMorphologicalSuffix(term: string, candidate: string): boolean {
  if (candidate === term) return true;
  if (!candidate.startsWith(term) || candidate.length > term.length + 8) return false;
  if (term.length >= 5) return true;
  const suffix = candidate.slice(term.length);
  return /^(?:s|es|ed|ing|er|ers|d|ly)$/.test(suffix);
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
        "CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, hash TEXT NOT NULL, stat TEXT NOT NULL DEFAULT ''); CREATE TABLE IF NOT EXISTS symbols (id TEXT PRIMARY KEY, path TEXT NOT NULL, data TEXT NOT NULL, document TEXT NOT NULL DEFAULT ''); CREATE INDEX IF NOT EXISTS symbols_path ON symbols(path); CREATE TABLE IF NOT EXISTS edges (source TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(source,target,kind)); CREATE INDEX IF NOT EXISTS edges_target ON edges(target); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE VIRTUAL TABLE IF NOT EXISTS documents USING fts5(id UNINDEXED, document, tokenize='unicode61'); CREATE VIRTUAL TABLE IF NOT EXISTS documents_vocab USING fts5vocab(documents, col);",
      );
      this.migrateFilesStat();
      this.migrateSymbolsDocument();
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
  private hasColumn(table: string, columnName: string): boolean {
    const columns = this.prepare(`PRAGMA table_info(${table})`).all() as unknown as {
      name: string;
    }[];
    return columns.some((column) => column.name === columnName);
  }
  private migrateFilesStat(): void {
    if (this.hasColumn("files", "stat")) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.hasColumn("files", "stat")) {
        this.db.exec("ALTER TABLE files ADD COLUMN stat TEXT NOT NULL DEFAULT ''");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private migrateSymbolsDocument(): void {
    if (this.hasColumn("symbols", "document")) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.hasColumn("symbols", "document")) {
        this.db.exec("ALTER TABLE symbols ADD COLUMN document TEXT NOT NULL DEFAULT ''");
        const update = this.prepare("UPDATE symbols SET data=?, document=? WHERE id=?");
        for (const row of this.prepare("SELECT id, data FROM symbols").iterate() as Iterable<{
          id: string;
          data: string;
        }>) {
          const parsed = JSON.parse(row.data) as Record<string, unknown>;
          const document = typeof parsed.document === "string" ? parsed.document : "";
          delete parsed.document;
          delete parsed.summary;
          delete parsed.hash;
          update.run(JSON.stringify(parsed), document, row.id);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private initializeNames(): void {
    const nameTable = this.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='symbol_names'",
    );
    if (!nameTable.get()) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        // A concurrent opener may have already migrated the index while we waited for the lock.
        if (!nameTable.get()) {
          this.db.exec(`CREATE TABLE symbol_names (
            symbol_id TEXT NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            folded_name TEXT NOT NULL,
            qualified INTEGER NOT NULL,
            callable INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(symbol_id, qualified)
          ) WITHOUT ROWID`);
          for (const row of this.prepare("SELECT data FROM symbols").iterate()) {
            this.insertNames(JSON.parse(row.data as string) as GraphSymbol);
          }
          this.db.exec(
            "CREATE INDEX symbol_names_folded ON symbol_names(folded_name, qualified DESC, callable DESC, symbol_id, name); CREATE INDEX symbol_names_exact ON symbol_names(name, qualified DESC, callable DESC, symbol_id);",
          );
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      return;
    }
    if (this.hasColumn("symbol_names", "callable")) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.hasColumn("symbol_names", "callable")) {
        this.db.exec("ALTER TABLE symbol_names ADD COLUMN callable INTEGER NOT NULL DEFAULT 0");
        this.db.exec(
          "UPDATE symbol_names SET callable = COALESCE((SELECT CASE WHEN json_extract(s.data,'$.kind') IN ('function','method') THEN 1 ELSE 0 END FROM symbols s WHERE s.id=symbol_names.symbol_id), 0)",
        );
        this.db.exec(
          "DROP INDEX IF EXISTS symbol_names_folded; CREATE INDEX symbol_names_folded ON symbol_names(folded_name, qualified DESC, callable DESC, symbol_id, name); CREATE INDEX IF NOT EXISTS symbol_names_exact ON symbol_names(name, qualified DESC, callable DESC, symbol_id);",
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private insertNames({
    id,
    name,
    qualifiedName,
    kind,
  }: Pick<GraphSymbol, "id" | "name" | "qualifiedName" | "kind">): void {
    const insert = this.prepare(
      "INSERT INTO symbol_names(symbol_id,name,folded_name,qualified,callable) VALUES (?,?,?,?,?)",
    );
    const callable = isCallableKind(kind);
    insert.run(id, name, name.toLowerCase(), 0, callable);
    if (qualifiedName !== name)
      insert.run(id, qualifiedName, qualifiedName.toLowerCase(), 2, callable);
    const alias = qualifiedAlias(name, qualifiedName);
    if (alias) insert.run(id, alias, alias.toLowerCase(), 1, callable);
  }
  files(): FileRecord[] {
    return this.prepare("SELECT path, hash, stat FROM files").all() as unknown as FileRecord[];
  }
  fileHash(path: string): string | undefined {
    return (
      this.prepare("SELECT hash FROM files WHERE path=?").get(path) as { hash: string } | undefined
    )?.hash;
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
  symbol(id: string): PublicSymbol | undefined {
    const row = this.prepare("SELECT data FROM symbols WHERE id=?").get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as PublicSymbol) : undefined;
  }
  symbols(ids: string[]): Map<string, GraphSymbol> {
    if (!ids.length) return new Map();
    const rows = this.prepare(
      "SELECT id,data,document FROM symbols WHERE id IN (SELECT value FROM json_each(?))",
    ).all(JSON.stringify(ids)) as unknown as SymbolRow[];
    return new Map(rows.map((row) => [row.id, decodeSymbol(row.data, row.document)]));
  }
  commit(
    files: FileRecord[],
    symbols: GraphSymbol[],
    edges: GraphEdge[],
    configHash: string,
    warnings: string[] = [],
    scanWarnings: string[] = [],
    options?: CommitOptions,
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Remove/diff edges before symbols so scoped JOINs still see deleted symbol paths.
      this.writeEdges(edges, options?.scopePaths);
      this.writeSymbols(symbols, options?.scopePaths);
      this.writeFiles(files);
      const metadata = this.prepare(
        "INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value",
      );
      metadata.run("revision", String(Number(this.metadata("revision") ?? "0") + 1));
      metadata.run("indexedAt", new Date().toISOString());
      metadata.run("configHash", configHash);
      metadata.run("warnings", JSON.stringify(warnings));
      metadata.run("scanWarnings", JSON.stringify(scanWarnings));
      if (options?.extraMetadata) {
        for (const [key, value] of Object.entries(options.extraMetadata)) metadata.run(key, value);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private writeSymbols(symbols: GraphSymbol[], scopePaths?: string[]): void {
    const rows = (scopePaths
      ? this.prepare(
          "SELECT id,data,document FROM symbols WHERE path IN (SELECT value FROM json_each(?))",
        ).all(JSON.stringify(scopePaths))
      : this.prepare("SELECT id,data,document FROM symbols").all()) as unknown as SymbolRecordRow[];
    const old = new Map(rows.map((row) => [row.id, row]));
    const upsert = this.prepare(
      "INSERT INTO symbols(id,path,data,document) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,data=excluded.data,document=excluded.document",
    );
    const removeNames = this.prepare("DELETE FROM symbol_names WHERE symbol_id=?");
    const addDocument = this.prepare("INSERT INTO documents(id,document) VALUES (?,?)");
    const removedDocuments: string[] = [];
    const changedDocuments: { id: string; document: string }[] = [];
    for (const symbol of symbols) {
      const { data, document } = encodeSymbol(symbol);
      const previous = old.get(symbol.id);
      old.delete(symbol.id);
      if (previous && previous.data === data && previous.document === document) continue;
      upsert.run(symbol.id, symbol.path, data, document);
      if (!previous) {
        this.insertNames(symbol);
        changedDocuments.push({ id: symbol.id, document });
        continue;
      }
      if (previous.data !== data) {
        const previousSymbol = JSON.parse(previous.data) as PublicSymbol;
        if (
          previousSymbol.name !== symbol.name ||
          previousSymbol.qualifiedName !== symbol.qualifiedName ||
          isCallableKind(previousSymbol.kind) !== isCallableKind(symbol.kind)
        ) {
          removeNames.run(symbol.id);
          this.insertNames(symbol);
        }
      }
      if (previous.document !== document) {
        removedDocuments.push(symbol.id);
        changedDocuments.push({ id: symbol.id, document });
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
    for (const entry of changedDocuments) addDocument.run(entry.id, entry.document);
  }
  private writeFiles(files: FileRecord[]): void {
    const old = new Map(this.files().map((file) => [file.path, file]));
    const add = this.prepare("INSERT INTO files(path,hash,stat) VALUES (?,?,?)");
    const update = this.prepare("UPDATE files SET hash=?,stat=? WHERE path=?");
    const remove = this.prepare("DELETE FROM files WHERE path=?");
    for (const file of files) {
      const previous = old.get(file.path);
      old.delete(file.path);
      const nextStat = file.stat ?? previous?.stat ?? "";
      if (!previous) add.run(file.path, file.hash, nextStat);
      else if (
        previous.hash !== file.hash ||
        (file.stat !== undefined && previous.stat !== file.stat)
      )
        update.run(file.hash, nextStat, file.path);
    }
    for (const path of old.keys()) remove.run(path);
  }
  private writeEdges(edges: GraphEdge[], scopePaths?: string[]): void {
    const rows = (scopePaths
      ? this.prepare(
          "SELECT e.source,e.target,e.kind,e.data FROM edges e JOIN symbols s ON s.id=e.source WHERE s.path IN (SELECT value FROM json_each(?))",
        ).all(JSON.stringify(scopePaths))
      : this.prepare("SELECT source,target,kind,data FROM edges").all()) as unknown as EdgeRow[];
    const old = new Map(rows.map((row) => [edgeKey(row), row]));
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
    return this.searchWithContext(
      terms.map((term) => [term]),
      scope,
      identifiers,
      false,
    ).symbols;
  }
  searchWithContext(
    groups: string[][],
    scope?: string,
    identifiers: string[] = [],
    expandPrefixes = true,
  ): SearchContext {
    const terms = [...new Set(groups.flat())].slice(0, 32);
    const totalSymbols =
      (this.prepare("SELECT COUNT(*) AS count FROM symbols").get() as { count: number } | undefined)
        ?.count ?? 0;
    const { docFreqs, expansions } = this.vocabStats(terms, expandPrefixes);
    const expandedGroups = groups
      .map((group) => {
        const out = new Set<string>();
        for (const term of group) {
          out.add(term);
          for (const extra of expansions.get(term) ?? []) out.add(extra);
        }
        return [...out];
      })
      .filter((group) => group.length);

    const symbols = new Map<string, GraphSymbol>();
    if (scope !== undefined) {
      const bounds = scopeBounds(scope);
      const probe = this.prepare(`SELECT 1 FROM symbols s WHERE ${scopePredicate} LIMIT 2501`).all(
        ...bounds,
      );
      if (probe.length === 0) {
        return { symbols: [], docFreqs, totalSymbols, expansions };
      }
      if (probe.length <= 2500 && terms.every((term) => /^[\p{L}\p{N}_-]+$/u.test(term))) {
        const scopedRows = this.prepare(
          `SELECT id,data,document FROM symbols s WHERE ${scopePredicate}`,
        ).all(...bounds) as unknown as SymbolRow[];
        return {
          symbols: this.searchScopedInMemory(
            scopedRows,
            expandedGroups,
            terms,
            identifiers,
            docFreqs,
            totalSymbols,
          ),
          docFreqs,
          totalSymbols,
          expansions,
        };
      }
    }

    const textRows = this.searchText(expandedGroups, scope, docFreqs);
    const nameRows = this.searchNames(terms, identifiers, scope);
    for (const row of [...textRows, ...nameRows]) {
      if (symbols.has(row.id)) continue;
      symbols.set(row.id, decodeSymbol(row.data, row.document));
    }
    return { symbols: [...symbols.values()], docFreqs, totalSymbols, expansions };
  }
  private vocabStats(
    terms: string[],
    expandPrefixes: boolean,
  ): { docFreqs: Map<string, number>; expansions: Map<string, string[]> } {
    const docFreqs = new Map<string, number>();
    const expansions = new Map<string, string[]>();
    if (!terms.length) return { docFreqs, expansions };
    const normalized = [...new Set(terms.map((term) => term.toLowerCase()))];
    const rows = this.prepare(
      "SELECT term, doc FROM documents_vocab WHERE term IN (SELECT value FROM json_each(?))",
    ).all(JSON.stringify(normalized)) as unknown as { term: string; doc: number }[];
    for (const row of rows) docFreqs.set(row.term, row.doc);

    if (expandPrefixes) {
      const rangeStmt = this.prepare(
        "SELECT term, doc FROM documents_vocab WHERE term >= ? AND term < ? LIMIT 8",
      );
      for (const term of normalized) {
        if (!/^[a-z]{4,}$/.test(term)) continue;
        const last = term.charCodeAt(term.length - 1);
        const upper = term.slice(0, -1) + String.fromCharCode(last + 1);
        const matches = rangeStmt.all(term, upper) as unknown as { term: string; doc: number }[];
        const variants: string[] = [];
        for (const match of matches) {
          if (match.term === term) continue;
          if (!safeMorphologicalSuffix(term, match.term)) continue;
          variants.push(match.term);
          if (!docFreqs.has(match.term)) docFreqs.set(match.term, match.doc);
        }
        if (variants.length) expansions.set(term, variants);
      }
    }
    return { docFreqs, expansions };
  }
  private searchScopedInMemory(
    rows: SymbolRow[],
    groups: string[][],
    terms: string[],
    identifiers: string[],
    docFreqs: Map<string, number>,
    totalSymbols: number,
  ): GraphSymbol[] {
    const decoded = new Map<string, GraphSymbol>();
    const decodeRow = (row: SymbolRow): GraphSymbol => {
      let sym = decoded.get(row.id);
      if (!sym) {
        sym = decodeSymbol(row.data, row.document);
        decoded.set(row.id, sym);
      }
      return sym;
    };
    const textScored: { symbol: GraphSymbol; score: number }[] = [];
    const activeGroups = groups
      .map((group) => group.flatMap((term) => unicodeTokens(term)).filter(Boolean))
      .filter((group) => group.length > 0);
    if (activeGroups.length) {
      const flatNeedles = [...new Set(activeGroups.flat())];
      for (const row of rows) {
        const docLower = row.document.toLowerCase();
        if (!flatNeedles.some((needle) => docLower.includes(needle))) continue;
        const docTokens = new Set(
          // Fast path for pre-tokenized ASCII documents without combining marks.
          /[^\x20-\x7e]/.test(row.document)
            ? unicodeTokens(row.document)
            : docLower.split(/[^a-z0-9]+/).filter(Boolean),
        );
        let hits = 0;
        let weight = 0;
        for (const group of activeGroups) {
          const hit = group.find((word) => docTokens.has(word));
          if (!hit) continue;
          hits++;
          const df = docFreqs.get(hit) ?? 1;
          weight += Math.log2(1 + Math.max(1, totalSymbols) / (1 + df));
        }
        if (hits > 0) {
          const lengthNorm = 1 / Math.sqrt(Math.max(4, docTokens.size));
          textScored.push({ symbol: decodeRow(row), score: hits * 10 + weight * lengthNorm });
        }
      }
      textScored.sort((a, b) => b.score - a.score || a.symbol.id.localeCompare(b.symbol.id));
    }

    const identSet = new Set(identifiers);
    const foldedSet = new Set(identifiers.map((name) => name.toLowerCase()));
    const hintSet = new Set(terms.slice(0, 32).map((term) => term.toLowerCase()));
    const nameScored: { symbol: GraphSymbol; priority: number; callable: number }[] = [];
    if (identSet.size || hintSet.size) {
      for (const row of rows) {
        const symbol = decodeRow(row);
        const tail = qualifiedAlias(symbol.name, symbol.qualifiedName);
        let priority = -1;
        if (symbol.qualifiedName !== symbol.name && identSet.has(symbol.qualifiedName))
          priority = 6;
        else if (tail && identSet.has(tail)) priority = 5;
        else if (identSet.has(symbol.name)) priority = 4;
        else if (
          symbol.qualifiedName !== symbol.name &&
          foldedSet.has(symbol.qualifiedName.toLowerCase())
        )
          priority = 3;
        else if (tail && foldedSet.has(tail.toLowerCase())) priority = 2;
        else if (foldedSet.has(symbol.name.toLowerCase())) priority = 1;
        else if (
          hintSet.has(symbol.name.toLowerCase()) ||
          hintSet.has(symbol.qualifiedName.toLowerCase()) ||
          (tail && hintSet.has(tail.toLowerCase()))
        )
          priority = 0;
        if (priority >= 0) {
          nameScored.push({ symbol, priority, callable: isCallableKind(symbol.kind) });
        }
      }
      nameScored.sort(
        (a, b) =>
          b.priority - a.priority ||
          b.callable - a.callable ||
          (a.symbol.id < b.symbol.id ? -1 : a.symbol.id > b.symbol.id ? 1 : 0),
      );
    }

    const result = new Map<string, GraphSymbol>();
    for (const item of textScored.slice(0, 80)) result.set(item.symbol.id, item.symbol);
    for (const item of nameScored.slice(0, 40)) {
      if (!result.has(item.symbol.id)) result.set(item.symbol.id, item.symbol);
    }
    return [...result.values()];
  }
  private searchText(
    groups: string[][],
    scope: string | undefined,
    docFreqs: Map<string, number>,
  ): SymbolRow[] {
    const presentGroups = groups
      .map((group) =>
        group.filter((term) => {
          const normalized = term.toLowerCase();
          return !/^[\p{L}\p{N}]+$/u.test(normalized) || (docFreqs.get(normalized) ?? 0) > 0;
        }),
      )
      .filter((group) => group.length > 0);
    if (!presentGroups.length) return [];

    const scopeFilter = scope ? ` AND (${scopePredicate})` : "";
    const order = scope ? "bm25(documents)" : "d.rank";
    const queryFts = this.prepare(
      `SELECT s.id,s.data,s.document FROM documents d JOIN symbols s ON s.id=d.id
       WHERE documents MATCH ?${scopeFilter} ORDER BY ${order} LIMIT 80`,
    );
    const bounds = scope ? scopeBounds(scope) : [];

    const collected = new Map<string, SymbolRow>();
    if (presentGroups.length >= 2) {
      const rankedGroups = [...presentGroups]
        .map((group) => ({
          group,
          minDoc: Math.min(
            ...group.map((term) => docFreqs.get(term.toLowerCase()) ?? Number.MAX_SAFE_INTEGER),
          ),
        }))
        .sort((a, b) => a.minDoc - b.minDoc);
      const topGroups = rankedGroups.slice(
        0,
        rankedGroups.length >= 3 && (rankedGroups[2]?.minDoc ?? 0) <= 500 ? 3 : 2,
      );
      const andExpr = topGroups
        .map(({ group }) => `(${group.map(escapeFtsTerm).join(" OR ")})`)
        .join(" AND ");
      for (const row of queryFts.all(andExpr, ...bounds) as unknown as SymbolRow[]) {
        collected.set(row.id, row);
      }
      if (collected.size >= 80) return [...collected.values()];
    }

    const allTerms = [...new Set(presentGroups.flat())];
    const orExpr = allTerms.map(escapeFtsTerm).join(" OR ");
    for (const row of queryFts.all(orExpr, ...bounds) as unknown as SymbolRow[]) {
      if (!collected.has(row.id)) {
        collected.set(row.id, row);
        if (collected.size >= 80) break;
      }
    }
    return [...collected.values()];
  }
  private searchNames(terms: string[], identifiers: string[], scope?: string): SymbolRow[] {
    if (!terms.length && !identifiers.length) return [];
    const foldedNames = identifiers.map((name) => name.toLowerCase());
    const hints = terms.slice(0, 32).map((term) => term.toLowerCase());
    if (!scope && identifiers.length <= 16 && hints.length <= 32) {
      return this.searchNamesFast(identifiers, foldedNames, hints);
    }
    const foldedCandidates = [...new Set([...foldedNames, ...hints])];
    const scopeFilter = scope ? ` WHERE ${scopePredicate}` : "";
    return this.prepare(
      `WITH matches AS (
         SELECT symbol_id, max(CASE
           WHEN name IN (SELECT value FROM json_each(?)) THEN 4 + qualified
           WHEN folded_name IN (SELECT value FROM json_each(?)) THEN 1 + qualified
           ELSE 0 END) AS priority,
           max(callable) AS callable
         FROM symbol_names
         WHERE folded_name IN (SELECT value FROM json_each(?))
         GROUP BY symbol_id
       )
       SELECT s.id,s.data,s.document FROM matches JOIN symbols s ON s.id=matches.symbol_id${scopeFilter}
       ORDER BY matches.priority DESC, matches.callable DESC, s.id LIMIT 40`,
    ).all(
      JSON.stringify(identifiers),
      JSON.stringify(foldedNames),
      JSON.stringify(foldedCandidates),
      ...(scope ? scopeBounds(scope) : []),
    ) as unknown as SymbolRow[];
  }
  private searchNamesFast(
    identifiers: string[],
    foldedNames: string[],
    hints: string[],
  ): SymbolRow[] {
    const byId = new Map<string, { priority: number; callable: number }>();
    const record = (symbolId: string, priority: number, callable: number) => {
      const existing = byId.get(symbolId);
      if (!existing || priority > existing.priority) byId.set(symbolId, { priority, callable });
    };
    const exactStmt = this.prepare(
      "SELECT symbol_id, qualified, callable FROM symbol_names WHERE name=? ORDER BY qualified DESC, callable DESC, symbol_id LIMIT 40",
    );
    for (const ident of identifiers) {
      const rows = exactStmt.all(ident) as unknown as {
        symbol_id: string;
        qualified: number;
        callable: number;
      }[];
      for (const row of rows) record(row.symbol_id, 4 + row.qualified, row.callable);
    }
    const foldedStmt = this.prepare(
      "SELECT symbol_id, qualified, callable FROM symbol_names WHERE folded_name=? ORDER BY qualified DESC, callable DESC, symbol_id LIMIT 40",
    );
    for (const folded of new Set(foldedNames)) {
      const rows = foldedStmt.all(folded) as unknown as {
        symbol_id: string;
        qualified: number;
        callable: number;
      }[];
      for (const row of rows) record(row.symbol_id, 1 + row.qualified, row.callable);
    }
    if (byId.size < 40) {
      const foldedSet = new Set(foldedNames);
      const hintTierStmt = this.prepare(
        "SELECT symbol_id, callable FROM symbol_names WHERE folded_name=? AND qualified=? ORDER BY callable DESC, symbol_id LIMIT 40",
      );
      for (const hint of new Set(hints)) {
        if (foldedSet.has(hint)) continue;
        for (const qualified of [0, 1, 2] as const) {
          const rows = hintTierStmt.all(hint, qualified) as unknown as {
            symbol_id: string;
            callable: number;
          }[];
          for (const row of rows) record(row.symbol_id, 0, row.callable);
        }
      }
    }
    const ranked = [...byId.entries()]
      .sort(
        (a, b) =>
          b[1].priority - a[1].priority ||
          b[1].callable - a[1].callable ||
          (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
      )
      .slice(0, 40)
      .map(([id]) => id);
    if (!ranked.length) return [];
    const fetched = this.prepare(
      "SELECT id,data,document FROM symbols WHERE id IN (SELECT value FROM json_each(?))",
    ).all(JSON.stringify(ranked)) as unknown as SymbolRow[];
    const rowMap = new Map(fetched.map((row) => [row.id, row]));
    return ranked.map((id) => rowMap.get(id)).filter((row): row is SymbolRow => Boolean(row));
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
  neighborsBatch(ids: string[], limit = 24): Map<string, GraphEdge[]> {
    const grouped = new Map<string, GraphEdge[]>(ids.map((id) => [id, []]));
    if (!ids.length || limit <= 0) return grouped;
    const rows = this.prepare(
      `WITH seeds AS (SELECT DISTINCT value AS id FROM json_each(?)),
       incident AS (
         SELECT s.id AS seed, e.source, e.target, e.kind, e.data
         FROM seeds s JOIN edges e ON e.source = s.id
         UNION
         SELECT s.id AS seed, e.source, e.target, e.kind, e.data
         FROM seeds s JOIN edges e ON e.target = s.id
       ),
       ranked AS (
         SELECT seed, data,
           ROW_NUMBER() OVER (
             PARTITION BY seed
             ORDER BY CASE kind WHEN 'calls' THEN 0 WHEN 'references' THEN 1 ELSE 2 END, source, target
           ) AS rn
         FROM incident
       )
       SELECT seed, data FROM ranked WHERE rn <= ? ORDER BY seed, rn`,
    ).all(JSON.stringify(ids), limit) as unknown as { seed: string; data: string }[];
    for (const row of rows) {
      grouped.get(row.seed)?.push(JSON.parse(row.data) as GraphEdge);
    }
    return grouped;
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
