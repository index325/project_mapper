import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { WORK_DIR } from "../scan.js";
import { GRAPH_FILE, openGraphStore, refreshGraph, type GraphBuild } from "./build.js";
import { formatContext, formatImpact, formatPath, formatSearch, resolveTarget } from "./query.js";
import type { GraphStore, NodeKind } from "./types.js";

/** A Spring request takes about 3 levels within a service, so crossing to another one needs more. */
export const DEFAULT_IMPACT_DEPTH = 5;

const NO_SOURCES = "No Java files found. The code graph currently supports only Java.";

/** Refreshes first: an answer from a stale graph looks just as confident as a correct one. */
async function withGraph(
  root: string | undefined,
  run: (store: GraphStore, build: GraphBuild, path: string) => string,
  options: { force?: boolean } = {},
): Promise<string> {
  const path = resolve(root ?? process.cwd());
  const info = await stat(path).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`Not a directory: ${path}`);
  const store = await openGraphStore(path);
  try {
    const build = await refreshGraph(path, store, options);
    return build.sourceFiles === 0 ? NO_SOURCES : run(store, build, path);
  } finally {
    store.close();
  }
}

export function graphIndex(root?: string, force = false): Promise<string> {
  return withGraph(
    root,
    (store, build) => {
      const stats = store.stats();
      const list = (counts: Record<string, number>) =>
        Object.entries(counts).map(([kind, total]) => `${total} ${kind}`).join(", ");
      const lines = [
        build.rebuilt ? `Graph rebuilt: ${build.parsedFiles} of ${build.sourceFiles} Java files parsed.` : `Graph already up to date: ${build.sourceFiles} Java files.`,
        `Nodes: ${list(stats.nodes)}.`,
        `Edges: ${list(stats.edges)}.`,
        `HTTP calls with no matching endpoint in this repository: ${stats.unresolvedHttpCalls}.`,
        `Stored in ${WORK_DIR}/${GRAPH_FILE}.`,
      ];
      if (build.filesWithSyntaxErrors.length > 0) {
        lines.push(`Files with syntax errors, possibly incomplete: ${build.filesWithSyntaxErrors.join(", ")}.`);
      }
      return lines.join("\n");
    },
    { force },
  );
}

export function graphSearch(query: string, kind?: NodeKind, root?: string): Promise<string> {
  return withGraph(root, (store) => formatSearch(store, query, kind));
}

export function graphContext(target: string, root?: string): Promise<string> {
  return withGraph(root, (store) => {
    const resolution = resolveTarget(store, target);
    return "error" in resolution ? resolution.error : formatContext(store, resolution.found);
  });
}

export function graphImpact(target: string, depth = DEFAULT_IMPACT_DEPTH, root?: string): Promise<string> {
  return withGraph(root, (store) => {
    const resolution = resolveTarget(store, target);
    return "error" in resolution ? resolution.error : formatImpact(store, resolution.found, depth);
  });
}

export function graphPath(from: string, to: string, root?: string): Promise<string> {
  return withGraph(root, (store) => {
    const start = resolveTarget(store, from);
    if ("error" in start) return start.error;
    const end = resolveTarget(store, to);
    if ("error" in end) return end.error;
    return formatPath(store, start.found, end.found);
  });
}
