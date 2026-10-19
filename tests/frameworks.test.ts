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

test("Vue Options API static props, data and setup members bind their declarations", async () => {
  const f = await fixture({
    "OptionsArray.vue": `<script lang="ts">
const arrayProp = "script-level declaration";
export default {
  props: ["arrayProp", "duplicate", "duplicate"],
  data() { return { count: 0 }; },
  setup() {
    const localValue = 1;
    const returnedValue = 2;
    return { exposedValue: localValue, returnedValue };
  },
  methods: { stop() {} },
  computed: { ready() { return true; } },
};
</script>
<template>{{ arrayProp }} {{ count }} {{ exposedValue }} {{ returnedValue }} {{ duplicate }} <button @click="stop" /> {{ ready }}</template>`,
    "OptionsObject.vue": `<script>
export default { props: { objectProp: String } };
</script>
<template>{{ objectProp }}</template>`,
    "OptionsUnsupported.vue": `<script>
const dynamicKey = "dynamic";
export default {
  props: { [dynamicKey]: String },
  data() { return { ...initialState, hidden: 1 }; },
  setup() {
    if (true) return { ambiguous: firstValue };
    return { ambiguous: secondValue };
  },
};
</script>
<template>{{ dynamic }} {{ hidden }} {{ ambiguous }}</template>`,
    "OptionsOuterDynamic.vue": `<script>
export default { ...sharedOptions, props: ["outerProp"] };
</script>
<template>{{ outerProp }}</template>`,
  });
  try {
    const templateFor = async (path: string) => {
      const template = (
        await f.engine.locate({ query: "template", scope: path, limit: 10 })
      ).results.find((symbol) => symbol.kind === "template");
      assert(template);
      return f.engine.inspect({ id: template.id, neighbors: 10 });
    };
    const arrayDetail = await templateFor("OptionsArray.vue");
    const arrayTargets = new Map(
      arrayDetail.relations
        .filter((edge) => edge.kind === "references")
        .map((edge) => {
          const target = arrayDetail.neighbors.find((symbol) => symbol.id === edge.target);
          return [target?.name, target];
        }),
    );
    const inspectArrayTarget = async (name: string) => {
      const target = arrayTargets.get(name);
      assert(target);
      return f.engine.inspect({ id: target.id });
    };
    for (const name of ["arrayProp", "count", "localValue", "returnedValue", "stop", "ready"])
      assert(arrayTargets.has(name), name);
    assert(!arrayTargets.has("duplicate"));
    assert.equal(arrayTargets.get("arrayProp")?.kind, "property");
    assert.equal(arrayTargets.get("count")?.kind, "property");
    assert.equal(arrayTargets.get("localValue")?.name, "localValue");
    assert.equal(arrayTargets.get("localValue")?.kind, "variable");
    assert.equal((await inspectArrayTarget("arrayProp")).source, '"arrayProp"');
    assert.equal((await inspectArrayTarget("count")).source, "count: 0");
    assert.match((await inspectArrayTarget("localValue")).source, /localValue = 1/);
    assert.match((await inspectArrayTarget("returnedValue")).source, /returnedValue = 2/);

    const objectDetail = await templateFor("OptionsObject.vue");
    const objectReference = objectDetail.relations.find((edge) => edge.kind === "references");
    assert(objectReference);
    const objectTarget = objectDetail.neighbors.find(
      (symbol) => symbol.id === objectReference.target,
    );
    assert(objectTarget);
    assert.equal(objectTarget.name, "objectProp");
    assert.equal(objectTarget.kind, "property");
    assert.equal((await f.engine.inspect({ id: objectTarget.id })).source, "objectProp: String");

    const unsupported = await templateFor("OptionsUnsupported.vue");
    assert.equal(unsupported.relations.filter((edge) => edge.kind === "references").length, 0);
    assert(
      f.engine
        .status()
        .warnings.some(
          (warning) =>
            warning.includes("OptionsUnsupported.vue") && warning.includes("dynamic-option-shape"),
        ),
    );

    const outerDynamic = await templateFor("OptionsOuterDynamic.vue");
    assert.equal(outerDynamic.relations.filter((edge) => edge.kind === "references").length, 0);
    assert(
      f.engine
        .status()
        .warnings.some(
          (warning) =>
            warning.includes("OptionsOuterDynamic.vue") && warning.includes("dynamic-option-shape"),
        ),
    );
  } finally {
    await f.cleanup();
  }
});

test("Vue v-for scopes bind sources, mask aliases and restore sibling bindings", async () => {
  const f = await fixture({
    "Panel.vue": `<script setup lang="ts">
import LoopChild from "./LoopChild.vue";
const items = [];
const item = "outer item";
const index = 0;
const local = "outer local";
const name = "outer name";
const fallback = 1;
const outer = "outside";
const tail = "tail";
function stop() {}
</script>
<template>
<section v-for="(item, index) in items" v-if="index" :data-index="index">
  {{ item }} {{ index }} {{ outer }}
  <div v-for="{ id: local = fallback, nested: { name } } of item.children">
    {{ local }} {{ name }} {{ item }} {{ outer }}
    <LoopChild :value="local" />
    <button @click="stop(local, name)" />
  </div>
</section>
<p>{{ tail }}</p>
</template>`,
    "LoopChild.vue": "<template><span /></template>",
    "ScopeExit.vue": `<script setup lang="ts">
const Item = "outer Item";
const item = "different case";
const items = [];
</script>
<template>
<div v-for="Item in items">{{ Item }}</div>
<p>{{ Item }} {{ item }}</p>
</template>`,
  });
  try {
    const templateFor = async (path: string) => {
      const template = (
        await f.engine.locate({ query: "template", scope: path, limit: 10 })
      ).results.find((symbol) => symbol.kind === "template");
      assert(template);
      const detail = await f.engine.inspect({ id: template.id, neighbors: 10 });
      const lines = new Map<string, number>();
      for (const edge of detail.relations.filter((relation) => relation.kind === "references")) {
        const target = detail.neighbors.find((symbol) => symbol.id === edge.target);
        if (target) lines.set(target.name, edge.line);
      }
      return { template, detail, lines };
    };

    const panel = await templateFor("Panel.vue");
    assert.equal(panel.lines.get("items"), 14);
    assert.equal(panel.lines.get("index"), 14);
    assert.equal(panel.lines.get("fallback"), 16);
    assert.equal(panel.lines.get("outer"), 17);
    assert.equal(panel.lines.get("stop"), 19);
    assert.equal(panel.lines.get("LoopChild"), 18);
    assert.equal(panel.lines.get("tail"), 22);
    for (const localName of ["item", "local", "name"])
      assert(!panel.lines.has(localName), localName);
    assert(
      panel.detail.relations
        .filter((edge) => edge.kind === "references")
        .every((edge) => edge.evidence === "syntax"),
    );

    const scopeExit = await templateFor("ScopeExit.vue");
    assert.equal(scopeExit.lines.get("items"), 7);
    assert.equal(scopeExit.lines.get("Item"), 8);
    assert.equal(scopeExit.lines.get("item"), 8);
  } finally {
    await f.cleanup();
  }
});

test("Vue v-slot scopes handle defaults, nested aliases and dynamic slot names", async () => {
  const f = await fixture({
    "SlotPanel.vue": `<script setup lang="ts">
import SlotComp from "./SlotComp.vue";
import InnerSlot from "./InnerSlot.vue";
import LeafComp from "./LeafComp.vue";
const slotName = "header";
const slotProp = "outer prop";
const slotValue = "outer value";
const outer = "outside";
const fallback = "fallback";
function stop() {}
</script>
<template>
<SlotComp v-slot:[slotName]="{ slotProp = fallback, value: slotValue }">
  {{ slotProp }} {{ slotValue }}
  <button @click="stop(slotProp, slotValue); stop(outer)" />
  <InnerSlot v-slot="{ outer }">
    {{ outer }} {{ slotProp }} {{ slotValue }}
    <LeafComp />
  </InnerSlot>
  {{ outer }} {{ slotProp }} {{ slotValue }}
</SlotComp>
<p>{{ slotProp }} {{ slotValue }}</p>
</template>`,
    "SlotComp.vue": "<template><slot /></template>",
    "InnerSlot.vue": "<template><slot /></template>",
    "LeafComp.vue": "<template><span /></template>",
  });
  try {
    const template = (
      await f.engine.locate({ query: "template", scope: "SlotPanel.vue", limit: 10 })
    ).results.find((symbol) => symbol.kind === "template");
    assert(template);
    const detail = await f.engine.inspect({ id: template.id, neighbors: 10 });
    const lines = new Map<string, number>();
    for (const edge of detail.relations.filter((relation) => relation.kind === "references")) {
      const target = detail.neighbors.find((symbol) => symbol.id === edge.target);
      if (target) lines.set(target.name, edge.line);
    }
    assert.equal(lines.get("slotName"), 13);
    assert.equal(lines.get("fallback"), 13);
    assert.equal(lines.get("stop"), 15);
    assert.equal(lines.get("outer"), 20);
    assert.equal(lines.get("slotProp"), 22);
    assert.equal(lines.get("slotValue"), 22);
    assert.equal(lines.get("SlotComp"), 13);
    assert.equal(lines.get("InnerSlot"), 16);
    assert.equal(lines.get("LeafComp"), 18);
    assert(
      detail.relations
        .filter((edge) => edge.kind === "references")
        .every((edge) => edge.evidence === "syntax"),
    );
  } finally {
    await f.cleanup();
  }
});

test("Vue unsupported v-for bindings skip only their local subtree", async () => {
  const f = await fixture({
    "UnsupportedLoop.vue": `<script setup lang="ts">
const items = [];
const outer = true;
const invalid = { value: 1 };
</script>
<template>
<div v-for="invalid.value in items">{{ outer }} {{ invalid }}</div>
<p>{{ outer }}</p>
</template>`,
  });
  try {
    const template = (
      await f.engine.locate({ query: "template", scope: "UnsupportedLoop.vue", limit: 10 })
    ).results.find((symbol) => symbol.kind === "template");
    assert(template);
    const detail = await f.engine.inspect({ id: template.id, neighbors: 10 });
    const references = new Map(
      detail.relations
        .filter((edge) => edge.kind === "references")
        .map((edge) => [
          detail.neighbors.find((symbol) => symbol.id === edge.target)?.name,
          edge.line,
        ]),
    );
    assert.equal(references.get("items"), 7);
    assert.equal(references.get("outer"), 8);
    assert(!references.has("invalid"));
    assert(
      f.engine
        .status()
        .warnings.some(
          (warning) =>
            warning.includes("UnsupportedLoop.vue") && warning.includes("unsupported-v-for-scope"),
        ),
    );
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
