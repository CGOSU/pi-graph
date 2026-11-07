import assert from "node:assert/strict";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { GraphClient } from "../src/core/client.js";
import { fixture } from "./helpers.js";

test("Astro indexes frontmatter and template relationships at original Unicode/CRLF offsets", async () => {
  const source = [
    "---",
    "// 中文😀",
    "import Card from './Card.astro';",
    "import Button from './Button.tsx';",
    "import { formatTitle } from './title.js';",
    "const title = '中文😀';",
    "function heading() { return formatTitle(title); }",
    "const props = { disabled: false };",
    "---",
    "<Card><Button client:load label={heading()} {...props} {title} />{title}</Card>",
    "<script>function browserOnly() {}</script>",
    "<style>.title { color: red; }</style>",
  ].join("\r\n");
  const f = await fixture({
    "Page.astro": source,
    "Card.astro": "<article><slot /></article>",
    "Button.tsx": "export default function Button() { return <button />; }",
    "title.ts": "export function formatTitle(value: string) { return value; }",
    "entry.ts": "import Page from './Page.astro'; export function page() { return Page; }",
  });
  try {
    const found = await f.engine.locate({ query: "heading", scope: "Page.astro", limit: 10 });
    const heading = found.results.find((symbol) => symbol.name === "heading");
    assert(heading);
    const detail = await f.engine.inspect({ id: heading.id, neighbors: 10 });
    assert.equal(detail.symbol.start, source.indexOf("function heading"));
    assert.equal(detail.symbol.startLine, 7);
    assert.equal(detail.source, "function heading() { return formatTitle(title); }");
    assert(detail.neighbors.some((symbol) => symbol.name === "formatTitle"));
    const template = await f.engine.inspect({
      id: "Page.astro#Page.template:template",
      neighbors: 10,
    });
    for (const name of ["Card", "Button", "heading", "title", "props"])
      assert(
        template.neighbors.some((symbol) => symbol.name === name),
        name,
      );
    assert(
      template.relations
        .filter((edge) => edge.kind === "references")
        .every((edge) => edge.evidence === "syntax" && edge.line === 10),
    );
    const entry = await f.engine.locate({ query: "page", scope: "entry.ts" });
    const page = entry.results.find((symbol) => symbol.name === "page");
    assert(page);
    assert(
      (await f.engine.inspect({ id: page.id })).neighbors.some(
        (symbol) => symbol.id === "Page.astro#Page:component",
      ),
    );
    assert.equal(
      (await f.engine.locate({ query: "browserOnly", scope: "Page.astro" })).results.some(
        (symbol) => symbol.name === "browserOnly",
      ),
      false,
    );
    assert.deepEqual(f.engine.status().warnings, []);
  } finally {
    await f.cleanup();
  }
});

test("Astro refresh removes old template edges and deleted components", async () => {
  const f = await fixture({
    "Page.astro": "---\nimport Card from './Card.astro';\n---\n<Card />",
    "Card.astro": "<slot />",
  });
  try {
    await f.engine.refresh(true);
    assert(
      (await f.engine.inspect({ id: "Page.astro#Page.template:template" })).neighbors.some(
        (symbol) => symbol.name === "Card",
      ),
    );
    await writeFile(
      join(f.root, "Page.astro"),
      "---\nconst nextTitle = 'Next';\n---\n<h1>{nextTitle}</h1>",
    );
    await unlink(join(f.root, "Card.astro"));
    await f.engine.refresh(true);
    const detail = await f.engine.inspect({ id: "Page.astro#Page.template:template" });
    assert(detail.neighbors.some((symbol) => symbol.name === "nextTitle"));
    assert(!detail.neighbors.some((symbol) => symbol.name === "Card"));
  } finally {
    await f.cleanup();
  }
});

test("Astro reports malformed input and avoids template-local shadowing edges", async () => {
  const f = await fixture({
    "Scoped.astro":
      "---\nconst item = 'outer';\nconst items = [];\n---\n{items.map(item => <span>{item}</span>)}",
    "Broken.astro": "---\nconst broken = ;\n---\n<h1 />",
  });
  try {
    await f.engine.refresh(true);
    const detail = await f.engine.inspect({ id: "Scoped.astro#Scoped.template:template" });
    assert(
      !detail.relations.some(
        (edge) => edge.kind === "references" && edge.target === "Scoped.astro#item:variable",
      ),
    );
    assert(
      f.engine
        .status()
        .warnings.some(
          (warning) => warning.includes("Scoped.astro") && warning.includes("not resolved"),
        ),
    );
    assert(f.engine.status().warnings.some((warning) => warning.includes("Broken.astro")));
  } finally {
    await f.cleanup();
  }
});

test("Astro imports resolve configured aliases through the worker", async () => {
  const f = await fixture({
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: { "@/*": ["src/*"] },
        moduleResolution: "bundler",
        module: "esnext",
      },
    }),
    "src/Card.astro": "<slot />",
    "src/Page.astro": "---\nimport Card from '@/Card.astro';\n---\n<Card />",
  });
  const client = new GraphClient(f.root);
  try {
    const result = await client.locate({ query: "template", scope: "src/Page.astro" });
    const template = result.results.find((symbol) => symbol.kind === "template");
    assert(template);
    assert(
      (await client.inspect({ id: template.id })).neighbors.some(
        (symbol) => symbol.path === "src/Card.astro" && symbol.kind === "component",
      ),
    );
  } finally {
    await client.close();
    await f.cleanup();
  }
});
