import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { GraphClient } from "../src/core/client.js";
import { fixture } from "./helpers.js";

test("React JSX/TSX components, hooks, wrappers and default arrows retain relationships", async () => {
  const f = await fixture({
    "hooks.ts": "export function useGeneration() { return false; }",
    "Child.jsx": "export default function Child() { return <span>Cancel</span>; }",
    "Panel.tsx": `import Child from './Child.jsx';
import { useGeneration } from './hooks.js';
import { memo, forwardRef } from 'react';
export const Panel = memo(() => { const loading = useGeneration(); return <Child loading={loading} />; });
export const Input = forwardRef((props, ref) => <input ref={ref} />);
export default () => <Panel />;`,
  });
  try {
    const result = await f.engine.locate({ query: "Panel", limit: 10 });
    const panel = result.results.find((s) => s.name === "Panel");
    assert.equal(panel?.kind, "function");
    assert(panel);
    const detail = await f.engine.inspect({ id: panel.id, neighbors: 10 });
    assert(detail.neighbors.some((s) => s.name === "useGeneration"));
    assert(detail.neighbors.some((s) => s.name === "Child" && s.path === "Child.jsx"));
    assert(detail.relations.some((e) => e.kind === "calls" && e.evidence === "type-resolved"));
    assert.equal(
      (await f.engine.locate({ query: "Input" })).results.find((s) => s.name === "Input")?.kind,
      "function",
    );
    const defaultComponent = (
      await f.engine.locate({ query: "Panel", scope: "Panel.tsx", limit: 10 })
    ).results.find((s) => s.name === "default");
    assert(defaultComponent);
    assert(
      (await f.engine.inspect({ id: defaultComponent.id })).source.includes(
        "export default () => <Panel />",
      ),
    );
    assert.equal(f.engine.status().warnings.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("Vue SFC scripts preserve original Unicode/CRLF offsets and link templates and imports", async () => {
  const source = [
    "<!-- 中文😀 -->",
    '<template><CancelButton @click="cancelGeneration">{{ loading }}</CancelButton></template>',
    '<script setup lang="ts">',
    "import CancelButton from './CancelButton.vue';",
    "import { clearLoading } from './state.js';",
    "const loading = false;",
    "function cancelGeneration() { clearLoading(); }",
    "</script>",
    "<style scoped>.cancel { color: red; }</style>",
  ].join("\r\n");
  const f = await fixture({
    "Panel.vue": source,
    "CancelButton.vue": "<template><button>Cancel</button></template>",
    "state.ts": "export function clearLoading() {}",
    "entry.ts":
      "import Panel from './Panel.vue'; export function registerPanel() { return Panel; }",
  });
  try {
    const result = await f.engine.locate({ query: "cancelGeneration", limit: 10 });
    const cancel = result.results.find((s) => s.name === "cancelGeneration");
    assert(cancel, "Vue script setup must be indexed");
    assert.equal(cancel.path, "Panel.vue");
    const detail = await f.engine.inspect({ id: cancel.id, neighbors: 10 });
    assert.equal(detail.source, "function cancelGeneration() { clearLoading(); }");
    assert.equal(detail.symbol.startLine, 7);
    assert(detail.neighbors.some((s) => s.name === "clearLoading"));
    assert(detail.relations.some((e) => e.kind === "calls" && e.evidence === "type-resolved"));
    const template = (
      await f.engine.locate({ query: "template", scope: "Panel.vue", limit: 10 })
    ).results.find((s) => s.kind === "template");
    assert(template);
    const templateDetail = await f.engine.inspect({ id: template.id, neighbors: 10 });
    assert(templateDetail.source.startsWith("<CancelButton"));
    for (const name of ["cancelGeneration", "loading", "CancelButton"])
      assert(
        templateDetail.neighbors.some((s) => s.name === name),
        name,
      );
    assert(
      templateDetail.relations
        .filter((e) => e.kind === "references")
        .every((e) => e.evidence === "syntax"),
    );
    const entry = (await f.engine.locate({ query: "registerPanel" })).results.find(
      (s) => s.name === "registerPanel",
    );
    assert(entry);
    assert(
      (await f.engine.inspect({ id: entry.id })).neighbors.some(
        (s) => s.kind === "component" && s.path === "Panel.vue",
      ),
    );
    assert.equal(f.engine.status().warnings.length, 0);
    assert.equal((await f.engine.locate({ query: "cancelGeneration" })).revision, result.revision);
    await f.write("Panel.vue", `\n${source}`);
    assert.equal((await f.engine.inspect({ id: cancel.id })).symbol.startLine, 8);
    await rm(join(f.root, "Panel.vue"));
    await assert.rejects(f.engine.inspect({ id: cancel.id }), /Symbol not found/);
  } finally {
    await f.cleanup();
  }
});

test("Vue normal scripts, Options API methods, setup JSX and malformed/external blocks stay bounded", async () => {
  const f = await fixture({
    "Options.vue":
      '<template><button @click="stop">Stop</button></template>\n<script>export default { methods: { stop() { return "stopped"; } } };</script>',
    "Render.vue":
      '<script setup lang="tsx">const Render = () => <div>Render</div>;</script><template><Render /></template>',
    "External.vue": '<script src="./external.ts"></script><template><div /></template>',
    "Broken.vue": "<script setup>function healthy() {};</script><template><div></template>",
    "ignored/Hidden.vue": "<script setup>function hidden() {}</script>",
    ".graphignore": "ignored/\n",
  });
  try {
    const stop = (
      await f.engine.locate({ query: "stop", scope: "Options.vue", limit: 10 })
    ).results.find((s) => s.name === "stop");
    assert(stop);
    const detail = await f.engine.inspect({ id: stop.id, neighbors: 10 });
    assert.equal(detail.source, 'stop() { return "stopped"; }');
    assert(detail.neighbors.some((s) => s.kind === "template"));
    assert(
      (await f.engine.locate({ query: "Render", scope: "Render.vue" })).results.some(
        (s) => s.name === "Render" && s.kind === "function",
      ),
    );
    assert((await f.engine.locate({ query: "healthy" })).results.some((s) => s.name === "healthy"));
    assert(f.engine.status().warnings.some((w) => w.includes("External.vue") && w.includes("src")));
    assert(f.engine.status().warnings.some((w) => w.includes("Broken.vue")));
    assert.equal(f.engine.status().files, 4);
    assert(
      !(await f.engine.locate({ query: "hidden" })).results.some((s) =>
        s.path.includes("ignored/"),
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test("Vue template scopes and expression case do not create guessed references", async () => {
  const f = await fixture({
    "Panel.vue": `<script setup lang="ts">
const Item = 'outer'; const ITEM = 'different case'; const items = [];
function stop() {}
</script>
<template>
<div v-for="Item in items">{{ Item }}<button @click="stop" /></div>
<div>{{ item }}</div>
<div>{{ [1].map(Item => Item) }}</div>
<button @click="stop" />
</template>`,
  });
  try {
    const template = (
      await f.engine.locate({ query: "template", scope: "Panel.vue", limit: 10 })
    ).results.find((s) => s.kind === "template");
    assert(template);
    const detail = await f.engine.inspect({ id: template.id, neighbors: 10 });
    const references = detail.relations
      .filter((e) => e.kind === "references")
      .map((e) => detail.neighbors.find((s) => s.id === e.target)?.name);
    assert.deepEqual(references, ["stop"]);
  } finally {
    await f.cleanup();
  }
});

test("React hook state and Vue destructured props remain searchable bindings", async () => {
  const f = await fixture({
    "Counter.tsx":
      'import { useState } from "react"; export function Counter() { const [loading, setLoading] = useState(false); return <button onClick={() => setLoading(true)}>{loading}</button>; }',
    "Props.vue":
      '<script setup lang="ts">const { loading } = defineProps<{ loading: boolean }>();</script><template>{{ loading }}</template>',
  });
  try {
    const react = (await f.engine.locate({ query: "loading", scope: "Counter.tsx", limit: 10 }))
      .results;
    assert(react.some((s) => s.name === "Counter.loading" && s.kind === "variable"));
    assert(react.some((s) => s.name === "Counter.setLoading"));
    const template = (
      await f.engine.locate({ query: "template", scope: "Props.vue", limit: 10 })
    ).results.find((s) => s.kind === "template");
    assert(template);
    assert(
      (await f.engine.inspect({ id: template.id })).neighbors.some((s) => s.name === "loading"),
    );
  } finally {
    await f.cleanup();
  }
});

test("Vue aliases and kebab-case component tags work through the worker", async () => {
  const f = await fixture({
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: { "@/*": ["src/*"] },
        moduleResolution: "bundler",
        module: "esnext",
      },
    }),
    "src/ActionButton.vue": "<template><button>Action</button></template>",
    "src/Panel.vue":
      '<script setup lang="ts">import ActionButton from "@/ActionButton.vue";</script><template><action-button /></template>',
    "src/entry.ts":
      'import Panel from "@/Panel.vue"; export function registerPanel() { return Panel; }',
  });
  const client = new GraphClient(f.root);
  try {
    const result = await client.locate({ query: "template", scope: "src/Panel.vue", limit: 10 });
    const template = result.results.find((s) => s.kind === "template");
    assert(template);
    assert(
      (await client.inspect({ id: template.id })).neighbors.some((s) => s.name === "ActionButton"),
    );
    const entry = (await client.locate({ query: "registerPanel" })).results.find(
      (s) => s.name === "registerPanel",
    );
    assert(entry);
    assert(
      (await client.inspect({ id: entry.id })).neighbors.some(
        (s) => s.path === "src/Panel.vue" && s.kind === "component",
      ),
    );
  } finally {
    await client.close();
    await f.cleanup();
  }
});
