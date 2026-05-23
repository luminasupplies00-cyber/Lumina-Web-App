import { pgTable, serial, text, timestamp, numeric, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const RFQ_STAGES = [
  "NEW",
  "SOURCING",
  "COMPARING",
  "QUOTE_READY",
  "QUOTE_SENT",
  "FOLLOW_UP",
  "WON",
  "LOST",
] as const;

export type RfqStage = (typeof RFQ_STAGES)[number];

export const SOURCE_CHANNELS = [
  "inbound_email",
  "referral",
  "existing_account",
  "cold_outreach",
  "tender",
  "unknown",
] as const;

export const CUSTOMER_SEGMENTS = ["anchor", "builder", "casual", "prospect"] as const;

export const INTENT_SIGNALS = ["urgent", "standard", "price_shopping", "unknown"] as const;

export const LOST_REASONS = [
  "price",
  "lead_time",
  "unresponsive",
  "went_elsewhere",
  "budget",
  "other",
] as const;

export const rfqRecordsTable = pgTable("rfq_records", {
  id: serial("id").primaryKey(),
  emailThreadId: integer("email_thread_id"),
  customerName: text("customer_name").notNull(),
  customerCompany: text("customer_company"),
  customerEmail: text("customer_email"),
  stage: text("stage").notNull().default("NEW"),
  estimatedValue: numeric("estimated_value", { precision: 12, scale: 2 }),
  currency: text("currency").notNull().default("SAR"),
  assignedTo: text("assigned_to"),
  notes: text("notes"),
  urgency: text("urgency"),
  deadline: text("deadline"),
  aiNextAction: text("ai_next_action"),

  sourceChannel: text("source_channel").default("inbound_email"),
  customerSegment: text("customer_segment").default("prospect"),
  intentSignal: text("intent_signal").default("unknown"),

  extractionReviewed: boolean("extraction_reviewed").notNull().default(false),
  extractionReviewedAt: timestamp("extraction_reviewed_at", { withTimezone: true }),

  lostReason: text("lost_reason"),

  timeToFirstSupplierContactMinutes: integer("time_to_first_supplier_contact_minutes"),
  timeToCustomerQuoteMinutes: integer("time_to_customer_quote_minutes"),
  suppliersContactedCount: integer("suppliers_contacted_count").notNull().default(0),
  suppliersRespondedCount: integer("suppliers_responded_count").notNull().default(0),

  landedCostBufferPercent: numeric("landed_cost_buffer_percent", { precision: 5, scale: 2 }).notNull().default("8"),

  isStuck: boolean("is_stuck").notNull().default(false),
  stuckSince: timestamp("stuck_since", { withTimezone: true }),

  stageUpdatedAt: timestamp("stage_updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertRfqRecordSchema = createInsertSchema(rfqRecordsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  stageUpdatedAt: true,
});
export type InsertRfqRecord = z.infer<typeof insertRfqRecordSchema>;
export type RfqRecord = typeof rfqRecordsTable.$inferSelect;
