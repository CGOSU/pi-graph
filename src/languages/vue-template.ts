import {
  type DirectiveNode,
  ElementTypes,
  NodeTypes,
  type SimpleExpressionNode,
  type TemplateChildNode,
} from "@vue/compiler-dom";
import ts from "typescript";
import type { GraphEdge, GraphSymbol } from "../core/types.js";
import type { VueSource } from "./vue.js";

type TemplateIssueCode =
  | "invalid-template-expression"
  | "unsupported-v-for-scope"
  | "unsupported-v-slot-scope";

interface TemplateIssue {
  code: TemplateIssueCode;
  message: string;
}

interface VueTemplateDiagnostic extends TemplateIssue {
  line: number;
}

export interface VueTemplateAnalysis {
  edges: GraphEdge[];
  issues: VueTemplateDiagnostic[];
}

type Analysis<T> = { ok: true; value: T } | { ok: false; issue: TemplateIssue };

type LocalScope = ReadonlySet<string>;

interface ParsedBindings {
  names: Set<string>;
  defaults: string[];
  parameterCount: number;
}

function hasParseErrors(source: ts.SourceFile): boolean {
  const parsed = source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] };
  return (parsed.parseDiagnostics?.length ?? 0) > 0;
}

function identifiers(expression: string, statements = false): Analysis<string[]> {
  let source = ts.createSourceFile(
    "template.tsx",
    `(${expression})`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  if (statements && hasParseErrors(source))
    source = ts.createSourceFile(
      "template-statements.tsx",
      expression,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
  if (hasParseErrors(source))
    return {
      ok: false,
      issue: {
        code: "invalid-template-expression",
        message: "Template expression is not valid JavaScript syntax",
      },
    };
  const names = new Set<string>();
  const bindings = new Set<string>();
  function bind(name: ts.BindingName): void {
    if (ts.isIdentifier(name)) bindings.add(name.text);
    else {
      for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name);
    }
  }
  function visit(node: ts.Node): void {
    if (ts.isParameter(node) || ts.isVariableDeclaration(node)) bind(node.name);
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      if (
        !(
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          (ts.isMethodDeclaration(parent) && parent.name === node)
        )
      )
        names.add(node.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { ok: true, value: [...names].filter((name) => !bindings.has(name)) };
}

function bindingNames(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements)
    if (ts.isBindingElement(element)) bindingNames(element.name, names);
}

function bindingDefaults(name: ts.BindingName, source: ts.SourceFile, defaults: string[]): void {
  if (!ts.isObjectBindingPattern(name) && !ts.isArrayBindingPattern(name)) return;
  for (const element of name.elements) {
    if (!ts.isBindingElement(element)) continue;
    if (element.initializer) defaults.push(element.initializer.getText(source));
    bindingDefaults(element.name, source, defaults);
  }
}

function parseBindingParameters(expressions: string[]): Analysis<ParsedBindings> {
  const sourceText = `(${expressions.join(",")}) => {}`;
  const source = ts.createSourceFile(
    "template-bindings.tsx",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const statement = source.statements[0];
  const expression =
    statement && ts.isExpressionStatement(statement) ? statement.expression : undefined;
  const arrow = expression && ts.isArrowFunction(expression) ? expression : undefined;
  if (hasParseErrors(source) || !arrow || arrow.parameters.length !== expressions.length)
    return {
      ok: false,
      issue: {
        code: "unsupported-v-for-scope",
        message: "Vue loop or slot bindings cannot be parsed as static binding patterns",
      },
    };
  const names = new Set<string>();
  const defaults: string[] = [];
  for (const parameter of arrow.parameters) {
    bindingNames(parameter.name, names);
    if (parameter.initializer) defaults.push(parameter.initializer.getText(source));
    bindingDefaults(parameter.name, source, defaults);
  }
  return { ok: true, value: { names, defaults, parameterCount: arrow.parameters.length } };
}

function addIssue(issues: VueTemplateDiagnostic[], issue: TemplateIssue, line: number): void {
  if (!issues.some((existing) => existing.code === issue.code && existing.line === line))
    issues.push({ ...issue, line });
}

function isLocallyBound(name: string, scopes: readonly LocalScope[]): boolean {
  return scopes.some((scope) => scope.has(name));
}

function directiveProps(
  node: Extract<TemplateChildNode, { type: NodeTypes.ELEMENT }>,
): DirectiveNode[] {
  return node.props.filter((prop): prop is DirectiveNode => prop.type === NodeTypes.DIRECTIVE);
}

function analyzeVFor(
  directive: DirectiveNode,
  scopes: readonly LocalScope[],
  expression: (text: string, line: number, scopes: readonly LocalScope[]) => void,
): Analysis<LocalScope> {
  const line = directive.loc.start.line;
  const result = directive.forParseResult;
  if (
    !result?.source ||
    result.source.type !== NodeTypes.SIMPLE_EXPRESSION ||
    !result.source.content.trim()
  )
    return {
      ok: false,
      issue: {
        code: "unsupported-v-for-scope",
        message: "Vue loop source is not available in the parser result",
      },
    };
  expression(result.source.content, result.source.loc.start.line, scopes);
  const aliases: SimpleExpressionNode[] = [];
  for (const alias of [result.value, result.key, result.index]) {
    if (!alias) continue;
    if (alias.type !== NodeTypes.SIMPLE_EXPRESSION)
      return {
        ok: false,
        issue: {
          code: "unsupported-v-for-scope",
          message: "Vue loop aliases are not statically identifiable",
        },
      };
    aliases.push(alias);
  }
  if (!result.value || aliases.length === 0)
    return {
      ok: false,
      issue: {
        code: "unsupported-v-for-scope",
        message: "Vue loop aliases are not statically identifiable",
      },
    };
  const parsed = parseBindingParameters(aliases.map((alias) => alias.content));
  if (!parsed.ok)
    return {
      ok: false,
      issue: {
        code: "unsupported-v-for-scope",
        message: parsed.issue.message,
      },
    };
  const loopScope = parsed.value.names;
  for (const value of parsed.value.defaults) expression(value, line, [...scopes, loopScope]);
  return { ok: true, value: loopScope };
}

function analyzeSlot(
  directive: DirectiveNode,
  scopes: readonly LocalScope[],
  expression: (text: string, line: number, scopes: readonly LocalScope[]) => void,
): Analysis<LocalScope> {
  if (!directive.exp) return { ok: true, value: new Set<string>() };
  if (directive.exp.type !== NodeTypes.SIMPLE_EXPRESSION)
    return {
      ok: false,
      issue: {
        code: "unsupported-v-slot-scope",
        message: "Vue slot bindings are not a simple static parameter expression",
      },
    };
  if (!directive.exp.content.trim()) return { ok: true, value: new Set<string>() };
  const parsed = parseBindingParameters([directive.exp.content]);
  if (!parsed.ok || parsed.value.parameterCount !== 1)
    return {
      ok: false,
      issue: {
        code: "unsupported-v-slot-scope",
        message: parsed.ok
          ? "Vue slot directive must declare one static binding parameter"
          : parsed.issue.message,
      },
    };
  for (const value of parsed.value.defaults)
    expression(value, directive.exp.loc.start.line, [...scopes, parsed.value.names]);
  return { ok: true, value: parsed.value.names };
}

export function vueTemplateEdges(
  vue: VueSource,
  lookup: (name: string, component: boolean) => GraphSymbol | undefined,
): VueTemplateAnalysis {
  const template = vue.template;
  const block = vue.descriptor.template;
  if (!template || !block?.ast || block.src || (block.lang && block.lang !== "html"))
    return { edges: [], issues: [] };
  const edges: GraphEdge[] = [];
  const issues: VueTemplateDiagnostic[] = [];
  const templateId = template.id;
  function reference(name: string, line: number, component = false): void {
    const target = lookup(name, component);
    if (target)
      edges.push({
        source: templateId,
        target: target.id,
        kind: "references",
        evidence: "syntax",
        line,
      });
  }
  function expression(
    text: string,
    line: number,
    scopes: readonly LocalScope[],
    statements = false,
  ): void {
    const result = identifiers(text, statements);
    if (!result.ok) {
      addIssue(issues, result.issue, line);
      return;
    }
    for (const name of result.value) if (!isLocallyBound(name, scopes)) reference(name, line);
  }
  function visit(node: TemplateChildNode, scopes: readonly LocalScope[]): void {
    if (node.type === NodeTypes.INTERPOLATION && node.content.type === NodeTypes.SIMPLE_EXPRESSION)
      expression(node.content.content, node.loc.start.line, scopes);
    if (node.type !== NodeTypes.ELEMENT) return;

    const directives = directiveProps(node);
    const forDirectives = directives.filter((prop) => prop.name === "for");
    const slotDirectives = directives.filter((prop) => prop.name === "slot");
    if (node.tagType === ElementTypes.COMPONENT) reference(node.tag, node.loc.start.line, true);

    let loopScope: LocalScope | undefined;
    const forDirective = forDirectives[0];
    let invalidLoop = forDirectives.length > 1;
    if (forDirective && !invalidLoop) {
      const result = analyzeVFor(forDirective, scopes, expression);
      if (result.ok) loopScope = result.value;
      else {
        invalidLoop = true;
        addIssue(issues, result.issue, forDirective.loc.start.line);
      }
    } else if (invalidLoop) {
      addIssue(
        issues,
        {
          code: "unsupported-v-for-scope",
          message: "Multiple v-for directives on one element are ambiguous",
        },
        node.loc.start.line,
      );
    }
    const elementScopes = loopScope ? [...scopes, loopScope] : scopes;

    let slotScope: LocalScope | undefined;
    const slotDirective = slotDirectives[0];
    let invalidSlot = slotDirectives.length > 1;
    if (!invalidLoop && slotDirective && !invalidSlot) {
      const result = analyzeSlot(slotDirective, elementScopes, expression);
      if (result.ok) slotScope = result.value;
      else {
        invalidSlot = true;
        addIssue(issues, result.issue, slotDirective.loc.start.line);
      }
    } else if (invalidSlot) {
      addIssue(
        issues,
        {
          code: "unsupported-v-slot-scope",
          message: "Multiple v-slot directives on one element are ambiguous",
        },
        node.loc.start.line,
      );
    }

    for (const prop of directives) {
      if (prop.name === "for") continue;
      if (invalidLoop && prop.name !== "if" && prop.name !== "else-if") continue;
      if (prop.name === "slot") {
        if (prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION && !prop.arg.isStatic)
          expression(prop.arg.content, prop.arg.loc.start.line, elementScopes);
        continue;
      }
      const propScopes = prop.name === "if" || prop.name === "else-if" ? scopes : elementScopes;
      if (prop.exp?.type === NodeTypes.SIMPLE_EXPRESSION)
        expression(prop.exp.content, prop.exp.loc.start.line, propScopes, prop.name === "on");
      if (prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION && !prop.arg.isStatic)
        expression(prop.arg.content, prop.arg.loc.start.line, propScopes);
    }

    if (invalidLoop || invalidSlot) return;
    const childScopes = slotScope ? [...elementScopes, slotScope] : elementScopes;
    for (const child of node.children) visit(child, childScopes);
  }
  for (const child of block.ast.children) visit(child, []);
  return { edges, issues };
}
