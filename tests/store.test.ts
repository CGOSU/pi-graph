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
    summary: "",
    excerpt: `function ${id}() {}`,
    document,
    hash: document,
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
  files: [alpha, beta, gamma].map(({ path, hash }) => ({ path, hash })),
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
    { path: gamma.path, hash: gamma.hash },
    { path: delta.path, hash: delta.hash },
  ],
  symbols: [{ ...alpha, document: "alpha updated", hash: "updated" }, gamma, delta],
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

test("batch symbol reads bind quoted IDs and see new persisted data after reuse", async () => {
  await withStore((store) => {
    const quoted = symbol("odd'\"?\n%_id", "quoted.ts", "quoted");
    const files: FileRecord[] = [{ path: quoted.path, hash: quoted.hash }];
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
