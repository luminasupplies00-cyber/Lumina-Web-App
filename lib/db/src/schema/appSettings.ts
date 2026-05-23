import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const appSettingsTable = pgTable("app_settings", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertAppSettingSchema = createInsertSchema(appSettingsTable).omit({
  id: true,
  updatedAt: true,
});
export type InsertAppSetting = z.infer<typeof insertAppSettingSchema>;
export type AppSetting = typeof appSettingsTable.$inferSelect;
