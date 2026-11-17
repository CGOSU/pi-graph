import { join, resolve } from "node:path";
import ts from "typescript";
import { fileIdentity, hashContent } from "../core/files.js";
import { searchDocument } from "../core/text.js";
import type { GraphEdge, GraphSymbol, SourceFile, SymbolKind } from "../core/types.js";
import { type AstroSource, astroTemplateEdges, prepareAstro } from "./astro.js";
import { analyzeVueOptions, prepareVue, type VueSource, vueTemplateEdges } from "./vue.js";

interface Declaration {
  node: ts.Node;
  name: string;
  kind: SymbolKind;
  nameNode?: ts.Node;
}
function declaration(node: ts.Node, source?: ts.SourceFile): Declaration | undefined {
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
    return { node, name: node.name.getText(source), kind: "method", nameNode: node.name };
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node))
    return { node, name: node.name.getText(source), kind: "property", nameNode: node.name };
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
function ownText(node: ts.Node, source: ts.SourceFile): string {
  const parts: string[] = [];
  let length = 0;
  function visit(current: ts.Node): void {
    if (length >= 8000) return;
    if (current !== node && declaration(current, source)) return;
    if (ts.isIdentifier(current) || ts.isStringLiteralLike(current)) {
      const piece = current.getText(source);
      parts.push(piece);
      length += piece.length + 1;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return parts.join(" ").slice(0, 8000);
}
function extractSignature(source: ts.SourceFile, node: ts.Node, info: Declaration): string {
  const start = node.getStart(source);
  const end = node.getEnd();
  let bodyStart = end;
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    node.body
  ) {
    bodyStart = node.body.getStart(source);
  } else if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
    const brace = source.text.indexOf("{", start);
    if (brace !== -1 && brace < end) bodyStart = brace;
  } else if (
    ts.isVariableDeclaration(node) &&
    node.initializer &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    bodyStart = node.initializer.body.getStart(source);
  }
  const raw = source.text.slice(start, Math.max(start, bodyStart)).replace(/\s+/g, " ").trim();
  return (raw || info.name).slice(0, 260);
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
export interface LanguageConfiguration {
  options: ts.CompilerOptions;
  hash: string;
  warnings: string[];
  watched?: { path: string; stat: string }[];
}
export function languageConfiguration(root: string): LanguageConfiguration {
  const warnings: string[] = [];
  const reads = new Map<string, string>();
  const watched = new Map<string, string>();
  const watchPath = (filePath: string) => {
    const abs = resolve(filePath);
    if (!watched.has(abs)) watched.set(abs, fileIdentity(abs));
  };
  const read = (path: string): string | undefined => {
    watchPath(path);
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
  watchPath(join(root, "tsconfig.json"));
  watchPath(join(root, "jsconfig.json"));
  const path =
    ts.findConfigFile(root, ts.sys.fileExists) ??
    ts.findConfigFile(root, ts.sys.fileExists, "jsconfig.json");
  if (path) {
    watchPath(path);
    const config = ts.readConfigFile(path, read);
    if (config.error) warnings.push(ts.flattenDiagnosticMessageText(config.error.messageText, " "));
    else {
      const parsed = ts.parseJsonConfigFileContent(
        config.config,
        // The graph supplies its own source list; config checks need options and inherited
        // file contents, not another recursive directory enumeration on every query.
        { ...ts.sys, readFile: read, readDirectory: () => [] },
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
    watched: [...watched].map(([filePath, stat]) => ({ path: filePath, stat })),
    hash: hashContent(
      JSON.stringify({ reads: [...reads].sort(([a], [b]) => a.localeCompare(b)), options }),
    ),
  };
}
export function isLanguageConfigurationCurrent(config: LanguageConfiguration): boolean {
  if (!config.watched?.length) return false;
  for (const entry of config.watched) {
    if (fileIdentity(entry.path) !== entry.stat) return false;
  }
  return true;
}
interface CachedTsFile {
  rawHash: string;
  path: string;
  absolutePath: string;
  externalModule: boolean;
  deps: string[];
  hasUnresolvedImport: boolean;
  symbols: GraphSymbol[];
  edges: GraphEdge[];
  warnings: string[];
  nodePairs: [ts.Node, GraphSymbol][];
}
export interface TypeScriptBuildResult {
  symbols: GraphSymbol[];
  edges: GraphEdge[];
  warnings: string[];
  scopePaths?: string[];
  deltaSymbols?: GraphSymbol[];
  deltaEdges?: GraphEdge[];
}
export class TypeScriptGraph {
  private program?: ts.Program;
  private cache = new Map<string, { hash: string; source: ts.SourceFile }>();
  private vueCache = new Map<string, { hash: string; prepared: VueSource }>();
  private astroCache = new Map<string, { hash: string; prepared: AstroSource }>();
  private fileExistsCache = new Map<string, boolean>();
  private sysReadCache = new Map<
    string,
    { stat: string; content: string | undefined; hash: string }
  >();
  private fileCache = new Map<string, CachedTsFile>();
  private lastConfigHash?: string;

  build(
    root: string,
    files: SourceFile[],
    configuration?: LanguageConfiguration,
    committedDiff?: { dirtyPaths?: ReadonlySet<string>; deletedPaths?: readonly string[] },
  ): TypeScriptBuildResult {
    const resolved = configuration ?? languageConfiguration(root);
    const options = resolved.options;
    const configWarnings = [...resolved.warnings];
    const configChanged = this.lastConfigHash !== resolved.hash;
    if (configChanged) {
      this.fileExistsCache.clear();
      this.fileCache.clear();
    }

    const vueFiles = files.filter((file) => /\.vue$/i.test(file.path));
    const activeVue = new Set(vueFiles.map((file) => file.path));
    for (const path of this.vueCache.keys()) if (!activeVue.has(path)) this.vueCache.delete(path);
    const vueSources = vueFiles.map((file) => {
      const cached = this.vueCache.get(file.path);
      if (cached?.hash === file.hash) return cached.prepared;
      const prepared = prepareVue(file);
      this.vueCache.set(file.path, { hash: file.hash, prepared });
      return prepared;
    });

    const astroFiles = files.filter((file) => /\.astro$/i.test(file.path));
    const activeAstro = new Set(astroFiles.map((file) => file.path));
    for (const path of this.astroCache.keys())
      if (!activeAstro.has(path)) this.astroCache.delete(path);
    const astroSources = astroFiles.map((file) => {
      const cached = this.astroCache.get(file.path);
      if (cached?.hash === file.hash) return cached.prepared;
      const prepared = prepareAstro(file);
      this.astroCache.set(file.path, { hash: file.hash, prepared });
      return prepared;
    });

    const prepared = [
      ...files.filter((file) => !/\.(vue|astro)$/i.test(file.path)),
      ...vueSources.map((vue) => vue.input),
      ...astroSources.map((astro) => astro.input),
    ];
    const rawHashByAbs = new Map<string, string>();
    for (const file of files) {
      if (!/\.(vue|astro)$/i.test(file.path))
        rawHashByAbs.set(resolve(file.absolutePath), file.hash);
    }
    for (const vue of vueSources) rawHashByAbs.set(resolve(vue.input.absolutePath), vue.input.hash);
    for (const astro of astroSources)
      rawHashByAbs.set(resolve(astro.input.absolutePath), astro.input.hash);
    const rawSourceHashByPath = new Map(files.map((file) => [file.path, file.hash]));

    const astroByPath = new Map(
      astroSources.map((astro) => [resolve(astro.input.absolutePath), astro]),
    );
    const inputs = new Map(prepared.map((file) => [resolve(file.absolutePath), file]));
    const vueByPath = new Map(vueSources.map((vue) => [resolve(vue.input.absolutePath), vue]));

    // Determine incremental dirty set before building ts.Program.
    const currentPaths = new Set(files.map((file) => file.path));
    let incremental = !configChanged && this.fileCache.size > 0;
    const deletedSet = new Set<string>(committedDiff?.deletedPaths ?? []);
    const deletedAbs: string[] = [];
    if (incremental) {
      for (const [path, cached] of this.fileCache) {
        if (!currentPaths.has(path)) {
          deletedSet.add(path);
          deletedAbs.push(cached.absolutePath);
        }
      }
      if (deletedSet.size) this.fileExistsCache.clear();
    }
    const deletedPaths = [...deletedSet];

    const dirtyAbs = new Set<string>();
    if (incremental) {
      let addedCount = 0;
      const importers = new Map<string, Set<string>>();
      for (const cached of this.fileCache.values()) {
        if (!cached.externalModule) {
          incremental = false;
          break;
        }
        for (const dep of cached.deps) {
          let list = importers.get(dep);
          if (!list) {
            list = new Set();
            importers.set(dep, list);
          }
          list.add(cached.absolutePath);
        }
      }
      if (incremental) {
        for (const file of prepared) {
          const abs = resolve(file.absolutePath);
          const prev = this.fileCache.get(file.path);
          const rawHash = rawSourceHashByPath.get(file.path) ?? file.hash;
          const forcedDirty = committedDiff?.dirtyPaths?.has(file.path) ?? false;
          if (!prev) {
            addedCount++;
            dirtyAbs.add(abs);
          } else if (forcedDirty || prev.rawHash !== rawHash || prev.absolutePath !== abs) {
            dirtyAbs.add(abs);
            if (prev.absolutePath !== abs) dirtyAbs.add(prev.absolutePath);
          }
        }
        if (addedCount > 0) {
          this.fileExistsCache.clear();
          for (const cached of this.fileCache.values()) {
            if (cached.hasUnresolvedImport) dirtyAbs.add(cached.absolutePath);
          }
        }
        for (const abs of deletedAbs) {
          for (const importer of importers.get(abs) ?? []) dirtyAbs.add(importer);
        }
        // Transitive reverse-dependency expansion for re-exports and type chains.
        const queue = [...dirtyAbs];
        for (let i = 0; i < queue.length; i++) {
          const current = queue[i];
          if (!current) continue;
          for (const importer of importers.get(current) ?? []) {
            if (!dirtyAbs.has(importer)) {
              dirtyAbs.add(importer);
              queue.push(importer);
            }
          }
        }
      }
    }
    if (!incremental) {
      for (const abs of inputs.keys()) dirtyAbs.add(abs);
    }

    const host = ts.createCompilerHost(options, true);
    const original = host.getSourceFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    const readSysFile = (absolute: string): { content: string | undefined; hash: string } => {
      const stat = fileIdentity(absolute);
      const cached = this.sysReadCache.get(absolute);
      if (cached && cached.stat === stat) return { content: cached.content, hash: cached.hash };
      const content = stat === "missing" ? undefined : ts.sys.readFile(absolute);
      const hash = content === undefined ? "" : hashContent(content);
      this.sysReadCache.set(absolute, { stat, content, hash });
      return { content, hash };
    };
    host.fileExists = (path) => {
      const absolute = resolve(path);
      if (inputs.has(absolute)) return true;
      const cached = this.fileExistsCache.get(absolute);
      if (cached !== undefined) return cached;
      const exists = fileExists(path);
      this.fileExistsCache.set(absolute, exists);
      return exists;
    };
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      const absolute = resolve(fileName);
      const input = inputs.get(absolute);
      let content: string | undefined;
      let hash: string;
      if (input) {
        content = input.content;
        hash = input.hash;
      } else {
        const sysEntry = readSysFile(absolute);
        content = sysEntry.content;
        hash = sysEntry.hash;
      }
      if (content === undefined)
        return original(fileName, languageVersion, onError, shouldCreateNewSourceFile);
      const cached = this.cache.get(absolute);
      if (cached?.hash === hash) return cached.source;
      const source = ts.createSourceFile(fileName, content, languageVersion, true);
      this.cache.set(absolute, { hash, source });
      return source;
    };
    host.readFile = (fileName) => {
      const absolute = resolve(fileName);
      return inputs.get(absolute)?.content ?? readSysFile(absolute).content;
    };
    this.program = ts.createProgram({
      rootNames: prepared.map((file) => file.absolutePath),
      options,
      host,
      oldProgram: this.program,
    });
    const checker = this.program.getTypeChecker();

    const byNode = new Map<ts.Node, GraphSymbol>();
    const vueMembersByPath = new Map<string, ReturnType<typeof analyzeVueOptions>>();
    const roots = this.program
      .getSourceFiles()
      .filter((source) => inputs.has(resolve(source.fileName)));

    // Check if any newly dirty root became a non-module global script; if so, analyze all roots.
    if (incremental) {
      for (const source of roots) {
        const abs = resolve(source.fileName);
        if (dirtyAbs.has(abs) && !ts.isExternalModule(source)) {
          incremental = false;
          for (const key of inputs.keys()) dirtyAbs.add(key);
          break;
        }
      }
    }

    const workingFiles = new Map<
      string,
      {
        input: SourceFile;
        source: ts.SourceFile;
        symbols: GraphSymbol[];
        edges: GraphEdge[];
        warnings: string[];
        nodePairs: [ts.Node, GraphSymbol][];
        usedIds: Set<string>;
      }
    >();

    for (const source of roots) {
      const absolute = resolve(source.fileName);
      const input = inputs.get(absolute);
      if (!input) continue;
      const path = input.path;

      if (!dirtyAbs.has(absolute)) {
        const cached = this.fileCache.get(path);
        if (cached) {
          for (const [node, sym] of cached.nodePairs) byNode.set(node, sym);
          continue;
        }
      }

      const fileSymbols: GraphSymbol[] = [];
      const fileEdges: GraphEdge[] = [];
      const fileWarnings: string[] = [];
      const nodePairs: [ts.Node, GraphSymbol][] = [];
      const usedIds = new Set<string>();

      const vue = vueByPath.get(absolute);
      const astro = astroByPath.get(absolute);
      if (vue) {
        fileSymbols.push(vue.component);
        usedIds.add(vue.component.id);
        if (vue.template) {
          fileSymbols.push(vue.template);
          usedIds.add(vue.template.id);
        }
        fileWarnings.push(...vue.warnings);
      } else if (astro) {
        fileSymbols.push(astro.component, astro.template);
        usedIds.add(astro.component.id);
        usedIds.add(astro.template.id);
        fileWarnings.push(...astro.warnings);
      }

      for (const error of this.program.getSyntacticDiagnostics(source))
        fileWarnings.push(`${path}: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`);

      const counters = new Map<string, number>();
      const componentSource = vue ?? astro;
      if (componentSource) {
        for (const statement of source.statements) {
          if (ts.isExportAssignment(statement)) {
            byNode.set(statement, componentSource.component);
            nodePairs.push([statement, componentSource.component]);
          }
        }
        if (componentSource.template)
          fileEdges.push({
            source: componentSource.component.id,
            target: componentSource.template.id,
            kind: "contains",
            evidence: "syntax",
            line: componentSource.template.startLine,
          });
      }

      function visit(node: ts.Node, parent?: GraphSymbol): void {
        const info = declaration(node, source);
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
          const signature = extractSignature(source, node, info);
          const comment =
            ts
              .getLeadingCommentRanges(source.text, node.getFullStart())
              ?.map((range) => source.text.slice(range.pos, range.end))
              .join(" ") ?? "";
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
            excerpt: text.slice(0, 180),
            document: searchDocument(
              [info.name, qualifiedName, signature, comment, path, ownText(node, source)].join(" "),
            ),
            parentId: parent?.id ?? componentSource?.component.id,
            exported: isExported(node),
          };
          fileSymbols.push(owner);
          usedIds.add(owner.id);
          byNode.set(node, owner);
          nodePairs.push([node, owner]);
          if (info.nameNode) {
            byNode.set(info.nameNode, owner);
            nodePairs.push([info.nameNode, owner]);
          }
          if (owner.parentId)
            fileEdges.push({
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
        vueMembersByPath.set(absolute, analysis);
        fileWarnings.push(
          ...analysis.issues.map((issue) => `${vue.input.path}: ${issue.code}: ${issue.message}`),
        );
      }

      workingFiles.set(absolute, {
        input,
        source,
        symbols: fileSymbols,
        edges: fileEdges,
        warnings: fileWarnings,
        nodePairs,
        usedIds,
      });
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
      work: NonNullable<ReturnType<typeof workingFiles.get>>,
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
      while (work.usedIds.has(id)) {
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
        excerpt: text.slice(0, 180),
        document: searchDocument([name, qualifiedName, path, text.slice(0, 8000)].join(" ")),
        parentId: vue.component.id,
        exported: false,
      };
      work.symbols.push(symbol);
      work.usedIds.add(symbol.id);
      byNode.set(node, symbol);
      work.nodePairs.push([node, symbol]);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        byNode.set(node.name, symbol);
        work.nodePairs.push([node.name, symbol]);
      }
      work.edges.push({
        source: vue.component.id,
        target: symbol.id,
        kind: "contains",
        evidence: "syntax",
        line,
      });
      return symbol;
    }

    const deltaSymbols: GraphSymbol[] = [];
    const deltaEdges: GraphEdge[] = [];
    const dirtyRepoPaths: string[] = [];

    for (const [absolute, work] of workingFiles) {
      const { source, input } = work;
      const astro = astroByPath.get(absolute);
      if (astro) {
        const bindings = new Map<string, GraphSymbol>();
        for (const binding of checker.getSymbolsInScope(
          source,
          ts.SymbolFlags.Value | ts.SymbolFlags.Alias,
        )) {
          const target = resolveSymbol(binding);
          if (target) bindings.set(binding.name, target);
        }
        work.edges.push(...astroTemplateEdges(astro, (name) => bindings.get(name)));
      }
      const vue = vueByPath.get(absolute);
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
        for (const member of vueMembersByPath.get(absolute)?.members ?? []) {
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
              const [decl] = declarations;
              let scope: ts.Node | undefined = decl;
              while (scope && scope !== member.scope) scope = scope.parent;
              if (
                decl &&
                scope === member.scope &&
                decl.getSourceFile() === source &&
                ts.isVariableDeclaration(decl) &&
                ts.isIdentifier(decl.name)
              )
                target = createVueSymbol(source, vue, work, decl, decl.name.text, "variable");
            }
          }
          target ??= byNode.get(member.node);
          target ??= createVueSymbol(source, vue, work, member.node, member.name, "property");
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
        work.edges.push(...templateAnalysis.edges);
        work.warnings.push(
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
              work.edges.push({
                source: owner.id,
                target: target.id,
                kind: "calls",
                evidence: "type-resolved",
                line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
              });
          } else if (ts.isIdentifier(node) && !byNode.has(node)) {
            const target = resolveTarget(node);
            if (target && target.id !== owner.id)
              work.edges.push({
                source: owner.id,
                target: target.id,
                kind: "references",
                evidence: "type-resolved",
                line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
              });
          }
        }
        ts.forEachChild(node, (child) => visit(child, owner));
      }
      visit(source);

      const deps: string[] = [];
      let hasUnresolvedImport = false;
      const pre = ts.preProcessFile(source.text, true, true);
      for (const ref of pre.importedFiles) {
        const resolvedMod = ts.resolveModuleName(
          ref.fileName,
          source.fileName,
          options,
          host,
        ).resolvedModule;
        if (resolvedMod?.resolvedFileName) {
          const targetAbs = resolve(resolvedMod.resolvedFileName);
          if (inputs.has(targetAbs)) deps.push(targetAbs);
        } else {
          hasUnresolvedImport = true;
        }
      }

      const uniqueFileEdges = [
        ...new Map(
          work.edges.map((edge) => [`${edge.source}|${edge.target}|${edge.kind}`, edge]),
        ).values(),
      ];
      const entry: CachedTsFile = {
        rawHash: rawSourceHashByPath.get(input.path) ?? input.hash,
        path: input.path,
        absolutePath: absolute,
        externalModule: ts.isExternalModule(source),
        deps: [...new Set(deps)],
        hasUnresolvedImport,
        symbols: work.symbols,
        edges: uniqueFileEdges,
        warnings: work.warnings,
        nodePairs: work.nodePairs,
      };
      this.fileCache.set(input.path, entry);
      dirtyRepoPaths.push(input.path);
      deltaSymbols.push(...entry.symbols);
      deltaEdges.push(...entry.edges);
    }

    for (const path of deletedPaths) this.fileCache.delete(path);

    const symbols: GraphSymbol[] = [];
    const edges: GraphEdge[] = [];
    const warnings = [...configWarnings];
    for (const file of files) {
      const cached = this.fileCache.get(file.path);
      if (!cached) continue;
      symbols.push(...cached.symbols);
      edges.push(...cached.edges);
      warnings.push(...cached.warnings);
    }
    const unique = new Map(
      edges.map((edge) => [`${edge.source}|${edge.target}|${edge.kind}`, edge]),
    );
    const active = new Set(this.program.getSourceFiles().map((source) => resolve(source.fileName)));
    for (const path of this.cache.keys()) if (!active.has(path)) this.cache.delete(path);
    this.lastConfigHash = resolved.hash;
    void rawHashByAbs;
    return {
      symbols,
      edges: [...unique.values()],
      warnings,
      scopePaths: incremental ? [...new Set([...dirtyRepoPaths, ...deletedPaths])] : undefined,
      deltaSymbols: incremental ? deltaSymbols : undefined,
      deltaEdges: incremental ? deltaEdges : undefined,
    };
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
