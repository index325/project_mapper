import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scanCodebase, WORK_DIR } from "../scan.js";
import { extractJava, JAVA_EXTRACTOR_VERSION, type JavaFacts } from "./java-extract.js";
import { resolveJava } from "./java-resolve.js";
import { SqliteGraphStore } from "./sqlite-store.js";
import type { CachedFacts, GraphStore } from "./types.js";

export const GRAPH_FILE = "graph.sqlite";

const BUILD_FILE = /(^|\/)(pom\.xml|build\.gradle(\.kts)?)$/;

export interface GraphBuild {
  rebuilt: boolean;
  sourceFiles: number;
  parsedFiles: number;
  filesWithSyntaxErrors: string[];
}

/** Keep it open as briefly as possible. Close it when done. */
export async function openGraphStore(root: string): Promise<GraphStore> {
  const workDir = join(root, WORK_DIR);
  await mkdir(workDir, { recursive: true });
  await writeFile(join(workDir, ".gitignore"), "*\n");
  return new SqliteGraphStore(join(workDir, GRAPH_FILE));
}

/**
 * Parsing is per file and cached by content hash, so only changed files are read again. Resolution
 * is always redone in full, because a change in one file can alter what another file's names mean.
 */
export async function refreshGraph(
  root: string,
  store: GraphStore,
  options: { force?: boolean } = {},
): Promise<GraphBuild> {
  const scan = await scanCodebase(root);
  const javaFiles = scan.files.filter((file) => file.path.endsWith(".java"));

  // Build files are small text files that survive the scanner's filters. They decide module
  // boundaries, so a new pom.xml has to change the fingerprint too.
  const buildFiles = scan.files.filter((file) => BUILD_FILE.test(file.path));
  const moduleDirs = new Set(
    buildFiles.map((file) => (file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ".")),
  );

  const fingerprint = createHash("sha256")
    .update(String(JAVA_EXTRACTOR_VERSION))
    .update([...javaFiles.map((file) => `${file.path}:${file.hash}`), ...[...moduleDirs].sort()].join("\n"))
    .digest("hex");

  const previous = new Map(store.loadFacts().map((entry) => [entry.path, entry]));
  if (!options.force && store.fingerprint() === fingerprint) {
    const filesWithSyntaxErrors = [...previous.values()]
      .filter((entry) => (JSON.parse(entry.facts) as JavaFacts).hasParseErrors)
      .map((entry) => entry.path);
    return { rebuilt: false, sourceFiles: javaFiles.length, parsedFiles: 0, filesWithSyntaxErrors };
  }

  let parsedFiles = 0;
  const entries: CachedFacts[] = [];
  const sources: { path: string; facts: JavaFacts }[] = [];
  const filesWithSyntaxErrors: string[] = [];

  for (const file of javaFiles) {
    const cached = previous.get(file.path);
    let facts: JavaFacts;
    if (!options.force && cached?.hash === file.hash && cached.extractorVersion === JAVA_EXTRACTOR_VERSION) {
      facts = JSON.parse(cached.facts) as JavaFacts;
    } else {
      facts = await extractJava(await readFile(join(root, file.path), "utf8"));
      parsedFiles += 1;
    }
    if (facts.hasParseErrors) filesWithSyntaxErrors.push(file.path);
    sources.push({ path: file.path, facts });
    entries.push({
      path: file.path,
      hash: file.hash,
      extractorVersion: JAVA_EXTRACTOR_VERSION,
      facts: JSON.stringify(facts),
    });
  }

  store.replace(resolveJava(sources, moduleDirs), entries, fingerprint);
  return { rebuilt: true, sourceFiles: javaFiles.length, parsedFiles, filesWithSyntaxErrors };
}
