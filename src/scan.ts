import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import ignore, { type Ignore } from "ignore";
import { estimateTokens } from "./config.js";

const exec = promisify(execFile);
const MAX_FILE_BYTES = 1_000_000;

export const MAP_PATH = "docs/CODEBASE_MAP.md";
export const WORK_DIR = ".project-mapper";

/**
 * Noise that adds cost without explaining the code. Also excludes this tool's own output: mapping
 * it would change the source fingerprint on every run and the map would never be up to date.
 */
const DEFAULT_IGNORE = [
  ".git/", ".svn/", ".hg/", "node_modules/", "__pycache__/", ".pytest_cache/", ".mypy_cache/",
  ".ruff_cache/", "venv/", ".venv/", "env/", "dist/", "build/", ".next/", ".nuxt/", ".output/",
  "coverage/", ".coverage", ".nyc_output/", "target/", "vendor/", ".bundle/", ".cargo/", ".gradle/",
  ".idea/", ".vscode/", ".DS_Store", "Thumbs.db",
  "*.pyc", "*.pyo", "*.so", "*.dylib", "*.dll", "*.exe", "*.o", "*.a", "*.lib", "*.class", "*.jar",
  "*.war", "*.egg", "*.whl", "*.lock", "package-lock.json", "pnpm-lock.yaml", "bun.lockb",
  "*.png", "*.jpg", "*.jpeg", "*.gif", "*.ico", "*.svg", "*.webp", "*.mp3", "*.mp4", "*.wav", "*.avi",
  "*.mov", "*.pdf", "*.zip", "*.tar", "*.gz", "*.rar", "*.7z", "*.woff", "*.woff2", "*.ttf", "*.eot",
  "*.otf", "*.min.js", "*.min.css", "*.map", "*.chunk.js", "*.bundle.js",
  // Generated build wrappers, identical across projects.
  "mvnw", "mvnw.cmd", ".mvn/", "gradlew", "gradlew.bat", "gradle/wrapper/",
  // Agent tooling. These configs can hold the model server's API key.
  ".opencode/", "opencode.json", "opencode.jsonc", ".mcp.json", ".claude/",
  `/${MAP_PATH}`, "/AGENTS.md", "/CLAUDE.md", `/${WORK_DIR}/`,
];

/** Files that are never read, so their contents cannot reach the model or the map. */
const SENSITIVE = [
  ".env", ".env.*", "!.env.example", "!.env.sample", "!.env.template",
  "*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "*.keystore", "*.truststore", "*.ppk", "*.tfstate",
  "*.tfstate.*", "*.tfvars", "id_rsa*", "id_dsa*", "id_ecdsa*", "id_ed25519*", ".npmrc", ".pypirc",
  ".netrc", ".git-credentials", "credentials", "credentials.*", "secrets.*", "kubeconfig",
];

export interface ScannedFile {
  path: string;
  bytes: number;
  tokens: number;
  hash: string;
}

export interface SkippedFile {
  path: string;
  reason: "sensitive" | "too_large" | "binary" | "unreadable";
}

export interface ScanResult {
  files: ScannedFile[];
  skipped: SkippedFile[];
  totalTokens: number;
}

/**
 * The noise patterns are directory names, and they match at any depth. Inside a JVM source root those
 * same names are ordinary packages, such as com.acme.vendor, and must not make code disappear.
 */
const JVM_SOURCE_ROOT = /(^|\/)src\/(main|test)\/(java|kotlin|scala|groovy)\//;

function isIgnored(rules: Ignore, path: string): boolean {
  if (!JVM_SOURCE_ROOT.test(path)) return rules.ignores(path);
  return path.endsWith("/") ? false : rules.ignores(path.slice(path.lastIndexOf("/") + 1));
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

async function listWithGit(root: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await exec(
      "git",
      ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { maxBuffer: 256 * 1024 * 1024 },
    );
    return stdout.split("\0").filter(Boolean);
  } catch {
    return undefined;
  }
}

async function listWithWalk(root: string, rules: Ignore): Promise<string[]> {
  const results: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = toPosix(relative(root, join(directory, entry.name)));
      if (entry.isDirectory()) {
        if (!isIgnored(rules, `${path}/`)) await walk(join(directory, entry.name));
      } else if (entry.isFile()) {
        results.push(path);
      }
    }
  }
  await walk(root);
  return results;
}

async function readGitignore(root: string): Promise<string> {
  try {
    return await readFile(join(root, ".gitignore"), "utf8");
  } catch {
    return "";
  }
}

export async function scanCodebase(root: string): Promise<ScanResult> {
  const rules = ignore().add(DEFAULT_IGNORE);
  const sensitive = ignore().add(SENSITIVE);

  let paths = await listWithGit(root);
  if (paths === undefined) {
    rules.add(await readGitignore(root));
    paths = await listWithWalk(root, rules);
  }

  const files: ScannedFile[] = [];
  const skipped: SkippedFile[] = [];

  for (const path of [...new Set(paths)].sort()) {
    if (isIgnored(rules, path)) continue;
    if (sensitive.ignores(path)) {
      skipped.push({ path, reason: "sensitive" });
      continue;
    }
    const absolute = join(root, path);
    try {
      const info = await stat(absolute);
      if (!info.isFile()) continue;
      if (info.size > MAX_FILE_BYTES) {
        skipped.push({ path, reason: "too_large" });
        continue;
      }
      const buffer = await readFile(absolute);
      if (buffer.subarray(0, 8192).includes(0)) {
        skipped.push({ path, reason: "binary" });
        continue;
      }
      files.push({
        path,
        bytes: info.size,
        tokens: estimateTokens(buffer.toString("utf8")),
        hash: createHash("sha256").update(buffer).digest("hex"),
      });
    } catch (error) {
      // Tracked by git but deleted from the working tree: not part of the code being mapped.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      skipped.push({ path, reason: "unreadable" });
    }
  }

  return { files, skipped, totalTokens: files.reduce((sum, file) => sum + file.tokens, 0) };
}
