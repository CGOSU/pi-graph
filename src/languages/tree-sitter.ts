import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import TreeSitter from "@vscode/tree-sitter-wasm";

export type SyntaxNode = TreeSitter.Node;
export type SyntaxParser = TreeSitter.Parser;
export type SyntaxTree = TreeSitter.Tree;
export type SyntaxLanguage = "dart" | "go" | "kotlin";
type Language = SyntaxLanguage | "rust";

// Digests pin the vendored grammar versions; update the index configuration when upgrading.
interface BundledGrammar {
  asset: string;
  sha256: string;
}
const languages = new Map<Language, Promise<TreeSitter.Language>>();
async function load(language: Language): Promise<TreeSitter.Language> {
  await TreeSitter.Parser.init();
  if (language === "dart" || language === "kotlin") {
    const manifest = JSON.parse(
      await readFile(new URL("../../../grammars/sources.json", import.meta.url), "utf8"),
    ) as Partial<Record<"dart" | "kotlin", BundledGrammar>>;
    const grammar = manifest[language];
    if (!grammar || grammar.asset !== `${language}.wasm` || !/^[a-f0-9]{64}$/.test(grammar.sha256))
      throw new Error(`${language}: invalid bundled Tree-sitter grammar manifest`);
    const bytes = await readFile(new URL(`../../../grammars/${grammar.asset}`, import.meta.url));
    if (createHash("sha256").update(bytes).digest("hex") !== grammar.sha256)
      throw new Error(`${language}: bundled Tree-sitter grammar checksum mismatch`);
    return TreeSitter.Language.load(bytes);
  }
  return TreeSitter.Language.load(
    fileURLToPath(
      import.meta.resolve(`@vscode/tree-sitter-wasm/wasm/tree-sitter-${language}.wasm`),
    ),
  );
}
export async function createParser(language: Language): Promise<SyntaxParser> {
  let pending = languages.get(language);
  if (!pending) {
    pending = load(language).catch((error: unknown) => {
      languages.delete(language);
      throw error;
    });
    languages.set(language, pending);
  }
  const grammar = await pending;
  const parser = new TreeSitter.Parser();
  parser.setLanguage(grammar);
  return parser;
}
export function namedChildren(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((child) => child !== null);
}
export function syntaxLanguage(path: string): SyntaxLanguage | undefined {
  if (/\.dart$/i.test(path)) return "dart";
  if (/\.go$/i.test(path)) return "go";
  if (/\.kts?$/i.test(path)) return "kotlin";
  return undefined;
}
