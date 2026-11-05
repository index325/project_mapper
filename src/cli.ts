#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { DEFAULT_IMPACT_DEPTH, graphContext, graphImpact, graphIndex, graphPath, graphSearch } from "./graph/tools.js";
import type { NodeKind } from "./graph/types.js";
import { mapCodebase, planMapping } from "./pipeline.js";
import { formatResult } from "./report.js";

const USAGE = `Usage:
  project-mapper [root] [--force] [--dry-run]     Generate or update docs/CODEBASE_MAP.md
  project-mapper graph index   [--force]          Show the code graph's size and coverage
  project-mapper graph search  <query> [--kind k] Find code by name
  project-mapper graph context <target>           What it depends on, and what depends on it
  project-mapper graph impact  <target> [--depth n]  What may break if it changes
  project-mapper graph path    <from> <to>        How one piece of code reaches another

Options:
  --force     Ignore cached results
  --dry-run   Show what would be processed, without calling the model
  --root      Project for graph commands (default: current directory)

Mapping needs PROJECT_MAPPER_BASE_URL and PROJECT_MAPPER_MODEL. The graph needs no model. See README.md.`;

async function runGraph(args: string[], root: string | undefined, force: boolean, depth: string | undefined, kind: string | undefined): Promise<string> {
  const [command, first, second] = args;
  const need = (value: string | undefined, name: string): string => {
    if (!value) throw new Error(`Missing ${name}.\n\n${USAGE}`);
    return value;
  };
  switch (command) {
    case "index":
      return graphIndex(root, force);
    case "search":
      return graphSearch(need(first, "<query>"), kind as NodeKind | undefined, root);
    case "context":
      return graphContext(need(first, "<target>"), root);
    case "impact":
      return graphImpact(need(first, "<target>"), depth ? Number(depth) : DEFAULT_IMPACT_DEPTH, root);
    case "path":
      return graphPath(need(first, "<from>"), need(second, "<to>"), root);
    default:
      throw new Error(`Unknown graph command "${command ?? ""}".\n\n${USAGE}`);
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      force: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      root: { type: "string" },
      depth: { type: "string" },
      kind: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  if (positionals[0] === "graph") {
    console.log(await runGraph(positionals.slice(1), values.root, values.force, values.depth, values.kind));
    return;
  }

  const root = resolve(positionals[0] ?? ".");
  const config = loadConfig();

  if (values["dry-run"]) {
    const { scan, chunks, budget } = await planMapping(root, config);
    console.log(`${scan.files.length} files, ~${scan.totalTokens} estimated tokens`);
    console.log(`${chunks.length} parts, up to ${budget} tokens each:`);
    for (const chunk of chunks) {
      console.log(`  ${chunk.label}: ${chunk.files.length} files, ~${chunk.tokens} tokens`);
    }
    if (scan.skipped.length > 0) console.log("Skipped:");
    for (const file of scan.skipped) console.log(`  ${file.path} (${file.reason})`);
    return;
  }

  const result = await mapCodebase(root, config, {
    force: values.force,
    onProgress: (message) => console.error(`[project-mapper] ${message}`),
  });
  console.log(formatResult(result));
}

main().catch((error: Error) => {
  console.error(`project-mapper: ${error.message}`);
  process.exitCode = 1;
});
