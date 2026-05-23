import { pgTable, serial, text, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const ATTACHMENT_TYPES = ["body", "pdf", "excel", "image"] as const;
export const EXTRACTION_CONFIDENCES = ["high", "medium", "low", "manual"] as const;

export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];
export type ExtractionConfidence = (typeof EXTRACTION_CONFIDENCES)[number];

export const rfqProductsTable = pgTable("rfq_products", {
  id: serial("id").primaryKey(),
  rfqId: integer("rfq_id").notNull(),
  productName: text("product_name").notNull(),
  catalogueNumber: text("catalogue_number"),
  brand: text("brand"),
  quantity: text("quantity"),
  specifications: text("specifications"),
  notes: text("notes"),
  attachmentType: text("attachment_type").notNull().default("body"),
  extractionConfidence: text("extraction_confidence").notNull().default("high"),
});

export const insertRfqProductSchema = createInsertSchema(rfqProductsTable).omit({ id: true });
export type InsertRfqProduct = z.infer<typeof insertRfqProductSchema>;
export type RfqProduct = typeof rfqProductsTable.$inferSelect;
