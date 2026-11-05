import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import type { Chat } from "../src/llm.js";
import { mapCodebase } from "../src/pipeline.js";
import type { ScannedFile } from "../src/scan.js";
import {
  buildTree,
  directoryBatches,
  listDirectories,
  parseDirectoryPurposes,
  parseFilePurposes,
  renderTree,
} from "../src/tree.js";

const file = (path: string, tokens = 10): ScannedFile => ({ path, tokens, bytes: tokens * 3, hash: path });

const FILES = [
  file("README.md"),
  file("svc/pom.xml"),
  file("svc/src/main/java/com/acme/App.java"),
  file("svc/src/main/java/com/acme/api/Controller.java"),
  file("web/index.html"),
];

test("buildTree collapses chains that contain nothing else", () => {
  const keys = listDirectories(buildTree(FILES)).map((directory) => directory.key);
  assert.deepEqual(keys, ["./", "svc/", "svc/src/main/java/com/acme/", "svc/src/main/java/com/acme/api/", "web/"]);
});

test("renderTree draws a tree with an aligned purpose on every item", () => {
  const purposes = new Map([
    ["./", "The whole system"],
    ["README.md", "How to run it"],
    ["svc/", "Backend service"],
    ["svc/pom.xml", "Build"],
    ["svc/src/main/java/com/acme/", "Application code"],
    ["svc/src/main/java/com/acme/App.java", "Entry point"],
    ["svc/src/main/java/com/acme/api/", "HTTP layer"],
    ["svc/src/main/java/com/acme/api/Controller.java", "Routes"],
    ["web/", "Frontend"],
    ["web/index.html", "Single page"],
  ]);
  const rendered = renderTree(buildTree(FILES), "shop", purposes);
  const expected = [
    "```text",
    "shop/                            # The whole system",
    "├── svc/                         # Backend service",
    "│   ├── src/main/java/com/acme/  # Application code",
    "│   │   ├── api/                 # HTTP layer",
    "│   │   │   └── Controller.java  # Routes",
    "│   │   └── App.java             # Entry point",
    "│   └── pom.xml                  # Build",
    "├── web/                         # Frontend",
    "│   └── index.html               # Single page",
    "└── README.md                    # How to run it",
    "```",
  ].join("\n");
  assert.equal(rendered.text, expected);
  assert.equal(rendered.itemsWithoutPurpose, 0);
  assert.equal(rendered.items, 10);
});

test("renderTree counts what is missing and keeps a very long line readable", () => {
  const deep = `svc/${"very-long-directory-name/".repeat(4)}File.java`;
  const rendered = renderTree(buildTree([file(deep)]), "p", new Map([[deep, "Deep file"]]));
  assert.equal(rendered.itemsWithoutPurpose, 2);
  assert.match(rendered.text, /File\.java +# Deep file/);
  const long = renderTree(buildTree([file("a.ts")]), "p", new Map([["./", "x"]]));
  assert.ok(long.text.includes("└── a.ts\n"), "an item with no purpose has no trailing comment");
});

test("renderTree falls back to directories on a very large project", () => {
  const rendered = renderTree(buildTree(FILES), "shop", new Map(), 2);
  assert.ok(!rendered.text.includes("pom.xml"));
  assert.ok(rendered.text.includes("svc/"));
  assert.ok(rendered.text.includes("directories only"));
  assert.equal(rendered.items, 5);
});

test("parseFilePurposes reads the table whatever the model does to the paths", () => {
  const files = [file("svc/src/A.java"), file("svc/src/B.java"), file("svc/src/C.java"), file("svc/lib/C.java"), file("pom.xml")];
  const report = [
    "#### Files",
    "| File | Purpose |",
    "|---|---|",
    "| `svc/src/A.java` | Does `a` \\| and more |",
    "| ./pom.xml | Build **definition** |",
    "| `src/B.java` | Shortened path |",
    "| `C.java` | Ambiguous: two files match, so it must not guess |",
    "| `ghost.java` | Does not exist |",
    "",
    "#### Key APIs",
    "- not | a | row",
  ].join("\n");
  assert.deepEqual(
    Object.fromEntries(parseFilePurposes(report, files)),
    {
      "svc/src/A.java": "Does a | and more",
      "pom.xml": "Build definition",
      "svc/src/B.java": "Shortened path",
    },
  );
});

test("parseFilePurposes gives one purpose to files grouped in a row, and shortens long text", () => {
  const purposes = parseFilePurposes(
    `| \`a.ts\`, \`b.ts\` | Shared helpers |\n| \`c.ts\` | ${"x".repeat(300)} |`,
    [file("a.ts"), file("b.ts"), file("c.ts")],
  );
  assert.equal(purposes.get("a.ts"), "Shared helpers");
  assert.equal(purposes.get("b.ts"), "Shared helpers");
  assert.equal(purposes.get("c.ts")?.length, 140);
});

test("parseDirectoryPurposes accepts the styles models tend to use", () => {
  const directories = listDirectories(buildTree(FILES));
  const answer = [
    "Here are the purposes:",
    "./: The whole system",
    "svc/: Backend",
    "- `web/`: Frontend",
    "* **svc/src/main/java/com/acme/**: Application code",
    "svc/src/main/java/com/acme/api: HTTP layer",
    "invented/: Not a directory",
  ].join("\n");
  assert.deepEqual(Object.fromEntries(parseDirectoryPurposes(answer, directories)), {
    "./": "The whole system",
    "svc/": "Backend",
    "web/": "Frontend",
    "svc/src/main/java/com/acme/": "Application code",
    "svc/src/main/java/com/acme/api/": "HTTP layer",
  });
});

test("a directory holding only subdirectories still gets something to go on", () => {
  const tree = buildTree([file("a/x.ts"), file("a/y.ts"), file("b/z.ts")]);
  const [batch] = directoryBatches(tree, new Map([["a/x.ts", "Parses input"]]), 10_000);
  assert.ok(batch?.user.includes('<directory path="./">\n- subdirectory a/\n  - x.ts: Parses input'), batch?.user);
});

test("the sample of a subdirectory skips boilerplate and spreads across its files", () => {
  const files = [
    file("svc/.gitignore"),
    file("svc/pom.xml"),
    ...Array.from({ length: 20 }, (_, index) => file(`svc/src/F${String(index).padStart(2, "0")}.java`)),
  ];
  const [batch] = directoryBatches(buildTree([...files, file("other/x.ts")]), new Map(), 10_000);
  const rootBlock = batch?.user.slice(0, batch.user.indexOf("</directory>")) ?? "";
  assert.ok(!rootBlock.includes(".gitignore"), rootBlock);
  assert.ok(!rootBlock.includes("pom.xml"), rootBlock);
  assert.ok(rootBlock.includes("F00.java"), rootBlock);
  assert.ok(rootBlock.includes("F19.java"), rootBlock);

  const onlyBoilerplate = directoryBatches(buildTree([file("a/pom.xml"), file("b/x.ts")]), new Map(), 10_000);
  assert.ok(onlyBoilerplate[0]?.user.includes("pom.xml"), "better boilerplate than nothing");
});

test("directory batches respect the budget without losing a directory", () => {
  const files = Array.from({ length: 30 }, (_, index) => file(`dir${index}/f.ts`));
  const tree = buildTree(files);
  const batches = directoryBatches(tree, new Map(), 200);
  assert.ok(batches.length > 1);
  assert.equal(batches.flatMap((batch) => batch.directories).length, listDirectories(tree).length);
  for (const batch of batches) assert.equal(batch.user.match(/<directory /g)?.length, batch.directories.length);
});

test("the map's tree has a purpose per item, reusing answers when only one file changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-mapper-tree-"));
  try {
    const module = (name: string) => `export const ${name} = 1;\n`.padEnd(3000, "/");
    for (const [path, content] of [["a/a.ts", module("a")], ["b/b.ts", module("b")]] as const) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    const seen: string[] = [];
    const chat: Chat = async (request) => {
      seen.push(request.system);
      if (request.system.includes("system-level sections")) return { text: "<agents_summary>S</agents_summary>", truncated: false };
      if (request.system.includes("what each directory")) {
        const keys = [...request.user.matchAll(/<directory path="([^"]+)">/g)].map((found) => found[1]);
        return { text: keys.map((key) => `${key}: Purpose of ${key}`).join("\n"), truncated: false };
      }
      const paths = [...request.user.matchAll(/<file path="([^"]+)">/g)].map((found) => found[1]);
      const hash = request.user.includes("changed") ? "new" : "old";
      return { text: `| File | Purpose |\n|---|---|\n${paths.map((path) => `| \`${path}\` | ${hash} purpose of ${path} |`).join("\n")}`, truncated: false };
    };
    const config = { ...loadConfig({}), model: "fake", contextTokens: 3400, maxOutputTokens: 1000 };

    const result = await mapCodebase(root, config, { chat });
    assert.deepEqual(result.warnings.filter((warning) => warning.includes("directory tree")), []);
    const map = await readFile(join(root, "docs/CODEBASE_MAP.md"), "utf8");
    const section = map.slice(map.indexOf("## Directory Structure"), map.indexOf("## Module Guide"));
    assert.ok(section.includes(`${basename(root)}/`));
    assert.match(section, /├── a\/ +# Purpose of a\//);
    assert.match(section, /│ {3}└── a\.ts +# old purpose of a\/a\.ts/);
    assert.match(section, /└── b\/ +# Purpose of b\//);

    seen.length = 0;
    await writeFile(join(root, "b/b.ts"), module("changed"));
    const update = await mapCodebase(root, config, { chat });
    assert.equal(update.status, "mapped");
    const updated = await readFile(join(root, "docs/CODEBASE_MAP.md"), "utf8");
    assert.match(updated, /└── b\.ts +# new purpose of b\/b\.ts/);
    assert.match(updated, /└── a\.ts +# old purpose of a\/a\.ts/);
    assert.equal(seen.filter((system) => system.includes("mapping one part")).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing purposes produce a warning, not a failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-mapper-tree-"));
  try {
    await writeFile(join(root, "a.ts"), "export {};");
    const chat: Chat = async () => ({ text: "no table here", truncated: false });
    const result = await mapCodebase(root, { ...loadConfig({}), model: "fake" }, { chat });
    assert.equal(result.status, "mapped");
    assert.ok(result.warnings.some((warning) => warning.includes("no purpose for 2 of 2 items")), result.warnings.join("\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
