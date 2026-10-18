import { basename } from "node:path";
import { ElementTypes, NodeTypes, type TemplateChildNode } from "@vue/compiler-dom";
import { parse, type SFCDescriptor } from "@vue/compiler-sfc";
import ts from "typescript";
import { hashContent } from "../core/files.js";
import { searchDocument } from "../core/text.js";
import type { GraphEdge, GraphSymbol, SourceFile } from "../core/types.js";

export interface VueSource {
  input: SourceFile;
  descriptor: SFCDescriptor;
  component: GraphSymbol;
  template?: GraphSymbol;
  warnings: string[];
}
function vueSymbol(
  file: SourceFile,
  name: string,
  kind: "component" | "template",
  start: number,
  end: number,
): GraphSymbol {
  const text = file.content.slice(start, end);
  return {
    id: `${file.path}#${name}:${kind}`,
    path: file.path,
    name,
    qualifiedName: name,
    kind,
    start,
    end,
    startLine: file.content.slice(0, start).split("\n").length,
    endLine: file.content.slice(0, end).split("\n").length,
    signature: `${kind} ${name}`,
    summary: text.slice(0, 180),
    excerpt: text.slice(0, 260),
    document: searchDocument([name, kind, file.path, text.slice(0, 8000)].join(" ")),
    hash: hashContent(text),
    exported: kind === "component",
  };
}
export function prepareVue(file: SourceFile): VueSource {
  const { descriptor, errors } = parse(file.content, { filename: file.path, sourceMap: false });
  const warnings = errors.map(
    (error) => `${file.path}: ${typeof error === "string" ? error : error.message}`,
  );
  let content = file.content.replace(/[^\r\n]/g, " ");
  let extension = "js";
  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (!block) continue;
    if (block.src) {
      warnings.push(`${file.path}: external script src is not embedded in the SFC index`);
      continue;
    }
    const lang = block.lang ?? "js";
    if (!["js", "jsx", "ts", "tsx"].includes(lang)) {
      warnings.push(`${file.path}: unsupported script language ${lang}`);
      continue;
    }
    if (lang.endsWith("x")) extension = "tsx";
    else if (lang === "ts" && extension !== "tsx") extension = "ts";
    content =
      content.slice(0, block.loc.start.offset) +
      block.content +
      content.slice(block.loc.end.offset);
  }
  const script = ts.createSourceFile(
    `component.${extension}`,
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  if (
    !script.statements.some(
      (statement) =>
        ts.isExportAssignment(statement) ||
        (ts.canHaveModifiers(statement) &&
          ts
            .getModifiers(statement)
            ?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)),
    )
  )
    content += "\nexport default {};\n";
  const name = basename(file.path, ".vue");
  const component = vueSymbol(file, name, "component", 0, file.content.length);
  const block = descriptor.template;
  const template = block
    ? vueSymbol(file, `${name}.template`, "template", block.loc.start.offset, block.loc.end.offset)
    : undefined;
  if (template) template.parentId = component.id;
  if (block?.src || (block?.lang && block.lang !== "html"))
    warnings.push(`${file.path}: external or preprocessed template is not resolved`);
  return {
    input: {
      ...file,
      absolutePath: `${file.absolutePath}.${extension}`,
      content,
      hash: hashContent(content),
    },
    descriptor,
    component,
    template,
    warnings,
  };
}
function identifiers(expression: string): string[] {
  const source = ts.createSourceFile(
    "template.tsx",
    `(${expression})`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const names = new Set<string>();
  const bindings = new Set<string>();
  function bind(name: ts.BindingName): void {
    if (ts.isIdentifier(name)) bindings.add(name.text);
    else for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name);
  }
  function visit(node: ts.Node): void {
    if (ts.isParameter(node) || ts.isVariableDeclaration(node)) bind(node.name);
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      if (
        !(
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          (ts.isMethodDeclaration(parent) && parent.name === node)
        )
      )
        names.add(node.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...names].filter((name) => !bindings.has(name));
}
export function vueTemplateEdges(
  vue: VueSource,
  lookup: (name: string, component: boolean) => GraphSymbol | undefined,
): GraphEdge[] {
  const template = vue.template;
  const block = vue.descriptor.template;
  if (!template || !block?.ast || block.src || (block.lang && block.lang !== "html")) return [];
  const edges: GraphEdge[] = [];
  const templateId = template.id;
  function reference(name: string, line: number, component = false): void {
    const target = lookup(name, component);
    if (target)
      edges.push({
        source: templateId,
        target: target.id,
        kind: "references",
        evidence: "syntax",
        line,
      });
  }
  function expression(text: string, line: number): void {
    for (const name of identifiers(text)) reference(name, line);
  }
  function visit(node: TemplateChildNode): void {
    if (node.type === NodeTypes.INTERPOLATION && node.content.type === NodeTypes.SIMPLE_EXPRESSION)
      expression(node.content.content, node.loc.start.line);
    if (node.type !== NodeTypes.ELEMENT) return;
    // Scoped template bindings need Vue's full binding transform; do not guess their targets.
    if (
      node.props.some(
        (prop) =>
          prop.type === NodeTypes.DIRECTIVE && (prop.name === "for" || prop.name === "slot"),
      )
    )
      return;
    if (node.tagType === ElementTypes.COMPONENT) reference(node.tag, node.loc.start.line, true);
    for (const prop of node.props) {
      if (prop.type !== NodeTypes.DIRECTIVE) continue;
      if (prop.exp?.type === NodeTypes.SIMPLE_EXPRESSION)
        expression(prop.exp.content, prop.loc.start.line);
      if (prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION && !prop.arg.isStatic)
        expression(prop.arg.content, prop.loc.start.line);
    }
    for (const child of node.children) visit(child);
  }
  for (const child of block.ast.children) visit(child);
  return edges;
}
