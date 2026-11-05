import assert from "node:assert/strict";
import { test } from "node:test";
import { planChunks } from "../src/chunk.js";
import { inputBudget, loadConfig } from "../src/config.js";
import { createChat, stripThinking } from "../src/llm.js";
import { redact } from "../src/redact.js";
import { demoteHeadings, findUnknownPaths, mergeInstructions, parseSections, readFingerprint } from "../src/render.js";
import type { ScannedFile } from "../src/scan.js";

const file = (path: string, tokens: number): ScannedFile => ({ path, tokens, bytes: tokens * 3, hash: path });

test("redact removes secrets from config files but keeps placeholders", () => {
  const input = [
    "spring.datasource.password=hunter2",
    "password: ${DB_PASSWORD}",
    "url: jdbc:postgresql://admin:s3cret@db.internal:5432/app",
    "ead.auth.jwtSecret: abcdef123",
  ].join("\n");
  const { text, count } = redact(input, "src/main/resources/application.yml");
  assert.ok(!text.includes("hunter2"));
  assert.ok(!text.includes("s3cret"));
  assert.ok(!text.includes("abcdef123"));
  assert.ok(text.includes("${DB_PASSWORD}"));
  assert.equal(count, 3);
});

test("redact does not take the next line as the value of an empty key", () => {
  const input = "password:\nusername: app\n";
  assert.equal(redact(input, "application.yml").text, input);
});

test("redact leaves type declarations in source code alone", () => {
  const source = "interface User { password: string; token: string }";
  assert.equal(redact(source, "src/user.ts").text, source);
});

test("redact catches unambiguous formats in any file", () => {
  const key = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
  const pem = ["-----BEGIN RSA PRIVATE KEY-----", "abc", "-----END RSA PRIVATE KEY-----"].join("\n");
  const { text } = redact(`const a = "${key}";\n${pem}`, "src/a.ts");
  assert.ok(!text.includes(key));
  assert.ok(!text.includes("abc\n"));
});

test("planChunks keeps a directory together when it fits", () => {
  const chunks = planChunks([file("a/x.ts", 10), file("a/y.ts", 10), file("b/z.ts", 10)], 100);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.label, "a, b");
});

test("planChunks splits over-budget trees by directory and respects the budget", () => {
  const files = [file("a/1.ts", 60), file("a/2.ts", 30), file("b/1.ts", 60), file("b/2.ts", 60), file("c.ts", 50)];
  const chunks = planChunks(files, 100);
  assert.ok(chunks.every((chunk) => chunk.tokens <= 100));
  assert.equal(chunks.flatMap((chunk) => chunk.files).length, files.length);
  assert.ok(chunks.some((chunk) => chunk.label === "a"));
  assert.equal(new Set(chunks.map((chunk) => chunk.label)).size, chunks.length);
});

test("planChunks counts an oversized file as one budget", () => {
  const chunks = planChunks([file("huge.ts", 5000), file("small.ts", 10)], 100);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.tokens, 100);
});

test("planChunks names merged services instead of labeling them as the root", () => {
  const chunks = planChunks(
    [file("gateway/a.java", 60), file("registry/b.java", 30), file("authuser/c.java", 90), file("course/d.java", 90)],
    100,
  );
  assert.deepEqual(
    chunks.map((chunk) => chunk.label),
    ["authuser", "course", "gateway, registry"],
  );
});

test("inputBudget rejects a context smaller than the output limit", () => {
  assert.throws(() => inputBudget({ contextTokens: 4096, maxOutputTokens: 4096 }), /too small/);
  assert.equal(inputBudget({ contextTokens: 32768, maxOutputTokens: 4096 }), 23521);
});

test("loadConfig rejects invalid values", () => {
  assert.throws(() => loadConfig({ PROJECT_MAPPER_CONCURRENCY: "zero" }), /positive integer/);
  assert.throws(() => loadConfig({ PROJECT_MAPPER_EXTRA_BODY: "{" }), /valid JSON/);
});

test("stripThinking removes complete and unterminated reasoning", () => {
  assert.equal(stripThinking("<think>hmm</think>\nanswer"), "answer");
  assert.equal(stripThinking("answer<think>never closed"), "answer");
});

test("mergeInstructions is idempotent and preserves other content", () => {
  const section = "<!-- project-mapper:start -->\nnew\n<!-- project-mapper:end -->";
  const first = mergeInstructions("# Rules\n\nKeep me.\n", section);
  assert.ok(first.includes("Keep me."));
  assert.equal(mergeInstructions(first, section), first);
  const updated = mergeInstructions(first, section.replace("new", "newer"));
  assert.ok(updated.includes("newer"));
  assert.ok(!updated.includes("\nnew\n"));
});

test("mergeInstructions takes over a section without markers", () => {
  const section = "<!-- project-mapper:start -->\nnew\n<!-- project-mapper:end -->";
  const merged = mergeInstructions("# T\n\n## Codebase Overview\n\nold\n\n## Other\n\nkeep\n", section);
  assert.ok(!merged.includes("old"));
  assert.ok(merged.includes("## Other\n\nkeep"));
  assert.equal(merged.match(/project-mapper:start/g)?.length, 1);
});

test("findUnknownPaths flags invented paths and accepts module-relative ones", () => {
  const known = new Set(["src/api/users.ts", "README.md"]);
  const unknown = findUnknownPaths(
    "`src/api/users.ts` `api/users.ts:10` `src/api/ghost.ts` `README.md` `/users/list.json` `foo`",
    known,
  );
  assert.deepEqual(unknown, ["src/api/ghost.ts"]);
});

test("parseSections ignores headings inside code fences", () => {
  const sections = parseSections("## A\ntext\n```\n## not a heading\n```\n## B\nmore");
  assert.deepEqual([...sections.keys()], ["A", "B"]);
});

test("demoteHeadings keeps reports below the module heading", () => {
  assert.equal(demoteHeadings("# T\n## U\n#### V\n```\n# code\n```"), "#### T\n#### U\n#### V\n```\n# code\n```");
});

test("readFingerprint only reads the frontmatter", () => {
  assert.equal(readFingerprint("---\nfingerprint: abc123\n---\n# Map"), "abc123");
  assert.equal(readFingerprint("# no frontmatter"), undefined);
});

function fakeFetch(answers: (() => Response)[], seen: unknown[] = []): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    seen.push(JSON.parse(String(init?.body)));
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    return next();
  }) as typeof fetch;
}

const completion = (content: string, finish = "stop") =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }] }));

const llmConfig = { ...loadConfig({}), baseUrl: "http://qwen.test/v1", model: "qwen", retryDelayMs: 1 };

test("chat retries temporary failures but not client errors", async () => {
  const chat = createChat(llmConfig, fakeFetch([() => new Response("busy", { status: 503 }), () => completion("ok")]));
  assert.deepEqual(await chat({ system: "s", user: "u" }), { text: "ok", truncated: false });

  const bad = createChat(llmConfig, fakeFetch([() => new Response("too long", { status: 400 }), () => completion("never")]));
  await assert.rejects(bad({ system: "s", user: "u" }), /HTTP 400/);
});

test("chat continues when the output limit is hit, and keeps partial text on overflow", async () => {
  const seen: { messages: unknown[]; model: string; enable?: boolean }[] = [];
  const chat = createChat(
    { ...llmConfig, extraBody: { enable: false } },
    fakeFetch([() => completion("part one ", "length"), () => completion("part two")], seen),
  );
  assert.deepEqual(await chat({ system: "s", user: "u" }), { text: "part one part two", truncated: false });
  assert.equal(seen[1]?.messages.length, 4);
  assert.equal(seen[0]?.enable, false);

  const overflow = createChat(
    llmConfig,
    fakeFetch([() => completion("partial", "length"), () => new Response("context exceeded", { status: 400 })]),
  );
  assert.deepEqual(await overflow({ system: "s", user: "u" }), { text: "partial", truncated: true });
});

test("chat explains a model that spends the whole limit reasoning", async () => {
  const answers = [1, 2, 3].map(() => () => completion("<think>still going", "length"));
  const chat = createChat(llmConfig, fakeFetch(answers));
  await assert.rejects(chat({ system: "s", user: "u" }), /PROJECT_MAPPER_EXTRA_BODY/);
});

test("chat requires the model server to be configured", () => {
  assert.throws(() => createChat(loadConfig({})), /PROJECT_MAPPER_BASE_URL/);
});
