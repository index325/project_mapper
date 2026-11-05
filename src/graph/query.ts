import type { EdgeKind, GraphEdge, GraphNode, GraphStore, NodeKind } from "./types.js";

/** Answers go into the context of a model with a limited window, so they are always bounded. */
const GROUP_LIMIT = 25;
const IMPACT_LIMIT = 120;
const MAX_PATH_DEPTH = 15;

const DEPENDENCY_KINDS: EdgeKind[] = [
  "calls",
  "uses",
  "injects",
  "extends",
  "implements",
  "overrides",
  "handled_by",
  "http_calls",
  "maps_to",
];

function location(node: GraphNode): string {
  if (!node.file) return "";
  return ` (${node.file}${node.line ? `:${node.line}` : ""})`;
}

function label(node: GraphNode): string {
  const test = node.isTest ? " [test]" : "";
  return `${node.qualifiedName}${location(node)}${test}`;
}

export type Resolution =
  | { found: GraphNode }
  | { error: string };

/** Accepts a name, a qualified name, a file, an endpoint, and both Type#method and Type.method. */
export function resolveTarget(store: GraphStore, target: string): Resolution {
  const text = target.trim();
  let matches = store.search(text);

  // UserService.save has the same meaning as UserService#save, but no node is spelled that way.
  if (matches.length === 0 && !text.includes("#") && text.includes(".")) {
    const dot = text.lastIndexOf(".");
    matches = store.search(`${text.slice(0, dot)}#${text.slice(dot + 1)}`);
  }
  if (matches.length === 1 && matches[0]) return { found: matches[0] };

  // UserModel is both a type and, by substring, UserModel.java: the type is what was meant.
  const types = matches.filter((node) => node.kind === "type" && node.name === text);
  if (types.length === 1 && types[0]) return { found: types[0] };

  if (matches.length === 0) {
    return { error: `Nothing in the graph matches "${text}". Use graph_search to look for similar names.` };
  }
  const options = matches.slice(0, 15).map((node) => `- ${node.kind} ${label(node)}`);
  return { error: `"${text}" is ambiguous. Call again with one of these qualified names:\n${options.join("\n")}` };
}

function groupByKind(edges: GraphEdge[]): Map<EdgeKind, GraphEdge[]> {
  const groups = new Map<EdgeKind, GraphEdge[]>();
  for (const edge of edges) groups.set(edge.kind, [...(groups.get(edge.kind) ?? []), edge]);
  return groups;
}

function renderGroup(title: string, ids: string[], nodes: Map<string, GraphNode>): string[] {
  const lines = ids
    .map((id) => nodes.get(id))
    .filter((node): node is GraphNode => node !== undefined)
    .sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName))
    .map((node) => `  - ${label(node)}`);
  const hidden = lines.length - GROUP_LIMIT;
  return [`${title} (${lines.length}):`, ...lines.slice(0, GROUP_LIMIT), ...(hidden > 0 ? [`  ... and ${hidden} more`] : [])];
}

export function formatSearch(store: GraphStore, query: string, kind?: NodeKind): string {
  const results = store.search(query, { limit: 30, ...(kind ? { kind } : {}) });
  if (results.length === 0) return `No matches for "${query}".`;
  return results.map((node) => `${node.kind} ${label(node)}`).join("\n");
}

const OUT_TITLES: Partial<Record<EdgeKind, string>> = {
  declares: "Declares",
  extends: "Extends",
  implements: "Implements",
  overrides: "Overrides",
  injects: "Injects",
  uses: "Uses",
  calls: "Calls",
  handled_by: "Handled by",
  http_calls: "Calls over HTTP",
  maps_to: "Maps to table",
};

const IN_TITLES: Partial<Record<EdgeKind, string>> = {
  declares: "Declared in",
  extends: "Extended by",
  implements: "Implemented by",
  overrides: "Overridden by",
  injects: "Injected into",
  uses: "Used by",
  calls: "Called by",
  handled_by: "Exposed as endpoint",
  http_calls: "Called over HTTP by",
  maps_to: "Mapped by",
};

export function formatContext(store: GraphStore, node: GraphNode): string {
  const outgoing = store.edges([node.id], "out");
  const incoming = store.edges([node.id], "in");
  const others = new Map(
    store.nodes([...outgoing.map((edge) => edge.to), ...incoming.map((edge) => edge.from)]).map((other) => [other.id, other]),
  );

  const lines = [`${node.kind} ${label(node)}`];
  if (node.module) lines.push(`Module: ${node.module}`);
  if (node.annotations?.length) lines.push(`Annotations: ${node.annotations.join(", ")}`);
  if (node.endLine && node.line) lines.push(`Lines: ${node.line}-${node.endLine}`);

  for (const [kind, edges] of groupByKind(outgoing)) {
    lines.push(...renderGroup(OUT_TITLES[kind] ?? kind, edges.map((edge) => edge.to), others));
  }
  for (const [kind, edges] of groupByKind(incoming)) {
    lines.push(...renderGroup(IN_TITLES[kind] ?? kind, edges.map((edge) => edge.from), others));
  }
  if (node.unresolvedHttp?.length) {
    lines.push("HTTP calls with no matching endpoint in this repository:", ...node.unresolvedHttp.map((call) => `  - ${call}`));
  }
  return lines.join("\n");
}

/** Changing a type or a file changes what it contains. */
function expandSeeds(store: GraphStore, node: GraphNode): string[] {
  const seeds = new Set([node.id]);
  if (node.kind !== "type" && node.kind !== "file") return [...seeds];
  let frontier = [node.id];
  while (frontier.length > 0) {
    const next = store.edges(frontier, "out", ["declares"]).map((edge) => edge.to).filter((id) => !seeds.has(id));
    for (const id of next) seeds.add(id);
    frontier = next;
  }
  return [...seeds];
}

interface Reached {
  depth: number;
  via: EdgeKind;
  /** Reached by going from an implementation up to its interface. */
  upward: boolean;
}

/**
 * Who may be affected by a change: everything that depends on the target, transitively.
 *
 * Callers usually hold the interface, not the implementation, so a change to an implementation also
 * walks up to what it overrides. Walking back down from there would wrongly reach sibling
 * implementations, which is why those steps are tracked as upward.
 */
export function formatImpact(store: GraphStore, node: GraphNode, depth: number): string {
  const seeds = expandSeeds(store, node);
  const seedSet = new Set(seeds);
  const reached = new Map<string, Reached>();
  const visited = new Set(seeds);
  let frontier = seeds.map((id) => ({ id, upward: false }));

  for (let level = 1; level <= depth && frontier.length > 0; level += 1) {
    // Going up costs no depth: the interface method and its implementation are the same behavior.
    const upQueue = [...frontier];
    while (upQueue.length > 0) {
      const edges = store.edges(upQueue.map((entry) => entry.id), "out", ["overrides", "implements", "extends"]);
      upQueue.length = 0;
      for (const edge of edges) {
        if (visited.has(edge.to)) continue;
        visited.add(edge.to);
        reached.set(edge.to, { depth: level, via: edge.kind, upward: true });
        const entry = { id: edge.to, upward: true };
        frontier.push(entry);
        upQueue.push(entry);
      }
    }

    const next: typeof frontier = [];
    const collect = (ids: string[], kinds: EdgeKind[]) => {
      for (const edge of store.edges(ids, "in", kinds)) {
        if (visited.has(edge.from)) continue;
        visited.add(edge.from);
        reached.set(edge.from, { depth: level, via: edge.kind, upward: false });
        next.push({ id: edge.from, upward: false });
      }
    };
    const down = frontier.filter((entry) => !entry.upward).map((entry) => entry.id);
    const up = frontier.filter((entry) => entry.upward).map((entry) => entry.id);
    if (down.length) collect(down, DEPENDENCY_KINDS);
    if (up.length) {
      collect(up, DEPENDENCY_KINDS.filter((kind) => !["overrides", "implements", "extends"].includes(kind)));
    }
    frontier = next;
  }

  const affected = store
    .nodes([...reached.keys()])
    .filter((other) => !seedSet.has(other.id) && other.kind !== "file" && other.kind !== "table");
  const endpoints = affected.filter((other) => other.kind === "endpoint");
  const tests = affected.filter((other) => other.isTest);
  const rest = affected.filter((other) => other.kind !== "endpoint" && !other.isTest);

  const lines = [
    `Impact of ${node.kind} ${label(node)}, up to ${depth} levels:`,
    `${endpoints.length} endpoints, ${tests.length} test members, ${rest.length} other members.`,
  ];
  if (affected.length === 0) {
    lines.push("Nothing in this repository depends on it. Reflection, AOP and configuration are not visible to this analysis.");
    return lines.join("\n");
  }

  if (endpoints.length) {
    lines.push("Endpoints:", ...endpoints.sort(byName).map((other) => `  - ${other.qualifiedName}`));
  }
  const ordered = rest.sort((a, b) => (reached.get(a.id)?.depth ?? 0) - (reached.get(b.id)?.depth ?? 0) || byName(a, b));
  const shown = ordered.slice(0, IMPACT_LIMIT);
  let currentDepth = 0;
  for (const other of shown) {
    const info = reached.get(other.id);
    if (info && info.depth !== currentDepth) {
      currentDepth = info.depth;
      lines.push(`Level ${currentDepth}:`);
    }
    lines.push(`  - ${label(other)} [${info?.via}]`);
  }
  if (ordered.length > shown.length) lines.push(`  ... and ${ordered.length - shown.length} more`);
  if (tests.length) {
    lines.push("Tests:", ...tests.sort(byName).slice(0, GROUP_LIMIT).map((other) => `  - ${label(other)}`));
  }
  lines.push("Calls are inferred without a compiler, so treat this as a starting point, not a guarantee.");
  return lines.join("\n");
}

function byName(a: GraphNode, b: GraphNode): number {
  return a.qualifiedName.localeCompare(b.qualifiedName);
}

interface Step {
  id: string;
  previous?: Step;
  kind?: string;
}

/**
 * Follows the code the way it runs. A call to an interface method continues in its implementations,
 * which is an incoming edge, so `overrides` and `implements` are also walked backwards.
 */
function findPath(store: GraphStore, from: string, targets: Set<string>): Step | undefined {
  if (targets.has(from)) return { id: from };
  const seen = new Set([from]);
  let frontier: Step[] = [{ id: from }];
  const forward: EdgeKind[] = ["declares", "calls", "uses", "injects", "extends", "implements", "handled_by", "http_calls", "maps_to"];

  for (let depth = 0; depth < MAX_PATH_DEPTH && frontier.length > 0; depth += 1) {
    const byId = new Map(frontier.map((step) => [step.id, step]));
    const next: Step[] = [];
    const visit = (id: string, previous: Step | undefined, kind: string): Step | undefined => {
      if (!previous || seen.has(id)) return undefined;
      seen.add(id);
      const step: Step = { id, previous, kind };
      next.push(step);
      return targets.has(id) ? step : undefined;
    };
    for (const edge of store.edges([...byId.keys()], "out", forward)) {
      const done = visit(edge.to, byId.get(edge.from), edge.kind);
      if (done) return done;
    }
    for (const edge of store.edges([...byId.keys()], "in", ["overrides", "implements"])) {
      const done = visit(edge.from, byId.get(edge.to), "dispatches_to");
      if (done) return done;
    }
    frontier = next;
  }
  return undefined;
}

export function formatPath(store: GraphStore, from: GraphNode, to: GraphNode): string {
  // Reaching any member of a class counts as reaching the class: no edge leads from a method to its
  // own type, so looking for the type's node alone would miss every path that ends in one of them.
  const direct = findPath(store, from.id, new Set(expandSeeds(store, to)));
  const reverse = direct ? undefined : findPath(store, to.id, new Set(expandSeeds(store, from)));
  const end = direct ?? reverse;
  if (!end) {
    return `No dependency path between ${from.qualifiedName} and ${to.qualifiedName}, in either direction.`;
  }

  const steps: Step[] = [];
  for (let step: Step | undefined = end; step; step = step.previous) steps.unshift(step);
  const nodes = new Map(store.nodes(steps.map((step) => step.id)).map((node) => [node.id, node]));
  const lines = reverse ? [`${to.qualifiedName} depends on ${from.qualifiedName}:`] : [];
  for (const step of steps) {
    const node = nodes.get(step.id);
    if (!node) continue;
    lines.push(step.kind ? `  -[${step.kind}]-> ${label(node)}` : label(node));
  }
  return lines.join("\n");
}
