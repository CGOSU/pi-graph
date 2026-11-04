import { declaration, firstIdentifier, type SyntaxAdapter } from "./syntax-types.js";
import { namedChildren } from "./tree-sitter.js";

export const kotlin: SyntaxAdapter = {
  declarations(node) {
    if (node.type === "class_declaration") {
      const kind = node.children.some((child) => child?.type === "interface")
        ? "interface"
        : namedChildren(node).some((child) => child.type === "enum_class_body")
          ? "enum"
          : "class";
      return declaration(node, kind);
    }
    if (node.type === "object_declaration") return declaration(node, "class");
    if (node.type === "function_declaration") {
      const result = declaration(node, "function");
      const receiver = namedChildren(node).find((child) => child.type === "user_type");
      if (receiver)
        for (const item of result) {
          item.extension = true;
          item.qualifier = receiver.text;
        }
      return result;
    }
    if (node.type === "type_alias")
      return declaration(node, "type", node.childForFieldName("type") ?? firstIdentifier(node));
    if (node.type === "enum_entry") return declaration(node, "variant");
    if (node.type === "variable_declaration" && node.parent?.type === "property_declaration")
      return declaration(node.parent, "variable", firstIdentifier(node));
    if (
      node.type === "class_parameter" &&
      node.children.some((child) => child?.type === "val" || child?.type === "var")
    )
      return declaration(node, "property");
    return [];
  },
  bindings(node) {
    if (
      [
        "parameter",
        "class_parameter",
        "variable_declaration",
        "catch_block",
        "class_declaration",
        "object_declaration",
        "type_alias",
      ].includes(node.type)
    ) {
      const name = firstIdentifier(node);
      return name ? [name.text] : [];
    }
    return [];
  },
  call(node) {
    if (node.type !== "call_expression") return;
    const target = namedChildren(node)[0];
    if (target?.type === "identifier") return { node, name: target.text };
    if (target?.type === "navigation_expression") {
      const parts = namedChildren(target);
      const receiver = parts[0];
      const name = parts.at(-1);
      if (receiver && name && name.type === "identifier")
        return { node, name: name.text, receiver: receiver.text };
    }
  },
};
