import { dirname } from "node:path/posix";
import { redact } from "../redact.js";
import type { AnnotationFact, HttpCallFact, JavaFacts, MethodFact, TypeFact } from "./java-extract.js";
import type { Confidence, EdgeKind, GraphEdge, GraphNode, GraphSnapshot } from "./types.js";

const VERB_ANNOTATIONS: Record<string, string> = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  DeleteMapping: "DELETE",
  PatchMapping: "PATCH",
};
const STEREOTYPES = new Set(["Component", "Service", "Repository", "Controller", "RestController", "Configuration"]);
const INJECTION = new Set(["Autowired", "Inject", "Resource"]);
const GENERATED_CONSTRUCTORS = new Set(["RequiredArgsConstructor", "AllArgsConstructor"]);
/** Kept on nodes because they say what a class is for. */
const NOTABLE_ANNOTATION =
  /^(Entity|Table|Transactional|Scheduled|Async|Bean|Configuration|Service|Component|Repository|(Rest)?Controller|\w+Mapping|FeignClient|\w*Listener|Cacheable)$/;

export interface JavaSource {
  path: string;
  facts: JavaFacts;
}

interface FileInfo {
  path: string;
  module: string;
  facts: JavaFacts;
}

interface TypeInfo {
  id: string;
  fqn: string;
  file: FileInfo;
  fact: TypeFact;
  methods: Map<string, string>;
  /** Filled in once every type is known. */
  superTypes: TypeInfo[];
}

function isTestPath(path: string): boolean {
  return /(^|\/)src\/test\//.test(path) || /(Test|Tests|IT)\.java$/.test(path);
}

/** A file belongs to the nearest directory with a build file: each is a separately built service. */
function moduleOf(path: string, moduleDirs: Set<string>): string {
  let directory = dirname(path);
  while (directory !== "." && directory !== "/") {
    if (moduleDirs.has(directory)) return directory;
    directory = dirname(directory);
  }
  return ".";
}

function joinPath(prefix: string, path: string): string {
  const joined = `/${prefix}/${path}`.replace(/\/+/g, "/");
  return joined.length > 1 ? joined.replace(/\/$/, "") : joined;
}

/** A value that is not a literal (a constant) still shows up, as a path variable. */
function pathValues(annotation: AnnotationFact): string[] {
  const raw = annotation.args.value ?? annotation.args.path ?? [""];
  return raw.map((value) => (value.startsWith("=") ? `{${value.slice(1)}}` : value));
}

function mappingVerbs(annotation: AnnotationFact): string[] | undefined {
  const fixed = VERB_ANNOTATIONS[annotation.name];
  if (fixed) return [fixed];
  if (annotation.name !== "RequestMapping") return undefined;
  const methods = annotation.args.method;
  if (!methods?.length) return ["ANY"];
  return methods.map((method) => method.replace(/^=/, "").split(".").pop() ?? "ANY");
}

/** "${base}/users/{}?page=1" -> ["users", "*"]. Null when no path can be told from the URL. */
export function pathSegments(template: string): string[] | null {
  const path = template
    .replace(/^\$\{[^}]*\}/, "")
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "")
    .split("?")[0] ?? "";
  if (!path.startsWith("/")) return null;
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => (/[{$]/.test(segment) ? "*" : segment));
}

export function resolveJava(sources: JavaSource[], moduleDirs: Set<string>): GraphSnapshot {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  const addEdge = (from: string, to: string, kind: EdgeKind, confidence: Confidence, line?: number) => {
    if (from === to) return;
    const key = `${from}|${to}|${kind}`;
    const existing = edges.get(key);
    if (!existing) edges.set(key, { from, to, kind, confidence, ...(line ? { line } : {}) });
    else if (confidence === "exact") existing.confidence = "exact";
  };

  // 1. Declare every type, so references can be resolved regardless of file order.
  const files: FileInfo[] = sources.map((source) => ({
    path: source.path,
    module: moduleOf(source.path, moduleDirs),
    facts: source.facts,
  }));
  const byFqn = new Map<string, TypeInfo[]>();
  const allTypes: TypeInfo[] = [];

  for (const file of files) {
    const fileId = `file:${file.path}`;
    nodes.set(fileId, {
      id: fileId,
      kind: "file",
      name: file.path.split("/").pop() ?? file.path,
      qualifiedName: file.path,
      file: file.path,
      module: file.module,
      isTest: isTestPath(file.path),
    });

    for (const fact of file.facts.types) {
      const fqn = file.facts.packageName ? `${file.facts.packageName}.${fact.localName}` : fact.localName;
      const id = `type:${file.module}:${fqn}`;
      const type: TypeInfo = { id, fqn, file, fact, methods: new Map(), superTypes: [] };
      allTypes.push(type);
      byFqn.set(fqn, [...(byFqn.get(fqn) ?? []), type]);
      nodes.set(id, {
        id,
        kind: "type",
        name: fact.localName.split(".").pop() ?? fact.localName,
        qualifiedName: fqn,
        file: file.path,
        line: fact.line,
        endLine: fact.endLine,
        module: file.module,
        isTest: isTestPath(file.path),
        annotations: notable(fact.annotations),
      });

      const outerName = fact.localName.includes(".") ? fact.localName.slice(0, fact.localName.lastIndexOf(".")) : null;
      const outerFqn = outerName && (file.facts.packageName ? `${file.facts.packageName}.${outerName}` : outerName);
      addEdge(outerFqn ? `type:${file.module}:${outerFqn}` : fileId, id, "declares", "exact");

      // Overloads with the same number of parameters share a node: telling them apart would need
      // the argument types, which only a compiler knows.
      for (const method of fact.methods) {
        const key = `${method.name}/${method.arity}`;
        if (type.methods.has(key)) continue;
        const methodId = `method:${file.module}:${fqn}#${key}`;
        type.methods.set(key, methodId);
        nodes.set(methodId, {
          id: methodId,
          kind: "method",
          name: method.name,
          qualifiedName: `${fqn}#${key}`,
          file: file.path,
          line: method.line,
          endLine: method.endLine,
          module: file.module,
          isTest: isTestPath(file.path),
          annotations: notable(method.annotations),
        });
        addEdge(id, methodId, "declares", "exact");
      }
    }
  }

  // Two services can have identical class names: prefer the one in the caller's own module.
  const pick = (candidates: TypeInfo[] | undefined, module: string): TypeInfo | undefined =>
    candidates?.find((type) => type.file.module === module) ?? candidates?.[0];

  const resolveType = (name: string, from: TypeInfo): TypeInfo | undefined => {
    const { facts, module } = from.file;
    const packagePrefix = facts.packageName ? `${facts.packageName}.` : "";

    // Enclosing types, innermost first.
    const parts = from.fact.localName.split(".");
    for (let depth = parts.length; depth > 0; depth -= 1) {
      const found = pick(byFqn.get(`${packagePrefix}${parts.slice(0, depth).join(".")}.${name}`), module);
      if (found) return found;
    }

    const [head = name, ...rest] = name.split(".");
    const suffix = rest.length ? `.${rest.join(".")}` : "";
    for (const entry of facts.imports) {
      if (!entry.isStatic && !entry.isWildcard && entry.name.split(".").pop() === head) {
        const found = pick(byFqn.get(`${entry.name}${suffix}`), module);
        if (found) return found;
      }
    }

    const samePackage = pick(byFqn.get(`${packagePrefix}${name}`), module);
    if (samePackage) return samePackage;

    for (const entry of facts.imports) {
      if (!entry.isStatic && entry.isWildcard) {
        const found = pick(byFqn.get(`${entry.name}.${name}`), module);
        if (found) return found;
      }
    }
    return pick(byFqn.get(name), module);
  };

  // 2. Inheritance.
  for (const type of allTypes) {
    for (const superType of type.fact.superTypes) {
      const resolved = resolveType(superType.name, type);
      if (resolved) {
        type.superTypes.push(resolved);
        addEdge(type.id, resolved.id, superType.relation, "exact", type.fact.line);
      }
      // JpaRepository<UserModel, UUID> ties a repository to its entity through the type argument.
      for (const ref of superType.refs) {
        const argument = resolveType(ref, type);
        if (argument && argument !== resolved) addEdge(type.id, argument.id, "uses", "exact", type.fact.line);
      }
    }
  }

  const ancestors = (type: TypeInfo, seen = new Set<TypeInfo>()): TypeInfo[] => {
    for (const parent of type.superTypes) {
      if (!seen.has(parent)) {
        seen.add(parent);
        ancestors(parent, seen);
      }
    }
    return [...seen];
  };

  const findMethod = (type: TypeInfo, name: string, arity: number): string | undefined => {
    for (const candidate of [type, ...ancestors(type)]) {
      if (arity >= 0) {
        const exact = candidate.methods.get(`${name}/${arity}`);
        if (exact) return exact;
      }
      const sameName = [...candidate.methods.entries()].filter(([key]) => key.startsWith(`${name}/`));
      if (arity < 0 && sameName[0]) return sameName[0][1];
    }
    return undefined;
  };

  const findField = (type: TypeInfo, name: string) => {
    for (const candidate of [type, ...ancestors(type)]) {
      const field = candidate.fact.fields.find((entry) => entry.name === name);
      if (field) return { field, owner: candidate };
    }
    return undefined;
  };

  const enclosing = (type: TypeInfo): TypeInfo[] => {
    const parts = type.fact.localName.split(".");
    const prefix = type.file.facts.packageName ? `${type.file.facts.packageName}.` : "";
    const chain: TypeInfo[] = [type];
    for (let depth = parts.length - 1; depth > 0; depth -= 1) {
      const outer = pick(byFqn.get(`${prefix}${parts.slice(0, depth).join(".")}`), type.file.module);
      if (outer) chain.push(outer);
    }
    return chain;
  };

  const httpCalls: { from: string; module: string; call: HttpCallFact }[] = [];
  const endpoints: { id: string; module: string; verb: string; segments: string[] }[] = [];

  const addTable = (name: string, from: string, confidence: Confidence, line: number) => {
    const id = `table:${name}`;
    if (!nodes.has(id)) nodes.set(id, { id, kind: "table", name, qualifiedName: name, isTest: false });
    addEdge(from, id, "maps_to", confidence, line);
  };

  // 3. Everything inside types.
  for (const type of allTypes) {
    const { fact, file } = type;
    const annotationNames = new Set(fact.annotations.map((annotation) => annotation.name));
    const isManaged = [...annotationNames].some((name) => STEREOTYPES.has(name));
    const hasGeneratedConstructor = [...annotationNames].some((name) => GENERATED_CONSTRUCTORS.has(name));
    const isFeignClient = annotationNames.has("FeignClient");

    for (const ref of fact.refs) {
      const resolved = resolveType(ref, type);
      if (resolved && resolved !== type) addEdge(type.id, resolved.id, "uses", "exact", fact.line);
    }

    const entity = fact.annotations.find((annotation) => annotation.name === "Entity");
    if (entity) {
      const declared = fact.annotations.find((annotation) => annotation.name === "Table")?.args.name?.[0];
      if (declared && !declared.startsWith("=")) addTable(declared, type.id, "exact", fact.line);
      else addTable(nodes.get(type.id)?.name ?? fact.localName, type.id, "inferred", fact.line);
    }

    for (const field of fact.fields) {
      const injected =
        field.annotations.some((annotation) => INJECTION.has(annotation.name)) ||
        (hasGeneratedConstructor && field.isFinal && !field.isStatic);
      const declaredType = resolveType(field.type, type);
      for (const ref of field.refs) {
        const resolved = resolveType(ref, type);
        if (!resolved || resolved === type) continue;
        addEdge(type.id, resolved.id, injected && resolved === declaredType ? "injects" : "uses", "exact", fact.line);
      }
      for (const annotation of field.annotations) {
        const resolved = resolveType(annotation.name, type);
        if (resolved) addEdge(type.id, resolved.id, "uses", "exact", fact.line);
        const joinTable = annotation.name === "JoinTable" ? annotation.args.name?.[0] : undefined;
        if (joinTable && !joinTable.startsWith("=")) addTable(joinTable, type.id, "exact", fact.line);
      }
    }

    const classMapping = fact.annotations.find((annotation) => annotation.name === "RequestMapping");
    const prefixes = classMapping ? pathValues(classMapping) : [""];
    const feignPrefix = fact.annotations.find((annotation) => annotation.name === "FeignClient")?.args.path?.[0] ?? "";

    const seenKeys = new Set<string>();
    for (const method of fact.methods) {
      const key = `${method.name}/${method.arity}`;
      const methodId = type.methods.get(key);
      if (!methodId) continue;
      const firstOverload = !seenKeys.has(key);
      seenKeys.add(key);

      resolveMethodBody(type, method, methodId);

      if (method.isConstructor && isManaged) {
        for (const paramType of method.paramTypes) {
          const resolved = resolveType(paramType, type);
          if (resolved) addEdge(type.id, resolved.id, "injects", "exact", method.line);
        }
      }

      if (firstOverload && !method.isConstructor) {
        for (const ancestor of ancestors(type)) {
          const overridden = ancestor.methods.get(key);
          if (overridden) addEdge(methodId, overridden, "overrides", "exact", method.line);
        }
      }

      for (const annotation of method.annotations) {
        const verbs = mappingVerbs(annotation);
        if (!verbs) continue;
        for (const verb of verbs) {
          for (const value of pathValues(annotation)) {
            if (isFeignClient) {
              httpCalls.push({
                from: methodId,
                module: file.module,
                call: { verb, template: joinPath(feignPrefix, value), line: method.line },
              });
              continue;
            }
            for (const prefix of prefixes) {
              const path = joinPath(prefix, value);
              const name = `${verb} ${path}`;
              const id = `endpoint:${file.module}:${name}`;
              if (!nodes.has(id)) {
                nodes.set(id, {
                  id,
                  kind: "endpoint",
                  name,
                  qualifiedName: `${file.module}:${name}`,
                  file: file.path,
                  line: method.line,
                  module: file.module,
                  isTest: false,
                });
                endpoints.push({ id, module: file.module, verb, segments: pathSegments(path) ?? [] });
              }
              addEdge(id, methodId, "handled_by", "exact", method.line);
            }
          }
        }
      }
    }
  }

  function resolveMethodBody(type: TypeInfo, method: MethodFact, methodId: string): void {
    for (const ref of method.refs) {
      const resolved = resolveType(ref, type);
      if (resolved && resolved !== type) addEdge(methodId, resolved.id, "uses", "exact", method.line);
    }

    for (const call of method.calls) {
      const target = resolveReceiver(type, method, call.receiver);
      if (!target) {
        if (call.receiver === null) {
          const importedStatic = resolveStaticImport(type, call.name, call.arity);
          if (importedStatic) addEdge(methodId, importedStatic, "calls", "inferred", call.line);
        }
        continue;
      }
      const candidates = call.receiver === null ? enclosing(target) : [target];
      const found = candidates.map((candidate) => findMethod(candidate, call.name, call.arity)).find(Boolean);
      if (found) addEdge(methodId, found, "calls", "inferred", call.line);
      // Inherited from outside the project, as JpaRepository.findById is. The dependency is real.
      else if (target !== type) addEdge(methodId, target.id, "uses", "inferred", call.line);
    }

    for (const call of method.httpCalls) {
      httpCalls.push({ from: methodId, module: type.file.module, call });
    }
  }

  function resolveReceiver(type: TypeInfo, method: MethodFact, receiver: string | null): TypeInfo | undefined {
    if (receiver === null || receiver === "this") return type;
    if (receiver === "super") return type.superTypes[0];
    if (receiver === "?") return undefined;

    if (receiver.startsWith("this.")) {
      const name = receiver.slice("this.".length);
      const found = findField(type, name);
      return found && resolveType(found.field.type, found.owner);
    }
    if (!receiver.includes(".")) {
      const local = method.locals[receiver];
      if (local) return resolveType(local, type);
      for (const scope of enclosing(type)) {
        const found = findField(scope, receiver);
        if (found) return resolveType(found.field.type, found.owner);
      }
    }
    return resolveType(receiver, type);
  }

  function resolveStaticImport(type: TypeInfo, name: string, arity: number): string | undefined {
    for (const entry of type.file.facts.imports) {
      if (!entry.isStatic) continue;
      const owner = entry.isWildcard ? entry.name : entry.name.slice(0, entry.name.lastIndexOf("."));
      if (!entry.isWildcard && !entry.name.endsWith(`.${name}`)) continue;
      const resolved = pick(byFqn.get(owner), type.file.module);
      const found = resolved && findMethod(resolved, name, arity);
      if (found) return found;
    }
    return undefined;
  }

  // 4. Service-to-service calls, matched by verb and path shape.
  const multiModule = new Set(files.map((file) => file.module)).size > 1;
  for (const { from, module, call } of httpCalls) {
    const segments = pathSegments(call.template);
    const matches = !segments?.some((segment) => segment !== "*")
      ? []
      : endpoints
          .filter((endpoint) => !multiModule || endpoint.module !== module)
          .filter((endpoint) => call.verb === "ANY" || endpoint.verb === "ANY" || endpoint.verb === call.verb)
          .filter(
            (endpoint) =>
              endpoint.segments.length === segments.length &&
              endpoint.segments.every(
                (part, index) => part === segments[index] || part === "*" || segments[index] === "*",
              ),
          );

    // A literal match beats a path variable: /users/courses/{id} is a better fit than /users/{a}/{b}.
    const score = (endpointSegments: string[]) =>
      endpointSegments.filter((part, index) => part === segments?.[index] && part !== "*").length;
    const best = Math.max(0, ...matches.map((endpoint) => score(endpoint.segments)));
    const winners = matches.filter((endpoint) => score(endpoint.segments) === best);

    if (winners.length === 0) {
      const node = nodes.get(from);
      // The one place source text reaches the graph, and from here it can reach the model.
      if (node) node.unresolvedHttp = [...(node.unresolvedHttp ?? []), redact(`${call.verb} ${call.template}`).text];
    }
    for (const endpoint of winners) addEdge(from, endpoint.id, "http_calls", "inferred", call.line);
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

function notable(annotations: AnnotationFact[]): string[] | undefined {
  const names = annotations.map((annotation) => annotation.name).filter((name) => NOTABLE_ANNOTATION.test(name));
  return names.length ? names : undefined;
}
