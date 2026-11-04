import { declaration, firstIdentifier, type SyntaxAdapter } from "./syntax-types.js";
import { namedChildren, type SyntaxNode } from "./tree-sitter.js";

function isCallable(node: SyntaxNode): boolean {
  return /^(?:function|constructor|getter|setter)_signature$/.test(node.type);
}
export const dart: SyntaxAdapter = {
  declarations(node) {
    const kinds = {
      class_definition: "class",
      mixin_declaration: "class",
      extension_declaration: "class",
      enum_declaration: "enum",
      enum_constant: "variant",
      type_alias: "type",
    } as const;
    const kind = kinds[node.type as keyof typeof kinds];
    if (kind)
      return node.type === "extension_declaration" && !node.childForFieldName("name")
        ? []
        : declaration(node, kind);
    if (isCallable(node)) {
      const wrapper = node.parent?.type === "method_signature" ? node.parent : node;
      const result = declaration(
        wrapper,
        "function",
        node.childForFieldName("name") ?? firstIdentifier(node),
      );
      const body = wrapper.nextNamedSibling;
      if (body?.type === "function_body") for (const item of result) item.end = body;
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (parent.type !== "extension_declaration") continue;
        const receiver = parent.childForFieldName("class");
        for (const item of result) {
          item.kind = "method";
          item.extension = true;
          item.qualifier = parent.childForFieldName("name")?.text ?? receiver?.text;
        }
        break;
      }
      return result;
    }
    if (
      [
        "initialized_identifier",
        "initialized_variable_definition",
        "static_final_declaration",
      ].includes(node.type)
    )
      return declaration(node, "variable");
    return [];
  },
  bindings(node) {
    if (node.type === "catch_parameters")
      return namedChildren(node)
        .filter((child) => child.type === "identifier")
        .map((child) => child.text);
    if (node.type === "formal_parameter" || node.type === "for_loop_parts") {
      const name = node.childForFieldName("name");
      return name ? [name.text] : [];
    }
    if (
      [
        "initialized_identifier",
        "initialized_variable_definition",
        "static_final_declaration",
        "class_definition",
        "enum_declaration",
        "mixin_declaration",
        "type_alias",
      ].includes(node.type)
    ) {
      const name = node.childForFieldName("name") ?? firstIdentifier(node);
      return name ? [name.text] : [];
    }
    return [];
  },
  call(node) {
    if (
      node.type !== "selector" ||
      !namedChildren(node).some((child) => child.type === "argument_part")
    )
      return;
    const previous = node.previousNamedSibling;
    if (previous?.type === "identifier") return { node, name: previous.text };
    if (previous?.type !== "selector") return;
    const selector = namedChildren(previous).find(
      (child) => child.type === "unconditional_assignable_selector",
    );
    const name = selector && firstIdentifier(selector);
    const receiver = previous.previousNamedSibling;
    if (name && receiver) return { node, name: name.text, receiver: receiver.text };
  },
};
