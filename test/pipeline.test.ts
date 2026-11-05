import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { loadConfig } from "../src/config.js";
import { JobRunner } from "../src/jobs.js";
import type { ChatRequest, Chat } from "../src/llm.js";
import { mapCodebase } from "../src/pipeline.js";
import { scanCodebase } from "../src/scan.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "project-mapper-test-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const SYNTHESIS = `<agents_summary>
A test system.

**Stack**: TypeScript
**Structure**: src
</agents_summary>

## System Overview
Overview text.

\`\`\`mermaid
graph TB
  A --> B
\`\`\`

## Data Flow
Flow text.

## Conventions
Conventions text.

## Gotchas
Gotchas text.

## Navigation Guide
**To change a**: \`src/a.ts\``;

function fakeModel(fail?: (request: ChatRequest) => boolean) {
  const calls: ChatRequest[] = [];
  const chat: Chat = async (request) => {
    calls.push(request);
    if (fail?.(request)) throw new Error("model down");
    if (request.system.includes("system-level sections")) return { text: SYNTHESIS, truncated: false };
    if (request.system.includes("merge reports")) return { text: "condensed", truncated: false };
    const names = [...request.user.matchAll(/<file path="([^"]+)">/g)].map((match) => match[1]);
    return { text: `#### Files\n${names.map((name) => `\`${name}\``).join("\n")}`, truncated: false };
  };
  const analyses = () => calls.filter((call) => call.user.includes("<file path="));
  return { chat, calls, analyses };
}

/** A budget small enough that each 3,000-character module becomes its own part. */
const config = {
  ...loadConfig({}),
  model: "fake",
  contextTokens: 3400,
  maxOutputTokens: 1000,
};
const module = (name: string) => `export const ${name} = 1;\n`.padEnd(3000, "/");

test("writes the map, the instructions, and sends no secret to the model", async () => {
  const root = await project({
    "src/a.ts": "export const a = 1;\n",
    "config/application.yml": "datasource:\n  password: hunter2\n  user: app\n",
    ".env": "API_KEY=from-dotenv\n",
    ".env.example": "API_KEY=\n",
    "certs/server.pem": "pem-content\n",
    "logo.png": "not really an image",
    "data.bin": Buffer.from([1, 0, 2]).toString("latin1"),
  });
  const model = fakeModel();
  const result = await mapCodebase(root, config, { chat: model.chat });

  assert.equal(result.status, "mapped");
  assert.equal(result.redactions, 1);
  assert.deepEqual(result.skipped, { sensitive: 2, binary: 1 });

  const sent = model.calls.map((call) => call.user).join("\n");
  for (const secret of ["hunter2", "from-dotenv", "pem-content"]) assert.ok(!sent.includes(secret), secret);
  assert.ok(!sent.includes("logo.png"));
  assert.ok(sent.includes("application.yml"));

  const map = await readFile(join(root, "docs/CODEBASE_MAP.md"), "utf8");
  for (const heading of ["System Overview", "Directory Structure", "Module Guide", "Data Flow", "Conventions", "Gotchas", "Navigation Guide", "Mapping Coverage"]) {
    assert.ok(map.includes(`\n## ${heading}\n`), heading);
  }
  assert.ok(map.includes("`certs/server.pem` | sensitive"));
  assert.ok(!map.includes("<agents_summary>"));

  const agents = await readFile(join(root, "AGENTS.md"), "utf8");
  assert.ok(agents.includes("**Stack**: TypeScript"));
  assert.ok(agents.includes("docs/CODEBASE_MAP.md"));
  assert.equal(await readFile(join(root, ".project-mapper/.gitignore"), "utf8"), "*\n");
});

test("does nothing when the code did not change, and only re-analyzes what did", async () => {
  const root = await project({ "a/a.ts": module("a"), "b/b.ts": module("b"), "c/c.ts": module("c") });
  const first = fakeModel();
  const initial = await mapCodebase(root, config, { chat: first.chat });
  assert.equal(first.analyses().length, 3);
  assert.equal(initial.chunks, 3);

  const second = fakeModel();
  const unchanged = await mapCodebase(root, config, { chat: second.chat });
  assert.equal(unchanged.status, "up_to_date");
  assert.equal(second.calls.length, 0);

  await writeFile(join(root, "b/b.ts"), module("changed"));
  const third = fakeModel();
  const updated = await mapCodebase(root, config, { chat: third.chat });
  assert.equal(updated.status, "mapped");
  assert.equal(third.analyses().length, 1);
  assert.ok(third.analyses()[0]?.user.includes("b/b.ts"));
  // Parts a and c, the directory tree and the overview: this fake model's report for b did not change.
  assert.equal(updated.reusedAnswers, 4);

  const forced = fakeModel();
  await mapCodebase(root, config, { chat: forced.chat, force: true });
  assert.equal(forced.analyses().length, 3);
});

test("a failed part leaves no map, and running again resumes from the cache", async () => {
  const root = await project({ "a/a.ts": module("a"), "b/b.ts": module("b") });
  const broken = fakeModel((request) => request.user.includes("b/b.ts"));
  await assert.rejects(mapCodebase(root, config, { chat: broken.chat }), /1 of 2 parts failed/);
  assert.ok(!existsSync(join(root, "docs/CODEBASE_MAP.md")));

  const healthy = fakeModel();
  const result = await mapCodebase(root, config, { chat: healthy.chat });
  assert.equal(result.status, "mapped");
  assert.equal(healthy.analyses().length, 1);
  assert.ok(healthy.analyses()[0]?.user.includes("b/b.ts"));
});

test("updates CLAUDE.md instead of creating an AGENTS.md that would hide it", async () => {
  const root = await project({
    "src/a.ts": "export const a = 1;\n",
    "CLAUDE.md": "# Project\n\nHouse rules.\n\n## Codebase Overview\n\nOld summary.\n",
  });
  const result = await mapCodebase(root, config, { chat: fakeModel().chat });
  assert.equal(result.instructionsPath, join(root, "CLAUDE.md"));
  assert.ok(!existsSync(join(root, "AGENTS.md")));
  const claude = await readFile(join(root, "CLAUDE.md"), "utf8");
  assert.ok(claude.includes("House rules."));
  assert.ok(claude.includes("**Stack**: TypeScript"));
  assert.ok(!claude.includes("Old summary."));
});

test("its own output does not count as a change", async () => {
  const root = await project({ "src/a.ts": "export const a = 1;\n", "AGENTS.md": "# Rules\n" });
  await mapCodebase(root, config, { chat: fakeModel().chat });
  const model = fakeModel();
  const result = await mapCodebase(root, config, { chat: model.chat });
  assert.equal(result.status, "up_to_date");
  assert.equal(model.calls.length, 0);
});

test("reports condense when they do not fit in one request", async () => {
  const files: Record<string, string> = {};
  for (const name of ["a", "b", "c", "d"]) files[`${name}/${name}.ts`] = module(name);
  const root = await project(files);
  const seen: ChatRequest[] = [];
  const chat: Chat = async (request) => {
    seen.push(request);
    if (request.system.includes("system-level sections")) return { text: SYNTHESIS, truncated: false };
    if (request.system.includes("merge reports")) return { text: "condensed", truncated: false };
    return { text: "x".repeat(2200), truncated: false };
  };
  const result = await mapCodebase(root, config, { chat });
  assert.ok(seen.some((request) => request.system.includes("merge reports")));
  assert.equal(result.status, "mapped");
});

test("warns about paths the model invented and sections it skipped", async () => {
  const root = await project({ "src/a.ts": "export const a = 1;\n" });
  const chat: Chat = async (request) =>
    request.system.includes("system-level sections")
      ? { text: "## System Overview\nSee `src/ghost.ts`.", truncated: false }
      : { text: "`src/a.ts`", truncated: false };
  const result = await mapCodebase(root, config, { chat });
  assert.ok(result.warnings.some((warning) => warning.includes("src/ghost.ts")));
  assert.ok(result.warnings.some((warning) => warning.includes('"Data Flow"')));
  assert.ok(result.warnings.some((warning) => warning.includes("summary")));
});

test("respects nested .gitignore files in a git repository", async () => {
  const root = await project({
    "src/a.ts": "a",
    "src/.gitignore": "generated.ts\n",
    "src/generated.ts": "g",
    "target/App.class": "c",
  });
  execFileSync("git", ["init", "-q"], { cwd: root });
  const { files } = await scanCodebase(root);
  assert.deepEqual(files.map((file) => file.path), ["src/.gitignore", "src/a.ts"]);
});

test("skips build wrappers and agent configuration that can hold the API key", async () => {
  const root = await project({
    "svc/mvnw": "#!/bin/sh",
    "svc/.mvn/wrapper/maven-wrapper.properties": "x=1",
    "svc/App.java": "class App {}",
    "opencode.jsonc": '{"apiKey": "key" }',
    ".opencode/commands/x.md": "x",
  });
  const { files } = await scanCodebase(root);
  assert.deepEqual(files.map((file) => file.path), ["svc/App.java"]);
});

test("respects .gitignore outside a git repository", async () => {
  const root = await project({ ".gitignore": "secret-dir/\n", "secret-dir/x.ts": "x", "a.ts": "a" });
  const { files } = await scanCodebase(root);
  assert.deepEqual(files.map((file) => file.path), [".gitignore", "a.ts"]);
});

test("a job keeps running between calls and is delivered once", async () => {
  const root = await project({ "src/a.ts": "export const a = 1;\n" });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = fakeModel();
  const runner = new JobRunner(config, {
    chat: async (request) => {
      await gate;
      return model.chat(request);
    },
  });

  assert.equal((await runner.run(root, false, 10)).state, "running");
  assert.equal((await runner.run(root, false, 10)).state, "running");
  assert.equal(model.calls.length, 0);

  release();
  const done = await runner.run(root, false, 5000);
  assert.equal(done.state, "done");
  assert.equal(model.analyses().length, 1);

  const again = await runner.run(root, false, 5000);
  assert.ok(again.state === "done" && again.result.status === "up_to_date");
});

test("a failed job reports the error", async () => {
  const runner = new JobRunner({ ...config, baseUrl: undefined });
  const root = await project({ "a.ts": "a" });
  const view = await runner.run(root, false, 5000);
  assert.ok(view.state === "failed" && view.error.includes("PROJECT_MAPPER_BASE_URL"));
});
