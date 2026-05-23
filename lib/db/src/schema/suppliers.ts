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
  country: text("country").notNull().default("SA"),
  currency: text("currency").notNull().default("SAR"),
  typicalLeadTimeDays: integer("typical_lead_time_days"),
  typicalResponseTimeHours: integer("typical_response_time_hours"),
  paymentTerms: text("payment_terms"),
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
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
