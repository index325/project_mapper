import type { ScannedFile } from "./scan.js";

export interface Chunk {
  label: string;
  files: ScannedFile[];
  tokens: number;
}

interface TreeNode {
  files: ScannedFile[];
  children: Map<string, TreeNode>;
}

function buildTree(files: ScannedFile[]): TreeNode {
  const root: TreeNode = { files: [], children: new Map() };
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
  return root;
}

function commonDirectory(files: ScannedFile[]): string {
  const split = files.map((file) => file.path.split("/").slice(0, -1));
  const first = split[0] ?? [];
  let length = first.length;
  for (const parts of split) {
    let shared = 0;
    while (shared < length && parts[shared] === first[shared]) shared += 1;
    length = shared;
  }
  return first.slice(0, length).join("/") || ".";
}

/** Names the directories a group spans, so a merged group never reads as just ".". */
function describeGroup(files: ScannedFile[]): string {
  const common = commonDirectory(files);
  const depth = common === "." ? 0 : common.split("/").length;
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/");
    const child = parts[depth];
    if (child !== undefined && parts.length > depth + 1) directories.add(child);
  }
  if (directories.size < 2) return common;
  const names = [...directories].sort();
  const shown = names.slice(0, 4).join(", ") + (names.length > 4 ? ` +${names.length - 4} more` : "");
  return common === "." ? shown : `${common}/{${shown}}`;
}

/**
 * Keeps each directory together whenever it fits, so a change in one module only invalidates that
 * module's analysis. Directories over budget are split, and neighbouring pieces merged back while
 * they fit. A file larger than the budget counts as exactly one budget: it gets truncated later.
 */
export function planChunks(files: ScannedFile[], budget: number): Chunk[] {
  const cost = (file: ScannedFile) => Math.min(file.tokens, budget);
  const sum = (group: ScannedFile[]) => group.reduce((total, file) => total + cost(file), 0);

  function allFiles(node: TreeNode): ScannedFile[] {
    return [...node.files, ...[...node.children.values()].flatMap(allFiles)];
  }

  function visit(node: TreeNode): ScannedFile[][] {
    const everything = allFiles(node);
    if (sum(everything) <= budget) return everything.length ? [everything] : [];

    const pieces: ScannedFile[][] = [
      ...node.files.map((file) => [file]),
      ...[...node.children.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .flatMap(([, child]) => visit(child)),
    ];

    const merged: ScannedFile[][] = [];
    for (const piece of pieces) {
      const last = merged[merged.length - 1];
      if (last && sum(last) + sum(piece) <= budget) last.push(...piece);
      else merged.push([...piece]);
    }
    return merged;
  }

  const groups = visit(buildTree(files));
  const totals = new Map<string, number>();
  for (const group of groups) {
    const name = describeGroup(group);
    totals.set(name, (totals.get(name) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  return groups.map((group) => {
    const name = describeGroup(group);
    const total = totals.get(name) ?? 1;
    const index = (seen.get(name) ?? 0) + 1;
    seen.set(name, index);
    return {
      label: total > 1 ? `${name} (part ${index}/${total})` : name,
      files: group,
      tokens: sum(group),
    };
  });
}
