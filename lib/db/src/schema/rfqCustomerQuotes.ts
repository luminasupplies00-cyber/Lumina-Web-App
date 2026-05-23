import { pgTable, serial, integer, numeric, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const rfqCustomerQuotesTable = pgTable("rfq_customer_quotes", {
  id: serial("id").primaryKey(),
  rfqId: integer("rfq_id").notNull(),
  markupPercent: numeric("markup_percent", { precision: 5, scale: 2 }).notNull().default("30"),
  landedCostBufferPercent: numeric("landed_cost_buffer_percent", { precision: 5, scale: 2 }).notNull().default("8"),
  markupApplied: numeric("markup_applied", { precision: 5, scale: 2 }),
  totalValue: numeric("total_value", { precision: 12, scale: 2 }),
  currency: text("currency").notNull().default("SAR"),
  validityDays: integer("validity_days").notNull().default(30),
  draft: text("draft"),

  versionNumber: integer("version_number").notNull().default(1),
  parentQuoteId: integer("parent_quote_id"),
  revisionReason: text("revision_reason"),
  changesSummary: text("changes_summary"),
  wasRevised: boolean("was_revised").notNull().default(false),
  revisionCount: integer("revision_count").notNull().default(0),

  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertRfqCustomerQuoteSchema = createInsertSchema(rfqCustomerQuotesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertRfqCustomerQuote = z.infer<typeof insertRfqCustomerQuoteSchema>;
export type RfqCustomerQuote = typeof rfqCustomerQuotesTable.$inferSelect;
