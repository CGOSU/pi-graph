import { posix } from "node:path";
import type { GraphEdge, SourceFile } from "../core/types.js";
import type {
  RustEntry,
  RustFileGraph,
  RustNode,
} from "./rust.js";

interface ParsedFile {
  source: SourceFile;
  graph: RustFileGraph;
}
interface ProjectContext {
  rootPath: string;
  modules: Map<string, string | null>;
  fileModules: Map<string, string[] | null>;
  imports: Map<string, Map<string, string[][]>>;
  entries: ContextEntry[];
  entriesByPath: Map<string, ContextEntry[]>;
  typeEntries: Map<string, ContextEntry[]>;
  inherentMethods: Map<string, ContextEntry[]>;
}
interface ContextEntry {
  entry: RustEntry;
  modulePath: string[];
  qualifiedName: string;
}
interface ImportSpec {
  target: string[];
  alias: string;
}
export interface RustProjectLinks {
  edges: GraphEdge[];
  qualifiedNames: Map<string, string>;
}

function key(parts: string[]): string {
  return parts.join("::");
}
function pathParts(text: string): string[] {
  return text
    .replace(/^::/, "")
    .split("::")
    .map((part) => part.trim())
    .filter(Boolean);
}
function field(node: RustNode, name: string): RustNode | null {
  return node.childForFieldName(name);
}
function asFilePath(path: string): string {
  const normalized = posix.normalize(path.replaceAll("\\", "/"));
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}
function isCrateRoot(path: string): boolean {
  const normalized = asFilePath(path);
  const base = posix.basename(normalized);
  return (
    base === "lib.rs" ||
    base === "main.rs" ||
    base === "build.rs" ||
    /(?:^|\/)(?:tests|examples|benches)\/.*\.rs$/i.test(normalized) ||
    /(?:^|\/)src\/bin\/.*\.rs$/i.test(normalized)
  );
}
function moduleCandidates(rootPath: string, modulePath: string[]): string[] {
  const rootDirectory = posix.dirname(rootPath);
  const stem = posix.join(rootDirectory, ...modulePath);
  return [`${stem}.rs`, posix.join(stem, "mod.rs")].map(asFilePath);
}
function setModule(context: ProjectContext, modulePath: string[], filePath: string | null): void {
  const moduleKey = key(modulePath);
  if (!context.modules.has(moduleKey)) {
    context.modules.set(moduleKey, filePath);
  } else if (context.modules.get(moduleKey) !== filePath) {
    context.modules.set(moduleKey, null);
  }
}
function setFileModule(context: ProjectContext, filePath: string, modulePath: string[]): void {
  if (!context.fileModules.has(filePath)) {
    context.fileModules.set(filePath, modulePath);
  } else if (key(context.fileModules.get(filePath) ?? []) !== key(modulePath)) {
    context.fileModules.set(filePath, null);
  }
}
function buildContext(rootPath: string, parsed: Map<string, ParsedFile>): ProjectContext {
  const context: ProjectContext = {
    rootPath,
    modules: new Map(),
    fileModules: new Map(),
    imports: new Map(),
    entries: [],
    entriesByPath: new Map(),
    typeEntries: new Map(),
    inherentMethods: new Map(),
  };
  setModule(context, [], rootPath);
  setFileModule(context, rootPath, []);
  const queue = [{ filePath: rootPath, modulePath: [] as string[] }];
  const visited = new Map<string, string>();
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const item = queue[cursor];
    if (!item) continue;
    const moduleKey = key(item.modulePath);
    if (visited.get(item.filePath) === moduleKey) continue;
    if (visited.has(item.filePath)) {
      context.fileModules.set(item.filePath, null);
      continue;
    }
    visited.set(item.filePath, moduleKey);
    const file = parsed.get(item.filePath);
    if (!file) continue;
    for (const declaration of file.graph.modules) {
      const declaredPath = [...item.modulePath, ...declaration.modulePath, declaration.name];
      if (declaration.inline) {
        setModule(context, declaredPath, item.filePath);
        continue;
      }
      const candidates = moduleCandidates(rootPath, declaredPath).filter((candidate) =>
        parsed.has(candidate),
      );
      if (candidates.length !== 1) {
        setModule(context, declaredPath, null);
        continue;
      }
      const target = candidates[0];
      if (!target) {
        setModule(context, declaredPath, null);
        continue;
      }
      setModule(context, declaredPath, target);
      setFileModule(context, target, declaredPath);
      queue.push({ filePath: target, modulePath: declaredPath });
    }
  }
  return context;
}
function normalizeImportPath(path: string[], modulePath: string[]): string[] | undefined {
  if (!path.length) return undefined;
  if (path[0] === "crate") return path.slice(1);
  if (path[0] === "self") return [...modulePath, ...path.slice(1)];
  if (path[0] === "super") {
    const result = [...modulePath];
    let index = 0;
    while (path[index] === "super") {
      if (!result.length) return undefined;
      result.pop();
      index++;
    }
    return [...result, ...path.slice(index)];
  }
  return path;
}
function expandUse(node: RustNode, prefix: string[] = []): ImportSpec[] {
  if (node.type === "use_wildcard") return [];
  if (node.type === "scoped_use_list") {
    const path = field(node, "path");
    const list = field(node, "list");
    return path && list ? expandUse(list, [...prefix, ...pathParts(path.text)]) : [];
  }
  if (node.type === "use_list")
    return node.namedChildren.flatMap((child) => expandUse(child, prefix));
  if (node.type === "use_as_clause") {
    const path = field(node, "path");
    const alias = field(node, "alias");
    const target = path ? [...prefix, ...pathParts(path.text)] : [];
    return target.length && alias ? [{ target, alias: alias.text }] : [];
  }
  if (node.type === "self") {
    const alias = prefix.at(-1);
    return prefix.length && alias ? [{ target: prefix, alias }] : [];
  }
  const parts = pathParts(node.text);
  const target = [...prefix, ...parts];
  const alias = parts.at(-1);
  return target.length && alias ? [{ target, alias }] : [];
}
function moduleImports(
  context: ProjectContext,
  parsed: Map<string, ParsedFile>,
  membership: Map<string, number>,
): void {
  for (const [filePath, modulePath] of context.fileModules) {
    if (!modulePath || membership.get(filePath) !== 1) continue;
    const parsedFile = parsed.get(filePath);
    if (!parsedFile) continue;
    for (const declaration of parsedFile.graph.uses) {
      if (declaration.node.namedChildren.some((child) => child.type === "visibility_modifier"))
        continue;
      const scope = key([...modulePath, ...declaration.modulePath]);
      if (context.modules.get(scope) === null || !context.modules.has(scope)) continue;
      const argument = field(declaration.node, "argument");
      if (!argument) continue;
      const byAlias = context.imports.get(scope) ?? new Map<string, string[][]>();
      for (const spec of expandUse(argument)) {
        const target = normalizeImportPath(spec.target, [...modulePath, ...declaration.modulePath]);
        if (!target) continue;
        const targets = byAlias.get(spec.alias) ?? [];
        if (!targets.some((existing) => key(existing) === key(target))) targets.push(target);
        byAlias.set(spec.alias, targets);
      }
      context.imports.set(scope, byAlias);
    }
  }
}
function genericTypeNames(node: RustNode | undefined): Set<string> {
  const result = new Set<string>();
  if (!node) return result;
  const parameters = field(node, "type_parameters");
  if (!parameters) return result;
  function visit(current: RustNode): void {
    if (current.type === "type_parameter") {
      const name = field(current, "name") ?? current.namedChildren[0];
      if (name) result.add(name.text);
      return;
    }
    for (const child of current.namedChildren) visit(child);
  }
  visit(parameters);
  return result;
}
function genericNames(entry: RustEntry): Set<string> {
  const names = genericTypeNames(entry.node);
  if (entry.implementation)
    for (const name of genericTypeNames(entry.implementation)) names.add(name);
  return names;
}
function rawTypePath(node: RustNode | null): string[] | undefined {
  if (!node) return undefined;
  if (node.type === "reference_type") return rawTypePath(field(node, "type"));
  if (node.type === "generic_type") return rawTypePath(field(node, "type"));
  if (
    node.type === "type_identifier" ||
    node.type === "scoped_type_identifier" ||
    node.type === "identifier" ||
    node.type === "scoped_identifier"
  )
    return pathParts(node.text);
  return undefined;
}
function bindingName(pattern: RustNode | null): string | undefined {
  if (!pattern) return undefined;
  if (pattern.type === "identifier") return pattern.text;
  if (["mutable_pattern", "mut_pattern", "ref_pattern", "captured_pattern"].includes(pattern.type))
    return bindingName(pattern.namedChildren[0] ?? null);
  return undefined;
}
function patternNames(pattern: RustNode | null): string[] {
  if (!pattern) return [];
  const names: string[] = [];
  function visit(node: RustNode): void {
    if (node.type === "identifier") {
      names.push(node.text);
      return;
    }
    if (node.type.endsWith("_pattern"))
      for (const child of node.namedChildren) visit(child);
  }
  visit(pattern);
  return [...new Set(names)];
}
function isAncestor(ancestor: RustNode, node: RustNode): boolean {
  for (let current: RustNode | null = node; current; current = current.parent)
    if (current.id === ancestor.id) return true;
  return false;
}
function depth(node: RustNode): number {
  let result = 0;
  for (let current: RustNode | null = node; current; current = current.parent) result++;
  return result;
}
interface TypedBinding {
  name: string;
  type: RustNode | null;
  scope: RustNode;
  start: number;
}
function nearestBlock(node: RustNode, stop: RustNode): RustNode | undefined {
  for (let current = node.parent; current && current.id !== stop.id; current = current.parent)
    if (current.type === "block") return current;
  return undefined;
}
function bindingsFor(functionNode: RustNode): TypedBinding[] {
  const body = field(functionNode, "body");
  if (!body) return [];
  const result: TypedBinding[] = [];
  function addPattern(
    pattern: RustNode | null,
    type: RustNode | null,
    scope: RustNode,
    start: number,
  ): void {
    const simpleName = bindingName(pattern);
    for (const name of patternNames(pattern))
      result.push({ name, type: simpleName === name ? type : null, scope, start });
  }
  const parameters = field(functionNode, "parameters");
  if (parameters) {
    for (const parameter of parameters.namedChildren) {
      if (parameter.type === "parameter")
        addPattern(field(parameter, "pattern"), field(parameter, "type"), body, body.startIndex);
    }
  }
  function visit(node: RustNode): void {
    if (node.id !== functionNode.id && node.type === "function_item") return;
    if (node.type === "closure_expression" && node.id !== functionNode.id) {
      const closureBody = field(node, "body") ?? node;
      const closureParameters = field(node, "parameters");
      for (const parameter of closureParameters?.namedChildren ?? [])
        addPattern(
          parameter.type === "parameter" ? field(parameter, "pattern") : parameter,
          null,
          closureBody,
          node.startIndex,
        );
    }
    if (node.type === "let_declaration") {
      const scope = nearestBlock(node, functionNode);
      if (scope)
        addPattern(field(node, "pattern"), field(node, "type"), scope, node.endIndex);
    } else if (node.type === "for_expression") {
      const scope = field(node, "body");
      if (scope) addPattern(field(node, "pattern"), null, scope, node.startIndex);
    } else if (node.type === "match_arm") {
      addPattern(field(node, "pattern"), null, node, node.startIndex);
    } else if (node.type === "let_condition") {
      const parent = node.parent;
      const scope =
        parent?.type === "if_expression"
          ? field(parent, "consequence")
          : parent?.type === "while_expression"
            ? field(parent, "body")
            : null;
      if (scope) addPattern(field(node, "pattern"), null, scope, scope.startIndex);
    }
    for (const child of node.namedChildren) visit(child);
  }
  visit(functionNode);
  return result;
}
function pathCandidates(
  context: ProjectContext,
  modulePath: string[],
  parts: string[],
): string[][] {
  const first = parts[0];
  if (!first) return [];
  if (first === "crate") return [parts.slice(1)];
  if (first === "self") return [[...modulePath, ...parts.slice(1)]];
  if (first === "super") {
    const parent = [...modulePath];
    let index = 0;
    while (parts[index] === "super") {
      if (!parent.length) return [];
      parent.pop();
      index++;
    }
    return [[...parent, ...parts.slice(index)]];
  }
  const aliases = context.imports.get(key(modulePath))?.get(first);
  if (aliases) {
    const unique = [...new Map(aliases.map((alias) => [key(alias), alias])).values()];
    const target = unique[0];
    return unique.length === 1 && target ? [[...target, ...parts.slice(1)]] : [];
  }
  return [[...modulePath, ...parts]];
}
function entriesAt(context: ProjectContext, parts: string[]): ContextEntry[] {
  return context.entriesByPath.get(key(parts)) ?? [];
}
function typesAt(context: ProjectContext, parts: string[]): ContextEntry[] {
  return context.typeEntries.get(key(parts)) ?? [];
}
function resolveTypePath(
  context: ProjectContext,
  modulePath: string[],
  parts: string[] | undefined,
  typeParameters: Set<string>,
): ContextEntry | undefined {
  const first = parts?.[0];
  if (!parts || !first || typeParameters.has(first) || first === "Self") return undefined;
  const candidates = pathCandidates(context, modulePath, parts);
  const target = candidates[0];
  if (candidates.length !== 1 || !target) return undefined;
  const matches = typesAt(context, target);
  return matches.length === 1 ? matches[0] : undefined;
}
function typeOfBinding(
  call: RustNode,
  owner: RustEntry,
  context: ProjectContext,
  modulePath: string[],
): ContextEntry | undefined {
  const receiver = field(field(call, "function")!, "value");
  if (receiver?.type !== "identifier") return undefined;
  const body = field(owner.node, "body");
  if (!body) return undefined;
  const candidates = bindingsFor(owner.node)
    .filter(
      (binding) =>
        binding.name === receiver.text &&
        binding.start < call.startIndex &&
        isAncestor(binding.scope, call),
    )
    .sort((a, b) => depth(b.scope) - depth(a.scope) || b.start - a.start);
  const binding = candidates[0];
  if (!binding) return undefined;
  return resolveTypePath(context, modulePath, rawTypePath(binding.type), genericNames(owner));
}
function typeForImplementation(
  entry: RustEntry,
  context: ProjectContext,
  modulePath: string[],
): ContextEntry | undefined {
  if (!entry.implementation || field(entry.implementation, "trait")) return undefined;
  const genericTypes = genericTypeNames(entry.implementation);
  return resolveTypePath(
    context,
    modulePath,
    rawTypePath(field(entry.implementation, "type")),
    genericTypes,
  );
}
function methodsForType(context: ProjectContext, type: ContextEntry, methodName: string): ContextEntry[] {
  const methods = context.inherentMethods.get(type.entry.symbol.id) ?? [];
  return methods.filter((method) => method.entry.symbol.name === methodName);
}
function callNodes(entry: RustEntry): RustNode[] {
  const result: RustNode[] = [];
  const boundaries = new Set([
    "function_item",
    "function_signature_item",
    "impl_item",
    "trait_item",
    "mod_item",
    "struct_item",
    "enum_item",
    "token_tree",
  ]);
  function visit(node: RustNode): void {
    if (node.id !== entry.node.id && boundaries.has(node.type)) return;
    if (node.type === "call_expression") result.push(node);
    for (const child of node.namedChildren) visit(child);
  }
  visit(entry.node);
  return result;
}
function resolveCall(
  call: RustNode,
  owner: ContextEntry,
  context: ProjectContext,
): ContextEntry | undefined {
  let expression = field(call, "function");
  if (expression?.type === "generic_function") expression = field(expression, "function");
  if (!expression) return undefined;
  const modulePath = owner.modulePath;
  const entry = owner.entry;
  if (expression.type === "field_expression") {
    const receiver = field(expression, "value");
    const methodName = field(expression, "field")?.text;
    if (!methodName) return undefined;
    if (receiver?.text === "self" && entry.implementation) {
      const matches = context.entries.filter(
        (candidate) =>
          candidate.entry.implementation?.id === entry.implementation?.id &&
          candidate.entry.symbol.name === methodName &&
          candidate.entry.symbol.kind === "method",
      );
      return matches.length === 1 ? matches[0] : undefined;
    }
    const type = typeOfBinding(call, entry, context, modulePath);
    const methods = type ? methodsForType(context, type, methodName) : [];
    return methods.length === 1 ? methods[0] : undefined;
  }
  if (expression.type === "identifier") {
    if (shadowsCall(call, entry.node, expression.text)) return undefined;
    const candidates = pathCandidates(context, modulePath, [expression.text]);
    const targetPath = candidates[0];
    if (candidates.length !== 1 || !targetPath) return undefined;
    const matches = entriesAt(context, targetPath).filter(
      (candidate) => candidate.entry.symbol.kind === "function",
    );
    return matches.length === 1 ? matches[0] : undefined;
  }
  if (expression.type !== "scoped_identifier") return undefined;
  const parts = pathParts(expression.text);
  if (parts[0] === "Self" && entry.implementation) {
    const methodName = parts.at(-1);
    const matches = context.entries.filter(
      (candidate) =>
        candidate.entry.implementation?.id === entry.implementation?.id &&
        candidate.entry.symbol.name === methodName &&
        candidate.entry.symbol.kind === "method",
    );
    return matches.length === 1 ? matches[0] : undefined;
  }
  if (parts.length > 1) {
    const type = resolveTypePath(context, modulePath, parts.slice(0, -1), genericNames(entry));
    if (type) {
      const methods = methodsForType(context, type, parts.at(-1) ?? "");
      if (methods.length === 1) return methods[0];
      if (methods.length > 1) return undefined;
    }
  }
  const candidates = pathCandidates(context, modulePath, parts);
  const targetPath = candidates[0];
  if (candidates.length !== 1 || !targetPath) return undefined;
  const matches = entriesAt(context, targetPath).filter(
    (candidate) => candidate.entry.symbol.kind === "function",
  );
  return matches.length === 1 ? matches[0] : undefined;
}
function shadowsCall(call: RustNode, functionNode: RustNode, name: string): boolean {
  return bindingsFor(functionNode).some(
    (binding) =>
      binding.name === name &&
      binding.start < call.startIndex &&
      isAncestor(binding.scope, call),
  );
}
function addEntry(context: ProjectContext, fileModulePath: string[], entry: RustEntry): void {
  const modulePath = [...fileModulePath, ...entry.modulePath];
  const qualifiedName = [...fileModulePath, ...pathParts(entry.symbol.qualifiedName)]
    .filter(Boolean)
    .join("::");
  const item = { entry, modulePath, qualifiedName };
  context.entries.push(item);
  const atPath = context.entriesByPath.get(qualifiedName) ?? [];
  atPath.push(item);
  context.entriesByPath.set(qualifiedName, atPath);
  if (entry.symbol.kind === "struct" || entry.symbol.kind === "enum") {
    const types = context.typeEntries.get(qualifiedName) ?? [];
    types.push(item);
    context.typeEntries.set(qualifiedName, types);
  }
}
function finalizeContext(
  context: ProjectContext,
  parsed: Map<string, ParsedFile>,
  membership: Map<string, number>,
): void {
  for (const [filePath, modulePath] of context.fileModules) {
    if (!modulePath || membership.get(filePath) !== 1) continue;
    const file = parsed.get(filePath);
    if (!file) continue;
    for (const entry of file.graph.entries) addEntry(context, modulePath, entry);
  }
  moduleImports(context, parsed, membership);
  for (const method of context.entries) {
    if (method.entry.symbol.kind !== "method") continue;
    const type = typeForImplementation(method.entry, context, method.modulePath);
    if (!type) continue;
    const methods = context.inherentMethods.get(type.entry.symbol.id) ?? [];
    methods.push(method);
    context.inherentMethods.set(type.entry.symbol.id, methods);
  }
}
function moduleContexts(parsed: Map<string, ParsedFile>): ProjectContext[] {
  const roots = [...parsed.keys()].filter(isCrateRoot);
  const contexts = roots.map((root) => buildContext(root, parsed));
  const membership = new Map<string, number>();
  for (const context of contexts)
    for (const [filePath, modulePath] of context.fileModules)
      if (modulePath) membership.set(filePath, (membership.get(filePath) ?? 0) + 1);
  for (const [filePath, file] of parsed) {
    if (!membership.has(filePath)) {
      const context = buildContext(filePath, new Map([[filePath, file]]));
      // An unreferenced file has no reliable crate root; retain only its local inline scope.
      context.fileModules.set(filePath, []);
      for (const declaration of file.graph.modules)
        if (declaration.inline)
          setModule(context, [...declaration.modulePath, declaration.name], filePath);
      contexts.push(context);
      membership.set(filePath, 1);
    }
  }
  for (const context of contexts) finalizeContext(context, parsed, membership);
  return contexts;
}

export function linkRustProject(
  files: SourceFile[],
  graphs: Map<string, RustFileGraph>,
): RustProjectLinks {
  const parsed = new Map<string, ParsedFile>();
  for (const source of files) {
    const graph = graphs.get(source.path);
    if (graph) parsed.set(asFilePath(source.path), { source, graph });
  }
  const contexts = moduleContexts(parsed);
  const edges: GraphEdge[] = [];
  const qualifiedNames = new Map<string, string>();
  const methodParents = new Map<string, string>();
  for (const context of contexts) {
    for (const item of context.entries) {
      if (context.entriesByPath.get(item.qualifiedName)?.length === 1)
        qualifiedNames.set(item.entry.symbol.id, item.qualifiedName);
      if (item.entry.symbol.kind === "method") {
        const type = typeForImplementation(item.entry, context, item.modulePath);
        if (type) methodParents.set(item.entry.symbol.id, type.entry.symbol.id);
      }
    }
    for (const [methodId, typeId] of methodParents) {
      const method = context.entries.find((item) => item.entry.symbol.id === methodId);
      if (!method) continue;
      if (!method.entry.symbol.parentId || method.entry.symbol.parentId !== typeId)
        edges.push({
          source: typeId,
          target: methodId,
          kind: "contains",
          evidence: "syntax",
          line: method.entry.symbol.startLine,
        });
    }
    for (const owner of context.entries) {
      if (owner.entry.symbol.kind !== "function" && owner.entry.symbol.kind !== "method") continue;
      for (const call of callNodes(owner.entry)) {
        const target = resolveCall(call, owner, context);
        if (!target || target.entry.symbol.id === owner.entry.symbol.id) continue;
        edges.push({
          source: owner.entry.symbol.id,
          target: target.entry.symbol.id,
          kind: "calls",
          evidence: "syntax",
          line: call.startPosition.row + 1,
        });
      }
    }
  }
  return {
    edges: [...new Map(edges.map((edge) => [`${edge.source}|${edge.target}|${edge.kind}`, edge])).values()],
    qualifiedNames,
  };
}
