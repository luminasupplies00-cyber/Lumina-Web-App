import { logger } from "./logger.js";

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

interface ClaudeRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

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
}): Promise<string> {
  const apiKey = getApiKey();
  const model = opts.model ?? AI_MODELS.CLAUDE;

  const body: ClaudeRequest = {
    model,
    max_tokens: opts.maxTokens,
    system: opts.system,
    messages: [{ role: "user", content: opts.userMessage }],
  };

  logger.info({ model, maxTokens: opts.maxTokens }, "Calling Claude API");

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
}): Promise<{ text: string; model: string }> {
  const model = opts.model ?? AI_MODELS.CLAUDE;
  const text = await callClaude({ ...opts, model });
  return { text, model };
}
