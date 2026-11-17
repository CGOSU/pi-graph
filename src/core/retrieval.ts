import { safeScope } from "./files.js";
import { extractIdentifiers, nameMatch } from "./names.js";
import type { GraphStore } from "./store.js";
import { queryTokenGroups, tokens } from "./text.js";
import type {
  GraphEdge,
  GraphSymbol,
  LocatedSymbol,
  LocateInput,
  LocateResult,
  PublicSymbol,
} from "./types.js";

interface Candidate {
  symbol: GraphSymbol;
  score: number;
  confidence: number;
  namePriority: number;
  reason: string;
  edge?: GraphEdge;
}
function inScope(symbol: GraphSymbol, scope?: string): boolean {
  return !scope || symbol.path === scope || symbol.path.startsWith(`${scope}/`);
}
function isTestPath(path: string): boolean {
  return /(?:^|[/._-])(?:test|tests|spec)(?:[/._-]|$)/i.test(path);
}
interface MatchQuery {
  groups: string[][];
  identifiers: Set<string>;
  foldedIdentifiers: Set<string>;
  docFreqs: ReadonlyMap<string, number>;
  totalSymbols: number;
  expansions: ReadonlyMap<string, string[]>;
  preferProduction: boolean;
}
function qualifiedAliasMatch(
  qualifiedName: string,
  name: string,
  identifiers: ReadonlySet<string>,
  foldedIdentifiers: ReadonlySet<string>,
): number {
  if (qualifiedName === name || !qualifiedName.includes("::")) return 0;
  const parts = qualifiedName.split("::");
  if (parts.length < 2) return 0;
  const normalized = parts
    .slice(-2)
    .join("::")
    .replace(/\s+as\s+[^:]+::/, "::");
  if (normalized === qualifiedName || normalized === name) {
    const asIndex = qualifiedName.indexOf(" as ");
    if (asIndex === -1) return 0;
    const typePart = qualifiedName.slice(0, asIndex).split("::").at(-1);
    const memberPart = qualifiedName.slice(asIndex).split("::").slice(1).join("::");
    const traitTarget = typePart && memberPart ? `${typePart}::${memberPart}` : "";
    if (!traitTarget) return 0;
    if (identifiers.has(traitTarget)) return 5;
    return foldedIdentifiers.has(traitTarget.toLowerCase()) ? 2 : 0;
  }
  if (identifiers.has(normalized)) return 5;
  return foldedIdentifiers.has(normalized.toLowerCase()) ? 2 : 0;
}
function fullNameMatch(
  symbol: Pick<GraphSymbol, "name" | "qualifiedName">,
  identifiers: ReadonlySet<string>,
  foldedIdentifiers: ReadonlySet<string>,
): number {
  const base = nameMatch(symbol, identifiers, foldedIdentifiers);
  // Map base levels (4/3/2/1) onto 6/4/3/1 while giving stripped :: tails levels 5/2.
  const mapped = base === 4 ? 6 : base === 3 ? 4 : base === 2 ? 3 : base === 1 ? 1 : 0;
  if (mapped >= 6) return mapped;
  return Math.max(
    mapped,
    qualifiedAliasMatch(symbol.qualifiedName, symbol.name, identifiers, foldedIdentifiers),
  );
}
function relevance(
  symbol: GraphSymbol,
  {
    groups,
    identifiers,
    foldedIdentifiers,
    docFreqs,
    totalSymbols,
    expansions,
    preferProduction,
  }: MatchQuery,
) {
  const names = new Set(tokens(symbol.name));
  const qualifiedNames =
    symbol.qualifiedName !== symbol.name ? new Set(tokens(symbol.qualifiedName)) : names;
  const document = new Set(symbol.document ? symbol.document.split(" ") : []);
  const path = new Set(tokens(symbol.path));
  const bodyWeight = 1.5 / (1 + Math.log2(Math.max(1, document.size / 32)));
  const matched: string[] = [];
  let value = 0;
  const findHit = (
    group: string[],
    target: Set<string>,
    exactOnly: boolean,
  ): string | undefined => {
    for (const word of group) {
      if (target.has(word)) return word;
      if (!exactOnly) {
        const variants = expansions.get(word);
        if (variants) {
          const hit = variants.find((variant) => target.has(variant));
          if (hit) return hit;
        }
      }
    }
    return undefined;
  };
  for (const group of groups) {
    let factor = 1;
    let term = findHit(group, names, true);
    let baseScore = 5;
    if (!term) {
      term = findHit(group, qualifiedNames, true);
      baseScore = 2.5;
    }
    if (!term) {
      term = findHit(group, document, true);
      baseScore = bodyWeight;
    }
    if (!term) {
      term = findHit(group, path, true);
      baseScore = 0.5;
    }
    if (!term) {
      factor = 0.8;
      term = findHit(group, names, false);
      baseScore = 5;
      if (!term) {
        term = findHit(group, qualifiedNames, false);
        baseScore = 2.5;
      }
      if (!term) {
        term = findHit(group, document, false);
        baseScore = bodyWeight;
      }
    }
    if (!term) continue;
    matched.push(term);
    let idf = 1;
    if (totalSymbols >= 20) {
      const df = docFreqs.get(term.toLowerCase()) ?? 1;
      idf = Math.min(2.2, Math.max(0.55, Math.log2(1 + totalSymbols / (1 + df)) / 4));
    }
    value += baseScore * factor * idf;
  }
  // Shared concepts should outweigh an isolated name hit, even in a long prose query.
  value *= matched.length;
  if (symbol.kind === "interface" || symbol.kind === "type") value *= 0.65;
  else if (symbol.kind === "class" || symbol.kind === "struct" || symbol.kind === "module")
    value *= 0.85;
  if (preferProduction && isTestPath(symbol.path)) value *= 0.45;
  const confidence = value;
  const namePriority = fullNameMatch(symbol, identifiers, foldedIdentifiers);
  const reasons: string[] = [];
  if (namePriority) {
    // Exceed the maximum lexical score plus its bounded 20% graph boost.
    value += Math.max(20, 6 * groups.length ** 2);
    reasons.push(namePriority >= 4 ? "Exact name" : "Name matched ignoring case");
  }
  if (matched.length) reasons.push(`Matched: ${matched.slice(0, 5).join(", ")}`);
  return { value, confidence, namePriority, reason: reasons.join("; ") };
}
function groupLocalEvidence(
  store: GraphStore,
  candidates: Map<string, Candidate>,
  query: MatchQuery,
): void {
  const locals = [...candidates.values()].filter(
    ({ symbol, namePriority }) =>
      symbol.kind === "variable" &&
      !namePriority &&
      // Preserve potentially callable declarations rather than folding away closures.
      !/=>|->|\b(?:function|func|fn)\b|=\s*\{/.test(symbol.signature),
  );
  const edges = store.containers(locals.map(({ symbol }) => symbol.id));
  const owners = store.symbols([...new Set(edges.map((edge) => edge.source))]);
  const evidence = new Map<string, { symbol: GraphSymbol; words: Set<string>; edge: GraphEdge }>();
  const terms = new Set(query.groups.flat());
  for (const term of [...terms]) {
    for (const extra of query.expansions.get(term) ?? []) terms.add(extra);
  }
  const grouped = new Set<string>();
  for (const edge of edges) {
    const local = candidates.get(edge.target)?.symbol;
    const owner = owners.get(edge.source);
    if (
      !local ||
      !owner ||
      !["function", "method"].includes(owner.kind) ||
      owner.path !== local.path ||
      owner.start > local.start ||
      owner.end < local.end
    )
      continue;
    let context = evidence.get(owner.id);
    if (!context) {
      context = { symbol: owner, words: new Set(owner.document.split(" ")), edge };
      evidence.set(owner.id, context);
    }
    for (const word of local.document.split(" ")) if (terms.has(word)) context.words.add(word);
    grouped.add(local.id);
  }
  for (const { symbol, words, edge } of evidence.values()) {
    const match = relevance({ ...symbol, document: [...words].join(" ") }, query);
    const previous = candidates.get(symbol.id);
    candidates.set(symbol.id, {
      symbol,
      score: Math.max(previous?.score ?? 0, match.value),
      confidence: Math.max(previous?.confidence ?? 0, match.confidence),
      namePriority: match.namePriority,
      reason: `${match.reason}; contains ${candidates.get(edge.target)?.symbol.qualifiedName} (${edge.evidence})`,
    });
  }
  for (const id of grouped) candidates.delete(id);
}
export function located(
  symbol: PublicSymbol,
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
  const identifiers = extractIdentifiers(input.query);
  const preferProduction =
    !(scope && isTestPath(scope)) &&
    !/\b(?:test|tests|spec|specs)\b|测试|用例|单测/iu.test(input.query);
  const {
    symbols: searchHits,
    docFreqs,
    totalSymbols,
    expansions,
  } = store.searchWithContext(activeGroups, scope, identifiers);
  const query: MatchQuery = {
    groups: activeGroups,
    identifiers: new Set(identifiers),
    foldedIdentifiers: new Set(identifiers.map((name) => name.toLowerCase())),
    docFreqs,
    totalSymbols,
    expansions,
    preferProduction,
  };
  const scores = new Map<string, ReturnType<typeof relevance>>();
  const scored = (symbol: GraphSymbol) => {
    let result = scores.get(symbol.id);
    if (!result) {
      result = relevance(symbol, query);
      scores.set(symbol.id, result);
    }
    return result;
  };
  const candidates = new Map<string, Candidate>();
  for (const symbol of searchHits) {
    const match = scored(symbol);
    candidates.set(symbol.id, {
      symbol,
      score: match.value,
      confidence: match.confidence,
      namePriority: match.namePriority,
      reason: match.reason,
    });
  }
  const seeds = [...candidates.values()]
    .sort(
      (a, b) =>
        b.namePriority - a.namePriority ||
        b.score - a.score ||
        a.symbol.id.localeCompare(b.symbol.id),
    )
    .slice(0, 8);
  const neighborsBySeed = store.neighborsBatch(
    seeds.map((seed) => seed.symbol.id),
    16,
  );
  const neighborhoods = seeds.map((seed) => ({
    seed,
    edges: neighborsBySeed.get(seed.symbol.id) ?? [],
  }));
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
        seed.confidence * (edge.kind === "calls" ? 0.4 : edge.kind === "references" ? 0.3 : 0.1),
        Math.max(1.5, match.confidence * 0.2),
      );
      const previous = candidates.get(otherId);
      if (!previous || previous.score < direct + boost) {
        const relationLabel =
          edge.target === seed.symbol.id
            ? `${edge.kind} ${seed.symbol.qualifiedName}`
            : `${edge.kind === "calls" ? "called by" : edge.kind === "references" ? "referenced by" : "contained in"} ${seed.symbol.qualifiedName}`;
        candidates.set(otherId, {
          symbol,
          score: direct + boost,
          confidence: match.confidence,
          namePriority: match.namePriority,
          reason: `${direct ? `${match.reason}; ` : ""}${relationLabel} (${edge.evidence})`,
          edge,
        });
      }
    }
  }
  if (activeGroups.length > 1 && !/\b(?:variables?|fields?)\b|变量|字段/iu.test(input.query))
    groupLocalEvidence(store, candidates, query);
  const selected: Candidate[] = [];
  const remaining = [...candidates.values()];
  // Name matches rank independently from lexical confidence.
  const minimumConfidence = Math.max(
    1.2,
    ...remaining.map((candidate) => candidate.confidence * 0.08),
  );
  while (selected.length < limit && remaining.length) {
    const adjusted = (candidate: Candidate, score: number): number => {
      let value = score;
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
    remaining.sort(
      (a, b) =>
        b.namePriority - a.namePriority ||
        adjusted(b, b.score) - adjusted(a, a.score) ||
        a.symbol.id.localeCompare(b.symbol.id),
    );
    const next = remaining.shift();
    if (!next) break;
    if (!next.namePriority && next.confidence < minimumConfidence) continue;
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
