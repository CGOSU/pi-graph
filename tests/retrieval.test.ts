import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./helpers.js";

const resourceQuery = "resource candidate snapshot store load validate BinaryFile SourceFile";
const resourceTypes =
  "package resources\ntype Artifact struct { BinaryFile string; SourceFile string }\n";
function resourceStore(copies: number): string {
  return `package resources
  type Store struct {}
  func (s *Store) load(candidate string) Artifact {
    binary := Artifact{BinaryFile: candidate}
    source := Artifact{SourceFile: candidate}
    dns := Artifact{SourceFile: candidate}
    snapshot := binary
    ${Array.from({ length: copies }, (_, i) => `copy${i} := Artifact{BinaryFile: candidate}`).join("\n")}
    return source
  }`;
}

test("name hints recall implementations outside the ordinary FTS candidate budget", async () => {
  const f = await fixture({
    "profile/compile.go": "package profile\nfunc Compile(input string) string { return input }\n",
    "noise.go": `package noise\n${Array.from(
      { length: 120 },
      (_, i) => `var source${i} = "dns nameserver policy hosts fakeip route candidate source"`,
    ).join("\n")}`,
    "outside/compile.go": "package outside\nfunc Compile(input string) string { return input }\n",
  });
  try {
    const result = await f.engine.locate({
      query: "Compile DNS nameserver policy hosts fakeip route candidate source",
      limit: 3,
    });
    assert(result.results.some((symbol) => symbol.path === "profile/compile.go"));
    const scoped = await f.engine.locate({ query: "Compile source", scope: "profile", limit: 3 });
    assert(scoped.results.some((symbol) => symbol.name === "Compile"));
    assert(scoped.results.every((symbol) => symbol.path.startsWith("profile/")));
  } finally {
    await f.cleanup();
  }
});

test("behavior queries return the containing method instead of its matching local variables", async () => {
  const f = await fixture({
    "resources/types.go": resourceTypes,
    "resources/cache.go": resourceStore(8),
  });
  try {
    const result = await f.engine.locate({ query: resourceQuery, scope: "resources", limit: 5 });
    const owner = result.results.find((symbol) => symbol.name === "Store.load");
    assert(owner);
    assert(!result.results.some((symbol) => symbol.name.startsWith("Store.load.")));
    assert(owner.reason.includes("contains"));
    assert(owner.reason.includes("syntax"));
    const domain = await f.engine.locate({
      query: `${resourceQuery} DNS`,
      scope: "resources",
      limit: 5,
    });
    assert(domain.results.some((symbol) => symbol.name === "Store.load"));
    assert(!domain.results.some((symbol) => symbol.name.startsWith("Store.load.")));
    const inspect = await f.engine.inspect({ id: owner.id });
    assert(inspect.neighbors.some((symbol) => symbol.name.startsWith("Store.load.")));
    for (const query of ["Store.load.binary", "binary", "Store.load.dns"]) {
      const exact = await f.engine.locate({ query, scope: "resources", limit: 3 });
      assert.equal(
        exact.results[0]?.name,
        query.endsWith("dns") ? "Store.load.dns" : "Store.load.binary",
      );
    }
    const variables = await f.engine.locate({
      query: "binary local variable",
      scope: "resources",
      limit: 3,
    });
    assert(variables.results.some((symbol) => symbol.name === "Store.load.binary"));
  } finally {
    await f.cleanup();
  }
});

test("repeating local evidence does not multiply its containing method's score", async () => {
  const f = await fixture({
    "resources/types.go": resourceTypes,
    "resources/cache.go": resourceStore(1),
  });
  try {
    const before = await f.engine.locate({ query: resourceQuery, scope: "resources", limit: 5 });
    const original = before.results.find((symbol) => symbol.name === "Store.load");
    assert(original);
    await f.write("resources/cache.go", resourceStore(40));
    const after = await f.engine.locate({ query: resourceQuery, scope: "resources", limit: 5 });
    const repeated = after.results.find((symbol) => symbol.name === "Store.load");
    assert(repeated);
    assert(repeated.score <= original.score);
    assert(!after.results.some((symbol) => symbol.name.startsWith("Store.load.")));
  } finally {
    await f.cleanup();
  }
});

test("behavior grouping preserves top-level state and local closures", async () => {
  const f = await fixture({
    "state.go": `package state
      var sharedSnapshot = "candidate snapshot binary source"
      func prepare() string {
        callback := func() string { return "candidate snapshot binary source" }
        binary := "candidate snapshot binary source"
        return callback() + binary
      }`,
    "state.rs": `pub fn prepare_rust() {
      const CALLBACK: fn() = || { let _ = "candidate snapshot binary source"; };
      CALLBACK();
    }`,
  });
  try {
    const result = await f.engine.locate({ query: "candidate snapshot binary source", limit: 10 });
    assert(result.results.some((symbol) => symbol.name === "sharedSnapshot"));
    assert(result.results.some((symbol) => symbol.name === "prepare.callback"));
    assert(result.results.some((symbol) => symbol.name === "prepare_rust::CALLBACK"));
  } finally {
    await f.cleanup();
  }
});
