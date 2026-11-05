import type { Config } from "./config.js";

export interface ChatRequest {
  system: string;
  user: string;
}

export interface ChatResponse {
  text: string;
  /** The model hit its output limit even after being asked to continue. */
  truncated: boolean;
}

export type Chat = (request: ChatRequest) => Promise<ChatResponse>;

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

const MAX_ATTEMPTS = 4;
const MAX_CONTINUATIONS = 2;
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** Reasoning models such as Qwen can emit their reasoning inline; it does not belong in a document. */
export function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "")
    .trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export function createChat(config: Config, fetchImpl: typeof fetch = fetch): Chat {
  const { baseUrl, model } = config;
  if (!baseUrl || !model) {
    throw new Error("PROJECT_MAPPER_BASE_URL and PROJECT_MAPPER_MODEL must be set to call the model");
  }
  const url = `${baseUrl}/chat/completions`;

  async function once(messages: Message[]): Promise<{ text: string; finishReason?: string }> {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        temperature: 0.2,
        ...config.extraBody,
        model,
        messages,
        max_tokens: config.maxOutputTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });

    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 500);
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new HttpError(
        `Model server answered HTTP ${response.status} at ${url}: ${body}`,
        response.status,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      );
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string | null }; finish_reason?: string }[];
    };
    const choice = data.choices?.[0];
    if (!choice) throw new Error(`Model server returned no choices at ${url}`);
    return { text: choice.message?.content ?? "", finishReason: choice.finish_reason };
  }

  async function withRetry(messages: Message[]): Promise<{ text: string; finishReason?: string }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await once(messages);
      } catch (error) {
        lastError = error;
        const retryable = error instanceof HttpError ? RETRYABLE.has(error.status) : true;
        if (!retryable || attempt === MAX_ATTEMPTS) break;
        const fallback = 2 ** (attempt - 1) * config.retryDelayMs;
        await sleep(error instanceof HttpError ? (error.retryAfterMs ?? fallback) : fallback);
      }
    }
    throw lastError;
  }

  return async ({ system, user }) => {
    const messages: Message[] = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    let text = "";
    for (let round = 0; round <= MAX_CONTINUATIONS; round += 1) {
      let result: { text: string; finishReason?: string };
      try {
        result = await withRetry(messages);
      } catch (error) {
        // A continuation can overflow the context window. What was already generated still counts.
        if (round > 0 && error instanceof HttpError && !RETRYABLE.has(error.status)) {
          return { text: stripThinking(text), truncated: true };
        }
        throw error;
      }
      text += result.text;
      if (result.finishReason !== "length") {
        return { text: stripThinking(text), truncated: false };
      }
      messages.push(
        { role: "assistant", content: result.text },
        { role: "user", content: "Continue exactly where you stopped. Do not repeat anything." },
      );
    }
    const cleaned = stripThinking(text);
    if (!cleaned) {
      throw new Error(
        "The model used its whole output limit without producing an answer. If it is reasoning, " +
          "raise PROJECT_MAPPER_MAX_OUTPUT_TOKENS or disable thinking with PROJECT_MAPPER_EXTRA_BODY.",
      );
    }
    return { text: cleaned, truncated: true };
  };
}
