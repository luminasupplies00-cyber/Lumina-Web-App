import { pgTable, serial, text, integer, boolean, timestamp, index } from "drizzle-orm/pg-core";

export const aiCommandsLogTable = pgTable(
  "ai_commands_log",
  {
    id: serial("id").primaryKey(),
    commandText: text("command_text").notNull(),
    intentDetected: text("intent_detected"),
    contextUsed: text("context_used"),
    responseType: text("response_type"),
    responseSummary: text("response_summary"),
    tokensUsed: integer("tokens_used"),
    executionTimeMs: integer("execution_time_ms"),
    success: boolean("success").notNull().default(false),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byCreatedAt: index("ai_commands_log_created_at_idx").on(t.createdAt),
  }),
);

export type AiCommandLog = typeof aiCommandsLogTable.$inferSelect;
export type NewAiCommandLog = typeof aiCommandsLogTable.$inferInsert;
