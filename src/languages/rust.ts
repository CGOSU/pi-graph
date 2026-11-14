import { searchDocument, tokens } from "../core/text.js";
import type { GraphEdge, GraphSymbol, SourceFile, SymbolKind } from "../core/types.js";
import { linkRustProject } from "./rust-project.js";
import {
  createParser,
  namedChildren,
  type SyntaxNode as RustNode,
  type SyntaxParser as RustParser,
  type SyntaxTree as RustTree,
} from "./tree-sitter.js";

export type { SyntaxNode as RustNode } from "./tree-sitter.js";
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
function fileGraph(parser: RustParser, file: SourceFile): RustFileGraph & { tree: RustTree } {
  const tree = parser.parse(file.content);
  if (!tree) throw new Error(`${file.path}: Rust parser did not produce a syntax tree`);
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
        excerpt: text.slice(0, 180),
        document: searchDocument(
          [name, qualifiedName, signature, comment, file.path, text.slice(0, 8000)].join(" "),
        ),
        parentId: parent?.id,
        exported:
          namedChildren(node).some((child) => child.type === "visibility_modifier") ||
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
    for (const child of namedChildren(node))
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
  }
  return {
    symbols: entries.map((entry) => entry.symbol),
    entries,
    modules,
    uses,
    edges,
    warnings,
    tree,
  };
}
export class RustGraph {
  private parser?: RustParser;
  private cache = new Map<string, { hash: string; graph: ReturnType<typeof fileGraph> }>();
  async build(
    files: SourceFile[],
  ): Promise<{ symbols: GraphSymbol[]; edges: GraphEdge[]; warnings: string[] }> {
    const result: { symbols: GraphSymbol[]; edges: GraphEdge[]; warnings: string[] } = {
      symbols: [],
      edges: [],
      warnings: [],
    };
    const current = new Set(files.map((file) => file.path));
    for (const [path, cached] of this.cache) {
      if (!current.has(path)) {
        cached.graph.tree.delete();
        this.cache.delete(path);
      }
    }
    if (!files.length) return result;
    this.parser ??= await createParser("rust");
    const parser = this.parser;
    const graphs = new Map<string, RustFileGraph>();
    for (const file of files) {
      let cached = this.cache.get(file.path);
      if (cached?.hash !== file.hash) {
        const graph = fileGraph(parser, file);
        cached?.graph.tree.delete();
        cached = { hash: file.hash, graph };
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
          if (!qualifiedName || qualifiedName === symbol.qualifiedName) return symbol;
          const documentTokens = symbol.document
            ? new Set(symbol.document.split(" "))
            : new Set<string>();
          for (const term of tokens(qualifiedName)) documentTokens.add(term);
          return {
            ...symbol,
            qualifiedName,
            document: [...documentTokens].join(" "),
          };
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
  close(): void {
    for (const cached of this.cache.values()) cached.graph.tree.delete();
    this.cache.clear();
    this.parser?.delete();
    this.parser = undefined;
  }
}
