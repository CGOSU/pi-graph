import type { GraphEdge } from "../core/types.js";
import { type Call, contains, type SyntaxAdapter, type SyntaxEntry } from "./syntax-types.js";
import type { SyntaxLanguage, SyntaxNode } from "./tree-sitter.js";

export function callable(entry: SyntaxEntry): boolean {
  return entry.symbol.kind === "function" || entry.symbol.kind === "method";
}
function encloses(entry: SyntaxEntry, node: SyntaxNode): boolean {
  return entry.symbol.start <= node.startIndex && node.endIndex <= entry.symbol.end;
}
function ancestors(entry: SyntaxEntry): SyntaxEntry[] {
  return [entry, ...(entry.parent ? ancestors(entry.parent) : [])];
}
function lexicalScope(node: SyntaxNode): SyntaxNode {
  if (node.type === "catch_block") return node;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      [
        "block",
        "for_statement",
        "for_in_statement",
        "lambda_literal",
        "func_literal",
        "function_expression",
        "class_body",
        "extension_body",
      ].includes(parent.type)
    )
      return parent;
  }
  return node.tree.rootNode;
}
function anonymousScope(call: Call, owner: SyntaxEntry): boolean {
  for (let parent = call.node.parent; parent; parent = parent.parent) {
    if (parent.startIndex < owner.symbol.start) break;
    if (
      ["lambda_literal", "func_literal", "function_expression", "anonymous_function"].includes(
        parent.type,
      )
    )
      return true;
  }
  return false;
}
export function syntaxCalls(
  nodes: SyntaxNode[],
  entries: SyntaxEntry[],
  adapter: SyntaxAdapter,
  language: SyntaxLanguage,
): GraphEdge[] {
  const functions = entries.filter(callable);
  const bindings = nodes.flatMap((node) =>
    adapter.bindings(node).map((name) => {
      const owner = entries
        .filter(
          (entry) =>
            (callable(entry) ||
              ["class", "struct", "interface", "enum"].includes(entry.symbol.kind)) &&
            encloses(entry, node),
        )
        .sort((a, b) => a.symbol.end - a.symbol.start - (b.symbol.end - b.symbol.start))[0];
      const block = lexicalScope(node);
      return { name, node, owner, scope: block, parameter: node.type.includes("parameter") };
    }),
  );
  const edges: GraphEdge[] = [];
  for (const node of nodes) {
    const call = adapter.call(node);
    if (!call) continue;
    const owner = functions
      .filter((entry) => encloses(entry, node))
      .sort((a, b) => a.symbol.end - a.symbol.start - (b.symbol.end - b.symbol.start))[0];
    if (!owner || anonymousScope(call, owner)) continue;
    const chain = ancestors(owner);
    const shadowed = (name: string) =>
      bindings.some((binding) => {
        if (binding.name !== name) return false;
        // Parameters precede the body but belong to the declaration's full region.
        if (binding.parameter) return !!binding.owner && encloses(binding.owner, node);
        return binding.node.startIndex <= node.startIndex && contains(binding.scope, node);
      });
    let targets: SyntaxEntry[];
    if (call.receiver) {
      if (language === "go") {
        const receiver = owner.declaration.receiver;
        if (!receiver || receiver.name !== call.receiver || shadowed(call.receiver)) continue;
        targets = functions.filter(
          (entry) =>
            entry.declaration.receiver?.type === receiver.type && entry.symbol.name === call.name,
        );
      } else {
        if (call.receiver !== "this") continue;
        const container = chain.find((entry) =>
          ["class", "enum", "struct"].includes(entry.symbol.kind),
        );
        if (!container) continue;
        targets = functions.filter(
          (entry) =>
            !entry.declaration.extension &&
            entry.parent === container &&
            entry.symbol.name === call.name,
        );
      }
    } else {
      if (shadowed(call.name)) continue;
      targets = functions.filter((entry) => {
        if (
          entry.symbol.name !== call.name ||
          entry.declaration.receiver ||
          entry.declaration.extension
        )
          return false;
        if (!entry.parent) return true;
        if (language === "go" && !callable(entry.parent)) return false;
        return chain.includes(entry.parent) && contains(lexicalScope(entry.declaration.node), node);
      });
      const rank = (entry: SyntaxEntry) =>
        entry.parent ? chain.indexOf(entry.parent) : chain.length;
      const nearest = Math.min(...targets.map(rank));
      targets = targets.filter((entry) => rank(entry) === nearest);
    }
    if (targets.length !== 1) continue;
    const target = targets[0];
    if (!target) continue;
    edges.push({
      source: owner.symbol.id,
      target: target.symbol.id,
      kind: "calls",
      evidence: "syntax",
      line: node.startPosition.row + 1,
    });
  }
  return [...new Map(edges.map((edge) => [`${edge.source}|${edge.target}`, edge])).values()];
}
