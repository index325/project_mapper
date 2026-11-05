import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { planChunks, type Chunk } from "./chunk.js";
import { estimateTokens, inputBudget, type Config } from "./config.js";
import { openGraphStore, refreshGraph } from "./graph/build.js";
import { graphSections, type GraphSections } from "./graph/map-sections.js";
import { createChat, type Chat } from "./llm.js";
import {
  analysisSystem,
  analysisUser,
  condenseSystem,
  PROMPT_VERSION,
  reportsUser,
  synthesisSystem,
} from "./prompts.js";
import { redact } from "./redact.js";
import {
  extractSummary,
  findUnknownPaths,
  mergeInstructions,
  parseSections,
  readFingerprint,
  renderInstructionsSection,
  renderMap,
  SYNTHESIS_SECTIONS,
} from "./render.js";
import { MAP_PATH, scanCodebase, WORK_DIR, type ScanResult } from "./scan.js";

const exec = promisify(execFile);
const MAX_CONDENSE_ROUNDS = 4;
const TRUNCATION_NOTE = "\n\n> Warning: this text was cut off by the model's output limit.";

export interface MapOptions {
  force?: boolean;
  onProgress?: (message: string) => void;
  /** Replaces the real model client. Used by tests. */
  chat?: Chat;
}

export interface MapResult {
  status: "mapped" | "up_to_date";
  mapPath: string;
  instructionsPath?: string;
  files: number;
  estimatedTokens: number;
  chunks: number;
  modelCalls: number;
  reusedAnswers: number;
  redactions: number;
  skipped: Record<string, number>;
  truncatedFiles: string[];
  warnings: string[];
}

export interface Plan {
  scan: ScanResult;
  chunks: Chunk[];
  budget: number;
  fingerprint: string;
}

function sha256(...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}

async function currentCommit(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec("git", ["-C", root, "rev-parse", "--short", "HEAD"]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function runPool<T>(items: T[], size: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(size, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await worker(item);
    }
  });
  await Promise.all(runners);
}

export async function planMapping(root: string, config: Config): Promise<Plan> {
  const scan = await scanCodebase(root);
  const budget = inputBudget(config);
  const chunks = planChunks(scan.files, budget);
  const fingerprint = sha256(
    String(PROMPT_VERSION),
    config.model ?? "",
    config.language,
    ...scan.files.map((file) => `${file.path}:${file.hash}`),
  ).slice(0, 32);
  return { scan, chunks, budget, fingerprint };
}

/**
 * Every model answer is cached by the hash of its inputs. That single mechanism gives both update
 * mode (only changed modules are re-analyzed) and resuming after a failure or a timeout.
 */
export async function mapCodebase(
  root: string,
  config: Config,
  options: MapOptions = {},
): Promise<MapResult> {
  const progress = options.onProgress ?? (() => {});
  const stats = await stat(root).catch(() => undefined);
  if (!stats?.isDirectory()) throw new Error(`Not a directory: ${root}`);

  progress("scanning");
  const { scan, chunks, budget, fingerprint } = await planMapping(root, config);
  if (scan.files.length === 0) throw new Error(`No files to map in ${root}`);

  const mapPath = join(root, MAP_PATH);
  const skipped: Record<string, number> = {};
  for (const file of scan.skipped) skipped[file.reason] = (skipped[file.reason] ?? 0) + 1;

  const base = {
    mapPath,
    files: scan.files.length,
    estimatedTokens: scan.totalTokens,
    chunks: chunks.length,
    skipped,
  };

  if (!options.force && readFingerprint((await readOptional(mapPath)) ?? "") === fingerprint) {
    return {
      ...base,
      status: "up_to_date",
      modelCalls: 0,
      reusedAnswers: 0,
      redactions: 0,
      truncatedFiles: [],
      warnings: [],
    };
  }

  const chat = options.chat ?? createChat(config);
  const workDir = join(root, WORK_DIR);
  const cacheDir = join(workDir, "cache");
  await mkdir(cacheDir, { recursive: true });
  // Self-ignoring, so the target project's .gitignore does not need to be touched.
  await writeFile(join(workDir, ".gitignore"), "*\n");

  let modelCalls = 0;
  let reusedAnswers = 0;
  let redactions = 0;
  const usedKeys = new Set<string>();
  const warnings: string[] = [];

  async function ask(system: string, user: string, keyParts: string[]): Promise<string> {
    const key = sha256(String(PROMPT_VERSION), config.model ?? "", config.language, system, ...keyParts);
    usedKeys.add(key);
    const cachePath = join(cacheDir, `${key}.md`);
    if (!options.force) {
      const cached = await readOptional(cachePath);
      if (cached !== undefined) {
        reusedAnswers += 1;
        return cached;
      }
    }
    modelCalls += 1;
    const answer = await chat({ system, user });
    // Second pass: the model must not be able to reintroduce a secret into the committed map.
    const clean = redact(answer.text);
    redactions += clean.count;
    const text = answer.truncated ? clean.text + TRUNCATION_NOTE : clean.text;
    await writeAtomic(cachePath, text);
    return text;
  }

  // 1. Analyze each chunk. A failure does not stop the others: their answers stay cached.
  const truncatedFiles: string[] = [];
  const reports: string[] = new Array(chunks.length).fill("");
  const failures: string[] = [];
  let done = 0;
  const indexed = chunks.map((chunk, index) => ({ chunk, index }));

  await runPool(indexed, config.concurrency, async ({ chunk, index }) => {
    try {
      const contents = await Promise.all(
        chunk.files.map(async (file) => {
          const raw = await readFile(join(root, file.path), "utf8");
          const clean = redact(raw, file.path);
          redactions += clean.count;
          if (estimateTokens(clean.text) <= budget) return { path: file.path, content: clean.text };
          truncatedFiles.push(file.path);
          return {
            path: file.path,
            content: `${clean.text.slice(0, budget * 3)}\n[truncated by project-mapper]`,
          };
        }),
      );
      reports[index] = await ask(
        analysisSystem(config.language),
        analysisUser(chunk.label, contents),
        chunk.files.map((file) => `${file.path}:${file.hash}`),
      );
    } catch (error) {
      failures.push(`${chunk.label}: ${(error as Error).message}`);
    }
    done += 1;
    progress(`analyzed ${done}/${chunks.length} parts`);
  });

  // Never write a partial map. Running again resumes from the cached answers.
  if (failures.length > 0) {
    throw new Error(
      `${failures.length} of ${chunks.length} parts failed, so the map was not written. ` +
        `Run again to resume.\n${failures.slice(0, 5).join("\n")}`,
    );
  }

  // A problem with the graph should cost its sections, not the whole map.
  progress("building code graph");
  let graph: GraphSections | undefined;
  try {
    const store = await openGraphStore(root);
    try {
      await refreshGraph(root, store);
      graph = graphSections(store.snapshot());
    } finally {
      store.close();
    }
  } catch (error) {
    warnings.push(`The code graph could not be built: ${(error as Error).message}`);
  }
  const factsBlock = graph ? `<graph_facts>\n${graph.facts}\n</graph_facts>\n\n` : "";

  // 2. Condense until the reports fit in one request, next to the graph facts.
  const reportBudget = Math.max(budget - estimateTokens(factsBlock), Math.floor(budget / 2));
  let material = chunks.map((chunk, index) => ({ label: chunk.label, text: reports[index] ?? "" }));
  const size = (items: typeof material) =>
    items.reduce((total, item) => total + estimateTokens(item.text), 0);

  for (let round = 1; size(material) > reportBudget; round += 1) {
    if (round > MAX_CONDENSE_ROUNDS) {
      warnings.push("Reports could not be condensed enough; the system overview saw only part of them.");
      break;
    }
    progress(`condensing reports (round ${round})`);
    const batches: (typeof material)[] = [];
    for (const item of material) {
      const last = batches[batches.length - 1];
      if (last && size(last) + estimateTokens(item.text) <= budget) last.push(item);
      else batches.push([item]);
    }
    const before = size(material);
    const condensed: typeof material = new Array(batches.length);
    await runPool(
      batches.map((batch, index) => ({ batch, index })),
      config.concurrency,
      async ({ batch, index }) => {
        const user = reportsUser(batch);
        condensed[index] = {
          label: batch.map((item) => item.label).join(", "),
          text: await ask(condenseSystem(config.language), user, [user]),
        };
      },
    );
    material = condensed;
    if (size(material) >= before) {
      warnings.push("Condensing did not reduce the reports; the system overview saw only part of them.");
      break;
    }
  }

  // 3. System-level sections.
  progress("writing system overview");
  let synthesisInput = factsBlock + reportsUser(material);
  if (estimateTokens(synthesisInput) > budget) synthesisInput = synthesisInput.slice(0, budget * 3);
  const synthesis = await ask(synthesisSystem(config.language), synthesisInput, [synthesisInput]);
  const { summary, rest } = extractSummary(synthesis);
  const sections = parseSections(rest);
  for (const name of SYNTHESIS_SECTIONS) {
    if (!sections.has(name)) warnings.push(`The model did not return the "${name}" section.`);
  }

  // 4. Render, check and write.
  const map = renderMap({
    frontmatter: {
      lastMapped: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      totalFiles: scan.files.length,
      totalTokens: scan.totalTokens,
      sourceCommit: await currentCommit(root),
      fingerprint,
    },
    scan,
    chunks,
    reports,
    sections,
    truncated: truncatedFiles,
    ...(graph ? { graphMarkdown: graph.markdown } : {}),
  });

  const known = new Set([
    ...scan.files.map((file) => file.path),
    ...scan.skipped.map((file) => file.path),
  ]);
  const unknown = findUnknownPaths(map, known);
  if (unknown.length > 0) {
    warnings.push(
      `The model cited paths that do not exist (${unknown.length}): ${unknown.slice(0, 15).join(", ")}`,
    );
  }

  await writeAtomic(mapPath, map);

  // opencode reads AGENTS.md first and only falls back to CLAUDE.md when AGENTS.md is missing, so
  // creating AGENTS.md in a CLAUDE.md project would silently hide that project's instructions.
  let instructionsPath: string | undefined;
  if (summary) {
    const agents = join(root, "AGENTS.md");
    const claude = join(root, "CLAUDE.md");
    const agentsContent = await readOptional(agents);
    const claudeContent = agentsContent === undefined ? await readOptional(claude) : undefined;
    instructionsPath = claudeContent !== undefined ? claude : agents;
    await writeAtomic(
      instructionsPath,
      mergeInstructions(agentsContent ?? claudeContent, renderInstructionsSection(summary, graph !== undefined)),
    );
  } else {
    warnings.push("The model did not return a summary, so the instructions file was left unchanged.");
  }

  // 5. Only now is it safe to forget answers from earlier versions of the code.
  for (const entry of await readdir(cacheDir)) {
    if (!usedKeys.has(entry.replace(/\.md$/, ""))) await rm(join(cacheDir, entry), { force: true });
  }

  return {
    ...base,
    status: "mapped",
    instructionsPath,
    modelCalls,
    reusedAnswers,
    redactions,
    truncatedFiles,
    warnings,
  };
}
