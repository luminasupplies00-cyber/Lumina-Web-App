import { pgTable, serial, integer, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const AUTOPILOT_ACTION_TYPES = [
  "auto_extract",
  "priority_score",
  "stuck_alert",
  "followup_suggestion",
  "stage_advance",
  "daily_briefing",
] as const;

export type AutopilotActionType = (typeof AUTOPILOT_ACTION_TYPES)[number];

export const AUTOPILOT_ACTION_STATUSES = [
  "pending",
  "completed",
  "dismissed",
  "failed",
] as const;

export type AutopilotActionStatus = (typeof AUTOPILOT_ACTION_STATUSES)[number];

export type AutopilotPayload = Record<string, unknown>;

export const autopilotActionsTable = pgTable(
  "autopilot_actions",
  {
    id: serial("id").primaryKey(),
    rfqId: integer("rfq_id"),
    actionType: text("action_type").notNull(),
    payload: jsonb("payload").$type<AutopilotPayload>().default({}).notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    byCreatedAt: index("autopilot_actions_created_at_idx").on(t.createdAt),
    byRfqId: index("autopilot_actions_rfq_id_idx").on(t.rfqId),
  }),
);

export type AutopilotAction = typeof autopilotActionsTable.$inferSelect;
export type NewAutopilotAction = typeof autopilotActionsTable.$inferInsert;
