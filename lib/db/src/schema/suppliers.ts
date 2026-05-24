import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const SUPPLIER_CATEGORIES = [
  "Lab Equipment & Instruments",
  "Reagents & Chemicals",
  "Consumables & Plasticware",
  "Glassware",
  "Life Science & Kits",
  "PPE & Safety",
  "Environmental Monitoring",
  "Diagnostics",
  "Refrigeration & Storage",
  "General Lab Supplies",
] as const;

export type SupplierCategory = (typeof SUPPLIER_CATEGORIES)[number];

export const suppliersTable = pgTable("suppliers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  company: text("company").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  website: text("website"),
  country: text("country").notNull().default("SA"),
  currency: text("currency").notNull().default("SAR"),
  typicalLeadTimeDays: integer("typical_lead_time_days"),
  typicalResponseTimeHours: integer("typical_response_time_hours"),
  paymentTerms: text("payment_terms"),
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  // Aggregated outreach metrics — updated on contact creation / status change.
  totalContacts: integer("total_contacts").notNull().default(0),
  totalResponses: integer("total_responses").notNull().default(0),
  lastContactedAt: timestamp("last_contacted_at", { withTimezone: true }),
  lastRespondedAt: timestamp("last_responded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertSupplierSchema = createInsertSchema(suppliersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSupplier = z.infer<typeof insertSupplierSchema>;
export type Supplier = typeof suppliersTable.$inferSelect;

export const supplierCategoriesTable = pgTable("supplier_categories", {
  id: serial("id").primaryKey(),
  supplierId: integer("supplier_id").notNull(),
  category: text("category").notNull(),
  isPreferred: boolean("is_preferred").notNull().default(false),
  notes: text("notes"),
});

export const insertSupplierCategorySchema = createInsertSchema(supplierCategoriesTable).omit({ id: true });
export type InsertSupplierCategory = z.infer<typeof insertSupplierCategorySchema>;
export type SupplierCategoryRow = typeof supplierCategoriesTable.$inferSelect;

export const supplierPerformanceTable = pgTable("supplier_performance", {
  id: serial("id").primaryKey(),
  supplierId: integer("supplier_id").notNull(),
  rfqId: integer("rfq_id").notNull(),
  wasContacted: boolean("was_contacted").notNull().default(false),
  responded: boolean("responded").notNull().default(false),
  responseTimeHours: integer("response_time_hours"),
  fulfilledAllItems: boolean("fulfilled_all_items"),
  selected: boolean("selected").notNull().default(false),
  selectionReason: text("selection_reason"),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSupplierPerformanceSchema = createInsertSchema(supplierPerformanceTable).omit({
  id: true,
  recordedAt: true,
});
export type InsertSupplierPerformance = z.infer<typeof insertSupplierPerformanceSchema>;
export type SupplierPerformance = typeof supplierPerformanceTable.$inferSelect;

// Per-RFQ supplier outreach — tracks who was emailed for sourcing, whether
// they replied, and response timing. `supplierId` is nullable so ad-hoc
// suppliers (e.g. ones discovered via AI web search but not yet saved to the
// DB) can still be tracked by email + name.
export const SUPPLIER_CONTACT_STATUSES = [
  "contacted",
  "responded",
  "no_response",
  "declined",
  "partial",
] as const;
export type SupplierContactStatus = (typeof SUPPLIER_CONTACT_STATUSES)[number];

export const SUPPLIER_CONTACT_MODES = ["separate", "bcc"] as const;
export type SupplierContactMode = (typeof SUPPLIER_CONTACT_MODES)[number];

export const rfqSupplierContactsTable = pgTable("rfq_supplier_contacts", {
  id: serial("id").primaryKey(),
  rfqId: integer("rfq_id").notNull(),
  supplierId: integer("supplier_id"), // nullable for ad-hoc suppliers
  supplierName: text("supplier_name").notNull(),
  supplierEmail: text("supplier_email").notNull(),
  contactedAt: timestamp("contacted_at", { withTimezone: true }).notNull().defaultNow(),
  contactMode: text("contact_mode").notNull().default("separate"), // separate | bcc
  status: text("status").notNull().default("contacted"),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
  responseTimeHours: integer("response_time_hours"),
  replyThreadId: integer("reply_thread_id"), // → emailThreadsTable.id
  followUpSentAt: timestamp("follow_up_sent_at", { withTimezone: true }),
  emailDraftId: integer("email_draft_id"), // → aiDraftsTable.id
  emailSentVia: text("email_sent_via"), // null = manual/clipboard | "zoho_api" = sent via API
  zohoMessageId: text("zoho_message_id"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertRfqSupplierContactSchema = createInsertSchema(rfqSupplierContactsTable).omit({
  id: true,
  createdAt: true,
  contactedAt: true,
});
export type InsertRfqSupplierContact = z.infer<typeof insertRfqSupplierContactSchema>;
export type RfqSupplierContact = typeof rfqSupplierContactsTable.$inferSelect;
