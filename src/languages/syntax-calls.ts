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
function enclosingResolver(entries: SyntaxEntry[]): (node: SyntaxNode) => SyntaxEntry | undefined {
  if (!entries.length) return () => undefined;
  const active: SyntaxEntry[] = [];
  let cursor = 0;
  let lastStart = -1;
  return (node: SyntaxNode): SyntaxEntry | undefined => {
    const start = node.startIndex;
    const end = node.endIndex;
    if (start < lastStart) {
      let best: SyntaxEntry | undefined;
      let bestSpan = Number.POSITIVE_INFINITY;
      for (const entry of entries) {
        if (entry.symbol.start > start) break;
        if (end <= entry.symbol.end) {
          const span = entry.symbol.end - entry.symbol.start;
          if (span < bestSpan) {
            best = entry;
            bestSpan = span;
          }
        }
      }
      return best;
    }
    lastStart = start;
    while (cursor < entries.length) {
      const next = entries[cursor];
      if (!next || next.symbol.start > start) break;
      if (next.symbol.end >= start) active.push(next);
      cursor++;
    }
    while (active.length) {
      const top = active[active.length - 1];
      if (!top || top.symbol.end >= start) break;
      active.pop();
    }
    let best: SyntaxEntry | undefined;
    let bestSpan = Number.POSITIVE_INFINITY;
    for (let i = active.length - 1; i >= 0; i--) {
      const entry = active[i];
      if (!entry || end > entry.symbol.end) continue;
      const span = entry.symbol.end - entry.symbol.start;
      if (span < bestSpan) {
        best = entry;
        bestSpan = span;
      }
    }
    return best;
  };
}
export function syntaxCalls(
  nodes: SyntaxNode[],
  entries: SyntaxEntry[],
  adapter: SyntaxAdapter,
  language: SyntaxLanguage,
): GraphEdge[] {
  const byInterval = (a: SyntaxEntry, b: SyntaxEntry) =>
    a.symbol.start - b.symbol.start || b.symbol.end - a.symbol.end;
  const sortedFunctions = entries.filter(callable).sort(byInterval);
  const sortedOwners = entries
    .filter(
      (entry) =>
        callable(entry) || ["class", "struct", "interface", "enum"].includes(entry.symbol.kind),
    )
    .sort(byInterval);
  const nearestOwner = enclosingResolver(sortedOwners);
  const nearestFunction = enclosingResolver(sortedFunctions);
  const functionsByName = new Map<string, SyntaxEntry[]>();
  for (const entry of sortedFunctions) {
    const bucket = functionsByName.get(entry.symbol.name) ?? [];
    bucket.push(entry);
    functionsByName.set(entry.symbol.name, bucket);
  }
  const bindingsByName = new Map<
    string,
    { node: SyntaxNode; owner?: SyntaxEntry; scope: SyntaxNode; parameter: boolean }[]
  >();
  for (const node of nodes) {
    const names = adapter.bindings(node);
    if (!names.length) continue;
    const owner = nearestOwner(node);
    const scope = lexicalScope(node);
    const parameter = node.type.includes("parameter");
    for (const name of names) {
      const bucket = bindingsByName.get(name) ?? [];
      bucket.push({ node, owner, scope, parameter });
      bindingsByName.set(name, bucket);
    }
  }
  const edges: GraphEdge[] = [];
  for (const node of nodes) {
    const call = adapter.call(node);
    if (!call) continue;
    const owner = nearestFunction(node);
    if (!owner || anonymousScope(call, owner)) continue;
    const chain = ancestors(owner);
    const shadowed = (name: string) =>
      (bindingsByName.get(name) ?? []).some((binding) => {
        // Parameters precede the body but belong to the declaration's full region.
        if (binding.parameter) return !!binding.owner && encloses(binding.owner, node);
        return binding.node.startIndex <= node.startIndex && contains(binding.scope, node);
      });
    const candidates = functionsByName.get(call.name) ?? [];
    let targets: SyntaxEntry[];
    if (call.receiver) {
      if (language === "go") {
        const receiver = owner.declaration.receiver;
        if (!receiver || receiver.name !== call.receiver || shadowed(call.receiver)) continue;
        targets = candidates.filter((entry) => entry.declaration.receiver?.type === receiver.type);
      } else {
        if (call.receiver !== "this") continue;
        const container = chain.find((entry) =>
          ["class", "enum", "struct"].includes(entry.symbol.kind),
        );
        if (!container) continue;
        targets = candidates.filter(
          (entry) => !entry.declaration.extension && entry.parent === container,
        );
      }
    } else {
      if (shadowed(call.name)) continue;
      targets = candidates.filter((entry) => {
        if (entry.declaration.receiver || entry.declaration.extension) return false;
        if (!entry.parent) return true;
        if (language === "go" && !callable(entry.parent)) return false;
        return chain.includes(entry.parent) && contains(lexicalScope(entry.declaration.node), node);
      });
      if (targets.length > 1) {
        const rank = (entry: SyntaxEntry) =>
          entry.parent ? chain.indexOf(entry.parent) : chain.length;
        const nearest = Math.min(...targets.map(rank));
        targets = targets.filter((entry) => rank(entry) === nearest);
      }
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
