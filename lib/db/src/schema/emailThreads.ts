import { pgTable, serial, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const emailThreadsTable = pgTable("email_threads", {
  id: serial("id").primaryKey(),
  threadId: text("thread_id").notNull().unique(),
  subject: text("subject").notNull(),
  senderName: text("sender_name").notNull(),
  senderEmail: text("sender_email").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  snippet: text("snippet"),
  bodyText: text("body_text"),
  classification: text("classification"),
  aiConfidence: text("ai_confidence"),    // "high" | "low" | "medium" | null
  aiReasoning: text("ai_reasoning"),      // one-sentence reasoning from Claude
  isRfq: boolean("is_rfq").notNull().default(false),
  hasAttachments: boolean("has_attachments").notNull().default(false),
  attachmentParsed: boolean("attachment_parsed").notNull().default(false),
  attachmentType: text("attachment_type"),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertEmailThreadSchema = createInsertSchema(emailThreadsTable).omit({
  id: true,
  syncedAt: true,
});
export type InsertEmailThread = z.infer<typeof insertEmailThreadSchema>;
export type EmailThread = typeof emailThreadsTable.$inferSelect;
