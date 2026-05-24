import { logger } from "./logger.js";
import { withBrainContext } from "./aiBrainContext.js";

// ─── Models ───────────────────────────────────────────────────────────────────
// Available on this account (confirmed via /v1/models):
//   claude-sonnet-4-5  → claude-sonnet-4-5-20250929 (primary, balanced)
//   claude-haiku-4-5-20251001                        (fast, cheap — triage)
//   claude-opus-4-7                                  (most capable)
export const AI_MODELS = {
  CLAUDE: "claude-sonnet-4-5",
  HAIKU: "claude-haiku-4-5-20251001",
  OPUS: "claude-opus-4-7",
} as const;

export type AIModel = (typeof AI_MODELS)[keyof typeof AI_MODELS];

type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } };

interface ClaudeRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string | ClaudeContentBlock[] }>;
}

export type AIAttachment = {
  mediaType: string;     // e.g. image/png, application/pdf
  base64: string;        // base64-encoded bytes
  name?: string;
};

interface ClaudeResponse {
  content: Array<{ type: string; text: string }>;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
}

function getApiKey(): string {
  const key = process.env["ANTHROPIC_API_KEY"];
  if (!key) {
    throw new Error(
      "ANTHROPIC_API_KEY environment variable is not set. Add it in Replit Secrets.",
    );
  }
  return key;
}

export async function callClaude(opts: {
  system: string;
  userMessage: string;
  maxTokens: number;
  model?: AIModel;
  attachments?: AIAttachment[];
  /**
   * If true, the caller's `system` prompt is sent as-is without prepending
   * the AI brain business context. Use only for tightly scoped utility calls
   * (e.g. the intent classifier inside the command engine) where the brain
   * context would be noise.
   */
  skipBrainContext?: boolean;
}): Promise<string> {
  const apiKey = getApiKey();
  const model = opts.model ?? AI_MODELS.CLAUDE;
  const systemPrompt = opts.skipBrainContext
    ? opts.system
    : await withBrainContext(opts.system);

  // Build user content: any attachments (images / PDFs) first, then a text block.
  let userContent: string | ClaudeContentBlock[] = opts.userMessage;
  if (opts.attachments && opts.attachments.length > 0) {
    const blocks: ClaudeContentBlock[] = [];
    for (const a of opts.attachments) {
      if (a.mediaType === "application/pdf") {
        blocks.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: a.base64 },
        });
      } else if (a.mediaType.startsWith("image/")) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: a.mediaType, data: a.base64 },
        });
      }
    }
    blocks.push({ type: "text", text: opts.userMessage });
    userContent = blocks;
  }

  const body: ClaudeRequest = {
    model,
    max_tokens: opts.maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userContent }],
  };

  logger.info(
    { model, maxTokens: opts.maxTokens, attachmentCount: opts.attachments?.length ?? 0 },
    "Calling Claude API",
  );

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Claude API error ${res.status} (model: ${model}): ${text}`,
    );
  }

  const data = (await res.json()) as ClaudeResponse;
  const text = data.content.find((c) => c.type === "text")?.text;
  if (!text) throw new Error("Claude returned no text content");
  return text;
}

export async function callAI(opts: {
  system: string;
  userMessage: string;
  maxTokens: number;
  model?: AIModel;
  attachments?: AIAttachment[];
  skipBrainContext?: boolean;
}): Promise<{ text: string; model: string }> {
  const model = opts.model ?? AI_MODELS.CLAUDE;
  const text = await callClaude({ ...opts, model });
  return { text, model };
}

// ─── Perplexity (web-search-grounded) ─────────────────────────────────────────
export const PERPLEXITY_MODEL = "sonar-pro";

interface PerplexityResponse {
  choices: Array<{ message: { role: string; content: string } }>;
  citations?: string[];
  model: string;
}

export async function callPerplexity(opts: {
  system: string;
  userMessage: string;
  maxTokens?: number;
  searchRecency?: "month" | "week" | "day" | "year";
}): Promise<{ text: string; citations: string[]; model: string }> {
  const apiKey = process.env["PERPLEXITY_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "PERPLEXITY_API_KEY environment variable is not set. Add it in Replit Secrets.",
    );
  }

  const body = {
    model: PERPLEXITY_MODEL,
    max_tokens: opts.maxTokens ?? 1200,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.userMessage },
    ],
    ...(opts.searchRecency && { search_recency_filter: opts.searchRecency }),
  };

  logger.info({ model: PERPLEXITY_MODEL, maxTokens: body.max_tokens }, "Calling Perplexity API");

  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Perplexity API error ${res.status}: ${text}`) as Error & {
      status?: number;
      isAuthError?: boolean;
    };
    err.status = res.status;
    err.isAuthError = res.status === 401 || res.status === 403;
    throw err;
  }

  const data = (await res.json()) as PerplexityResponse;
  const text = data.choices[0]?.message.content ?? "";
  if (!text) throw new Error("Perplexity returned no content");
  return { text, citations: data.citations ?? [], model: data.model };
}
