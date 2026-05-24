import { pgTable, serial, text, boolean, timestamp, index } from "drizzle-orm/pg-core";

export const aiBrainMemoryTable = pgTable(
  "ai_brain_memory",
  {
    id: serial("id").primaryKey(),
    category: text("category").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byCategory: index("ai_brain_memory_category_idx").on(t.category),
  }),
);

export type AiBrainMemory = typeof aiBrainMemoryTable.$inferSelect;
export type NewAiBrainMemory = typeof aiBrainMemoryTable.$inferInsert;

export const BRAIN_MEMORY_CATEGORIES = [
  "company_profile",
  "team",
  "template",
  "supplier_rule",
  "customer_rule",
  "behavior",
] as const;
export type BrainMemoryCategory = (typeof BRAIN_MEMORY_CATEGORIES)[number];
