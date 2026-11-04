import type { GraphSymbol, SymbolKind } from "../core/types.js";
import { namedChildren, type SyntaxNode } from "./tree-sitter.js";

export interface Declaration {
  node: SyntaxNode;
  name: SyntaxNode;
  kind: SymbolKind;
  end?: SyntaxNode;
  receiver?: { name: string; type: string };
  extension?: boolean;
  qualifier?: string;
}
export interface SyntaxEntry {
  declaration: Declaration;
  symbol: GraphSymbol;
  parent?: SyntaxEntry;
}
export interface Call {
  node: SyntaxNode;
  name: string;
  receiver?: string;
}
export interface SyntaxAdapter {
  declarations(node: SyntaxNode): Declaration[];
  bindings(node: SyntaxNode): string[];
  call(node: SyntaxNode): Call | undefined;
}
export function* descendants(node: SyntaxNode): Generator<SyntaxNode> {
  yield node;
  for (const child of namedChildren(node)) yield* descendants(child);
}
export function firstIdentifier(node: SyntaxNode): SyntaxNode | undefined {
  return namedChildren(node).find((child) =>
    /^(?:simple_|type_|field_)?identifier$/.test(child.type),
  );
}
export function declaration(
  node: SyntaxNode,
  kind: SymbolKind,
  name = node.childForFieldName("name") ?? firstIdentifier(node),
): Declaration[] {
  return name ? [{ node, name, kind }] : [];
}
export function contains(outer: SyntaxNode, inner: SyntaxNode): boolean {
  return outer.startIndex <= inner.startIndex && inner.endIndex <= outer.endIndex;
}
