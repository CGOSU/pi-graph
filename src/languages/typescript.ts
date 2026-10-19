import { relative, resolve } from "node:path";
import ts from "typescript";
import { hashContent, normalizePath } from "../core/files.js";
import { searchDocument } from "../core/text.js";
import type { GraphEdge, GraphSymbol, SourceFile, SymbolKind } from "../core/types.js";
import { analyzeVueOptions, prepareVue, vueTemplateEdges } from "./vue.js";

interface Declaration {
  node: ts.Node;
  name: string;
  kind: SymbolKind;
  nameNode?: ts.Node;
}
function declaration(node: ts.Node): Declaration | undefined {
  if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
    let parent: ts.Node = node.parent;
    while (
      ts.isBindingElement(parent) ||
      ts.isObjectBindingPattern(parent) ||
      ts.isArrayBindingPattern(parent)
    )
      parent = parent.parent;
    if (ts.isVariableDeclaration(parent))
      return { node, name: node.name.text, kind: "variable", nameNode: node.name };
  }
  if (ts.isExportAssignment(node) && !node.isExportEquals && callable(node.expression))
    return { node, name: "default", kind: "function", nameNode: node.expression };
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
    const isCallable = callable(node.initializer);
    const topLevel =
      ts.isVariableDeclarationList(node.parent) &&
      ts.isVariableStatement(node.parent.parent) &&
      ts.isSourceFile(node.parent.parent.parent);
    if (isCallable || topLevel)
      return {
        node,
        name: node.name.text,
        kind: isCallable ? "function" : "variable",
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
  if (ts.isExportAssignment(node)) return !node.isExportEquals;
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
    const vueSources = files.filter((file) => /\.vue$/i.test(file.path)).map(prepareVue);
    warnings.push(...vueSources.flatMap((vue) => vue.warnings));
    const prepared = [
      ...files.filter((file) => !/\.vue$/i.test(file.path)),
      ...vueSources.map((vue) => vue.input),
    ];
    const inputs = new Map(prepared.map((file) => [resolve(file.absolutePath), file]));
    const vueByPath = new Map(vueSources.map((vue) => [resolve(vue.input.absolutePath), vue]));
    const host = ts.createCompilerHost(options, true);
    const original = host.getSourceFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    host.fileExists = (path) => inputs.has(resolve(path)) || fileExists(path);
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
      rootNames: prepared.map((file) => file.absolutePath),
      options,
      host,
      oldProgram: this.program,
    });
    const checker = this.program.getTypeChecker();
    const symbols: GraphSymbol[] = vueSources.flatMap((vue) =>
      vue.template ? [vue.component, vue.template] : [vue.component],
    );
    const edges: GraphEdge[] = [];
    const byNode = new Map<ts.Node, GraphSymbol>();
    const vueMembersByPath = new Map<string, ReturnType<typeof analyzeVueOptions>>();
    const roots = this.program
      .getSourceFiles()
      .filter((source) => inputs.has(resolve(source.fileName)));
    for (const source of roots) {
      for (const error of this.program.getSyntacticDiagnostics(source))
        warnings.push(
          (inputs.get(resolve(source.fileName))?.path ??
            normalizePath(relative(root, source.fileName))) +
            ": " +
            ts.flattenDiagnosticMessageText(error.messageText, " "),
        );
      const counters = new Map<string, number>();
      const path =
        inputs.get(resolve(source.fileName))?.path ??
        normalizePath(relative(root, source.fileName));
      const vue = vueByPath.get(resolve(source.fileName));
      if (vue) {
        for (const statement of source.statements)
          if (ts.isExportAssignment(statement)) byNode.set(statement, vue.component);
        if (vue.template)
          edges.push({
            source: vue.component.id,
            target: vue.template.id,
            kind: "contains",
            evidence: "syntax",
            line: vue.template.startLine,
          });
      }
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
            parentId: parent?.id ?? vue?.component.id,
            exported: isExported(node),
          };
          symbols.push(owner);
          byNode.set(node, owner);
          if (info.nameNode) byNode.set(info.nameNode, owner);
          if (owner.parentId)
            edges.push({
              source: owner.parentId,
              target: owner.id,
              kind: "contains",
              evidence: "syntax",
              line: owner.startLine,
            });
        }
        ts.forEachChild(node, (child) => visit(child, owner));
      }
      visit(source);
      if (vue) {
        const analysis = analyzeVueOptions(vue, source);
        vueMembersByPath.set(resolve(source.fileName), analysis);
        warnings.push(
          ...analysis.issues.map((issue) => `${vue.input.path}: ${issue.code}: ${issue.message}`),
        );
      }
    }
    const resolveSymbol = (input: ts.Symbol | undefined): GraphSymbol | undefined => {
      let symbol = input;
      if (!symbol) return undefined;
      if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      for (const definition of [symbol.valueDeclaration, ...(symbol.declarations ?? [])]) {
        if (!definition) continue;
        const target = byNode.get(definition);
        if (target) return target;
      }
      return undefined;
    };
    const resolveTarget = (node: ts.Node): GraphSymbol | undefined =>
      resolveSymbol(checker.getSymbolAtLocation(node));
    function createVueSymbol(
      source: ts.SourceFile,
      vue: NonNullable<ReturnType<typeof vueByPath.get>>,
      node: ts.Node,
      name: string,
      kind: SymbolKind,
    ): GraphSymbol {
      const existing = byNode.get(node);
      if (existing) return existing;
      const path = vue.input.path;
      const qualifiedName = name;
      const baseId = `${path}#${qualifiedName}:${kind}`;
      let id = baseId;
      let occurrence = 0;
      while (symbols.some((symbol) => symbol.id === id)) {
        occurrence += 1;
        id = `${baseId}:${occurrence}`;
      }
      const start = node.getStart(source);
      const end = node.getEnd();
      const text = source.text.slice(start, end);
      const line = source.getLineAndCharacterOfPosition(start).line + 1;
      const symbol: GraphSymbol = {
        id,
        path,
        name,
        qualifiedName,
        kind,
        start,
        end,
        startLine: line,
        endLine: source.getLineAndCharacterOfPosition(end).line + 1,
        signature: `${kind} ${name}`,
        summary: text.split(/\r?\n/)[0]?.slice(0, 180) ?? name,
        excerpt: text.slice(0, 260),
        document: searchDocument([name, qualifiedName, path, text.slice(0, 8000)].join(" ")),
        hash: hashContent(text),
        parentId: vue.component.id,
        exported: false,
      };
      symbols.push(symbol);
      byNode.set(node, symbol);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
        byNode.set(node.name, symbol);
      edges.push({
        source: vue.component.id,
        target: symbol.id,
        kind: "contains",
        evidence: "syntax",
        line,
      });
      return symbol;
    }
    for (const source of roots) {
      const vue = vueByPath.get(resolve(source.fileName));
      if (vue) {
        const bindingCandidates = new Map<string, Map<string, GraphSymbol>>();
        function addBinding(name: string, target: GraphSymbol): void {
          const candidates = bindingCandidates.get(name) ?? new Map<string, GraphSymbol>();
          candidates.set(target.id, target);
          bindingCandidates.set(name, candidates);
        }
        if (vue.descriptor.scriptSetup) {
          for (const symbol of checker.getSymbolsInScope(
            source,
            ts.SymbolFlags.Value | ts.SymbolFlags.Alias,
          )) {
            const target = resolveSymbol(symbol);
            if (target) addBinding(symbol.name, target);
          }
        }
        for (const statement of source.statements) {
          if (!ts.isExportAssignment(statement)) continue;
          let expression = statement.expression;
          if (ts.isCallExpression(expression) && expression.arguments[0])
            expression = expression.arguments[0];
          if (!ts.isObjectLiteralExpression(expression)) continue;
          for (const property of expression.properties) {
            if (
              !ts.isPropertyAssignment(property) ||
              !["methods", "computed", "components"].includes(
                property.name.getText(source).replace(/['"]/g, ""),
              ) ||
              !ts.isObjectLiteralExpression(property.initializer)
            )
              continue;
            for (const member of property.initializer.properties) {
              if (!member.name) continue;
              const target = ts.isShorthandPropertyAssignment(member)
                ? resolveSymbol(checker.getShorthandAssignmentValueSymbol(member))
                : ts.isPropertyAssignment(member) && ts.isIdentifier(member.initializer)
                  ? resolveTarget(member.initializer)
                  : byNode.get(member);
              if (target) addBinding(member.name.getText(source).replace(/['"]/g, ""), target);
            }
          }
        }
        for (const member of vueMembersByPath.get(resolve(source.fileName))?.members ?? []) {
          let target: GraphSymbol | undefined;
          if (member.kind === "setup" && member.value && ts.isIdentifier(member.value)) {
            target = member.shorthand
              ? resolveSymbol(
                  checker.getShorthandAssignmentValueSymbol(
                    member.node as ts.ShorthandPropertyAssignment,
                  ),
                )
              : resolveTarget(member.value);
            if (!target && member.scope) {
              let valueSymbol = member.shorthand
                ? checker.getShorthandAssignmentValueSymbol(
                    member.node as ts.ShorthandPropertyAssignment,
                  )
                : checker.getSymbolAtLocation(member.value);
              if (valueSymbol && valueSymbol.flags & ts.SymbolFlags.Alias)
                valueSymbol = checker.getAliasedSymbol(valueSymbol);
              const declarations = [
                ...new Set([
                  ...(valueSymbol?.valueDeclaration ? [valueSymbol.valueDeclaration] : []),
                  ...(valueSymbol?.declarations ?? []),
                ]),
              ];
              const [declaration] = declarations;
              let scope: ts.Node | undefined = declaration;
              while (scope && scope !== member.scope) scope = scope.parent;
              if (
                declaration &&
                scope === member.scope &&
                declaration.getSourceFile() === source &&
                ts.isVariableDeclaration(declaration) &&
                ts.isIdentifier(declaration.name)
              )
                target = createVueSymbol(
                  source,
                  vue,
                  declaration,
                  declaration.name.text,
                  "variable",
                );
            }
          }
          target ??= byNode.get(member.node);
          target ??= createVueSymbol(source, vue, member.node, member.name, "property");
          addBinding(member.name, target);
        }
        const bindings = new Map<string, GraphSymbol>();
        for (const [name, candidates] of bindingCandidates)
          if (candidates.size === 1) {
            const [target] = candidates.values();
            if (target) bindings.set(name, target);
          }
        const canonical = (name: string) => name.replaceAll("-", "").toLowerCase();
        const templateAnalysis = vueTemplateEdges(vue, (name, component) => {
          const exact = bindings.get(name);
          if (exact || !component) return exact;
          const matches = [...bindings].filter(
            ([binding]) => canonical(binding) === canonical(name),
          );
          return matches.length === 1 ? matches[0]?.[1] : undefined;
        });
        edges.push(...templateAnalysis.edges);
        warnings.push(
          ...templateAnalysis.issues.map(
            (issue) => `${vue.input.path}: ${issue.code}: ${issue.message} (line ${issue.line})`,
          ),
        );
      }
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
function callable(node: ts.Expression | undefined): boolean {
  if (!node) return false;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    return callable(node.expression);
  return (
    ts.isCallExpression(node) &&
    ((ts.isIdentifier(node.expression) && ["memo", "forwardRef"].includes(node.expression.text)) ||
      (ts.isPropertyAccessExpression(node.expression) &&
        ["memo", "forwardRef"].includes(node.expression.name.text))) &&
    node.arguments.some((argument) => callable(argument))
  );
}
