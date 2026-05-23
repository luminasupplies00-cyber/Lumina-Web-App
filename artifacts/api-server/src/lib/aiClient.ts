import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { decrypt } from "./encrypt.js";
import { logger } from "./logger.js";
import { AI_MODELS } from "./aiConstants.js";

interface ClaudeMessage {
  role: "user" | "assistant";
  content: string;
}

interface ClaudeRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: ClaudeMessage[];
}

interface ClaudeResponse {
  content: Array<{ type: string; text: string }>;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
}

async function getDecryptedSetting(key: string): Promise<string | null> {
  const rows = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.key, key))
    .limit(1);
  if (!rows[0]) return null;
  try {
    return decrypt(rows[0].value);
  } catch {
    return rows[0].value;
  }
}

export async function callClaude(opts: {
  system: string;
  userMessage: string;
  maxTokens: number;
}): Promise<string> {
  let apiKey = await getDecryptedSetting("ANTHROPIC_API_KEY");
  if (!apiKey) {
    apiKey = process.env["ANTHROPIC_API_KEY"] ?? null;
  }
  if (!apiKey) {
    throw new Error("Anthropic API key not configured. Add it in Settings.");
  }

  const body: ClaudeRequest = {
    model: AI_MODELS.CLAUDE,
    max_tokens: opts.maxTokens,
    system: opts.system,
    messages: [{ role: "user", content: opts.userMessage }],
  };

  logger.info({ model: AI_MODELS.CLAUDE, maxTokens: opts.maxTokens }, "Calling Claude API");

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
    throw new Error(`Claude API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as ClaudeResponse;
  const text = data.content.find((c) => c.type === "text")?.text;
  if (!text) throw new Error("Claude returned no text content");
  return text;
}

export async function callPerplexity(opts: {
  system: string;
  userMessage: string;
  maxTokens: number;
}): Promise<string> {
  let apiKey = await getDecryptedSetting("PERPLEXITY_API_KEY");
  if (!apiKey) {
    apiKey = process.env["PERPLEXITY_API_KEY"] ?? null;
  }
  if (!apiKey) {
    throw new Error("Perplexity API key not configured.");
  }

  const body = {
    model: AI_MODELS.PERPLEXITY,
    max_tokens: opts.maxTokens,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.userMessage },
    ],
  };

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
    throw new Error(`Perplexity API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  const text = data.choices[0]?.message?.content;
  if (!text) throw new Error("Perplexity returned no content");
  return text;
}

export async function callAI(opts: {
  system: string;
  userMessage: string;
  maxTokens: number;
  preferredModel?: "claude" | "perplexity";
}): Promise<{ text: string; model: string }> {
  const preferred = opts.preferredModel ?? "claude";

  if (preferred === "claude") {
    const text = await callClaude(opts);
    return { text, model: AI_MODELS.CLAUDE };
  } else {
    const text = await callPerplexity(opts);
    return { text, model: AI_MODELS.PERPLEXITY };
  }
}
