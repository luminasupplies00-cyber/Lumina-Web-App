import { pgTable, serial, text, integer, timestamp, numeric, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const rfqSupplierQuotesTable = pgTable("rfq_supplier_quotes", {
  id: serial("id").primaryKey(),
  rfqId: integer("rfq_id").notNull(),
  supplierName: text("supplier_name").notNull(),
  supplierEmail: text("supplier_email"),
  totalAmount: numeric("total_amount", { precision: 12, scale: 2 }),
  currency: text("currency").notNull().default("SAR"),
  notes: text("notes"),

  responseTimeHours: numeric("response_time_hours", { precision: 8, scale: 2 }),
  fulfilledAllItems: boolean("fulfilled_all_items").default(true),
  partialFulfillmentNotes: text("partial_fulfillment_notes"),

  quotedAt: timestamp("quoted_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertRfqSupplierQuoteSchema = createInsertSchema(rfqSupplierQuotesTable).omit({
  id: true,
  quotedAt: true,
});
export type InsertRfqSupplierQuote = z.infer<typeof insertRfqSupplierQuoteSchema>;
export type RfqSupplierQuote = typeof rfqSupplierQuotesTable.$inferSelect;

export const rfqSupplierQuoteLinesTable = pgTable("rfq_supplier_quote_lines", {
  id: serial("id").primaryKey(),
  quoteId: integer("quote_id").notNull(),
  rfqProductId: integer("rfq_product_id"),
  productName: text("product_name"),
  unitPrice: text("unit_price").notNull(),
  currency: text("currency").notNull().default("SAR"),
  leadTimeDays: integer("lead_time_days"),
  moq: text("moq"),
  notes: text("notes"),
});

export const insertRfqSupplierQuoteLineSchema = createInsertSchema(rfqSupplierQuoteLinesTable).omit({ id: true });
export type InsertRfqSupplierQuoteLine = z.infer<typeof insertRfqSupplierQuoteLineSchema>;
export type RfqSupplierQuoteLine = typeof rfqSupplierQuoteLinesTable.$inferSelect;
