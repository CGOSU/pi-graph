import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./helpers.js";

const declarations = [
  {
    path: "view.dart",
    source: `class View extends StatelessWidget {\n  final int count = 1;\n  Widget build(BuildContext context) => Text("hello🌏");\n}\nenum Mode { idle, busy }\ntypedef Action = void Function();\nmixin Tracking { void track() {} }\nextension Extra on View { void extra() {} }\nextension on View { void extensionOnly() {} }\nvoid unrelated() { extensionOnly(); }\nconst String message = "void phantom() {}";\n`,
    expected: {
      View: "class",
      "View.count": "property",
      "View.build": "method",
      Mode: "enum",
      "Mode.idle": "variant",
      Action: "type",
      Tracking: "class",
      "Tracking.track": "method",
      Extra: "class",
      "Extra.extra": "method",
      "View.extensionOnly": "method",
      unrelated: "function",
      message: "variable",
    },
  },
  {
    path: "core.go",
    source: `package core\ntype Reset interface { Reset() }\ntype Box[T any] struct { Value T }\ntype ID = int\nconst Limit = 4\nvar Active = "func phantom() {}"\n`,
    expected: {
      Reset: "interface",
      "Reset.Reset": "method",
      Box: "struct",
      "Box.Value": "property",
      ID: "type",
      Limit: "variable",
      Active: "variable",
    },
  },
  {
    path: "service.kt",
    source: `data class Counter(val count: Int)\ninterface Reset {\n fun reset()\n}\nobject Service {\n val active = false\n}\nenum class Mode { Idle, Busy }\ntypealias Action = () -> Unit\nval message = "fun phantom() {}"\n`,
    expected: {
      Counter: "class",
      "Counter.count": "property",
      Reset: "interface",
      "Reset.reset": "method",
      Service: "class",
      "Service.active": "property",
      Mode: "enum",
      "Mode.Idle": "variant",
      Action: "type",
      message: "variable",
    },
  },
];
for (const sample of declarations) {
  test(`${sample.path} common declarations and framework-style source`, async () => {
    const f = await fixture({ [sample.path]: sample.source });
    try {
      for (const [name, kind] of Object.entries(sample.expected)) {
        const symbol = (await f.engine.locate({ query: name, limit: 10 })).results.find(
          (item) => item.name === name,
        );
        assert(symbol, name);
        const detail = await f.engine.inspect({ id: symbol.id });
        assert.equal(detail.symbol.kind, kind, name);
        assert.equal(detail.source, sample.source.slice(detail.symbol.start, detail.symbol.end));
        if (name === "View.build")
          assert.equal(detail.source, 'Widget build(BuildContext context) => Text("hello🌏");');
      }
      assert.equal(
        (await f.engine.locate({ query: "phantom" })).results.filter(
          (item) => item.name === "phantom",
        ).length,
        0,
      );
      if (sample.path === "view.dart") {
        const unrelated = (await f.engine.locate({ query: "unrelated" })).results.find(
          (item) => item.name === "unrelated",
        );
        assert(unrelated);
        assert(
          !(await f.engine.inspect({ id: unrelated.id })).relations.some(
            (edge) => edge.kind === "calls",
          ),
        );
      }
      assert.deepEqual(f.engine.status().warnings, []);
    } finally {
      await f.cleanup();
    }
  });
}

const shadowing = [
  {
    path: "scope.dart",
    source:
      "void clear() {}\nvoid loop(List<dynamic> xs) { for (final clear in xs) { clear(); } }\nvoid caught() { try {} catch(clear) { clear(); } }\nvoid after() { clear(); }\n",
    names: ["loop", "caught"],
  },
  {
    path: "scope.go",
    source:
      "package x\nfunc Clear() {}\nfunc loop(xs []func()) { for _, Clear := range xs { Clear() } }\nfunc typed() { type Clear func(); Clear() }\nfunc after() { Clear() }\n",
    names: ["loop", "typed"],
  },
  {
    path: "scope.kt",
    source:
      "fun clear() {}\nfun loop(xs: List<() -> Unit>) { for (clear in xs) { clear() } }\nfun caught() { try {} catch (clear: Exception) { clear() } }\nfun after() { clear() }\n",
    names: ["loop", "caught"],
  },
];
for (const sample of shadowing) {
  test(`${sample.path} loop, catch and type bindings cannot create false call edges`, async () => {
    const f = await fixture({ [sample.path]: sample.source });
    try {
      for (const name of [...sample.names, "after"]) {
        const symbol = (await f.engine.locate({ query: name })).results.find(
          (item) => item.name === name,
        );
        assert(symbol, name);
        const detail = await f.engine.inspect({ id: symbol.id, neighbors: 10 });
        const calls = detail.relations.filter(
          (edge) => edge.kind === "calls" && edge.source === symbol.id,
        );
        assert.equal(calls.length, name === "after" ? 1 : 0, name);
      }
    } finally {
      await f.cleanup();
    }
  });
}

test("overloads and unrelated local scopes do not invent links", async () => {
  const f = await fixture({
    "scope.kt":
      "fun work(x: Int) {}\nfun work(x: String) {}\nfun invoke() { work(1) }\nfun left() {\n fun hidden() {}\n}\nfun right() { hidden() }\n",
    "scope.dart": "void left() { void hidden() {} }\nvoid right() { hidden(); }\n",
  });
  try {
    for (const [path, names] of [
      ["scope.kt", ["invoke", "right"]],
      ["scope.dart", ["right"]],
    ] as const) {
      for (const name of names) {
        const symbol = (await f.engine.locate({ query: name, scope: path })).results.find(
          (item) => item.name === name,
        );
        assert(symbol);
        const detail = await f.engine.inspect({ id: symbol.id });
        assert(
          !detail.relations.some((edge) => edge.kind === "calls" && edge.source === symbol.id),
        );
      }
    }
  } finally {
    await f.cleanup();
  }
});

test("partial parses retain valid declarations and expose their coverage warning", async () => {
  const f = await fixture({
    "bad.dart": "// void phantom() {}\nvoid keptDart() {}\nvoid broken(\n",
    "bad.go": "package x\n// func phantom() {}\nfunc KeptGo() {}\nfunc broken(\n",
    "bad.kt": "// fun phantom() {}\nfun keptKotlin() {}\nfun broken(\n",
  });
  try {
    for (const name of ["keptDart", "KeptGo", "keptKotlin"])
      assert(
        (await f.engine.locate({ query: name })).results.some((item) => item.name === name),
        name,
      );
    const warnings = f.engine.status().warnings;
    for (const path of ["bad.dart", "bad.go", "bad.kt"])
      assert(warnings.some((warning) => warning.startsWith(path)));
    assert(
      !(await f.engine.locate({ query: "phantom" })).results.some(
        (item) => item.name === "phantom",
      ),
    );
  } finally {
    await f.cleanup();
  }
});
