import { basename } from "node:path";
import { parse, type SFCDescriptor } from "@vue/compiler-sfc";
import ts from "typescript";
import { hashContent } from "../core/files.js";
import { searchDocument } from "../core/text.js";
import type { GraphSymbol, SourceFile } from "../core/types.js";

export interface VueSource {
  input: SourceFile;
  descriptor: SFCDescriptor;
  component: GraphSymbol;
  template?: GraphSymbol;
  warnings: string[];
}
function vueSymbol(
  file: SourceFile,
  name: string,
  kind: "component" | "template",
  start: number,
  end: number,
): GraphSymbol {
  const text = file.content.slice(start, end);
  return {
    id: `${file.path}#${name}:${kind}`,
    path: file.path,
    name,
    qualifiedName: name,
    kind,
    start,
    end,
    startLine: file.content.slice(0, start).split("\n").length,
    endLine: file.content.slice(0, end).split("\n").length,
    signature: `${kind} ${name}`,
    summary: text.slice(0, 180),
    excerpt: text.slice(0, 260),
    document: searchDocument([name, kind, file.path, text.slice(0, 8000)].join(" ")),
    hash: hashContent(text),
    exported: kind === "component",
  };
}
export function prepareVue(file: SourceFile): VueSource {
  const { descriptor, errors } = parse(file.content, { filename: file.path, sourceMap: false });
  const warnings = errors.map(
    (error) => `${file.path}: ${typeof error === "string" ? error : error.message}`,
  );
  let content = file.content.replace(/[^\r\n]/g, " ");
  let extension = "js";
  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (!block) continue;
    if (block.src) {
      warnings.push(`${file.path}: external script src is not embedded in the SFC index`);
      continue;
    }
    const lang = block.lang ?? "js";
    if (!["js", "jsx", "ts", "tsx"].includes(lang)) {
      warnings.push(`${file.path}: unsupported script language ${lang}`);
      continue;
    }
    if (lang.endsWith("x")) extension = "tsx";
    else if (lang === "ts" && extension !== "tsx") extension = "ts";
    content =
      content.slice(0, block.loc.start.offset) +
      block.content +
      content.slice(block.loc.end.offset);
  }
  const script = ts.createSourceFile(
    `component.${extension}`,
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  if (
    !script.statements.some(
      (statement) =>
        ts.isExportAssignment(statement) ||
        (ts.canHaveModifiers(statement) &&
          ts
            .getModifiers(statement)
            ?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)),
    )
  )
    content += "\nexport default {};\n";
  const name = basename(file.path, ".vue");
  const component = vueSymbol(file, name, "component", 0, file.content.length);
  const block = descriptor.template;
  const template = block
    ? vueSymbol(file, `${name}.template`, "template", block.loc.start.offset, block.loc.end.offset)
    : undefined;
  if (template) template.parentId = component.id;
  if (block?.src || (block?.lang && block.lang !== "html"))
    warnings.push(`${file.path}: external or preprocessed template is not resolved`);
  return {
    input: {
      ...file,
      absolutePath: `${file.absolutePath}.${extension}`,
      content,
      hash: hashContent(content),
    },
    descriptor,
    component,
    template,
    warnings,
  };
}

export interface VueOptionMember {
  name: string;
  node: ts.Node;
  kind: "member" | "setup";
  value?: ts.Expression;
  shorthand?: boolean;
  scope?: ts.FunctionLikeDeclaration;
}

export interface VueOptionIssue {
  code:
    | "ambiguous-option"
    | "dynamic-option-shape"
    | "duplicate-option-member"
    | "non-static-return";
  message: string;
}

export interface VueOptionAnalysis {
  members: VueOptionMember[];
  issues: VueOptionIssue[];
}

function staticPropertyName(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (!ts.isComputedPropertyName(name)) return undefined;
  const expression = name.expression;
  return ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)
    ? expression.text
    : undefined;
}

function uniqueMembers(members: VueOptionMember[]): VueOptionAnalysis {
  const counts = new Map<string, number>();
  for (const member of members) counts.set(member.name, (counts.get(member.name) ?? 0) + 1);
  const duplicates = [...counts].filter(([, count]) => count > 1).map(([name]) => name);
  return {
    members: members.filter((member) => counts.get(member.name) === 1),
    issues: duplicates.length
      ? [
          {
            code: "duplicate-option-member",
            message: `Duplicate static option members are not resolved: ${duplicates.join(", ")}`,
          },
        ]
      : [],
  };
}

function objectMembers(
  object: ts.ObjectLiteralExpression,
  kind: VueOptionMember["kind"],
  scope?: ts.FunctionLikeDeclaration,
): VueOptionAnalysis {
  const members: VueOptionMember[] = [];
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property))
      return {
        members: [],
        issues: [
          {
            code: "dynamic-option-shape",
            message: "Spread option members are not statically resolved",
          },
        ],
      };
    const name = staticPropertyName(property.name);
    if (name === undefined)
      return {
        members: [],
        issues: [
          {
            code: "dynamic-option-shape",
            message: "Dynamic option keys are not statically resolved",
          },
        ],
      };
    const shorthand = ts.isShorthandPropertyAssignment(property);
    const value = ts.isPropertyAssignment(property)
      ? property.initializer
      : shorthand
        ? property.name
        : undefined;
    members.push({ name, node: property, kind, value, shorthand, scope });
  }
  return uniqueMembers(members);
}

function returnedObject(fn: ts.FunctionLikeDeclaration): ts.ObjectLiteralExpression | undefined {
  let body = fn.body;
  if (!body) return undefined;
  while (ts.isParenthesizedExpression(body)) body = body.expression;
  if (!ts.isBlock(body)) return ts.isObjectLiteralExpression(body) ? body : undefined;
  const returns: ts.ReturnStatement[] = [];
  function visit(node: ts.Node): void {
    if (node !== body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) returns.push(node);
    ts.forEachChild(node, visit);
  }
  for (const statement of body.statements) visit(statement);
  const [statement] = returns;
  return returns.length === 1 &&
    statement?.parent === body &&
    statement.expression &&
    ts.isObjectLiteralExpression(statement.expression)
    ? statement.expression
    : undefined;
}

function optionFunction(
  property: ts.ObjectLiteralElementLike,
): ts.FunctionLikeDeclaration | undefined {
  if (ts.isMethodDeclaration(property)) return property;
  if (!ts.isPropertyAssignment(property)) return undefined;
  const value = property.initializer;
  return ts.isFunctionExpression(value) || ts.isArrowFunction(value) ? value : undefined;
}

export function analyzeVueOptions(vue: VueSource, source: ts.SourceFile): VueOptionAnalysis {
  const issues: VueOptionIssue[] = [];
  const defaults = source.statements.filter(
    (statement): statement is ts.ExportAssignment =>
      ts.isExportAssignment(statement) && !statement.isExportEquals,
  );
  if (defaults.length !== 1)
    return {
      members: [],
      issues: [
        {
          code: "ambiguous-option",
          message: `${vue.input.path}: default Options API object is not uniquely identifiable`,
        },
      ],
    };
  let options = defaults[0]?.expression;
  if (options && ts.isCallExpression(options)) options = options.arguments[0];
  if (!options || !ts.isObjectLiteralExpression(options)) return { members: [], issues };

  if (
    options.properties.some(
      (property) =>
        ts.isSpreadAssignment(property) ||
        (property.name !== undefined &&
          ts.isComputedPropertyName(property.name) &&
          staticPropertyName(property.name) === undefined),
    )
  )
    return {
      members: [],
      issues: [
        {
          code: "dynamic-option-shape",
          message: "Vue Options API object contains spreads or non-static keys",
        },
      ],
    };

  const optionProperties = new Map<string, ts.ObjectLiteralElementLike[]>();
  for (const property of options.properties) {
    const name = staticPropertyName(property.name);
    if (name !== "props" && name !== "data" && name !== "setup") continue;
    const entries = optionProperties.get(name) ?? [];
    entries.push(property);
    optionProperties.set(name, entries);
  }
  const members: VueOptionMember[] = [];
  for (const name of ["props", "data", "setup"] as const) {
    const entries = optionProperties.get(name);
    if (entries && entries.length !== 1) {
      issues.push({
        code: "ambiguous-option",
        message: `Repeated Vue ${name} options are not statically resolved`,
      });
      continue;
    }
    const property = entries?.[0];
    if (!property) continue;
    if (name === "props") {
      if (!ts.isPropertyAssignment(property)) {
        issues.push({
          code: "dynamic-option-shape",
          message: "Vue props option is not a static value",
        });
        continue;
      }
      const initializer = property.initializer;
      if (ts.isArrayLiteralExpression(initializer)) {
        const names = initializer.elements.filter(ts.isStringLiteralLike);
        if (
          initializer.elements.some(ts.isSpreadElement) ||
          names.length !== initializer.elements.length
        ) {
          issues.push({
            code: "dynamic-option-shape",
            message: "Vue props arrays must contain only static strings and no spreads",
          });
          continue;
        }
        const result = uniqueMembers(
          names.map((element) => ({ name: element.text, node: element, kind: "member" as const })),
        );
        members.push(...result.members);
        issues.push(...result.issues);
      } else if (ts.isObjectLiteralExpression(initializer)) {
        const result = objectMembers(initializer, "member");
        members.push(...result.members);
        issues.push(...result.issues);
      } else {
        issues.push({
          code: "dynamic-option-shape",
          message: "Vue props option is not a static object or string array",
        });
      }
      continue;
    }
    const fn = optionFunction(property);
    const object = fn && returnedObject(fn);
    if (!object) {
      issues.push({
        code: "non-static-return",
        message: `Vue ${name} must directly return a single static object for member lookup`,
      });
      continue;
    }
    const result = objectMembers(object, name === "setup" ? "setup" : "member", fn);
    members.push(...result.members);
    issues.push(...result.issues);
  }
  return { members, issues };
}

export { vueTemplateEdges } from "./vue-template.js";
