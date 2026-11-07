import { basename } from "node:path";
import { parse } from "@astrojs/compiler/sync";
import type { Node } from "@astrojs/compiler/types";
import ts from "typescript";
import { hashContent } from "../core/files.js";
import { searchDocument } from "../core/text.js";
import type { GraphEdge, GraphSymbol, SourceFile } from "../core/types.js";

export interface AstroSource {
  input: SourceFile;
  component: GraphSymbol;
  template: GraphSymbol;
  references: { name: string; line: number }[];
  warnings: string[];
}

export function prepareAstro(file: SourceFile): AstroSource {
  const { ast, diagnostics } = parse(file.content, { position: true });
  const warnings = diagnostics.map((item) => `${file.path}: ${item.text}`);
  // Compiler offsets are UTF-8 bytes, whereas graph/TypeScript offsets are UTF-16.
  const bytes = Buffer.from(file.content);
  const offset = (byte: number) => bytes.subarray(0, byte).toString("utf8").length;
  const frontmatter = ast.children.find((node) => node.type === "frontmatter");
  let content = file.content.replace(/[^\r\n]/g, " ");
  let templateStart = 0;
  if (frontmatter?.position?.end) {
    const start = offset(frontmatter.position.start.offset) + 3;
    const end = offset(frontmatter.position.end.offset) - 3;
    content = content.slice(0, start) + file.content.slice(start, end) + content.slice(end);
    templateStart = offset(frontmatter.position.end.offset);
  }
  const name = basename(file.path, ".astro");
  function symbol(name: string, kind: "component" | "template", start: number): GraphSymbol {
    const text = file.content.slice(start);
    return {
      id: `${file.path}#${name}:${kind}`,
      path: file.path,
      name,
      qualifiedName: name,
      kind,
      start,
      end: file.content.length,
      startLine: file.content.slice(0, start).split("\n").length,
      endLine: file.content.split("\n").length,
      signature: `${kind} ${name}`,
      summary: text.slice(0, 180),
      excerpt: text.slice(0, 260),
      document: searchDocument([name, kind, file.path, text.slice(0, 8000)].join(" ")),
      hash: hashContent(text),
      exported: kind === "component",
    };
  }
  const component = symbol(name, "component", 0);
  const template = symbol(`${name}.template`, "template", templateStart);
  template.parentId = component.id;
  const references: AstroSource["references"] = [];
  function expression(value: string, line: number): void {
    const source = ts.createSourceFile(
      "expression.tsx",
      `(${value})`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    // Do not resolve template-local bindings against frontmatter by name.
    let scoped = false;
    function check(node: ts.Node): void {
      if (ts.isFunctionLike(node) || ts.isVariableDeclaration(node)) scoped = true;
      ts.forEachChild(node, check);
    }
    check(source);
    if (scoped) {
      warnings.push(
        `${file.path}: template expression with local bindings is not resolved (line ${line})`,
      );
      return;
    }
    function visit(node: ts.Node): void {
      if (
        ts.isIdentifier(node) &&
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
        !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)
      )
        references.push({ name: node.text, line });
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  function visit(node: Node): void {
    const line = node.position?.start.line ?? template.startLine;
    if (node.type === "frontmatter" || node.type === "comment") return;
    if (node.type === "component")
      references.push({ name: node.name.split(".")[0] ?? node.name, line });
    if ("attributes" in node) {
      for (const attribute of node.attributes) {
        const attributeLine = attribute.position?.start.line ?? line;
        if (attribute.kind === "expression") expression(attribute.value, attributeLine);
        if (["shorthand", "spread"].includes(attribute.kind))
          expression(attribute.name, attributeLine);
      }
    }
    if (node.type === "element" && ["script", "style"].includes(node.name)) return;
    if (node.type === "expression") {
      // Mixed markup expressions need lexical scope analysis; avoid fabricated edges.
      if (node.children.every((child) => child.type === "text"))
        expression(
          node.children.map((child) => ("value" in child ? child.value : "")).join(""),
          line,
        );
      else warnings.push(`${file.path}: mixed template expression is not resolved (line ${line})`);
      return;
    }
    if ("children" in node) for (const child of node.children) visit(child);
  }
  visit(ast);
  content += "\nexport default {};\n";
  return {
    input: {
      ...file,
      absolutePath: `${file.absolutePath}.ts`,
      content,
      hash: hashContent(content),
    },
    component,
    template,
    references,
    warnings,
  };
}

export function astroTemplateEdges(
  astro: AstroSource,
  resolve: (name: string) => GraphSymbol | undefined,
): GraphEdge[] {
  return astro.references.flatMap(({ name, line }) => {
    const target = resolve(name);
    return target
      ? [
          {
            source: astro.template.id,
            target: target.id,
            kind: "references" as const,
            evidence: "syntax" as const,
            line,
          },
        ]
      : [];
  });
}
