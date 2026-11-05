import { fileURLToPath } from "node:url";
import { Language, Parser, type Node } from "web-tree-sitter";

/** Bump when the facts change shape, so cached facts from older versions are discarded. */
export const JAVA_EXTRACTOR_VERSION = 1;

const GRAMMAR = fileURLToPath(new URL("../../../vendor/tree-sitter-java.wasm", import.meta.url));

export interface AnnotationFact {
  name: string;
  /** String literals as plain text; anything else is the source text prefixed with "=". */
  args: Record<string, string[]>;
}

export interface FieldFact {
  name: string;
  type: string;
  refs: string[];
  annotations: AnnotationFact[];
  isFinal: boolean;
  isStatic: boolean;
}

export interface CallFact {
  /** null: unqualified. Otherwise "this", "super", a name, a dotted name, or "?" for an expression. */
  receiver: string | null;
  name: string;
  /** -1 for a method reference, whose argument count is unknown. */
  arity: number;
  line: number;
}

export interface HttpCallFact {
  verb: string;
  /** "{}" marks a part only known at runtime, "${x}" a configuration property. */
  template: string;
  line: number;
}

export interface MethodFact {
  name: string;
  line: number;
  endLine: number;
  isConstructor: boolean;
  arity: number;
  annotations: AnnotationFact[];
  /** Variable name to its type, including parameters. */
  locals: Record<string, string>;
  paramTypes: string[];
  refs: string[];
  calls: CallFact[];
  httpCalls: HttpCallFact[];
}

export interface SuperTypeFact {
  name: string;
  relation: "extends" | "implements";
  refs: string[];
}

export interface TypeFact {
  /** Dotted within the file: "Outer.Inner". */
  localName: string;
  kind: "class" | "interface" | "enum" | "record" | "annotation";
  line: number;
  endLine: number;
  annotations: AnnotationFact[];
  superTypes: SuperTypeFact[];
  fields: FieldFact[];
  methods: MethodFact[];
  refs: string[];
}

export interface ImportFact {
  name: string;
  isStatic: boolean;
  isWildcard: boolean;
}

export interface JavaFacts {
  packageName: string;
  imports: ImportFact[];
  types: TypeFact[];
  hasParseErrors: boolean;
}

const REST_TEMPLATE_VERBS: Record<string, string | null> = {
  exchange: null,
  getForObject: "GET",
  getForEntity: "GET",
  postForObject: "POST",
  postForEntity: "POST",
  postForLocation: "POST",
  put: "PUT",
  delete: "DELETE",
  patchForObject: "PATCH",
};

const TYPE_NODES: Record<string, TypeFact["kind"]> = {
  class_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
  record_declaration: "record",
  annotation_type_declaration: "annotation",
};

let parser: Promise<Parser> | undefined;

function getParser(): Promise<Parser> {
  parser ??= (async () => {
    await Parser.init();
    const instance = new Parser();
    instance.setLanguage(await Language.load(GRAMMAR));
    return instance;
  })();
  return parser;
}

function kids(node: Node): Node[] {
  return node.namedChildren.filter(
    (child): child is Node =>
      child !== null && child.type !== "line_comment" && child.type !== "block_comment",
  );
}

/** Line numbers are 1-based, as editors show them. */
function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}

function endLineOf(node: Node): number {
  return node.endPosition.row + 1;
}

function stringValue(node: Node): string {
  return node.text.replace(/^"""\s*|^"/, "").replace(/"""$|"$/, "");
}

/** List<UserDto>[] -> List */
function baseType(node: Node | null): string {
  if (!node) return "";
  if (node.type === "generic_type" || node.type === "array_type") {
    return baseType(kids(node)[0] ?? null);
  }
  if (node.type === "annotated_type") {
    return baseType(kids(node).at(-1) ?? null);
  }
  return node.text;
}

/** Every type named anywhere inside a node: List<Map<A, B>> -> List, Map, A, B */
function typeNames(node: Node | null, into: Set<string> = new Set()): Set<string> {
  if (!node) return into;
  if (node.type === "type_identifier" || node.type === "scoped_type_identifier") {
    if (node.text !== "var") into.add(node.text);
    return into;
  }
  for (const child of kids(node)) typeNames(child, into);
  return into;
}

function annotationValues(node: Node): string[] {
  if (node.type === "string_literal") return [stringValue(node)];
  if (node.type === "element_value_array_initializer") return kids(node).flatMap(annotationValues);
  return [`=${node.text}`];
}

function annotationsOf(modifiers: Node | undefined): AnnotationFact[] {
  if (!modifiers) return [];
  const annotations: AnnotationFact[] = [];
  for (const child of kids(modifiers)) {
    if (child.type !== "annotation" && child.type !== "marker_annotation") continue;
    const name = child.childForFieldName("name")?.text.split(".").pop() ?? "";
    const args: Record<string, string[]> = {};
    const list = child.childForFieldName("arguments");
    for (const argument of list ? kids(list) : []) {
      if (argument.type === "element_value_pair") {
        const key = argument.childForFieldName("key")?.text ?? "value";
        const value = argument.childForFieldName("value");
        args[key] = value ? annotationValues(value) : [];
      } else {
        args.value = annotationValues(argument);
      }
    }
    annotations.push({ name, args });
  }
  return annotations;
}

function modifiersOf(node: Node): Node | undefined {
  return kids(node).find((child) => child.type === "modifiers");
}

function hasKeyword(modifiers: Node | undefined, keyword: string): boolean {
  return modifiers ? new RegExp(`\\b${keyword}\\b`).test(modifiers.text) : false;
}

/** this.foo and a.b stay readable; anything computed becomes "?". */
function receiverText(node: Node): string {
  if (["this", "super", "identifier", "type_identifier", "scoped_type_identifier"].includes(node.type)) {
    return node.text;
  }
  if (node.type === "field_access") {
    const object = node.childForFieldName("object");
    return object && receiverText(object) !== "?" ? node.text.replace(/\s+/g, "") : "?";
  }
  return "?";
}

interface Scope {
  fields: FieldFact[];
  /** Value of String fields: a literal, or "${x}" from @Value. */
  fieldStrings: Map<string, string>;
  locals: Record<string, string>;
  localStrings: Map<string, string>;
}

function evaluateString(node: Node | null, scope: Scope): string {
  if (!node) return "{}";
  switch (node.type) {
    case "string_literal":
      return stringValue(node);
    case "parenthesized_expression":
      return evaluateString(kids(node)[0] ?? null, scope);
    case "identifier":
      return scope.localStrings.get(node.text) ?? scope.fieldStrings.get(node.text) ?? "{}";
    case "field_access":
      if (node.childForFieldName("object")?.type === "this") {
        return scope.fieldStrings.get(node.childForFieldName("field")?.text ?? "") ?? "{}";
      }
      return "{}";
    case "binary_expression":
      return (
        evaluateString(node.childForFieldName("left"), scope) +
        evaluateString(node.childForFieldName("right"), scope)
      );
    case "method_invocation": {
      if (node.childForFieldName("name")?.text !== "concat") return "{}";
      const argument = node.childForFieldName("arguments");
      return (
        evaluateString(node.childForFieldName("object"), scope) +
        evaluateString(argument ? (kids(argument)[0] ?? null) : null, scope)
      );
    }
    default:
      return "{}";
  }
}

function receiverType(receiver: string, scope: Scope): string | undefined {
  const name = receiver.replace(/^this\./, "");
  if (!receiver.startsWith("this.") && scope.locals[name]) return scope.locals[name];
  return scope.fields.find((field) => field.name === name)?.type;
}

function collectBody(body: Node, scope: Scope, method: Pick<MethodFact, "calls" | "httpCalls">, refs: Set<string>): void {
  const addLocal = (name: string | undefined, type: string) => {
    if (name) scope.locals[name] = type;
  };

  const walk = (node: Node): void => {
    switch (node.type) {
      case "type_identifier":
      case "scoped_type_identifier":
        if (node.text !== "var") refs.add(node.text);
        return;
      case "marker_annotation":
      case "annotation": {
        const name = node.childForFieldName("name")?.text;
        if (name) refs.add(name);
        return;
      }
      case "local_variable_declaration": {
        const typeNode = node.childForFieldName("type");
        for (const declarator of kids(node).filter((child) => child.type === "variable_declarator")) {
          const value = declarator.childForFieldName("value");
          let type = baseType(typeNode);
          if (type === "var" && value) {
            if (value.type === "object_creation_expression" || value.type === "cast_expression") {
              type = baseType(value.childForFieldName("type"));
            } else if (value.type === "string_literal") {
              type = "String";
            }
          }
          const name = declarator.childForFieldName("name")?.text;
          addLocal(name, type);
          if (name && value && type === "String") {
            scope.localStrings.set(name, evaluateString(value, scope));
          }
        }
        break;
      }
      case "enhanced_for_statement":
      case "resource":
      case "formal_parameter":
        addLocal(node.childForFieldName("name")?.text, baseType(node.childForFieldName("type")));
        break;
      case "catch_formal_parameter": {
        const catchType = kids(node).find((child) => child.type === "catch_type");
        addLocal(node.childForFieldName("name")?.text, baseType(catchType ? (kids(catchType)[0] ?? null) : null));
        break;
      }
      case "field_access": {
        const object = node.childForFieldName("object");
        if (object?.type === "identifier" && /^[A-Z]/.test(object.text)) refs.add(object.text);
        break;
      }
      case "method_reference": {
        const parts = kids(node);
        const first = parts[0];
        const last = parts.at(-1);
        if (first && last && parts.length > 1) {
          method.calls.push({ receiver: receiverText(first), name: last.text, arity: -1, line: lineOf(node) });
        }
        break;
      }
      case "method_invocation": {
        const object = node.childForFieldName("object");
        const name = node.childForFieldName("name")?.text ?? "";
        const argumentList = node.childForFieldName("arguments");
        const args = argumentList ? kids(argumentList) : [];
        const receiver = object ? receiverText(object) : null;
        method.calls.push({ receiver, name, arity: args.length, line: lineOf(node) });

        if (receiver && name in REST_TEMPLATE_VERBS && baseName(receiverType(receiver, scope)) === "RestTemplate") {
          const verb = REST_TEMPLATE_VERBS[name] ?? /HttpMethod\.(\w+)/.exec(args[1]?.text ?? "")?.[1] ?? "ANY";
          method.httpCalls.push({ verb, template: evaluateString(args[0] ?? null, scope), line: lineOf(node) });
        }
        break;
      }
      default:
        break;
    }
    for (const child of kids(node)) walk(child);
  };

  walk(body);
}

function baseName(type: string | undefined): string | undefined {
  return type?.split(".").pop();
}

function extractMethod(node: Node, fields: FieldFact[], fieldStrings: Map<string, string>): MethodFact {
  const isConstructor = node.type !== "method_declaration" && node.type !== "annotation_type_element_declaration";
  const refs = new Set<string>();
  const annotations = annotationsOf(modifiersOf(node));
  for (const annotation of annotations) refs.add(annotation.name);

  const locals: Record<string, string> = {};
  const paramTypes: string[] = [];
  const parameters = node.childForFieldName("parameters");
  for (const parameter of parameters ? kids(parameters) : []) {
    if (parameter.type === "formal_parameter") {
      const typeNode = parameter.childForFieldName("type");
      const type = baseType(typeNode);
      paramTypes.push(type);
      const name = parameter.childForFieldName("name")?.text;
      if (name) locals[name] = type;
      typeNames(typeNode, refs);
      for (const annotation of annotationsOf(modifiersOf(parameter))) refs.add(annotation.name);
    } else if (parameter.type === "spread_parameter") {
      const typeNode = kids(parameter).find((child) => child.type !== "modifiers") ?? null;
      const type = baseType(typeNode);
      paramTypes.push(type);
      const name = kids(parameter).find((child) => child.type === "variable_declarator")?.childForFieldName("name")?.text;
      if (name) locals[name] = type;
      typeNames(typeNode, refs);
    }
  }

  typeNames(node.childForFieldName("type"), refs);
  const throwsClause = kids(node).find((child) => child.type === "throws");
  typeNames(throwsClause ?? null, refs);

  const method: MethodFact = {
    name: isConstructor ? "<init>" : (node.childForFieldName("name")?.text ?? ""),
    line: lineOf(node),
    endLine: endLineOf(node),
    isConstructor,
    arity: paramTypes.length,
    annotations,
    locals,
    paramTypes,
    refs: [],
    calls: [],
    httpCalls: [],
  };

  const body = node.childForFieldName("body");
  if (body) {
    collectBody(body, { fields, fieldStrings, locals, localStrings: new Map() }, method, refs);
  }
  method.refs = [...refs];
  return method;
}

function extractSuperTypes(node: Node): SuperTypeFact[] {
  const result: SuperTypeFact[] = [];
  const add = (typeNode: Node, relation: SuperTypeFact["relation"]) => {
    result.push({ name: baseType(typeNode), relation, refs: [...typeNames(typeNode)] });
  };
  const fromList = (holder: Node | undefined | null, relation: SuperTypeFact["relation"]) => {
    const list = holder ? kids(holder).find((child) => child.type === "type_list") : undefined;
    for (const typeNode of list ? kids(list) : []) add(typeNode, relation);
  };

  const superclass = node.childForFieldName("superclass");
  const superclassType = superclass ? kids(superclass)[0] : undefined;
  if (superclassType) add(superclassType, "extends");
  fromList(node.childForFieldName("interfaces"), "implements");
  fromList(kids(node).find((child) => child.type === "extends_interfaces"), "extends");
  return result;
}

function extractField(node: Node, fieldStrings: Map<string, string>, refs: Set<string>): FieldFact[] {
  const modifiers = modifiersOf(node);
  const annotations = annotationsOf(modifiers);
  const typeNode = node.childForFieldName("type");
  const type = baseType(typeNode);
  const typeRefs = [...typeNames(typeNode)];
  const fields: FieldFact[] = [];

  for (const declarator of kids(node).filter((child) => child.type === "variable_declarator")) {
    const name = declarator.childForFieldName("name")?.text ?? "";
    fields.push({
      name,
      type,
      refs: typeRefs,
      annotations,
      isFinal: hasKeyword(modifiers, "final"),
      isStatic: hasKeyword(modifiers, "static"),
    });
    const value = declarator.childForFieldName("value");
    const configured = annotations.find((annotation) => annotation.name === "Value")?.args.value?.[0];
    if (configured !== undefined) fieldStrings.set(name, configured);
    else if (value?.type === "string_literal") fieldStrings.set(name, stringValue(value));
    if (value) typeNames(value, refs);
  }
  return fields;
}

function extractType(node: Node, outer: string | null, out: TypeFact[]): void {
  const name = node.childForFieldName("name")?.text ?? "";
  const localName = outer ? `${outer}.${name}` : name;
  const annotations = annotationsOf(modifiersOf(node));
  const refs = new Set<string>(annotations.map((annotation) => annotation.name));
  const fields: FieldFact[] = [];
  const methods: MethodFact[] = [];
  const fieldStrings = new Map<string, string>();

  const parameters = node.type === "record_declaration" ? node.childForFieldName("parameters") : null;
  for (const parameter of parameters ? kids(parameters) : []) {
    const typeNode = parameter.childForFieldName("type");
    if (!typeNode) continue;
    fields.push({
      name: parameter.childForFieldName("name")?.text ?? "",
      type: baseType(typeNode),
      refs: [...typeNames(typeNode)],
      annotations: annotationsOf(modifiersOf(parameter)),
      isFinal: true,
      isStatic: false,
    });
  }

  const body = node.childForFieldName("body");
  const members = body
    ? kids(body).flatMap((member) => (member.type === "enum_body_declarations" ? kids(member) : [member]))
    : [];

  // Fields first: a method can use a field declared below it.
  for (const member of members) {
    if (member.type === "field_declaration" || member.type === "constant_declaration") {
      fields.push(...extractField(member, fieldStrings, refs));
    }
  }

  const type: TypeFact = {
    localName,
    kind: TYPE_NODES[node.type] ?? "class",
    line: lineOf(node),
    endLine: endLineOf(node),
    annotations,
    superTypes: extractSuperTypes(node),
    fields,
    methods,
    refs: [],
  };
  out.push(type);

  for (const member of members) {
    if (member.type in TYPE_NODES) {
      extractType(member, localName, out);
    } else if (
      member.type === "method_declaration" ||
      member.type === "constructor_declaration" ||
      member.type === "compact_constructor_declaration" ||
      member.type === "annotation_type_element_declaration"
    ) {
      methods.push(extractMethod(member, fields, fieldStrings));
    } else if (member.type === "static_initializer" || member.type === "block" || member.type === "enum_constant") {
      typeNames(member, refs);
    }
  }
  type.refs = [...refs];
}

export async function extractJava(source: string): Promise<JavaFacts> {
  const instance = await getParser();
  const tree = instance.parse(source);
  if (!tree) throw new Error("The Java parser returned no tree");
  try {
    const facts: JavaFacts = {
      packageName: "",
      imports: [],
      types: [],
      hasParseErrors: tree.rootNode.hasError,
    };
    for (const node of kids(tree.rootNode)) {
      if (node.type === "package_declaration") {
        facts.packageName = kids(node).find((child) => child.type !== "marker_annotation" && child.type !== "annotation")?.text ?? "";
      } else if (node.type === "import_declaration") {
        const parts = kids(node);
        facts.imports.push({
          name: parts.find((child) => child.type !== "asterisk")?.text ?? "",
          isStatic: /^import\s+static\b/.test(node.text),
          isWildcard: parts.some((child) => child.type === "asterisk"),
        });
      } else if (node.type in TYPE_NODES) {
        extractType(node, null, facts.types);
      }
    }
    return facts;
  } finally {
    tree.delete();
  }
}
