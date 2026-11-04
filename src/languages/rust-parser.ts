import { fileURLToPath } from "node:url";
import TreeSitter from "@vscode/tree-sitter-wasm";

export type RustNode = TreeSitter.Node;
export type RustParser = TreeSitter.Parser;
export type RustTree = TreeSitter.Tree;

let language: Promise<TreeSitter.Language> | undefined;
export async function createRustParser(): Promise<RustParser> {
  language ??= TreeSitter.Parser.init()
    .then(() =>
      TreeSitter.Language.load(
        fileURLToPath(import.meta.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-rust.wasm")),
      ),
    )
    .catch((error: unknown) => {
      language = undefined;
      throw error;
    });
  const rust = await language;
  const parser = new TreeSitter.Parser();
  parser.setLanguage(rust);
  return parser;
}

export function namedChildren(node: RustNode): RustNode[] {
  return node.namedChildren.filter((child) => child !== null);
}
