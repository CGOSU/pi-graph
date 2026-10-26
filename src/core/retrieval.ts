import { safeScope } from "./files.js";
import type { GraphStore } from "./store.js";
import { queryTokenGroups, tokens } from "./text.js";
import type { GraphEdge, GraphSymbol, LocatedSymbol, LocateInput, LocateResult } from "./types.js";

interface Candidate {
  symbol: GraphSymbol;
  score: number;
  reason: string;
  edge?: GraphEdge;
}
function inScope(symbol: GraphSymbol, scope?: string): boolean {
  return !scope || symbol.path === scope || symbol.path.startsWith(`${scope}/`);
}
function relevance(symbol: GraphSymbol, groups: string[][], identifiers: Set<string>) {
  const names = new Set(tokens(symbol.name));
  const document = new Set(symbol.document.split(" "));
  const path = new Set(tokens(symbol.path));
  const bodyWeight = 1.5 / (1 + Math.log2(Math.max(1, document.size / 32)));
  const matched: string[] = [];
  let value = 0;
  for (const group of groups) {
    const term =
      group.find((word) => names.has(word)) ??
      group.find((word) => document.has(word)) ??
      group.find((word) => path.has(word));
    if (!term) continue;
    matched.push(term);
    value += names.has(term) ? 5 : document.has(term) ? bodyWeight : 0.5;
  }
  // Shared concepts should outweigh an isolated name hit, even in a long prose query.
  value *= matched.length;
  if (symbol.kind === "interface" || symbol.kind === "type") value *= 0.65;
  if (
    identifiers.has(symbol.qualifiedName.toLowerCase()) ||
    identifiers.has(symbol.name.toLowerCase())
  ) {
    // Exceed the maximum lexical score plus its bounded 20% graph boost.
    value += Math.max(20, 6 * groups.length ** 2);
  }
  return { value, reason: `Matched: ${matched.slice(0, 5).join(", ")}` };
}
export function located(
  symbol: GraphSymbol,
  scoreValue: number,
  reason: string,
  edge?: GraphEdge,
): LocatedSymbol {
  const role = /(?:^|[/._-])(?:test|tests|spec)(?:[/._-]|$)/i.test(symbol.path)
    ? "test"
    : symbol.kind === "property" || symbol.kind === "variable"
      ? "state"
      : /^(?:on|handle|start|register|route)[A-Z_]/.test(symbol.name)
        ? "entry"
        : edge?.target === symbol.id
          ? "implementation"
          : edge
            ? "consumer"
            : "implementation";
  return {
    id: symbol.id,
    path: symbol.path,
    name: symbol.qualifiedName,
    kind: symbol.kind,
    lines: [symbol.startLine, symbol.endLine],
    signature: symbol.signature.slice(0, 180),
    role,
    reason,
    evidence: symbol.excerpt.slice(0, 180),
    score: Math.round(scoreValue * 100) / 100,
    freshness: "current",
  };
}
export function locate(store: GraphStore, input: LocateInput, warnings: string[]): LocateResult {
  if (!input.query.trim() || input.query.length > 2000)
    throw new Error("query must contain 1–2000 characters");
  const limit = input.limit ?? 6;
  if (!Number.isInteger(limit) || limit < 3 || limit > 10)
    throw new Error("limit must be an integer from 3 to 10");
  const scope = safeScope(input.scope);
  const groups = queryTokenGroups(input.query);
  const terms = [...new Set(groups.flat())].slice(0, 32);
  const activeGroups = groups
    .map((group) => group.filter((term) => terms.includes(term)))
    .filter((group) => group.length);
  const identifiers = new Set(
    (input.query.match(/[\p{L}\p{N}_$]+(?:(?:\.|::)[\p{L}\p{N}_$]+)*/gu) ?? [])
      .filter((word) => word === input.query.trim() || /[._$]|::|[a-z][A-Z]/.test(word))
      .map((word) => word.toLowerCase()),
  );
  const scores = new Map<string, ReturnType<typeof relevance>>();
  const scored = (symbol: GraphSymbol) => {
    let result = scores.get(symbol.id);
    if (!result) {
      result = relevance(symbol, activeGroups, identifiers);
      scores.set(symbol.id, result);
    }
    return result;
  };
  const candidates = new Map<string, Candidate>();
  for (const symbol of store.search(terms, scope)) {
    const match = scored(symbol);
    candidates.set(symbol.id, { symbol, score: match.value, reason: match.reason });
  }
  const seeds = [...candidates.values()]
    .sort((a, b) => b.score - a.score || a.symbol.id.localeCompare(b.symbol.id))
    .slice(0, 8);
  const neighborhoods = seeds.map((seed) => ({ seed, edges: store.neighbors(seed.symbol.id, 16) }));
  const symbols = new Map([...candidates.values()].map(({ symbol }) => [symbol.id, symbol]));
  const missing = new Set<string>();
  for (const { seed, edges } of neighborhoods) {
    for (const edge of edges) {
      const id = edge.source === seed.symbol.id ? edge.target : edge.source;
      if (!symbols.has(id)) missing.add(id);
    }
  }
  for (const [id, symbol] of store.symbols([...missing])) symbols.set(id, symbol);
  const relationMap = new Map<string, GraphEdge>();
  for (const { seed, edges } of neighborhoods) {
    for (const edge of edges) {
      relationMap.set(`${edge.source}|${edge.target}|${edge.kind}`, edge);
      const otherId = edge.source === seed.symbol.id ? edge.target : edge.source;
      const symbol = symbols.get(otherId);
      if (!symbol || !inScope(symbol, scope)) continue;
      const match = scored(symbol);
      const direct = match.value;
      const boost = Math.min(
        seed.score * (edge.kind === "calls" ? 0.4 : edge.kind === "references" ? 0.3 : 0.1),
        Math.max(1.5, direct * 0.2),
      );
      const previous = candidates.get(otherId);
      if (!previous || previous.score < direct + boost)
        candidates.set(otherId, {
          symbol,
          score: direct + boost,
          reason: `${direct ? `${match.reason}; ` : ""}${edge.kind} ${seed.symbol.qualifiedName} (${edge.evidence})`,
          edge,
        });
    }
  }
  const selected: Candidate[] = [];
  const remaining = [...candidates.values()];
  while (selected.length < limit && remaining.length) {
    const adjusted = (candidate: Candidate): number => {
      let value = candidate.score;
      for (const picked of selected) {
        const a = picked.symbol;
        const b = candidate.symbol;
        if (
          a.path === b.path &&
          ((a.start <= b.start && a.end >= b.end) || (b.start <= a.start && b.end >= a.end))
        )
          value *= 0.3;
        else if (a.path === b.path && a.name === b.name) value *= 0.5;
      }
      return value;
    };
    remaining.sort((a, b) => adjusted(b) - adjusted(a) || a.symbol.id.localeCompare(b.symbol.id));
    const next = remaining.shift();
    if (!next || adjusted(next) < Math.max(1.4, (seeds[0]?.score ?? 0) * 0.12)) break;
    selected.push(next);
  }
  const ids = new Set(selected.map((candidate) => candidate.symbol.id));
  return {
    query: input.query,
    revision: Number(store.metadata("revision") ?? 0),
    results: selected.map((candidate) =>
      located(candidate.symbol, candidate.score, candidate.reason, candidate.edge),
    ),
    relations: [...relationMap.values()]
      .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
      .slice(0, 20),
    warnings: selected.length
      ? warnings
      : [...warnings, "No confident symbol matches. Try a literal, identifier, or narrower scope."],
    retrieval: "lexical+graph",
  };
}
