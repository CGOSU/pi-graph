import { declaration, descendants, firstIdentifier, type SyntaxAdapter } from "./syntax-types.js";
import { namedChildren } from "./tree-sitter.js";

export const go: SyntaxAdapter = {
  declarations(node) {
    if (node.type === "type_spec" || node.type === "type_alias") {
      const type = node.childForFieldName("type");
      return declaration(
        node,
        type?.type === "struct_type"
          ? "struct"
          : type?.type === "interface_type"
            ? "interface"
            : "type",
      );
    }
    if (node.type === "function_declaration") return declaration(node, "function");
    if (node.type === "method_declaration") {
      const result = declaration(node, "method");
      const receiver = node.childForFieldName("receiver");
      const parameter = receiver && namedChildren(receiver)[0];
      const name = parameter?.childForFieldName("name");
      const type = parameter?.childForFieldName("type");
      const identifier =
        type && [...descendants(type)].find((child) => child.type === "type_identifier");
      if (name && identifier)
        for (const item of result) item.receiver = { name: name.text, type: identifier.text };
      return result;
    }
    if (node.type === "method_elem" || node.type === "method_spec")
      return declaration(node, "method");
    if (["field_declaration", "var_spec", "const_spec"].includes(node.type)) {
      return node
        .childrenForFieldName("name")
        .filter((name) => name !== null)
        .flatMap((name) =>
          declaration(node, node.type === "field_declaration" ? "property" : "variable", name),
        );
    }
    if (node.type === "short_var_declaration") {
      const left = node.childForFieldName("left");
      return left
        ? namedChildren(left)
            .filter((child) => child.type === "identifier" && child.text !== "_")
            .flatMap((name) => declaration(node, "variable", name))
        : [];
    }
    return [];
  },
  bindings(node) {
    if (node.type === "parameter_declaration" || node.type === "variadic_parameter_declaration") {
      if (node.parent?.id === node.parent?.parent?.childForFieldName("receiver")?.id) return [];
      return node
        .childrenForFieldName("name")
        .filter((name) => name !== null)
        .map((name) => name.text);
    }
    if (
      ["var_spec", "const_spec", "field_declaration", "type_spec", "type_alias"].includes(node.type)
    )
      return node
        .childrenForFieldName("name")
        .filter((name) => name !== null)
        .map((name) => name.text);
    if (node.type === "short_var_declaration" || node.type === "range_clause") {
      const left = node.childForFieldName("left");
      return left
        ? namedChildren(left)
            .filter((child) => child.type === "identifier")
            .map((child) => child.text)
        : [];
    }
    return [];
  },
  call(node) {
    if (node.type !== "call_expression") return;
    const target = node.childForFieldName("function");
    if (target?.type === "identifier") return { node, name: target.text };
    if (target?.type === "selector_expression") {
      const name = target.childForFieldName("field") ?? firstIdentifier(target);
      const receiver = target.childForFieldName("operand");
      if (name && receiver) return { node, name: name.text, receiver: receiver.text };
    }
  },
};
