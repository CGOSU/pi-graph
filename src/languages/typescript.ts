import { relative, resolve } from "node:path";
import ts from "typescript";
import { hashContent, normalizePath } from "../core/files.js";
import { searchDocument } from "../core/text.js";
import type { GraphEdge, GraphSymbol, SourceFile, SymbolKind } from "../core/types.js";

interface Declaration {
  node: ts.Node;
  name: string;
  kind: SymbolKind;
  nameNode?: ts.Node;
}
function declaration(node: ts.Node): Declaration | undefined {
  if (ts.isFunctionDeclaration(node))
    return { node, name: node.name?.text ?? "default", kind: "function", nameNode: node.name };
  if (ts.isClassDeclaration(node))
    return { node, name: node.name?.text ?? "default", kind: "class", nameNode: node.name };
  if (ts.isInterfaceDeclaration(node))
    return { node, name: node.name.text, kind: "interface", nameNode: node.name };
  if (ts.isTypeAliasDeclaration(node))
    return { node, name: node.name.text, kind: "type", nameNode: node.name };
  if (
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  )
    return { node, name: node.name.getText(), kind: "method", nameNode: node.name };
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node))
    return { node, name: node.name.getText(), kind: "property", nameNode: node.name };
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    const callable =
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer));
    const topLevel =
      ts.isVariableDeclarationList(node.parent) &&
      ts.isVariableStatement(node.parent.parent) &&
      ts.isSourceFile(node.parent.parent.parent);
    if (callable || topLevel)
      return {
        node,
        name: node.name.text,
        kind: callable ? "function" : "variable",
        nameNode: node.name,
      };
  }
  return undefined;
}
function ownText(node: ts.Node): string {
  const parts: string[] = [];
  function visit(current: ts.Node): void {
    if (current !== node && declaration(current)) return;
    if (ts.isIdentifier(current) || ts.isStringLiteralLike(current)) parts.push(current.getText());
    ts.forEachChild(current, visit);
  }
  visit(node);
  return parts.join(" ").slice(0, 8000);
}
function isExported(node: ts.Node): boolean {
  const target = ts.isVariableDeclaration(node) ? node.parent.parent : node;
  return (
    ts.canHaveModifiers(target) &&
    (ts
      .getModifiers(target)
      ?.some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword,
      ) ??
      false)
  );
}
interface LanguageConfiguration {
  options: ts.CompilerOptions;
  hash: string;
  warnings: string[];
}
export function languageConfiguration(root: string): LanguageConfiguration {
  const warnings: string[] = [];
  const reads = new Map<string, string>();
  const read = (path: string): string | undefined => {
    const content = ts.sys.readFile(path);
    reads.set(resolve(path), content ?? "<missing>");
    return content;
  };
  let options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.Preserve,
    skipLibCheck: true,
    noEmit: true,
  };
  const path =
    ts.findConfigFile(root, ts.sys.fileExists) ??
    ts.findConfigFile(root, ts.sys.fileExists, "jsconfig.json");
  if (path) {
    const config = ts.readConfigFile(path, read);
    if (config.error) warnings.push(ts.flattenDiagnosticMessageText(config.error.messageText, " "));
    else {
      const parsed = ts.parseJsonConfigFileContent(
        config.config,
        { ...ts.sys, readFile: read },
        resolve(path, ".."),
      );
      options = { ...options, ...parsed.options, allowJs: true, noEmit: true };
      warnings.push(
        ...parsed.errors
          .filter((error) => error.code !== 18003)
          .map((error) => ts.flattenDiagnosticMessageText(error.messageText, " ")),
      );
    }
  }
  return {
    options,
    warnings,
    hash: hashContent(
      JSON.stringify({ reads: [...reads].sort(([a], [b]) => a.localeCompare(b)), options }),
    ),
  };
}
export class TypeScriptGraph {
  private program?: ts.Program;
  private cache = new Map<string, { hash: string; source: ts.SourceFile }>();
  build(
    root: string,
    files: SourceFile[],
  ): { symbols: GraphSymbol[]; edges: GraphEdge[]; warnings: string[] } {
    const { options, warnings } = languageConfiguration(root);
    const inputs = new Map(files.map((f) => [resolve(f.absolutePath), f]));
    const host = ts.createCompilerHost(options, true);
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      const absolute = resolve(fileName);
      const input = inputs.get(absolute);
      const content = input?.content ?? ts.sys.readFile(absolute);
      if (content === undefined)
        return original(fileName, languageVersion, onError, shouldCreateNewSourceFile);
      const hash = input?.hash ?? hashContent(content);
      const cached = this.cache.get(absolute);
      if (cached?.hash === hash) return cached.source;
      const source = ts.createSourceFile(fileName, content, languageVersion, true);
      this.cache.set(absolute, { hash, source });
      return source;
    };
    host.readFile = (fileName) =>
      inputs.get(resolve(fileName))?.content ?? ts.sys.readFile(fileName);
    this.program = ts.createProgram({
      rootNames: files.map((f) => f.absolutePath),
      options,
      host,
      oldProgram: this.program,
    });
    const checker = this.program.getTypeChecker();
    const symbols: GraphSymbol[] = [];
    const edges: GraphEdge[] = [];
    const byNode = new Map<ts.Node, GraphSymbol>();
    const roots = this.program
      .getSourceFiles()
      .filter((source) => inputs.has(resolve(source.fileName)));
    for (const source of roots) {
      for (const error of this.program.getSyntacticDiagnostics(source))
        warnings.push(
          normalizePath(relative(root, source.fileName)) +
            ": " +
            ts.flattenDiagnosticMessageText(error.messageText, " "),
        );
      const counters = new Map<string, number>();
      const path = normalizePath(relative(root, source.fileName));
      function visit(node: ts.Node, parent?: GraphSymbol): void {
        const info = declaration(node);
        let owner = parent;
        if (info) {
          const qualifiedName = parent ? `${parent.qualifiedName}.${info.name}` : info.name;
          const key = `${path}#${qualifiedName}:${info.kind}`;
          const occurrence = counters.get(key) ?? 0;
          counters.set(key, occurrence + 1);
          const id = key + (occurrence ? `:${occurrence}` : "");
          const start = node.getStart(source);
          const end = node.getEnd();
          const text = source.text.slice(start, end);
          const header = text.split(/\r?\n/)[0] ?? info.name;
          const type = info.nameNode ? checker.getTypeAtLocation(info.nameNode) : undefined;
          const signature = (
            type
              ? `${info.name}: ${checker.typeToString(type, node, ts.TypeFormatFlags.NoTruncation)}`
              : header
          ).slice(0, 260);
          const comment =
            ts
              .getLeadingCommentRanges(source.text, node.getFullStart())
              ?.map((range) => source.text.slice(range.pos, range.end))
              .join(" ") ?? "";
          const summary =
            comment
              .replace(/\/\*+|\*\/|\/\/|\*/g, " ")
              .trim()
              .slice(0, 180) || header.slice(0, 180);
          owner = {
            id,
            path,
            name: info.name,
            qualifiedName,
            kind: info.kind,
            start,
            end,
            startLine: source.getLineAndCharacterOfPosition(start).line + 1,
            endLine: source.getLineAndCharacterOfPosition(end).line + 1,
            signature,
            summary,
            excerpt: text.slice(0, 260),
            document: searchDocument(
              [info.name, qualifiedName, signature, comment, path, ownText(node)].join(" "),
            ),
            hash: hashContent(text),
            parentId: parent?.id,
            exported: isExported(node),
          };
          symbols.push(owner);
          byNode.set(node, owner);
          if (info.nameNode) byNode.set(info.nameNode, owner);
          if (parent)
            edges.push({
              source: parent.id,
              target: owner.id,
              kind: "contains",
              evidence: "syntax",
              line: owner.startLine,
            });
        }
        ts.forEachChild(node, (child) => visit(child, owner));
      }
      visit(source);
    }
    const resolveTarget = (node: ts.Node): GraphSymbol | undefined => {
      let symbol = checker.getSymbolAtLocation(node);
      if (!symbol) return undefined;
      if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      for (const definition of [symbol.valueDeclaration, ...(symbol.declarations ?? [])]) {
        if (!definition) continue;
        const target = byNode.get(definition);
        if (target) return target;
      }
      return undefined;
    };
    for (const source of roots) {
      function visit(node: ts.Node, parent?: GraphSymbol): void {
        const owner = byNode.get(node) ?? parent;
        if (owner) {
          if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            const expression = ts.isPropertyAccessExpression(node.expression)
              ? node.expression.name
              : node.expression;
            const target = resolveTarget(expression);
            if (target && target.id !== owner.id)
              edges.push({
                source: owner.id,
                target: target.id,
                kind: "calls",
                evidence: "type-resolved",
                line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
              });
          } else if (ts.isIdentifier(node) && !byNode.has(node)) {
            const target = resolveTarget(node);
            if (target && target.id !== owner.id)
              edges.push({
                source: owner.id,
                target: target.id,
                kind: "references",
                evidence: "type-resolved",
                line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
              });
          }
        }
        ts.forEachChild(node, (child) => visit(child, owner));
      }
      visit(source);
    }
    const unique = new Map(
      edges.map((edge) => [`${edge.source}|${edge.target}|${edge.kind}`, edge]),
    );
    const active = new Set(this.program.getSourceFiles().map((source) => resolve(source.fileName)));
    for (const path of this.cache.keys()) if (!active.has(path)) this.cache.delete(path);
    return { symbols, edges: [...unique.values()], warnings };
  }
}
