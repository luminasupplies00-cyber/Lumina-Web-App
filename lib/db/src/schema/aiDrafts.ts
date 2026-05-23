import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const aiDraftsTable = pgTable("ai_drafts", {
  id: serial("id").primaryKey(),
  rfqId: integer("rfq_id").notNull(),
  draftType: text("draft_type").notNull(),
  content: text("content").notNull(),
  rawInput: text("raw_input"),
  modelUsed: text("model_used").notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  copiedAt: timestamp("copied_at", { withTimezone: true }),
});

export const insertAiDraftSchema = createInsertSchema(aiDraftsTable).omit({
  id: true,
  generatedAt: true,
});
export type InsertAiDraft = z.infer<typeof insertAiDraftSchema>;
export type AiDraft = typeof aiDraftsTable.$inferSelect;
