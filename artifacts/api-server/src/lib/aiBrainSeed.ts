import { db } from "@workspace/db";
import { aiBrainMemoryTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger.js";

// Seed AI brain memory with Lumina Supplies defaults the first time the
// server boots against an empty table. Idempotent — only inserts when the
// table is empty so user edits are never overwritten.
const SEED_ROWS: Array<{ category: string; key: string; value: string }> = [
  // Company profile
  { category: "company_profile", key: "Company name", value: "Lumina Supplies" },
  { category: "company_profile", key: "Legal name", value: "Success Lines Company" },
  { category: "company_profile", key: "Location", value: "Riyadh, Saudi Arabia" },
  { category: "company_profile", key: "Business type", value: "B2B laboratory and scientific supplies distribution" },
  { category: "company_profile", key: "Primary market", value: "Saudi Arabia" },
  {
    category: "company_profile",
    key: "Customer types",
    value: "hospitals, labs, universities, research centers, industrial facilities",
  },
  {
    category: "company_profile",
    key: "Business model",
    value: "back-order, markup-based pricing on imported lab supplies",
  },
  { category: "company_profile", key: "Default markup", value: "35%" },
  { category: "company_profile", key: "Default payment terms", value: "Net 30" },
  { category: "company_profile", key: "Default quote validity", value: "30 days" },
  { category: "company_profile", key: "Default follow-up period", value: "3 days" },
  { category: "company_profile", key: "Primary currency", value: "SAR" },
  { category: "company_profile", key: "Supplier quote currency", value: "USD (most international suppliers)" },
  { category: "company_profile", key: "Language", value: "English primary, Arabic supported" },

  // Team
  {
    category: "team",
    key: "Eman Ali (General Manager)",
    value: "Handles operations, coordination, and admin tasks. Default assignee for general operations.",
  },
  {
    category: "team",
    key: "Asha Maru (Procurement Manager)",
    value: "Handles supplier sourcing, purchasing, and POs. Default assignee for supplier outreach.",
  },
  {
    category: "team",
    key: "Sales Team",
    value: "Handles customer-facing communication and quotations.",
  },

  // Behavior
  { category: "behavior", key: "Default email tone", value: "Professional and formal" },
  { category: "behavior", key: "Default email language", value: "English" },
  {
    category: "behavior",
    key: "Email signoff",
    value: "Best regards, [Name] | Lumina Supplies",
  },
  {
    category: "behavior",
    key: "Quote requirements",
    value:
      "Every customer quote must include quote validity (30 days), payment terms (Net 30), and a clear unit/total price.",
  },
];

export async function seedAIBrainMemory(): Promise<void> {
  try {
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(aiBrainMemoryTable);
    const count = rows[0]?.n ?? 0;
    if (count > 0) {
      logger.info({ count }, "AI brain memory already seeded — skipping");
      return;
    }
    await db.insert(aiBrainMemoryTable).values(SEED_ROWS);
    logger.info({ inserted: SEED_ROWS.length }, "AI brain memory seeded with defaults");
  } catch (err) {
    // Don't crash boot — the brain will just be empty until manually seeded.
    logger.error({ err }, "AI brain memory seeding failed");
  }
}
