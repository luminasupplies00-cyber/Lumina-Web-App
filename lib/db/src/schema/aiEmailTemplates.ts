import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";

export const aiEmailTemplatesTable = pgTable("ai_email_templates", {
  id: serial("id").primaryKey(),
  templateName: text("template_name").notNull(),
  templateType: text("template_type").notNull(),
  purpose: text("purpose"),
  exampleContent: text("example_content").notNull(),
  styleInstructions: text("style_instructions"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AiEmailTemplate = typeof aiEmailTemplatesTable.$inferSelect;
export type NewAiEmailTemplate = typeof aiEmailTemplatesTable.$inferInsert;

export const TEMPLATE_TYPES = [
  "supplier_rfq",
  "customer_quotation",
  "follow_up_customer",
  "follow_up_supplier",
  "order_confirmation",
  "apology",
  "introduction",
] as const;
export type TemplateType = (typeof TEMPLATE_TYPES)[number];
