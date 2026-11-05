import { estimateTokens } from "./config.js";
import type { ScannedFile } from "./scan.js";

/** Past this, one line per file would bury the map, so the tree shows directories only. */
const MAX_TREE_FILES = 1000;
const MAX_LINES_PER_DIRECTORY = 40;
const SAMPLES_PER_SUBDIRECTORY = 5;
const BOILERPLATE = /(^|\/)(\.[^/]*|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|package\.json|tsconfig\.json|LICENSE[^/]*|Dockerfile)$/;
const MAX_PURPOSE_LENGTH = 140;
/** Comments line up at this column at most, so one deep path does not push every comment away. */
const MAX_COMMENT_COLUMN = 60;

export const ROOT_KEY = "./";

export interface TreeDirectory {
  /** Full path with a trailing slash, or "./" for the root. */
  key: string;
  /** What the tree shows: "src/main/java/com/acme/" when a chain has nothing else in it. */
  label: string;
  files: ScannedFile[];
  directories: TreeDirectory[];
}

interface RawNode {
  files: ScannedFile[];
  children: Map<string, RawNode>;
}

function byName(a: string, b: string): number {
  return a.localeCompare(b);
}

export function buildTree(files: ScannedFile[]): TreeDirectory {
  const root: RawNode = { files: [], children: new Map() };
  for (const file of files) {
    const parts = file.path.split("/");
    parts.pop();
    let node = root;
    for (const part of parts) {
      let child = node.children.get(part);
      if (!child) {
        child = { files: [], children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    node.files.push(file);
  }

  function convert(node: RawNode, label: string, path: string): TreeDirectory {
    return {
      key: path ? `${path}/` : ROOT_KEY,
      label,
      files: [...node.files].sort((a, b) => byName(a.path, b.path)),
      directories: [...node.children.entries()]
        .sort(([a], [b]) => byName(a, b))
        .map(([name, child]) => {
          // Java trees are mostly chains: com/acme/app is one item, not three to explain.
          let current = child;
          let chain = name;
          while (current.files.length === 0 && current.children.size === 1) {
            const [nextName, next] = [...current.children.entries()][0] as [string, RawNode];
            chain += `/${nextName}`;
            current = next;
          }
          return convert(current, `${chain}/`, path ? `${path}/${chain}` : chain);
        }),
    };
  }
  return convert(root, "", "");
}

export function listDirectories(tree: TreeDirectory): TreeDirectory[] {
  return [tree, ...tree.directories.flatMap(listDirectories)];
}

function cleanPurpose(text: string): string {
  const clean = text
    .replace(/\\\|/g, "|")
    .replace(/`+/g, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > MAX_PURPOSE_LENGTH ? `${clean.slice(0, MAX_PURPOSE_LENGTH - 1).trimEnd()}…` : clean;
}

/** Reads the report's Files table. A model may shorten a path or put several files in one row. */
export function parseFilePurposes(report: string, files: ScannedFile[]): Map<string, string> {
  const purposes = new Map<string, string>();
  const paths = files.map((file) => file.path);

  const match = (written: string): string | undefined => {
    const path = written.replace(/^\.\//, "");
    if (paths.includes(path)) return path;
    const candidates = paths.filter((candidate) => candidate.endsWith(`/${path}`));
    return candidates.length === 1 ? candidates[0] : undefined;
  };

  for (const line of report.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const cells = line.split(/(?<!\\)\|/).map((cell) => cell.trim());
    const fileCell = cells[1];
    const purposeCell = cells[2];
    if (!fileCell || !purposeCell || /^:?-+:?$/.test(purposeCell)) continue;
    const quoted = [...fileCell.matchAll(/`([^`]+)`/g)].map((found) => found[1] ?? "");
    for (const written of quoted.length ? quoted : [fileCell]) {
      const path = match(written);
      if (path && !purposes.has(path)) purposes.set(path, cleanPurpose(purposeCell));
    }
  }
  return purposes;
}

/** Reads "path/: purpose" lines, accepting the list and quoting styles models tend to add. */
export function parseDirectoryPurposes(text: string, directories: TreeDirectory[]): Map<string, string> {
  const known = new Set(directories.map((directory) => directory.key));
  const purposes = new Map<string, string>();
  for (const line of text.split("\n")) {
    const found = /^\s*(?:[-*]\s+)?(?:\*\*)?`?([^`\s:*]+?)`?(?:\*\*)?\s*:(?:\*\*)?\s+(.+?)\s*$/.exec(line);
    if (!found?.[1] || !found[2]) continue;
    const written = found[1].replace(/^\.\/(?=.)/, "").replace(/\/+$/, "");
    const key = written === "" || written === "." ? ROOT_KEY : `${written}/`;
    if (known.has(key) && !purposes.has(key)) purposes.set(key, cleanPurpose(found[2]));
  }
  return purposes;
}

function allFiles(directory: TreeDirectory): ScannedFile[] {
  return [...directory.files, ...directory.directories.flatMap(allFiles)];
}

/**
 * Spread across the directory and without boilerplate: the first few files of a service are its
 * .gitignore and pom.xml, which say nothing about what the service does.
 */
function sampleFiles(files: ScannedFile[]): ScannedFile[] {
  const informative = files.filter((file) => !BOILERPLATE.test(file.path));
  const pool = informative.length > 0 ? informative : files;
  if (pool.length <= SAMPLES_PER_SUBDIRECTORY) return pool;
  const step = (pool.length - 1) / (SAMPLES_PER_SUBDIRECTORY - 1);
  return Array.from({ length: SAMPLES_PER_SUBDIRECTORY }, (_, index) => pool[Math.round(index * step)] as ScannedFile);
}

/**
 * What a directory is for shows in its files. A directory holding only subdirectories, such as a
 * repository's root, would have nothing to go on, so a sample of what each one contains comes along.
 */
function directoryBlock(directory: TreeDirectory, filePurposes: Map<string, string>): string {
  const describe = (file: ScannedFile, name: string) => {
    const purpose = filePurposes.get(file.path);
    return purpose ? `${name}: ${purpose}` : name;
  };
  const lines = [
    ...directory.files.map((file) => `- ${describe(file, file.path.split("/").pop() ?? file.path)}`),
    ...directory.directories.flatMap((child) => {
      const samples = sampleFiles(allFiles(child)).map(
        (file) => `  - ${describe(file, file.path.slice(child.key.length))}`,
      );
      return [`- subdirectory ${child.label}`, ...samples];
    }),
  ];
  const hidden = lines.length - MAX_LINES_PER_DIRECTORY;
  const shown = lines.slice(0, MAX_LINES_PER_DIRECTORY).join("\n");
  return `<directory path="${directory.key}">\n${shown}${hidden > 0 ? `\n- ...and ${hidden} more lines` : ""}\n</directory>`;
}

export interface DirectoryBatch {
  directories: TreeDirectory[];
  user: string;
}

export function directoryBatches(
  tree: TreeDirectory,
  filePurposes: Map<string, string>,
  budget: number,
): DirectoryBatch[] {
  const batches: DirectoryBatch[] = [];
  for (const directory of listDirectories(tree)) {
    const block = directoryBlock(directory, filePurposes);
    const last = batches[batches.length - 1];
    if (last && estimateTokens(last.user) + estimateTokens(block) <= budget) {
      last.directories.push(directory);
      last.user += `\n\n${block}`;
    } else {
      batches.push({ directories: [directory], user: block });
    }
  }
  return batches;
}

export interface RenderedTree {
  text: string;
  itemsWithoutPurpose: number;
  items: number;
}

/** Purposes are keyed by file path or directory key. */
export function renderTree(
  tree: TreeDirectory,
  rootName: string,
  purposes: Map<string, string>,
  maxFiles: number = MAX_TREE_FILES,
): RenderedTree {
  const includeFiles = allFiles(tree).length <= maxFiles;
  const rows: { text: string; key: string }[] = [{ text: `${rootName}/`, key: ROOT_KEY }];

  function visit(directory: TreeDirectory, prefix: string): void {
    const children = [
      ...directory.directories.map((child) => ({ label: child.label, key: child.key, child })),
      ...(includeFiles
        ? directory.files.map((file) => ({
            label: file.path.split("/").pop() ?? file.path,
            key: file.path,
            child: undefined,
          }))
        : []),
    ];
    children.forEach((entry, index) => {
      const isLast = index === children.length - 1;
      rows.push({ text: `${prefix}${isLast ? "└── " : "├── "}${entry.label}`, key: entry.key });
      if (entry.child) visit(entry.child, `${prefix}${isLast ? "    " : "│   "}`);
    });
  }
  visit(tree, "");

  const column = Math.min(Math.max(...rows.map((row) => row.text.length)), MAX_COMMENT_COLUMN) + 2;
  const lines = rows.map((row) => {
    const purpose = purposes.get(row.key);
    if (!purpose) return row.text;
    return `${row.text.padEnd(column)}${row.text.length >= column ? "  " : ""}# ${purpose}`;
  });

  const note = includeFiles
    ? ""
    : `\n\nThis project has more than ${maxFiles} mapped files, so the tree shows directories only. The files are described in the Module Guide.`;
  return {
    text: `\`\`\`text\n${lines.join("\n")}\n\`\`\`${note}`,
    itemsWithoutPurpose: rows.filter((row) => !purposes.has(row.key)).length,
    items: rows.length,
  };
}
