import type { GraphNode, GraphSnapshot } from "./types.js";

const MAX_ENDPOINT_ROWS = 200;
const MAX_FACT_LINES = 60;

export interface GraphSections {
  /** Parser-derived facts given to the model, so its diagrams rest on what the code really does. */
  facts: string;
  /** Sections written straight into the map, with no model involved. */
  markdown: string;
}

interface ModuleLink {
  from: string;
  to: string;
  http: number;
  code: number;
}

function moduleLinks(snapshot: GraphSnapshot, nodes: Map<string, GraphNode>): ModuleLink[] {
  const links = new Map<string, ModuleLink>();
  for (const edge of snapshot.edges) {
    if (edge.kind === "declares") continue;
    const from = nodes.get(edge.from)?.module;
    const to = nodes.get(edge.to)?.module;
    if (!from || !to || from === to) continue;
    const key = `${from}|${to}`;
    const link = links.get(key) ?? { from, to, http: 0, code: 0 };
    if (edge.kind === "http_calls") link.http += 1;
    else link.code += 1;
    links.set(key, link);
  }
  return [...links.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

function mermaidId(module: string): string {
  return `m_${module.replace(/[^A-Za-z0-9]/g, "_")}`;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

export function graphSections(snapshot: GraphSnapshot): GraphSections | undefined {
  if (snapshot.nodes.length === 0) return undefined;

  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const modules = [
    ...new Set(snapshot.nodes.filter((node) => node.kind === "file" && node.module).map((node) => node.module as string)),
  ].sort();
  const links = moduleLinks(snapshot, nodes);
  const handlers = new Map(snapshot.edges.filter((edge) => edge.kind === "handled_by").map((edge) => [edge.from, edge.to]));
  const endpoints = snapshot.nodes
    .filter((node) => node.kind === "endpoint")
    .sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
  const tables = snapshot.nodes.filter((node) => node.kind === "table").map((node) => node.name).sort();
  const httpCalls = snapshot.edges
    .filter((edge) => edge.kind === "http_calls")
    .map((edge) => `${nodes.get(edge.from)?.qualifiedName} -> ${nodes.get(edge.to)?.qualifiedName}`)
    .sort();

  const facts = [
    `Modules: ${modules.join(", ")}`,
    ...links.map((link) => `Module dependency: ${link.from} -> ${link.to} (${link.http} HTTP calls, ${link.code} code references)`),
    ...httpCalls.map((call) => `HTTP call: ${call}`),
    `Endpoints: ${endpoints.length}`,
    ...(tables.length ? [`Database tables: ${tables.join(", ")}`] : []),
  ].slice(0, MAX_FACT_LINES);

  const sections: string[] = [];

  if (modules.length > 1) {
    const moduleLines = modules.map((module) => `  ${mermaidId(module)}["${module}"]`);
    const linkLines = links.map((link) => {
      const parts = [link.http ? `${link.http} HTTP` : "", link.code ? `${link.code} code` : ""].filter(Boolean);
      return `  ${mermaidId(link.from)} -->|"${parts.join(", ")}"| ${mermaidId(link.to)}`;
    });
    sections.push(
      `## Service Dependencies\n\nExtracted from the code by a parser. HTTP calls whose URL is only known at runtime are not shown.\n\n\`\`\`mermaid\ngraph LR\n${[...moduleLines, ...linkLines].join("\n")}\n\`\`\``,
    );
  }

  if (endpoints.length > 0) {
    const rows = endpoints.slice(0, MAX_ENDPOINT_ROWS).map((endpoint) => {
      const handler = nodes.get(handlers.get(endpoint.id) ?? "");
      const where = handler?.file ? `\`${handler.file}:${handler.line ?? 1}\`` : "";
      return `| ${escapeCell(endpoint.module ?? "")} | \`${escapeCell(endpoint.name)}\` | ${where} |`;
    });
    const hidden = endpoints.length - rows.length;
    sections.push(
      `## HTTP Endpoints\n\n| Module | Endpoint | Handler |\n|--------|----------|---------|\n${rows.join("\n")}${hidden > 0 ? `\n\n...and ${hidden} more.` : ""}`,
    );
  }

  return { facts: facts.join("\n"), markdown: sections.join("\n\n") };
}
