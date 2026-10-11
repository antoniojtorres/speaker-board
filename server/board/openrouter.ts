// Minimal OpenRouter Chat Completions client. Plain fetch rather than the OpenAI
// SDK: most of what this app sends is OpenRouter-specific (`reasoning`,
// Anthropic `cache_control` passthrough, `reasoning_details`, server tools), and
// none of it is in OpenAI's types.

// Overridable for OpenRouter's regional endpoints, or a local stand-in in tests.
const BASE_URL = (process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1").replace(/\/$/, "");
const ENDPOINT = `${BASE_URL}/chat/completions`;
const TIMEOUT_MS = 180_000; // a turn with searches and adaptive thinking can run long
const RETRIES = 3;

export interface CacheControl {
  type: "ephemeral";
  ttl?: "1h";
}

export interface TextPart {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type Message =
  | { role: "system"; content: TextPart[] }
  | { role: "user"; content: TextPart[] }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
      // Claude's reasoning between tool calls; must go back exactly as received.
      reasoning_details?: unknown[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export type Tool =
  | { type: "function"; function: { name: string; description: string; parameters: object } }
  | { type: "openrouter:web_search"; parameters?: Record<string, unknown> };

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: Tool[];
  max_tokens?: number;
  reasoning?: { effort: "low" | "medium" | "high" | "xhigh" | "max" };
  cache_control?: CacheControl; // automatic caching: breakpoint moves to the last cacheable block
  max_tool_calls?: number; // step budget for server tools (web search) within one request
}

export interface ChatResponse {
  id: string;
  model: string;
  choices: {
    finish_reason: string | null;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
      reasoning_details?: unknown[];
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    // Observed on live responses; OpenRouter's docs call this `server_tool_use`.
    server_tool_use_details?: { web_search_requests?: number };
  };
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The request may not have failed at all; the answer just didn't arrive. */
    readonly transient = false,
  ) {
    super(message);
  }

  /** The key or account is the problem; retrying won't help. */
  get fatal(): boolean {
    return this.status === 401 || this.status === 402 || this.status === 403;
  }

  get retryable(): boolean {
    return this.transient || this.status === 429 || this.status >= 500;
  }
}

export async function chat(apiKey: string, req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await sleep(2000 * 2 ** (attempt - 1), signal);
    try {
      return await once(apiKey, req, signal);
    } catch (err) {
      lastError = err;
      const retryable = !(err instanceof OpenRouterError) || err.retryable;
      if (!retryable || signal?.aborted) throw err;
    }
  }
  throw lastError;
}

async function once(apiKey: string, req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "Speaker Board", // OpenRouter app attribution
    },
    body: JSON.stringify(req),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
  });
  let body: ChatResponse & { error?: { message?: string; code?: number } };
  try {
    body = (await res.json()) as typeof body;
  } catch (err) {
    // OpenRouter sends its 200 headers before the model has finished, so a
    // connection that drops mid-answer (network blip, the machine sleeping)
    // shows up here, while reading the body.
    const why = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    throw new OpenRouterError(`OpenRouter response cut off after HTTP ${res.status} (${why})`, res.status, true);
  }
  // OpenRouter can also report an upstream failure inside a 200 body.
  if (!res.ok || body.error) {
    const status = body.error?.code ?? res.status;
    const detail = body.error?.message ?? (body.error ? JSON.stringify(body.error) : res.statusText);
    throw new OpenRouterError(`OpenRouter ${status}: ${detail}`, status);
  }
  return body;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}
