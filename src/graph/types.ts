export type NodeKind = "file" | "type" | "method" | "endpoint" | "table";

/**
 * Direction is always "from depends on to": if `to` changes, `from` may be affected.
 * The exception is `declares`, which only expresses containment.
 */
export type EdgeKind =
  | "declares"
  | "extends"
  | "implements"
  | "overrides"
  | "injects"
  | "uses"
  | "calls"
  | "handled_by"
  | "http_calls"
  | "maps_to";

/** `exact` comes from the syntax. `inferred` is a best guess: types were resolved without a compiler. */
export type Confidence = "exact" | "inferred";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  file?: string;
  line?: number;
  endLine?: number;
  module?: string;
  isTest: boolean;
  /** Spring and JPA annotations on a type or method, for context. */
  annotations?: string[];
  /** REST client calls whose URL could not be matched to an endpoint in this repository. */
  unresolvedHttp?: string[];
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  confidence: Confidence;
  line?: number;
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface CachedFacts {
  path: string;
  hash: string;
  extractorVersion: number;
  facts: string;
}

export interface GraphStats {
  nodes: Record<string, number>;
  edges: Record<string, number>;
  unresolvedHttpCalls: number;
}

/**
 * Everything the rest of the code knows about storage. Traversal lives in query.ts on top of these
 * operations, so another backend such as Neo4j only has to implement this interface.
 */
export interface GraphStore {
  fingerprint(): string | undefined;
  loadFacts(): CachedFacts[];
  replace(snapshot: GraphSnapshot, facts: CachedFacts[], fingerprint: string): void;
  nodes(ids: string[]): GraphNode[];
  /** Exact matches first, then suffix matches, then substring matches. Only the best tier returns. */
  search(text: string, options?: { kind?: NodeKind; limit?: number }): GraphNode[];
  edges(ids: string[], direction: "out" | "in", kinds?: EdgeKind[]): GraphEdge[];
  snapshot(): GraphSnapshot;
  stats(): GraphStats;
  close(): void;
}
