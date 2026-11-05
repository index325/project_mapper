#!/usr/bin/env node
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { DEFAULT_IMPACT_DEPTH, graphContext, graphImpact, graphIndex, graphPath, graphSearch } from "./graph/tools.js";
import { JobRunner } from "./jobs.js";
import { planMapping } from "./pipeline.js";
import { formatResult } from "./report.js";

const config = loadConfig();
const runner = new JobRunner(config);
const server = new McpServer({ name: "project-mapper", version: "0.1.0" });

function text(content: string, isError = false) {
  return { content: [{ type: "text" as const, text: content }], isError };
}

async function resolveRoot(root: string | undefined): Promise<string> {
  const path = resolve(root ?? process.cwd());
  const info = await stat(path).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`Not a directory: ${path}`);
  return path;
}

server.registerTool(
  "map_codebase",
  {
    description:
      "Generates or updates docs/CODEBASE_MAP.md and the project's agent instructions summary. " +
      "Only changed modules are re-analyzed. May answer RUNNING: then call it again with attempt " +
      "increased by 1, and repeat until it answers DONE, UP TO DATE or FAILED.",
    inputSchema: {
      root: z.string().optional().describe("Absolute path of the project. Defaults to the current project."),
      force: z.boolean().optional().describe("Re-analyze everything, ignoring cached answers."),
      // Unused by the server. opencode asks the user for approval when a tool is called three times
      // with identical input (doom_loop), which would interrupt legitimate waiting.
      attempt: z
        .number()
        .int()
        .optional()
        .describe("1 on the first call, increased by 1 on each repeated call."),
    },
  },
  async ({ root, force }) => {
    try {
      const path = await resolveRoot(root);
      const view = await runner.run(path, force ?? false, config.waitSeconds * 1000);
      if (view.state === "running") {
        return text(`RUNNING (${view.progress}). Not finished yet: call map_codebase again with attempt increased by 1.`);
      }
      if (view.state === "failed") return text(`FAILED. ${view.error}`, true);
      return text(formatResult(view.result));
    } catch (error) {
      return text(`FAILED. ${(error as Error).message}`, true);
    }
  },
);

server.registerTool(
  "scan_codebase",
  {
    description:
      "Previews what map_codebase would process, without calling the model or writing files: " +
      "file count, estimated tokens, how the work is split and which files are skipped.",
    inputSchema: {
      root: z.string().optional().describe("Absolute path of the project. Defaults to the current project."),
    },
  },
  async ({ root }) => {
    try {
      const { scan, chunks, budget } = await planMapping(await resolveRoot(root), config);
      return text(
        JSON.stringify(
          {
            files: scan.files.length,
            estimatedTokens: scan.totalTokens,
            tokensPerRequest: budget,
            parts: chunks.map((chunk) => ({
              label: chunk.label,
              files: chunk.files.length,
              tokens: chunk.tokens,
            })),
            skipped: scan.skipped,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      return text(`FAILED. ${(error as Error).message}`, true);
    }
  },
);

const ROOT_ARGUMENT = z.string().optional().describe("Absolute path of the project. Defaults to the current project.");

function registerGraphTool<Shape extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: Shape,
  run: (args: z.infer<z.ZodObject<Shape>>) => Promise<string>,
): void {
  server.registerTool(name, { description, inputSchema }, (async (args: z.infer<z.ZodObject<Shape>>) => {
    try {
      return text(await run(args));
    } catch (error) {
      return text(`FAILED. ${(error as Error).message}`, true);
    }
  }) as never);
}

registerGraphTool(
  "graph_search",
  "Finds classes, methods, HTTP endpoints, database tables or files in the code graph by name. Java only.",
  {
    query: z.string().describe("Name or part of a name, e.g. UserService or /users."),
    kind: z.enum(["file", "type", "method", "endpoint", "table"]).optional(),
    root: ROOT_ARGUMENT,
  },
  ({ query, kind, root }) => graphSearch(query, kind, root),
);

registerGraphTool(
  "graph_context",
  "Shows what a class, method, endpoint or table depends on and what depends on it, with file and line. Use before reading or changing unfamiliar code.",
  {
    target: z.string().describe("Name, qualified name, Type#method, file path, or endpoint such as GET /users."),
    root: ROOT_ARGUMENT,
  },
  ({ target, root }) => graphContext(target, root),
);

registerGraphTool(
  "graph_impact",
  "Lists what may break if a class, method, endpoint or table changes, including affected HTTP endpoints and tests. Use before changing code.",
  {
    target: z.string().describe("Name, qualified name, Type#method, file path, or endpoint such as GET /users."),
    depth: z.number().int().min(1).max(10).optional().describe(`Levels to follow. Defaults to ${DEFAULT_IMPACT_DEPTH}.`),
    root: ROOT_ARGUMENT,
  },
  ({ target, depth, root }) => graphImpact(target, depth, root),
);

registerGraphTool(
  "graph_path",
  "Shows how one piece of code reaches another, following calls, dependency injection and HTTP calls between services.",
  {
    from: z.string().describe("Where the path starts."),
    to: z.string().describe("Where the path ends."),
    root: ROOT_ARGUMENT,
  },
  ({ from, to, root }) => graphPath(from, to, root),
);

registerGraphTool(
  "graph_index",
  "Reports the code graph's size and coverage. The other graph tools already refresh it, so this is only needed to check it or to force a rebuild.",
  {
    force: z.boolean().optional().describe("Parse every file again, ignoring the cache."),
    root: ROOT_ARGUMENT,
  },
  ({ force, root }) => graphIndex(root, force ?? false),
);

// stdout carries the MCP protocol, so nothing else may be printed there.
await server.connect(new StdioServerTransport());
