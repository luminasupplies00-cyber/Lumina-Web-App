import { pgTable, serial, text, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export type EmailAttachment = {
  attachmentId: string;
  name: string;
  size?: number;
  type?: string;
};

export const emailThreadsTable = pgTable("email_threads", {
  id: serial("id").primaryKey(),
  threadId: text("thread_id").notNull().unique(),    // Zoho-side key: "{accountId}:{messageId}"
  accountId: text("account_id"),    // Zoho accountId — links thread to a connection
  folderId: text("folder_id"),      // Zoho folderId — required for content/details fetch
  subject: text("subject").notNull(),
  senderName: text("sender_name").notNull(),
  senderEmail: text("sender_email").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  snippet: text("snippet"),
  bodyText: text("body_text"),
  bodyHtml: text("body_html"),     // Full HTML body, populated on first detail fetch
  classification: text("classification"),
  aiConfidence: text("ai_confidence"),    // "high" | "low" | "medium" | null
  aiReasoning: text("ai_reasoning"),      // one-sentence reasoning from Claude
  isRfq: boolean("is_rfq").notNull().default(false),
  isRead: boolean("is_read").notNull().default(false),
  hasAttachments: boolean("has_attachments").notNull().default(false),
  attachments: jsonb("attachments").$type<EmailAttachment[]>().default([]).notNull(),
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
