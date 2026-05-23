import { pgTable, serial, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const zohoConnectionsTable = pgTable("zoho_connections", {
  id: serial("id").primaryKey(),
  accountId: text("account_id").notNull(),
  email: text("email").notNull(),
  accountLabel: text("account_label").notNull().default("General"),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  tokenExpiry: timestamp("token_expiry", { withTimezone: true }).notNull(),
  accountsDomain: text("accounts_domain").notNull().default("accounts.zoho.com"),
  isActive: boolean("is_active").notNull().default(true),
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
});

export const insertZohoConnectionSchema = createInsertSchema(zohoConnectionsTable).omit({
  id: true,
  connectedAt: true,
});
export type InsertZohoConnection = z.infer<typeof insertZohoConnectionSchema>;
export type ZohoConnection = typeof zohoConnectionsTable.$inferSelect;

export const ZOHO_ACCOUNT_LABELS = [
  "Owner",
  "Sales",
  "Procurement",
  "Support",
  "Finance",
  "General",
] as const;
export type ZohoAccountLabel = (typeof ZOHO_ACCOUNT_LABELS)[number];
