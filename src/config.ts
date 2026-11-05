export interface Config {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** Model context window, in tokens. */
  contextTokens: number;
  /** Maximum tokens requested per completion. */
  maxOutputTokens: number;
  /** Parallel requests. Kept low by default because the model server is shared. */
  concurrency: number;
  /** Language the map is written in. */
  language: string;
  requestTimeoutMs: number;
  /** First retry delay; doubles on each attempt. */
  retryDelayMs: number;
  /** How long one MCP call waits before answering "still running". */
  waitSeconds: number;
  /** Merged into every request, e.g. {"chat_template_kwargs":{"enable_thinking":false}}. */
  extraBody: Record<string, unknown>;
}

type Env = Record<string, string | undefined>;

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function parseExtraBody(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("PROJECT_MAPPER_EXTRA_BODY must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("PROJECT_MAPPER_EXTRA_BODY must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function loadConfig(env: Env = process.env): Config {
  return {
    baseUrl: env.PROJECT_MAPPER_BASE_URL?.replace(/\/+$/, "") || undefined,
    apiKey: env.PROJECT_MAPPER_API_KEY || undefined,
    model: env.PROJECT_MAPPER_MODEL || undefined,
    contextTokens: positiveInt(env, "PROJECT_MAPPER_CONTEXT_TOKENS", 32768),
    maxOutputTokens: positiveInt(env, "PROJECT_MAPPER_MAX_OUTPUT_TOKENS", 4096),
    concurrency: positiveInt(env, "PROJECT_MAPPER_CONCURRENCY", 2),
    language: env.PROJECT_MAPPER_LANGUAGE || "English",
    requestTimeoutMs: positiveInt(env, "PROJECT_MAPPER_REQUEST_TIMEOUT_MS", 600_000),
    retryDelayMs: positiveInt(env, "PROJECT_MAPPER_RETRY_DELAY_MS", 2000),
    waitSeconds: positiveInt(env, "PROJECT_MAPPER_WAIT_SECONDS", 25),
    extraBody: parseExtraBody(env.PROJECT_MAPPER_EXTRA_BODY),
  };
}

/** Tokens of source one request can carry, leaving room for the prompt and the answer. */
export function inputBudget(config: Pick<Config, "contextTokens" | "maxOutputTokens">): number {
  const budget = Math.floor((config.contextTokens - config.maxOutputTokens - 1000) * 0.85);
  if (budget < 1000) {
    throw new Error(
      `PROJECT_MAPPER_CONTEXT_TOKENS (${config.contextTokens}) is too small for ` +
        `PROJECT_MAPPER_MAX_OUTPUT_TOKENS (${config.maxOutputTokens})`,
    );
  }
  return budget;
}

/**
 * Conservative estimate. A real tokenizer would need the exact Qwen vocabulary, and tiktoken
 * downloads its data from the internet, which an in-house deployment cannot rely on.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}
