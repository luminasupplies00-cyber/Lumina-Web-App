import { db } from "@workspace/db";
import { aiBrainMemoryTable, type AiBrainMemory } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";

// Short in-memory cache so we don't query the DB on every AI call. Memory
// rarely changes; staleness for a few seconds is fine.
let cache: { text: string; expiresAt: number } | null = null;
const TTL_MS = 30_000;

const CATEGORY_HEADINGS: Record<string, string> = {
  company_profile: "Company profile",
  team: "Team",
  template: "Email templates",
  supplier_rule: "Supplier preferences",
  customer_rule: "Customer rules",
  behavior: "AI behavior settings",
};

function groupByCategory(rows: AiBrainMemory[]): Map<string, AiBrainMemory[]> {
  const map = new Map<string, AiBrainMemory[]>();
  for (const r of rows) {
    if (!map.has(r.category)) map.set(r.category, []);
    map.get(r.category)!.push(r);
  }
  return map;
}

function formatSection(category: string, rows: AiBrainMemory[]): string {
  const heading = CATEGORY_HEADINGS[category] ?? category;
  const lines = rows.map((r) => `- ${r.key}: ${r.value}`).join("\n");
  return `${heading}:\n${lines}`;
}

// Public — invalidate after a write to memory.
export function invalidateBrainContextCache(): void {
  cache = null;
}

export async function buildAIContext(): Promise<string> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.text;

  let rows: AiBrainMemory[] = [];
  try {
    rows = await db
      .select()
      .from(aiBrainMemoryTable)
      .where(eq(aiBrainMemoryTable.isActive, true));
  } catch (err) {
    // Never break an AI call because the brain table is unreachable —
    // fall back to a minimal default header so existing prompts still work.
    logger.warn({ err }, "buildAIContext: brain memory read failed, falling back");
    return DEFAULT_HEADER;
  }

  if (rows.length === 0) {
    cache = { text: DEFAULT_HEADER, expiresAt: now + TTL_MS };
    return DEFAULT_HEADER;
  }

  const grouped = groupByCategory(rows);
  // Preserve a stable, readable order regardless of insertion order.
  const order = [
    "company_profile",
    "team",
    "behavior",
    "supplier_rule",
    "customer_rule",
    "template",
  ];
  const sections: string[] = [DEFAULT_HEADER];
  for (const cat of order) {
    const items = grouped.get(cat);
    if (items && items.length > 0) sections.push(formatSection(cat, items));
  }
  // Any unknown categories at the end.
  for (const [cat, items] of grouped) {
    if (!order.includes(cat) && items.length > 0) sections.push(formatSection(cat, items));
  }

  const text = sections.join("\n\n");
  cache = { text, expiresAt: now + TTL_MS };
  return text;
}

const DEFAULT_HEADER =
  "You are the AI brain for Lumina Supplies, a B2B laboratory and scientific supplies distributor based in Riyadh, Saudi Arabia. Use the business context below to keep responses consistent with how this company operates.";

// Convenience wrapper: prepend the brain context to a feature-specific system
// prompt. Use this at every AI call site to keep context injection uniform.
export async function withBrainContext(systemPrompt: string): Promise<string> {
  const ctx = await buildAIContext();
  return `${ctx}\n\n---\n\n${systemPrompt}`;
}
