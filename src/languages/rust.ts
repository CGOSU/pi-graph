import Parser from "tree-sitter";
import Rust from "tree-sitter-rust";
import { hashContent } from "../core/files.js";
import { searchDocument } from "../core/text.js";
import type { GraphEdge, GraphSymbol, SourceFile, SymbolKind } from "../core/types.js";
import { linkRustProject } from "./rust-project.js";

export type RustNode = Parser.SyntaxNode;
export interface RustEntry {
  node: RustNode;
  symbol: GraphSymbol;
  implementation?: RustNode;
  modulePath: string[];
}
export interface RustModuleDeclaration {
  name: string;
  modulePath: string[];
  inline: boolean;
}
export interface RustUseDeclaration {
  node: RustNode;
  modulePath: string[];
}
export interface RustFileGraph {
  symbols: GraphSymbol[];
  edges: GraphEdge[];
  warnings: string[];
  entries: RustEntry[];
  modules: RustModuleDeclaration[];
  uses: RustUseDeclaration[];
}
type Node = RustNode;
const kinds: Record<string, SymbolKind> = {
  function_item: "function",
  function_signature_item: "method",
  struct_item: "struct",
  enum_item: "enum",
  enum_variant: "variant",
  trait_item: "trait",
  type_item: "type",
  associated_type: "type",
  const_item: "variable",
  static_item: "variable",
  field_declaration: "property",
  mod_item: "module",
  macro_definition: "macro",
};
function field(node: Node, name: string): Node | null {
  return node.childForFieldName(name);
}
function implementationType(node: Node): string {
  const type = field(node, "type");
  return (type && (field(type, "type") ?? type).text) ?? "impl";
}
function documentation(node: Node): string {
  const parts: string[] = [];
  for (
    let previous = node.previousNamedSibling;
    previous;
    previous = previous.previousNamedSibling
  ) {
    if (!previous.type.endsWith("comment") && previous.type !== "attribute_item") break;
    parts.unshift(previous.text);
  }
  return parts.join(" ").slice(0, 2000);
}
function patternContains(node: Node | null, name: string): boolean {
  return (
    !!node &&
    ((node.type === "identifier" && node.text === name) ||
      node.namedChildren.some((child) => patternContains(child, name)))
  );
}
function shadows(node: Node, scope: Node, name: string): boolean {
  const parameters = field(scope, "parameters");
  if (
    parameters?.namedChildren.some((parameter) =>
      patternContains(field(parameter, "pattern") ?? parameter, name),
    )
  )
    return true;
  return scope.namedChildren.some(
    (child) =>
      child.type === "let_declaration" &&
      child.startIndex < node.startIndex &&
      patternContains(field(child, "pattern"), name),
  );
}
function callTarget(call: Node, owner: RustEntry, entries: RustEntry[]): RustEntry | undefined {
  let expression = field(call, "function");
  if (expression?.type === "generic_function") expression = field(expression, "function");
  if (!expression) return undefined;
  let candidates: RustEntry[] = [];
  if (expression.type === "identifier") {
    for (let scope: Node | null = call.parent; scope; scope = scope.parent) {
      if (shadows(call, scope, expression.text)) return undefined;
      candidates = entries.filter(
        (entry) =>
          entry.symbol.kind === "function" &&
          entry.node.parent?.id === scope.id &&
          entry.symbol.name === expression.text,
      );
      if (candidates.length || scope.type === "mod_item") break;
    }
  } else if (
    expression.type === "field_expression" &&
    field(expression, "value")?.text === "self" &&
    owner.implementation
  ) {
    candidates = entries.filter(
      (entry) =>
        entry.implementation?.id === owner.implementation?.id &&
        entry.symbol.name === field(expression, "field")?.text,
    );
  } else if (expression.type === "scoped_identifier") {
    const path = expression.text;
    if (path.startsWith("Self::") && owner.implementation) {
      candidates = entries.filter(
        (entry) =>
          entry.implementation?.id === owner.implementation?.id &&
          entry.symbol.name === field(expression, "name")?.text,
      );
    } else {
      const modules: string[] = [];
      for (let parent = call.parent; parent; parent = parent.parent) {
        if (parent.type === "mod_item") modules.unshift(field(parent, "name")?.text ?? "");
      }
      let qualified = path;
      if (qualified.startsWith("crate::")) {
        modules.length = 0;
        qualified = qualified.slice(7);
      } else if (qualified.startsWith("self::")) qualified = qualified.slice(6);
      else
        while (qualified.startsWith("super::")) {
          modules.pop();
          qualified = qualified.slice(7);
        }
      const name = [...modules, qualified].join("::");
      candidates = entries.filter(
        (entry) =>
          entry.symbol.qualifiedName === name &&
          (entry.symbol.kind === "function" || entry.symbol.kind === "method"),
      );
    }
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}
function fileGraph(parser: Parser, file: SourceFile): RustFileGraph {
  const tree = parser.parse(file.content);
  const entries: RustEntry[] = [];
  const edges: GraphEdge[] = [];
  const modules: RustModuleDeclaration[] = [];
  const uses: RustUseDeclaration[] = [];
  const counters = new Map<string, number>();
  const warnings = tree.rootNode.hasError
    ? [`${file.path}: Rust syntax errors; index may be incomplete`]
    : [];
  function visit(
    node: Node,
    parent?: GraphSymbol,
    namespace = "",
    implementation?: Node,
    modulePath: string[] = [],
  ): void {
    if (node.type === "ERROR" || node.type === "token_tree") return;
    let owner = parent;
    let prefix = namespace;
    let currentImpl = implementation;
    const name = field(node, "name")?.text;
    const childModulePath = node.type === "mod_item" && name ? [...modulePath, name] : modulePath;
    if (node.type === "mod_item" && name)
      modules.push({ name, modulePath, inline: !!field(node, "body") });
    if (
      node.type === "use_declaration" &&
      (node.parent?.type === "source_file" ||
        (node.parent?.type === "declaration_list" && node.parent.parent?.type === "mod_item"))
    )
      uses.push({ node, modulePath });
    if (node.type === "impl_item") {
      currentImpl = node;
      const trait = field(node, "trait");
      prefix = [namespace, implementationType(node) + (trait ? ` as ${trait.text}` : "")]
        .filter(Boolean)
        .join("::");
      owner = undefined;
    }
    const kind = kinds[node.type];
    if (kind && name) {
      const qualifiedName = [prefix, name].filter(Boolean).join("::");
      const method =
        node.type === "function_item" &&
        (node.parent?.parent?.type === "impl_item" || node.parent?.parent?.type === "trait_item");
      const symbolKind = method ? "method" : kind;
      const key = `${file.path}#${qualifiedName}:${symbolKind}`;
      const occurrence = counters.get(key) ?? 0;
      counters.set(key, occurrence + 1);
      const text = file.content.slice(node.startIndex, node.endIndex);
      const body = field(node, "body");
      const signature = file.content
        .slice(node.startIndex, body?.startIndex ?? node.endIndex)
        .trim()
        .slice(0, 260);
      const comment = documentation(node);
      owner = {
        id: key + (occurrence ? `:${occurrence}` : ""),
        path: file.path,
        name,
        qualifiedName,
        kind: symbolKind,
        start: node.startIndex,
        end: node.endIndex,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        signature,
        summary: (comment || signature).slice(0, 180),
        excerpt: text.slice(0, 260),
        document: searchDocument(
          [name, qualifiedName, signature, comment, file.path, text.slice(0, 8000)].join(" "),
        ),
        hash: hashContent(text),
        parentId: parent?.id,
        exported:
          node.namedChildren.some((child) => child.type === "visibility_modifier") ||
          parent?.kind === "trait" ||
          parent?.kind === "enum",
      };
      if (
        node.type === "mod_item" ||
        symbolKind === "function" ||
        symbolKind === "method" ||
        symbolKind === "struct" ||
        symbolKind === "enum" ||
        symbolKind === "trait"
      )
        prefix = qualifiedName;
      entries.push({ node, symbol: owner, implementation: currentImpl, modulePath });
    }
    for (const child of node.namedChildren)
      visit(child, owner, prefix, currentImpl, childModulePath);
  }
  visit(tree.rootNode);
  for (const entry of entries) {
    if (!entry.symbol.parentId && entry.implementation && entry.symbol.kind === "method") {
      const type = implementationType(entry.implementation);
      const modulePrefix = entry.symbol.qualifiedName.split("::").slice(0, -2).join("::");
      const qualifiedType = [modulePrefix, type].filter(Boolean).join("::");
      entry.symbol.parentId = entries.find(
        (other) =>
          other.symbol.qualifiedName === qualifiedType &&
          (other.symbol.kind === "struct" || other.symbol.kind === "enum"),
      )?.symbol.id;
    }
    if (entry.symbol.parentId)
      edges.push({
        source: entry.symbol.parentId,
        target: entry.symbol.id,
        kind: "contains",
        evidence: "syntax",
        line: entry.symbol.startLine,
      });
    if (entry.symbol.kind !== "function" && entry.symbol.kind !== "method") continue;
    function calls(node: Node): void {
      if (
        node.id !== entry.node.id &&
        (kinds[node.type] || node.type === "impl_item" || node.type === "token_tree")
      )
        return;
      if (node.type === "call_expression") {
        const target = callTarget(node, entry, entries);
        if (target && target.symbol.id !== entry.symbol.id)
          edges.push({
            source: entry.symbol.id,
            target: target.symbol.id,
            kind: "calls",
            evidence: "syntax",
            line: node.startPosition.row + 1,
          });
      }
      for (const child of node.namedChildren) calls(child);
    }
    calls(entry.node);
  }
  return {
    symbols: entries.map((entry) => entry.symbol),
    entries,
    modules,
    uses,
    edges: [
      ...new Map(
        edges.map((edge) => [`${edge.source}|${edge.target}|${edge.kind}`, edge]),
      ).values(),
    ],
    warnings,
  };
}
export class RustGraph {
  private parser = new Parser();
  private cache = new Map<string, { hash: string; graph: RustFileGraph }>();
  constructor() {
    this.parser.setLanguage(Rust as Parser.Language);
  }
  build(files: SourceFile[]): RustFileGraph {
    const result: RustFileGraph = {
      symbols: [],
      edges: [],
      warnings: [],
      entries: [],
      modules: [],
      uses: [],
    };
    const current = new Set(files.map((file) => file.path));
    for (const path of this.cache.keys()) if (!current.has(path)) this.cache.delete(path);
    const graphs = new Map<string, RustFileGraph>();
    for (const file of files) {
      let cached = this.cache.get(file.path);
      if (cached?.hash !== file.hash) {
        cached = { hash: file.hash, graph: fileGraph(this.parser, file) };
        this.cache.set(file.path, cached);
      }
      graphs.set(file.path, cached.graph);
    }
    const project = linkRustProject(files, graphs);
    for (const file of files) {
      const graph = graphs.get(file.path);
      if (!graph) continue;
      result.symbols.push(
        ...graph.symbols.map((symbol) => {
          const qualifiedName = project.qualifiedNames.get(symbol.id);
          return qualifiedName
            ? {
                ...symbol,
                qualifiedName,
                document: searchDocument([symbol.document, qualifiedName].join(" ")),
              }
            : symbol;
        }),
      );
      result.edges.push(...graph.edges);
      result.warnings.push(...graph.warnings);
    }
    result.edges.push(...project.edges);
    result.edges = [
      ...new Map(
        result.edges.map((edge) => [`${edge.source}|${edge.target}|${edge.kind}`, edge]),
      ).values(),
    ];
    return result;
  }
}
