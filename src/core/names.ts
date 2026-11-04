import type { GraphSymbol } from "./types.js";

export function extractIdentifiers(query: string): string[] {
  const trimmed = query.trim();
  const words =
    trimmed.match(
      /[\p{ID_Continue}$\u200C\u200D]+(?:(?:\.|::)[\p{ID_Continue}$\u200C\u200D]+)*/gu,
    ) ?? [];
  return [
    ...new Set(
      words.filter(
        (word) =>
          word === trimmed || /[._$]|::|\p{Ll}\p{Lu}/u.test(word) || /^\p{Lu}.*\p{Ll}/u.test(word),
      ),
    ),
  ];
}

export function nameMatch(
  { name, qualifiedName }: Pick<GraphSymbol, "name" | "qualifiedName">,
  names: ReadonlySet<string>,
  foldedNames: ReadonlySet<string>,
): number {
  const qualified = qualifiedName !== name;
  if (qualified && names.has(qualifiedName)) return 4;
  if (names.has(name)) return 3;
  if (qualified && foldedNames.has(qualifiedName.toLowerCase())) return 2;
  return foldedNames.has(name.toLowerCase()) ? 1 : 0;
}
