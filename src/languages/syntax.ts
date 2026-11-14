import { searchDocument } from "../core/text.js";
import type { GraphEdge, GraphSymbol, SourceFile } from "../core/types.js";
import { dart } from "./dart.js";
import { go } from "./go.js";
import { kotlin } from "./kotlin.js";
import { callable, syntaxCalls } from "./syntax-calls.js";
import {
  type Declaration,
  descendants,
  type SyntaxAdapter,
  type SyntaxEntry,
} from "./syntax-types.js";
import {
  createParser,
  namedChildren,
  type SyntaxLanguage,
  type SyntaxNode,
  type SyntaxParser,
  syntaxLanguage,
} from "./tree-sitter.js";

export interface SyntaxFileGraph {
  symbols: GraphSymbol[];
  edges: GraphEdge[];
  warnings: string[];
}
const adapters: Record<SyntaxLanguage, SyntaxAdapter> = { dart, go, kotlin };
function end(item: Declaration): number {
  return (item.end ?? item.node).endIndex;
}
function container(item: Declaration): boolean {
  return ["class", "struct", "enum", "interface", "function", "method"].includes(item.kind);
}
function documentation(node: SyntaxNode): string {
  const parts: string[] = [];
  for (
    let previous = node.previousNamedSibling;
    previous?.type.includes("comment");
    previous = previous.previousNamedSibling
  )
    parts.unshift(previous.text);
  return parts.join(" ").slice(0, 1200);
}
function fileGraph(
  file: SourceFile,
  parser: SyntaxParser,
  language: SyntaxLanguage,
): SyntaxFileGraph {
  const tree = parser.parse(file.content);
  if (!tree) throw new Error(`${file.path}: ${language} parser did not produce a syntax tree`);
  try {
    const adapter = adapters[language];
    const nodes = [...descendants(tree.rootNode)];
    const declarations = nodes.flatMap((node) => adapter.declarations(node));
    const parents = new Map<Declaration, Declaration>();
    const containers = declarations.filter(container);
    const receiverTypes = new Map<string, Declaration[]>();
    for (const item of declarations) {
      if (item.kind !== "struct" && item.kind !== "type") continue;
      const list = receiverTypes.get(item.name.text) ?? [];
      list.push(item);
      receiverTypes.set(item.name.text, list);
    }
    for (const item of declarations) {
      if (item.receiver) {
        const candidates = receiverTypes.get(item.receiver.type);
        if (candidates?.length === 1 && candidates[0]) parents.set(item, candidates[0]);
        continue;
      }
      let best: Declaration | undefined;
      let bestSpan = Number.POSITIVE_INFINITY;
      for (const candidate of containers) {
        if (candidate === item) continue;
        const candidateEnd = end(candidate);
        if (candidate.node.startIndex <= item.node.startIndex && end(item) <= candidateEnd) {
          const span = candidateEnd - candidate.node.startIndex;
          if (span < bestSpan) {
            best = candidate;
            bestSpan = span;
          }
        }
      }
      if (best) parents.set(item, best);
    }
    const entries = new Map<Declaration, SyntaxEntry>();
    const counters = new Map<string, number>();
    const entryFor = (item: Declaration): SyntaxEntry => {
      const existing = entries.get(item);
      if (existing) return existing;
      const parentItem = parents.get(item);
      const parent = parentItem && entryFor(parentItem);
      const name = item.name.text;
      let kind = item.kind;
      if (parent && ["class", "struct", "enum", "interface"].includes(parent.symbol.kind)) {
        if (kind === "function") kind = "method";
        if (kind === "variable") kind = "property";
      }
      const qualifier = parent?.symbol.qualifiedName ?? item.qualifier ?? item.receiver?.type;
      const qualifiedName = qualifier ? `${qualifier}.${name}` : name;
      const key = `${file.path}#${qualifiedName}:${kind}`;
      const occurrence = counters.get(key) ?? 0;
      counters.set(key, occurrence + 1);
      const start = item.node.startIndex;
      const finish = end(item);
      const excerpt = file.content.slice(start, Math.min(finish, start + 180));
      const body =
        item.node.childForFieldName("body") ??
        item.end ??
        namedChildren(item.node).find(
          (child) => child.type === "function_body" || child.type === "class_body",
        );
      const signature = file.content
        .slice(start, body?.startIndex ?? finish)
        .replace(/\s+/g, " ")
        .slice(0, 300);
      const comment = documentation(item.node);
      const modifiers =
        namedChildren(item.node).find((child) => child.type === "modifiers")?.text ?? "";
      const exported =
        (language === "go"
          ? /^[A-Z]/.test(name)
          : language === "dart"
            ? !name.startsWith("_")
            : !/\b(?:private|protected|internal)\b/.test(modifiers)) &&
        (parent?.symbol.exported ?? true) &&
        (!parent || !callable(parent));
      const symbol: GraphSymbol = {
        id: `${key}:${occurrence}`,
        path: file.path,
        name,
        qualifiedName,
        kind,
        start,
        end: finish,
        startLine: item.node.startPosition.row + 1,
        endLine: (item.end ?? item.node).endPosition.row + 1,
        signature,
        excerpt,
        document: searchDocument([qualifiedName, file.path, signature, comment].join(" ")),
        parentId: parent?.symbol.id,
        exported,
      };
      const entry = { declaration: item, symbol, parent };
      entries.set(item, entry);
      return entry;
    };
    for (const item of declarations) entryFor(item);
    const all = [...entries.values()];
    const edges: GraphEdge[] = all.flatMap((entry) =>
      entry.parent
        ? [
            {
              source: entry.parent.symbol.id,
              target: entry.symbol.id,
              kind: "contains" as const,
              evidence: "syntax" as const,
              line: entry.symbol.startLine,
            },
          ]
        : [],
    );
    edges.push(...syntaxCalls(nodes, all, adapter, language));
    return {
      symbols: all.map((entry) => entry.symbol),
      edges,
      warnings: tree.rootNode.hasError
        ? [`${file.path}: ${language} parse errors; index may be incomplete`]
        : [],
    };
  } finally {
    tree.delete();
  }
}
export class SyntaxGraph {
  private parsers = new Map<SyntaxLanguage, SyntaxParser>();
  private cache = new Map<string, { hash: string; graph: SyntaxFileGraph }>();
  async build(files: SourceFile[]): Promise<SyntaxFileGraph> {
    const result: SyntaxFileGraph = { symbols: [], edges: [], warnings: [] };
    const paths = new Set(files.map((file) => file.path));
    for (const path of this.cache.keys()) if (!paths.has(path)) this.cache.delete(path);
    for (const file of files) {
      const graph = await this.buildFile(file);
      if (!graph) continue;
      result.symbols.push(...graph.symbols);
      result.edges.push(...graph.edges);
      result.warnings.push(...graph.warnings);
    }
    return result;
  }
  async update(
    changed: SourceFile[],
    deletedPaths: string[],
  ): Promise<{ files: Map<string, SyntaxFileGraph> }> {
    for (const path of deletedPaths) this.cache.delete(path);
    const files = new Map<string, SyntaxFileGraph>();
    for (const file of changed) {
      const graph = await this.buildFile(file);
      if (graph) files.set(file.path, graph);
    }
    return { files };
  }
  private async buildFile(file: SourceFile): Promise<SyntaxFileGraph | undefined> {
    const language = syntaxLanguage(file.path);
    if (!language) return undefined;
    let cached = this.cache.get(file.path);
    if (cached?.hash !== file.hash) {
      let parser = this.parsers.get(language);
      if (!parser) {
        parser = await createParser(language);
        this.parsers.set(language, parser);
      }
      cached = { hash: file.hash, graph: fileGraph(file, parser, language) };
      this.cache.set(file.path, cached);
    }
    return cached.graph;
  }
  close(): void {
    this.cache.clear();
    for (const parser of this.parsers.values()) parser.delete();
    this.parsers.clear();
  }
}
