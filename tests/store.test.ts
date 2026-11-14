import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { locate } from "../src/core/retrieval.js";
import { GraphStore } from "../src/core/store.js";
import type { FileRecord, GraphEdge, GraphSymbol } from "../src/core/types.js";

function symbol(id: string, path: string, document: string): GraphSymbol {
  return {
    id,
    path,
    name: id,
    qualifiedName: id,
    kind: "function",
    start: 0,
    end: 20,
    startLine: 1,
    endLine: 1,
    signature: `function ${id}()`,
    excerpt: `function ${id}() {}`,
    document,
    exported: true,
  };
}
const alpha = symbol("alpha", "src/100%_done/alpha.ts", "alpha cancel generation");
const beta = symbol("beta", "src/100XXdone/beta.ts", "beta obsolete");
const gamma = symbol("gamma", "src/gamma.ts", "gamma stable");
const delta = symbol("delta", "src/delta.ts", "delta replacement");
interface GraphSnapshot {
  files: FileRecord[];
  symbols: GraphSymbol[];
  edges: GraphEdge[];
}
const initial: GraphSnapshot = {
  files: [alpha, beta, gamma].map(({ id, path }) => ({ path, hash: id })),
  symbols: [alpha, beta, gamma],
  edges: [
    { source: "alpha", target: "beta", kind: "calls", evidence: "syntax", line: 1 },
    { source: "alpha", target: "gamma", kind: "references", evidence: "syntax", line: 1 },
    { source: "gamma", target: "alpha", kind: "contains", evidence: "syntax", line: 1 },
  ] satisfies GraphEdge[],
};
const changed: GraphSnapshot = {
  files: [
    { path: alpha.path, hash: "updated" },
    { path: gamma.path, hash: gamma.id },
    { path: delta.path, hash: delta.id },
  ],
  symbols: [{ ...alpha, document: "alpha updated" }, gamma, delta],
  edges: [
    { source: "alpha", target: "delta", kind: "calls", evidence: "type-resolved", line: 8 },
    { source: "alpha", target: "gamma", kind: "references", evidence: "type-resolved", line: 8 },
    initial.edges[2]!,
  ] satisfies GraphEdge[],
};
function commit(store: GraphStore, data: GraphSnapshot, config = "config") {
  store.commit(data.files, data.symbols, data.edges, config);
}
function snapshot(db: DatabaseSync) {
  return {
    files: db.prepare("SELECT * FROM files ORDER BY path").all(),
    symbols: db.prepare("SELECT * FROM symbols ORDER BY id").all(),
    edges: db.prepare("SELECT * FROM edges ORDER BY source,target,kind").all(),
    documents: db.prepare("SELECT id,document FROM documents ORDER BY id").all(),
  };
}
async function withStore(run: (store: GraphStore, db: DatabaseSync, root: string) => void) {
  const root = await mkdtemp(join(tmpdir(), "pi-graph-store-"));
  const path = join(root, "index.sqlite");
  const store = new GraphStore(path);
  const db = new DatabaseSync(path);
  try {
    run(store, db, root);
  } finally {
    db.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}
function audit(db: DatabaseSync) {
  db.exec("CREATE TABLE writes (tableName TEXT, operation TEXT)");
  for (const table of ["files", "symbols", "edges"]) {
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      db.exec(`CREATE TRIGGER audit_${table}_${operation} AFTER ${operation} ON ${table}
        BEGIN INSERT INTO writes VALUES ('${table}','${operation}'); END`);
    }
  }
}

test("delta commits skip unchanged graph rows and match a rebuilt snapshot", async () => {
  await withStore((store, db, root) => {
    commit(store, initial);
    audit(db);
    const before = snapshot(db);
    const documents = db.prepare("SELECT rowid,* FROM documents ORDER BY id").all();
    commit(store, initial);
    assert.deepEqual(db.prepare("SELECT * FROM writes").all(), []);
    assert.deepEqual(snapshot(db), before);
    assert.deepEqual(db.prepare("SELECT rowid,* FROM documents ORDER BY id").all(), documents);
    assert.equal(store.metadata("revision"), "2");

    commit(store, changed);
    assert.deepEqual(
      db
        .prepare(
          "SELECT tableName,operation,COUNT(*) AS count FROM writes GROUP BY tableName,operation ORDER BY tableName,operation",
        )
        .all()
        .map((row) => ({ ...row })),
      ["edges", "files", "symbols"].flatMap((tableName) =>
        ["DELETE", "INSERT", "UPDATE"].map((operation) => ({ tableName, operation, count: 1 })),
      ),
    );
    assert.equal(store.metadata("revision"), "3");
    assert.equal(store.symbol("beta"), undefined);
    assert.deepEqual(store.search(["obsolete"]), []);
    assert.deepEqual(
      store.search(["updated"]).map((s) => s.id),
      ["alpha"],
    );
    assert.deepEqual(
      store.search(["updated"], "src/100%_done").map((s) => s.id),
      ["alpha"],
    );
    assert.deepEqual(store.search(["stable"], "src/100%_done"), []);
    assert.deepEqual(store.neighbors("beta"), []);
    assert.equal(
      store.neighbors("alpha").filter((edge) => edge.kind === "calls")[0]?.target,
      "delta",
    );

    const rebuilt = new GraphStore(join(root, "rebuilt.sqlite"));
    const rebuiltDb = new DatabaseSync(join(root, "rebuilt.sqlite"));
    try {
      commit(rebuilt, changed);
      assert.deepEqual(snapshot(db), snapshot(rebuiltDb));
      assert.deepEqual(store.counts(), rebuilt.counts());
      for (const query of ["alpha", "gamma stable", "replacement", "obsolete"]) {
        const current = locate(store, { query, limit: 3 }, []);
        const fresh = locate(rebuilt, { query, limit: 3 }, []);
        assert.deepEqual({ ...current, revision: 0 }, { ...fresh, revision: 0 });
      }
      store.commit([], [], [], "empty");
      assert.deepEqual(store.files(), []);
      assert.deepEqual(store.search(["updated", "stable", "replacement"]), []);
      assert.equal(store.counts().edges, 0);
      assert.equal(store.counts().symbols, 0);
    } finally {
      rebuiltDb.close();
      rebuilt.close();
    }
  });
});

test("SQL failures roll back graph, FTS and metadata and cached statements recover", async () => {
  await withStore((store, db) => {
    commit(store, initial);
    audit(db);
    const before = snapshot(db);
    const metadata = db.prepare("SELECT * FROM metadata ORDER BY key").all();
    const documents = db.prepare("SELECT rowid,* FROM documents ORDER BY id").all();
    const duplicate = { ...changed, edges: [...changed.edges, changed.edges[0]!] };
    assert.throws(() => commit(store, duplicate), /UNIQUE constraint failed/);
    db.exec(`CREATE TRIGGER fail_commit BEFORE UPDATE ON metadata
      WHEN NEW.key='configHash' AND NEW.value='fail'
      BEGIN SELECT RAISE(ABORT,'injected commit failure'); END`);
    assert.throws(() => commit(store, changed, "fail"), /injected commit failure/);
    assert.deepEqual(snapshot(db), before);
    assert.deepEqual(db.prepare("SELECT * FROM metadata ORDER BY key").all(), metadata);
    assert.deepEqual(db.prepare("SELECT rowid,* FROM documents ORDER BY id").all(), documents);
    assert.deepEqual(db.prepare("SELECT * FROM writes").all(), []);
    assert.deepEqual(
      store.search(["obsolete"]).map((s) => s.id),
      ["beta"],
    );
    assert.equal(store.symbols(["alpha", "delta"]).get("alpha")?.document, alpha.document);
    assert(!store.symbols(["delta"]).has("delta"));
    commit(store, changed);
    assert.equal(store.metadata("revision"), "2");
    assert.equal(store.metadata("configHash"), "config");
    assert.deepEqual(store.search(["obsolete"]), []);
    assert.deepEqual(
      store.search(["replacement"]).map((s) => s.id),
      ["delta"],
    );
    assert.deepEqual(store.neighbors("beta"), []);
  });
});

test("bulk FTS changes preserve persisted searches without stale or duplicate documents", async () => {
  await withStore((store, db, root) => {
    const symbols = Array.from({ length: 1400 }, (_, i) => {
      const term = i < 1100 ? "obsoleteword" : i < 1200 ? "stableword" : "removedword";
      return symbol(i === 0 ? "odd'\"?\n%_id" : `symbol${i}`, "bulk.ts", `${term} token${i}`);
    });
    const files = [{ path: "bulk.ts", hash: "initial" }];
    store.commit(files, symbols, [], "config");
    const stableDocuments = db
      .prepare(
        "SELECT rowid,id,document FROM documents WHERE document LIKE 'stableword%' ORDER BY id",
      )
      .all();
    const current = symbols
      .slice(0, 1200)
      .map((entry, i) => (i < 1100 ? { ...entry, document: `updatedword token${i}` } : entry));
    current.push(symbol("new'\"?\n%_id", "bulk.ts", "addedword"));
    const reopened = new GraphStore(join(root, "index.sqlite"));
    try {
      reopened.commit([{ path: "bulk.ts", hash: "updated" }], current, [], "config");
      assert.deepEqual(
        db
          .prepare("SELECT id,document FROM documents ORDER BY id")
          .all()
          .map((row) => ({ ...row })),
        current
          .map(({ id, document }) => ({ id, document }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      );
      assert.deepEqual(
        db
          .prepare(
            "SELECT rowid,id,document FROM documents WHERE document LIKE 'stableword%' ORDER BY id",
          )
          .all(),
        stableDocuments,
      );
      assert.deepEqual(reopened.search(["obsoleteword", "removedword"]), []);
      for (const entry of current.filter((entry) => entry.id.includes("'"))) {
        assert.deepEqual(reopened.search([entry.document]), [entry]);
      }
      assert.equal(reopened.counts().symbols, current.length);
    } finally {
      reopened.close();
    }
  });
});

test("batch symbol reads bind quoted IDs and see new persisted data after reuse", async () => {
  await withStore((store) => {
    const quoted = symbol("odd'\"?\n%_id", "quoted.ts", "quoted");
    const files: FileRecord[] = [{ path: quoted.path, hash: quoted.id }];
    store.commit(files, [quoted], [], "config");
    assert.deepEqual(store.symbols([]), new Map());
    assert.deepEqual(
      store.symbols([quoted.id, quoted.id, "missing"]),
      new Map([[quoted.id, quoted]]),
    );
    store.commit(files, [{ ...quoted, document: "changed" }], [], "config");
    assert.equal(store.symbols([quoted.id]).get(quoted.id)?.document, "changed");
    store.commit([], [], [], "config");
    assert.equal(store.symbols([quoted.id]).size, 0);
  });
});

test("name lookup ranks exact spelling and qualification before the candidate limit", async () => {
  await withStore((store) => {
    const shadowing = Array.from({ length: 45 }, (_, index) => ({
      ...symbol(`shadow${index}`, "src/shadows.ts", "unrelated"),
      name: "é",
      qualifiedName: "é",
    }));
    const exactShort = {
      ...symbol("exactShort", "src/short.ts", "unrelated"),
      name: "É",
      qualifiedName: "É",
    };
    const exactQualified = {
      ...symbol("exactQualified", "src/qualified.ts", "unrelated"),
      name: "É",
      qualifiedName: "Store.É",
      kind: "property" as const,
    };
    const foldedQualified = {
      ...symbol("foldedQualified", "src/folded.ts", "unrelated"),
      name: "é",
      qualifiedName: "store.é",
    };
    store.commit([], [...shadowing, exactShort, exactQualified, foldedQualified], [], "config");

    const identifiers = Array.from({ length: 35 }, (_, index) => `unused${index}`);
    const result = store.search([], undefined, [...identifiers, "É", "Store.É"]);
    assert.equal(result.length, 40);
    assert.deepEqual(result.slice(0, 3), [exactQualified, exactShort, foldedQualified]);
    assert.deepEqual(store.search(["store.é"], "src/qualified.ts"), [exactQualified]);
  });
});

test("both candidate lanes apply literal case-sensitive scope before their limits", async () => {
  await withStore((store) => {
    const inScope = symbol("inside", "src/100%_done/main.ts", "common");
    const file = symbol("file", "src/100%_done", "common");
    const outside = Array.from({ length: 120 }, (_, index) => ({
      ...symbol(`outside${index}`, "SRC/100%_done/main.ts", "common"),
      name: "inside",
      qualifiedName: "inside",
    }));
    const wildcard = symbol("wildcard", "src/100XXdone/main.ts", "common");
    store.commit([], [...outside, wildcard, inScope, file], [], "config");

    assert.deepEqual(
      store
        .search(["common"], "src/100%_done")
        .map(({ id }) => id)
        .sort(),
      [file.id, inScope.id],
    );
    assert.deepEqual(store.search([], "src/100%_done", ["inside"]), [inScope]);
  });
});

test("opening a legacy database backfills names and later changes are atomic", async () => {
  await withStore((store, db, root) => {
    const previous = {
      ...symbol("rename", "src/rename.ts", "body"),
      name: "İş",
      qualifiedName: "Store.İş",
    };
    const renamed = { ...previous, name: "x", qualifiedName: "Store.x" };
    const added = symbol("newName", "src/new.ts", "body");
    const removed = symbol("removedName", "src/old.ts", "body");
    store.commit([], [previous, removed], [], "config");
    db.exec("DROP TABLE IF EXISTS symbol_names");

    const indexPath = join(root, "index.sqlite");
    const updateData = db.prepare("UPDATE symbols SET data=? WHERE id=?");
    updateData.run("invalid JSON", removed.id);
    assert.throws(() => new GraphStore(indexPath), SyntaxError);
    assert.equal(
      db.prepare("SELECT 1 FROM sqlite_schema WHERE name='symbol_names'").get(),
      undefined,
    );
    updateData.run(JSON.stringify(removed), removed.id);

    const reopened = new GraphStore(indexPath);
    try {
      assert.equal(reopened.metadata("revision"), "1");
      assert.deepEqual(reopened.search([], undefined, ["store.i\u0307ş"]), [previous]);
      db.exec(`CREATE TRIGGER fail_names_commit BEFORE UPDATE ON metadata
        WHEN NEW.key='configHash' AND NEW.value='fail'
        BEGIN SELECT RAISE(ABORT,'injected name commit failure'); END`);
      assert.throws(
        () => reopened.commit([], [renamed, added], [], "fail"),
        /injected name commit failure/,
      );
      assert.deepEqual(reopened.search([], undefined, ["Store.İş", "removedName"]), [
        previous,
        removed,
      ]);
      assert.deepEqual(reopened.search([], undefined, ["x", "newName"]), []);

      reopened.commit([], [renamed, added], [], "config");
      assert.deepEqual(reopened.search([], undefined, ["Store.İş", "removedName"]), []);
      assert.deepEqual(reopened.search([], undefined, ["Store.x", "newName"]), [renamed, added]);
      const latest = new GraphStore(indexPath);
      try {
        assert.deepEqual(latest.search([], undefined, ["x"]), [renamed]);
      } finally {
        latest.close();
      }
    } finally {
      reopened.close();
    }
  });
});

test("legacy symbols table without document column migrates cleanly on open", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-graph-legacy-doc-"));
  const indexPath = join(root, "index.sqlite");
  try {
    const legacy = new DatabaseSync(indexPath);
    const legacyAlpha = symbol("alpha", "src/alpha.ts", "alpha document text");
    const legacyBeta = symbol("beta", "src/beta.ts", "beta document text");
    legacy.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE files (path TEXT PRIMARY KEY, hash TEXT NOT NULL);
      CREATE TABLE symbols (id TEXT PRIMARY KEY, path TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE edges (source TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (source, target, kind));
      CREATE VIRTUAL TABLE documents USING fts5(id UNINDEXED, document, tokenize='unicode61');
    `);
    legacy
      .prepare("INSERT INTO symbols(id,path,data) VALUES (?,?,?)")
      .run(
        legacyAlpha.id,
        legacyAlpha.path,
        JSON.stringify({ ...legacyAlpha, summary: "legacy", hash: "legacy-hash" }),
      );
    legacy
      .prepare("INSERT INTO symbols(id,path,data) VALUES (?,?,?)")
      .run(
        legacyBeta.id,
        legacyBeta.path,
        JSON.stringify({ ...legacyBeta, summary: "legacy", hash: "legacy-hash" }),
      );
    legacy
      .prepare("INSERT INTO documents(id,document) VALUES (?,?)")
      .run(legacyAlpha.id, legacyAlpha.document);
    legacy
      .prepare("INSERT INTO documents(id,document) VALUES (?,?)")
      .run(legacyBeta.id, legacyBeta.document);
    legacy.prepare("INSERT INTO metadata(key,value) VALUES ('revision','4')").run();
    legacy.close();

    const store = new GraphStore(indexPath);
    try {
      const publicAlpha = store.symbol(legacyAlpha.id);
      assert(publicAlpha);
      assert.equal("document" in publicAlpha, false);
      assert.deepEqual(
        store.symbols([legacyAlpha.id, legacyBeta.id]),
        new Map([
          [legacyAlpha.id, legacyAlpha],
          [legacyBeta.id, legacyBeta],
        ]),
      );
      assert.deepEqual(store.search(["alpha"]), [legacyAlpha]);
      const inspectDb = new DatabaseSync(indexPath, { readOnly: true });
      try {
        const columns = inspectDb
          .prepare("PRAGMA table_info(symbols)")
          .all()
          .map((column) => String(column.name));
        assert(columns.includes("document"));
        const rawRow = inspectDb
          .prepare("SELECT data, document FROM symbols WHERE id=?")
          .get(legacyAlpha.id) as { data: string; document: string };
        assert.equal(rawRow.document, legacyAlpha.document);
        assert.equal("document" in JSON.parse(rawRow.data), false);
      } finally {
        inspectDb.close();
      }
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("neighborsBatch matches per-symbol neighbors without duplicates", async () => {
  await withStore((store) => {
    const a = symbol("a", "src/a.ts", "a");
    const b = symbol("b", "src/b.ts", "b");
    const c = symbol("c", "src/c.ts", "c");
    const ab: GraphEdge = { source: "a", target: "b", kind: "calls", evidence: "syntax", line: 1 };
    const bc: GraphEdge = { source: "b", target: "c", kind: "calls", evidence: "syntax", line: 2 };
    const ca: GraphEdge = {
      source: "c",
      target: "a",
      kind: "references",
      evidence: "syntax",
      line: 3,
    };
    store.commit(
      [
        { path: a.path, hash: "1" },
        { path: b.path, hash: "1" },
        { path: c.path, hash: "1" },
      ],
      [a, b, c],
      [ab, bc, ca],
      "config",
    );
    assert.deepEqual(store.neighborsBatch([], 10), new Map());
    const batch = store.neighborsBatch(["a", "b", "a"], 10);
    assert.deepEqual([...batch.keys()], ["a", "b"]);
    assert.deepEqual(batch.get("a"), store.neighbors("a", 10));
    assert.deepEqual(batch.get("b"), store.neighbors("b", 10));
    const limited = store.neighborsBatch(["a", "b"], 1);
    assert.deepEqual(limited.get("a"), store.neighbors("a", 1));
    assert.deepEqual(limited.get("b"), store.neighbors("b", 1));
  });
});

test("scoped commit updates only scoped paths and preserves untouched symbols and edges", async () => {
  await withStore((store) => {
    const tsSym = symbol("ts_fn", "src/app.ts", "ts function");
    const rsSym = symbol("rs_fn", "src/lib.rs", "rs function");
    const goOld = symbol("go_old", "src/main.go", "go old");
    const goUpdated = symbol("go_new", "src/main.go", "go new");
    const tsEdge: GraphEdge = {
      source: tsSym.id,
      target: tsSym.id,
      kind: "calls",
      evidence: "type-resolved",
      line: 1,
    };
    const goOldEdge: GraphEdge = {
      source: goOld.id,
      target: tsSym.id,
      kind: "references",
      evidence: "syntax",
      line: 2,
    };
    const goNewEdge: GraphEdge = {
      source: goUpdated.id,
      target: rsSym.id,
      kind: "calls",
      evidence: "syntax",
      line: 3,
    };
    store.commit(
      [
        { path: tsSym.path, hash: "1" },
        { path: rsSym.path, hash: "1" },
        { path: goOld.path, hash: "1" },
      ],
      [tsSym, rsSym, goOld],
      [tsEdge, goOldEdge],
      "config",
    );

    store.commit(
      [
        { path: tsSym.path, hash: "1" },
        { path: rsSym.path, hash: "1" },
        { path: goUpdated.path, hash: "2" },
      ],
      [goUpdated],
      [goNewEdge],
      "config",
      [],
      [],
      { scopePaths: ["src/main.go"], extraMetadata: { domainWarnings: "{}" } },
    );

    assert.equal(store.symbol(goOld.id), undefined);
    assert.equal(store.symbol(goUpdated.id)?.id, goUpdated.id);
    assert.equal(store.symbol(tsSym.id)?.id, tsSym.id);
    assert.equal(store.symbol(rsSym.id)?.id, rsSym.id);
    assert.deepEqual(store.neighbors(tsSym.id), [tsEdge]);
    assert.deepEqual(store.neighbors(goOld.id), []);
    assert.deepEqual(store.neighbors(goUpdated.id), [goNewEdge]);
    assert.equal(store.metadata("domainWarnings"), "{}");
  });
});
