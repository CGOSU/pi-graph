import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { GraphEngine } from "../src/core/engine.js";
import { hashContent } from "../src/core/files.js";
import type { InspectResult } from "../src/core/types.js";
import { languageConfiguration } from "../src/languages/typescript.js";
import { fixture } from "./helpers.js";

function references(detail: InspectResult) {
  const symbols = new Map(detail.neighbors.map((symbol) => [symbol.id, symbol]));
  return detail.relations.flatMap((edge) => {
    const target = symbols.get(edge.target);
    return edge.kind === "references" && target
      ? [{ name: target.name, path: target.path, kind: target.kind, line: edge.line }]
      : [];
  });
}

async function templateDetail(engine: GraphEngine, path: string) {
  const template = (
    await engine.locate({ query: "template", scope: path, limit: 10 })
  ).results.find((symbol) => symbol.kind === "template");
  assert(template);
  return engine.inspect({ id: template.id, neighbors: 10 });
}

test("GraphEngine rebuilds a persisted Vue index with the legacy framework config hash", async () => {
  const source = `<script setup lang="ts">
const rows = [];
const row = "outer row";
const marker = "marker";
</script>
<template>
<div v-for="row in rows">{{ row }} {{ marker }}</div>
<p>{{ row }}</p>
</template>`;
  const f = await fixture({ "Panel.vue": source });
  const database = new DatabaseSync(join(f.root, ".pi-graph", "index.sqlite"));
  const legacyConfigHash = `frameworks-v1:rust-v1:${languageConfiguration(f.root).hash}`;
  try {
    database
      .prepare("INSERT INTO files(path, hash) VALUES (?, ?)")
      .run("Panel.vue", hashContent(source));
    database
      .prepare("INSERT INTO metadata(key, value) VALUES (?, ?)")
      .run("configHash", legacyConfigHash);
  } finally {
    database.close();
  }

  try {
    const detail = await templateDetail(f.engine, "Panel.vue");
    const panelReferences = references(detail);
    assert.deepEqual(
      panelReferences.map(({ name, line }) => [name, line]).sort(),
      [
        ["marker", 7],
        ["row", 8],
        ["rows", 7],
      ].sort(),
    );
    assert.equal(f.engine.status().changedFiles, 0);
    assert.equal(f.engine.status().deletedFiles, 0);
    assert.equal(f.engine.status().revision, 1);
  } finally {
    await f.cleanup();
  }
});

test("GraphEngine refreshes Vue bindings, scopes, positions and deleted files incrementally", async () => {
  const initial = `<script setup lang="ts">
import ExistingChild from "./ExistingChild.vue";
const entries = [];
const row = "old row";
const outside = "outside";
</script>
<template>
<ExistingChild v-for="row in entries">{{ row }} {{ outside }}</ExistingChild>
<p>{{ row }}</p>
</template>`;
  const updated = `<script setup lang="ts">
import ExistingChild from "./ExistingChild.vue";
const records = [];
const active = "current";
const entry = "outer entry";
const outside = "updated outside";
</script>
<template>
<ExistingChild v-for="entry in records">{{ entry }} {{ outside }}</ExistingChild>
<p>{{ active }} {{ entry }}</p>
</template>`;
  const f = await fixture({
    "Panel.vue": initial,
    "ExistingChild.vue": "<template><span /></template>",
  });
  try {
    const firstDetail = await templateDetail(f.engine, "Panel.vue");
    const firstReferences = references(firstDetail);
    const staleEntries = firstDetail.neighbors.find(
      (symbol) => symbol.name === "entries" && symbol.kind === "variable",
    );
    const staleRow = firstDetail.neighbors.find(
      (symbol) => symbol.name === "row" && symbol.kind === "variable",
    );
    assert(staleEntries);
    assert(staleRow);
    assert.deepEqual(
      firstReferences.filter(({ name }) => name === "row").map(({ line }) => line),
      [9],
    );
    assert(firstReferences.some(({ name, line }) => name === "entries" && line === 8));
    assert(firstReferences.some(({ name, line }) => name === "outside" && line === 8));
    assert(
      firstReferences.some(
        ({ name, path, kind }) =>
          name === "ExistingChild" && path === "ExistingChild.vue" && kind === "component",
      ),
    );

    await f.write("Panel.vue", updated);
    assert.equal((await f.engine.refresh()).changedFiles, 1);
    const updatedDetail = await templateDetail(f.engine, "Panel.vue");
    const updatedReferences = references(updatedDetail);
    assert(!updatedReferences.some(({ name }) => name === "entries" || name === "row"));
    await assert.rejects(f.engine.inspect({ id: staleEntries.id }), /Symbol not found/);
    await assert.rejects(f.engine.inspect({ id: staleRow.id }), /Symbol not found/);
    assert(updatedReferences.some(({ name, line }) => name === "records" && line === 9));
    assert(updatedReferences.some(({ name, line }) => name === "outside" && line === 9));
    assert(updatedReferences.some(({ name, line }) => name === "active" && line === 10));
    assert.deepEqual(
      updatedReferences.filter(({ name }) => name === "entry").map(({ line }) => line),
      [10],
    );
    assert(
      updatedReferences.some(
        ({ name, path, kind }) =>
          name === "ExistingChild" && path === "ExistingChild.vue" && kind === "component",
      ),
    );

    await f.write("Panel.vue", `<!-- 前置内容 -->\n\n${updated}`);
    assert.equal((await f.engine.refresh()).changedFiles, 1);
    const shiftedDetail = await templateDetail(f.engine, "Panel.vue");
    const shiftedReferences = references(shiftedDetail);
    for (const name of ["records", "active", "entry", "outside", "ExistingChild"]) {
      const previousLine = updatedReferences.find((reference) => reference.name === name)?.line;
      const shiftedLine = shiftedReferences.find((reference) => reference.name === name)?.line;
      assert.notEqual(previousLine, undefined, name);
      assert.equal(shiftedLine, (previousLine ?? 0) + 2, name);
    }
    await rm(join(f.root, "Panel.vue"));
    const deleted = await f.engine.refresh();
    assert.equal(deleted.deletedFiles, 1);
    assert.equal(deleted.files, 1);
    await assert.rejects(f.engine.inspect({ id: shiftedDetail.symbol.id }), /Symbol not found/);
    assert.equal(
      (await f.engine.locate({ query: "active", scope: "Panel.vue" })).results.length,
      0,
    );
    assert.equal(
      (await templateDetail(f.engine, "ExistingChild.vue")).symbol.path,
      "ExistingChild.vue",
    );
  } finally {
    await f.cleanup();
  }
});
