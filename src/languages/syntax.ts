import { hashContent } from "../core/files.js";
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

interface FileGraph {
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
function fileGraph(file: SourceFile, parser: SyntaxParser, language: SyntaxLanguage): FileGraph {
  const tree = parser.parse(file.content);
  if (!tree) throw new Error(`${file.path}: ${language} parser did not produce a syntax tree`);
  try {
    const adapter = adapters[language];
    const nodes = [...descendants(tree.rootNode)];
    const declarations = nodes.flatMap((node) => adapter.declarations(node));
    const parents = new Map<Declaration, Declaration>();
    for (const item of declarations) {
      let candidates = declarations.filter(
        (candidate) =>
          candidate !== item &&
          container(candidate) &&
          candidate.node.startIndex <= item.node.startIndex &&
          end(item) <= end(candidate),
      );
      if (item.receiver)
        candidates = declarations.filter(
          (candidate) =>
            ["struct", "type"].includes(candidate.kind) &&
            candidate.name.text === item.receiver?.type,
        );
      candidates.sort((a, b) => end(a) - a.node.startIndex - (end(b) - b.node.startIndex));
      if (candidates[0] && (!item.receiver || candidates.length === 1))
        parents.set(item, candidates[0]);
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
      const excerpt = file.content.slice(start, Math.min(finish, start + 1800));
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
      const summary = documentation(item.node);
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
        summary,
        excerpt,
        document: searchDocument([qualifiedName, file.path, signature, summary].join(" ")),
        hash: hashContent(file.content.slice(start, finish)),
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
  private cache = new Map<string, { hash: string; graph: FileGraph }>();
  async build(files: SourceFile[]): Promise<FileGraph> {
    const result: FileGraph = { symbols: [], edges: [], warnings: [] };
    const paths = new Set(files.map((file) => file.path));
    for (const path of this.cache.keys()) if (!paths.has(path)) this.cache.delete(path);
    for (const file of files) {
      const language = syntaxLanguage(file.path);
      if (!language) continue;
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
      result.symbols.push(...cached.graph.symbols);
      result.edges.push(...cached.graph.edges);
      result.warnings.push(...cached.graph.warnings);
    }
    return result;
  }
  close(): void {
    this.cache.clear();
    for (const parser of this.parsers.values()) parser.delete();
    this.parsers.clear();
  }
}
