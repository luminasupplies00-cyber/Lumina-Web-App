/**
 * AI Autopilot Engine — background processor for Lumina HQ.
 *
 * Runs on a configurable interval (default 5 min). Each tick:
 *  1. Auto-extract products for NEW RFQs without products
 *  2. Detect stuck RFQs and generate alerts
 *  3. Flag supplier contacts with no response after 48h
 *  4. Score/prioritize all active RFQs via AI
 *  5. Generate smart "next action" suggestions for each RFQ
 *  6. Auto-advance stages when conditions are met
 *
 * Respects AUTOPILOT_ENABLED setting (global on/off).
 * Logs all actions to the autopilot_actions table.
 */
import { db } from "@workspace/db";
import {
  appSettingsTable,
  rfqRecordsTable,
  rfqProductsTable,
  rfqSupplierContactsTable,
  rfqSupplierQuotesTable,
  rfqCustomerQuotesTable,
  autopilotActionsTable,
  type RfqStage,
  type AutopilotPayload,
} from "@workspace/db";
import { eq, and, sql, isNull, not, inArray } from "drizzle-orm";
import { logger } from "./logger.js";
import { callAI, AI_MODELS } from "./aiClient.js";
import { AI_MAX_TOKENS } from "./aiConstants.js";
import { isRfqStuck } from "./stuckRfq.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface AutopilotState {
  enabled: boolean;
  intervalMinutes: number;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  running: boolean;
  timer: ReturnType<typeof setInterval> | null;
  stats: AutopilotStats;
}

export interface AutopilotStats {
  totalCycles: number;
  lastCycleActions: number;
  lastCycleDurationMs: number;
  extractionsTriggered: number;
  stuckAlerts: number;
  followupSuggestions: number;
  priorityScores: number;
  stageAdvances: number;
}

const ACTIVE_STAGES: RfqStage[] = [
  "NEW",
  "SOURCING",
  "COMPARING",
  "QUOTE_READY",
  "QUOTE_SENT",
  "FOLLOW_UP",
];

// ─── State ───────────────────────────────────────────────────────────────────

const state: AutopilotState = {
  enabled: false,
  intervalMinutes: 5,
  lastRunAt: null,
  nextRunAt: null,
  running: false,
  timer: null,
  stats: {
    totalCycles: 0,
    lastCycleActions: 0,
    lastCycleDurationMs: 0,
    extractionsTriggered: 0,
    stuckAlerts: 0,
    followupSuggestions: 0,
    priorityScores: 0,
    stageAdvances: 0,
  },
};

// ─── Public getters ──────────────────────────────────────────────────────────

export function getAutopilotState(): {
  enabled: boolean;
  intervalMinutes: number;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  running: boolean;
  stats: AutopilotStats;
} {
  return {
    enabled: state.enabled,
    intervalMinutes: state.intervalMinutes,
    lastRunAt: state.lastRunAt,
    nextRunAt: state.nextRunAt,
    running: state.running,
    stats: { ...state.stats },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function readEnabledSetting(): Promise<boolean> {
  try {
    const rows = await db
      .select({ value: appSettingsTable.value })
      .from(appSettingsTable)
      .where(eq(appSettingsTable.key, "AUTOPILOT_ENABLED"))
      .limit(1);
    return rows[0]?.value === "true";
  } catch {
    return false;
  }
}

async function readIntervalSetting(): Promise<number> {
  try {
    const rows = await db
      .select({ value: appSettingsTable.value })
      .from(appSettingsTable)
      .where(eq(appSettingsTable.key, "AUTOPILOT_INTERVAL_MINUTES"))
      .limit(1);
    const raw = parseInt(rows[0]?.value ?? "5");
    return Number.isFinite(raw) && raw >= 1 ? raw : 5;
  } catch {
    return 5;
  }
}

async function logAction(
  actionType: string,
  rfqId: number | null,
  payload: AutopilotPayload,
  status: "pending" | "completed" | "failed" = "completed",
): Promise<void> {
  try {
    await db.insert(autopilotActionsTable).values({
      rfqId,
      actionType,
      payload,
      status,
      completedAt: status === "completed" ? new Date() : null,
    });
  } catch (err) {
    logger.warn({ err, actionType, rfqId }, "Autopilot: failed to log action");
  }
}

// ─── Step 1: Auto-extract products for NEW RFQs ─────────────────────────────

async function autoExtractNewRfqs(): Promise<number> {
  // Find NEW RFQs that have no products extracted yet
  const newRfqs = await db
    .select({ id: rfqRecordsTable.id, emailThreadId: rfqRecordsTable.emailThreadId })
    .from(rfqRecordsTable)
    .where(eq(rfqRecordsTable.stage, "NEW"));

  let triggered = 0;
  for (const rfq of newRfqs) {
    const products = await db
      .select({ id: rfqProductsTable.id })
      .from(rfqProductsTable)
      .where(eq(rfqProductsTable.rfqId, rfq.id))
      .limit(1);

    if (products.length === 0 && rfq.emailThreadId) {
      // Trigger extraction via dynamic import to avoid circular deps
      try {
        const { triggerAutopilotExtraction } = await import("./autopilotExtraction.js");
        await triggerAutopilotExtraction(rfq.id);
        await logAction("auto_extract", rfq.id, {
          message: "Auto-triggered product extraction for NEW RFQ",
        });
        triggered++;
      } catch (err) {
        logger.warn({ err, rfqId: rfq.id }, "Autopilot: auto-extraction failed");
        await logAction("auto_extract", rfq.id, {
          message: "Auto-extraction failed",
          error: String(err),
        }, "failed");
      }
    }
  }
  return triggered;
}

// ─── Step 2: Detect stuck RFQs ──────────────────────────────────────────────

async function detectStuckRfqs(): Promise<number> {
  const activeRfqs = await db
    .select()
    .from(rfqRecordsTable)
    .where(inArray(rfqRecordsTable.stage, ACTIVE_STAGES));

  let alerts = 0;
  for (const rfq of activeRfqs) {
    const stuck = isRfqStuck(rfq.stage, new Date(rfq.stageUpdatedAt));
    const wasStuck = rfq.isStuck;

    if (stuck && !wasStuck) {
      await db
        .update(rfqRecordsTable)
        .set({ isStuck: true, stuckSince: new Date() })
        .where(eq(rfqRecordsTable.id, rfq.id));

      await logAction("stuck_alert", rfq.id, {
        message: `RFQ stuck in ${rfq.stage}`,
        stage: rfq.stage,
        customerName: rfq.customerName,
        customerCompany: rfq.customerCompany,
      });
      alerts++;
    } else if (!stuck && wasStuck) {
      // Clear stuck flag if no longer stuck
      await db
        .update(rfqRecordsTable)
        .set({ isStuck: false, stuckSince: null })
        .where(eq(rfqRecordsTable.id, rfq.id));
    }
  }
  return alerts;
}

// ─── Step 3: Flag supplier contacts with no response after 48h ──────────────

async function flagOverdueSupplierContacts(): Promise<number> {
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const overdueContacts = await db
    .select({
      id: rfqSupplierContactsTable.id,
      rfqId: rfqSupplierContactsTable.rfqId,
      supplierName: rfqSupplierContactsTable.supplierName,
      supplierEmail: rfqSupplierContactsTable.supplierEmail,
      contactedAt: rfqSupplierContactsTable.contactedAt,
    })
    .from(rfqSupplierContactsTable)
    .where(
      and(
        eq(rfqSupplierContactsTable.status, "contacted"),
        isNull(rfqSupplierContactsTable.respondedAt),
        isNull(rfqSupplierContactsTable.followUpSentAt),
        sql`${rfqSupplierContactsTable.contactedAt} < ${cutoff}`,
      ),
    );

  let flagged = 0;
  // Group by RFQ to avoid duplicate actions
  const byRfq = new Map<number, typeof overdueContacts>();
  for (const c of overdueContacts) {
    const existing = byRfq.get(c.rfqId) ?? [];
    existing.push(c);
    byRfq.set(c.rfqId, existing);
  }

  for (const [rfqId, contacts] of byRfq) {
    await logAction("followup_suggestion", rfqId, {
      message: `${contacts.length} supplier(s) have not responded after 48h`,
      suppliers: contacts.map((c) => ({
        name: c.supplierName,
        email: c.supplierEmail,
        contactedAt: c.contactedAt.toISOString(),
        hoursSinceContact: Math.round(
          (Date.now() - c.contactedAt.getTime()) / 3_600_000,
        ),
      })),
    });
    flagged++;
  }
  return flagged;
}

// ─── Step 4: Priority scoring ────────────────────────────────────────────────

interface RfqForScoring {
  id: number;
  stage: string;
  customerName: string;
  customerCompany: string | null;
  customerEmail: string | null;
  estimatedValue: string | null;
  stageUpdatedAt: Date;
  createdAt: Date;
  productCount: number;
  supplierContactCount: number;
  supplierResponseCount: number;
  quoteCount: number;
  customerQuoteCount: number;
  isStuck: boolean;
}

async function scorePriorities(): Promise<number> {
  const activeRfqs = await db
    .select()
    .from(rfqRecordsTable)
    .where(inArray(rfqRecordsTable.stage, ACTIVE_STAGES));

  if (activeRfqs.length === 0) return 0;

  // Gather supplementary data for each RFQ
  const rfqsForScoring: RfqForScoring[] = [];
  for (const rfq of activeRfqs) {
    const [products, contacts, quotes, customerQuotes] = await Promise.all([
      db.select({ id: rfqProductsTable.id }).from(rfqProductsTable).where(eq(rfqProductsTable.rfqId, rfq.id)),
      db.select({ id: rfqSupplierContactsTable.id, status: rfqSupplierContactsTable.status }).from(rfqSupplierContactsTable).where(eq(rfqSupplierContactsTable.rfqId, rfq.id)),
      db.select({ id: rfqSupplierQuotesTable.id }).from(rfqSupplierQuotesTable).where(eq(rfqSupplierQuotesTable.rfqId, rfq.id)),
      db.select({ id: rfqCustomerQuotesTable.id }).from(rfqCustomerQuotesTable).where(eq(rfqCustomerQuotesTable.rfqId, rfq.id)),
    ]);

    rfqsForScoring.push({
      id: rfq.id,
      stage: rfq.stage,
      customerName: rfq.customerName,
      customerCompany: rfq.customerCompany,
      customerEmail: rfq.customerEmail,
      estimatedValue: rfq.estimatedValue,
      stageUpdatedAt: new Date(rfq.stageUpdatedAt),
      createdAt: new Date(rfq.createdAt),
      productCount: products.length,
      supplierContactCount: contacts.length,
      supplierResponseCount: contacts.filter((c) => c.status === "responded").length,
      quoteCount: quotes.length,
      customerQuoteCount: customerQuotes.length,
      isStuck: rfq.isStuck,
    });
  }

  // Build a batch prompt for AI scoring
  const rfqSummaries = rfqsForScoring.map((r) => {
    const hoursInStage = (Date.now() - r.stageUpdatedAt.getTime()) / 3_600_000;
    return `ID:${r.id} | Stage:${r.stage} | Customer:${r.customerCompany ?? r.customerName} | Value:${r.estimatedValue ?? "unknown"} SAR | Products:${r.productCount} | Suppliers contacted:${r.supplierContactCount} responded:${r.supplierResponseCount} | Quotes:${r.quoteCount} | Customer quotes:${r.customerQuoteCount} | Hours in stage:${Math.round(hoursInStage)} | Stuck:${r.isStuck}`;
  });

  const system = `You are a B2B sales operations AI for Lumina Supplies (laboratory supplies, Riyadh, Saudi Arabia).

Score each RFQ's priority from 0-100 based on:
- Estimated value (higher value = higher priority)
- Time urgency (longer in current stage vs typical thresholds = more urgent)
- Stage momentum (further along the pipeline = higher priority to avoid losing)
- Stuck status (stuck RFQs need immediate attention)

Stuck thresholds: NEW>4h, SOURCING>48h, COMPARING>24h, QUOTE_READY>4h, QUOTE_SENT>72h, FOLLOW_UP>120h

Return ONLY a valid JSON array. No explanation, no markdown.
Format: [{"id": <rfq_id>, "score": <0-100>, "reason": "<one-line reason>"}]`;

  try {
    const { text } = await callAI({
      system,
      userMessage: `Score these active RFQs:\n\n${rfqSummaries.join("\n")}`,
      maxTokens: AI_MAX_TOKENS.AUTOPILOT_PRIORITY,
      model: AI_MODELS.HAIKU,
    });

    const arrMatch = text.match(/\[[\s\S]*\]/);
    if (!arrMatch) {
      logger.warn("Autopilot: priority scoring returned no JSON array");
      return 0;
    }

    const scores = JSON.parse(arrMatch[0]) as Array<{
      id: number;
      score: number;
      reason: string;
    }>;

    let updated = 0;
    for (const s of scores) {
      if (typeof s.id !== "number" || typeof s.score !== "number") continue;
      const clampedScore = Math.max(0, Math.min(100, Math.round(s.score)));
      await db
        .update(rfqRecordsTable)
        .set({
          priorityScore: clampedScore,
          priorityReason: s.reason?.slice(0, 200) ?? null,
        })
        .where(eq(rfqRecordsTable.id, s.id));
      updated++;
    }

    if (updated > 0) {
      await logAction("priority_score", null, {
        message: `Scored ${updated} active RFQs`,
        count: updated,
      });
    }

    return updated;
  } catch (err) {
    logger.warn({ err }, "Autopilot: priority scoring failed");
    return 0;
  }
}

// ─── Step 5: Smart suggestions (next best action) ───────────────────────────

async function generateSuggestions(): Promise<number> {
  const activeRfqs = await db
    .select()
    .from(rfqRecordsTable)
    .where(inArray(rfqRecordsTable.stage, ACTIVE_STAGES));

  let updated = 0;
  for (const rfq of activeRfqs) {
    const suggestion = await computeNextAction(rfq);
    if (suggestion) {
      await db
        .update(rfqRecordsTable)
        .set({
          nextAction: suggestion.action,
          nextActionReason: suggestion.reason,
        })
        .where(eq(rfqRecordsTable.id, rfq.id));
      updated++;
    }
  }
  return updated;
}

interface NextActionSuggestion {
  action: string;
  reason: string;
}

async function computeNextAction(
  rfq: typeof rfqRecordsTable.$inferSelect,
): Promise<NextActionSuggestion | null> {
  const stage = rfq.stage as RfqStage;
  const hoursInStage = (Date.now() - new Date(rfq.stageUpdatedAt).getTime()) / 3_600_000;

  // Gather context for the RFQ
  const [products, contacts, quotes, customerQuotes] = await Promise.all([
    db.select().from(rfqProductsTable).where(eq(rfqProductsTable.rfqId, rfq.id)),
    db.select().from(rfqSupplierContactsTable).where(eq(rfqSupplierContactsTable.rfqId, rfq.id)),
    db.select().from(rfqSupplierQuotesTable).where(eq(rfqSupplierQuotesTable.rfqId, rfq.id)),
    db.select().from(rfqCustomerQuotesTable).where(eq(rfqCustomerQuotesTable.rfqId, rfq.id)),
  ]);

  const respondedContacts = contacts.filter((c) => c.status === "responded");
  const noResponseContacts = contacts.filter(
    (c) => c.status === "contacted" && !c.respondedAt,
  );
  const overdueContacts = noResponseContacts.filter(
    (c) => (Date.now() - new Date(c.contactedAt).getTime()) / 3_600_000 > 48,
  );

  switch (stage) {
    case "NEW": {
      if (products.length === 0) {
        return { action: "Extract products", reason: "No products extracted yet — run AI extraction to identify items" };
      }
      if (!rfq.extractionReviewed) {
        return { action: "Review extraction", reason: `${products.length} products extracted, awaiting your review and confirmation` };
      }
      return { action: "Move to Sourcing", reason: "Products confirmed — ready to contact suppliers" };
    }

    case "SOURCING": {
      if (contacts.length === 0) {
        return { action: "Contact suppliers", reason: "No suppliers contacted yet — draft inquiry emails" };
      }
      if (overdueContacts.length > 0) {
        return {
          action: "Follow up with non-responders",
          reason: `${overdueContacts.length} supplier(s) haven't responded in 48h+`,
        };
      }
      if (quotes.length > 0 && respondedContacts.length >= contacts.length) {
        return { action: "Compare quotes", reason: "All contacted suppliers have responded — compare quotes now" };
      }
      if (quotes.length > 0) {
        return { action: "Compare quotes", reason: `${quotes.length} quote(s) received — you can start comparing` };
      }
      return { action: "Waiting for supplier responses", reason: `${contacts.length} supplier(s) contacted, awaiting replies` };
    }

    case "COMPARING": {
      if (quotes.length === 0) {
        return { action: "Log supplier quotes", reason: "No supplier quotes logged yet — add quotes to compare" };
      }
      if (customerQuotes.length === 0) {
        return { action: "Generate customer quote", reason: `${quotes.length} supplier quote(s) available — draft customer quote` };
      }
      return { action: "Review and finalize quote", reason: "Customer quote drafted — review and move to Quote Ready" };
    }

    case "QUOTE_READY": {
      return { action: "Send to customer", reason: "Quote is ready — send to customer via email" };
    }

    case "QUOTE_SENT": {
      if (hoursInStage > 72) {
        return { action: "Follow up with customer", reason: `Quote sent ${Math.round(hoursInStage / 24)} days ago — follow up` };
      }
      return { action: "Awaiting customer response", reason: `Quote sent ${Math.round(hoursInStage)}h ago` };
    }

    case "FOLLOW_UP": {
      return { action: "Mark as Won or Lost", reason: "Follow-up stage — close this RFQ with an outcome" };
    }

    default:
      return null;
  }
}

// ─── Step 6: Auto-advance stages ────────────────────────────────────────────

async function autoAdvanceStages(): Promise<number> {
  let advances = 0;

  // NEW → SOURCING: extraction confirmed + has products
  const newRfqs = await db
    .select()
    .from(rfqRecordsTable)
    .where(
      and(
        eq(rfqRecordsTable.stage, "NEW"),
        eq(rfqRecordsTable.extractionReviewed, true),
      ),
    );

  for (const rfq of newRfqs) {
    const contacts = await db
      .select({ id: rfqSupplierContactsTable.id })
      .from(rfqSupplierContactsTable)
      .where(eq(rfqSupplierContactsTable.rfqId, rfq.id))
      .limit(1);

    if (contacts.length > 0) {
      await db
        .update(rfqRecordsTable)
        .set({ stage: "SOURCING", stageUpdatedAt: new Date() })
        .where(eq(rfqRecordsTable.id, rfq.id));

      await logAction("stage_advance", rfq.id, {
        message: "Auto-advanced from NEW to SOURCING",
        from: "NEW",
        to: "SOURCING",
        reason: "Extraction confirmed and suppliers contacted",
      });
      advances++;
    }
  }

  // COMPARING → QUOTE_READY: customer quote exists
  const comparingRfqs = await db
    .select()
    .from(rfqRecordsTable)
    .where(eq(rfqRecordsTable.stage, "COMPARING"));

  for (const rfq of comparingRfqs) {
    const customerQuotes = await db
      .select({ id: rfqCustomerQuotesTable.id })
      .from(rfqCustomerQuotesTable)
      .where(eq(rfqCustomerQuotesTable.rfqId, rfq.id))
      .limit(1);

    if (customerQuotes.length > 0) {
      await db
        .update(rfqRecordsTable)
        .set({ stage: "QUOTE_READY", stageUpdatedAt: new Date() })
        .where(eq(rfqRecordsTable.id, rfq.id));

      await logAction("stage_advance", rfq.id, {
        message: "Auto-advanced from COMPARING to QUOTE_READY",
        from: "COMPARING",
        to: "QUOTE_READY",
        reason: "Customer quote has been generated",
      });
      advances++;
    }
  }

  return advances;
}

// ─── Daily Briefing ──────────────────────────────────────────────────────────

export async function generateDailyBriefing(): Promise<string> {
  const allRfqs = await db.select().from(rfqRecordsTable);

  const activeRfqs = allRfqs.filter((r) =>
    ACTIVE_STAGES.includes(r.stage as RfqStage),
  );
  const stuckRfqs = activeRfqs.filter((r) => r.isStuck);
  const wonThisMonth = allRfqs.filter((r) => {
    if (r.stage !== "WON") return false;
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    return new Date(r.stageUpdatedAt) >= start;
  });
  const lostThisMonth = allRfqs.filter((r) => {
    if (r.stage !== "LOST") return false;
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    return new Date(r.stageUpdatedAt) >= start;
  });

  const stageCounts: Record<string, number> = {};
  for (const stage of ACTIVE_STAGES) {
    stageCounts[stage] = activeRfqs.filter((r) => r.stage === stage).length;
  }

  const totalPipelineValue = activeRfqs.reduce(
    (sum, r) => sum + (r.estimatedValue ? parseFloat(r.estimatedValue) : 0),
    0,
  );

  // Get recent autopilot actions
  const recentActions = await db
    .select()
    .from(autopilotActionsTable)
    .where(sql`${autopilotActionsTable.createdAt} > NOW() - INTERVAL '24 hours'`)
    .limit(20);

  const highPriorityRfqs = activeRfqs
    .filter((r) => (r.priorityScore ?? 0) >= 70)
    .sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0))
    .slice(0, 5);

  const system = `You are the AI operations assistant for Lumina Supplies (B2B lab supplies, Riyadh, Saudi Arabia).

Generate a concise daily briefing for the operations team. Be direct, actionable, and professional.
Use this structure:
1. Pipeline snapshot (counts by stage, total value)
2. What needs attention (stuck RFQs, high-priority items)
3. Wins and losses this month
4. Key recommendations (2-3 actionable items)

Keep it under 300 words. Use bullet points for readability. Currency: SAR.`;

  const userMessage = `Pipeline data:
- Active RFQs: ${activeRfqs.length}
- Stage breakdown: ${JSON.stringify(stageCounts)}
- Total pipeline value: ${totalPipelineValue.toLocaleString()} SAR
- Stuck RFQs: ${stuckRfqs.length} (${stuckRfqs.map((r) => `${r.customerCompany ?? r.customerName} in ${r.stage}`).join(", ") || "none"})
- Won this month: ${wonThisMonth.length}
- Lost this month: ${lostThisMonth.length}
- High-priority RFQs: ${highPriorityRfqs.map((r) => `${r.customerCompany ?? r.customerName} (score:${r.priorityScore}, stage:${r.stage})`).join(", ") || "none"}
- Autopilot actions in last 24h: ${recentActions.length}`;

  try {
    const { text } = await callAI({
      system,
      userMessage,
      maxTokens: AI_MAX_TOKENS.AUTOPILOT_BRIEFING,
      model: AI_MODELS.HAIKU,
    });

    await logAction("daily_briefing", null, {
      message: "Daily briefing generated",
      briefing: text,
    });

    return text;
  } catch (err) {
    logger.warn({ err }, "Autopilot: daily briefing generation failed");
    return "Unable to generate daily briefing at this time.";
  }
}

// ─── Main Cycle ──────────────────────────────────────────────────────────────

export async function runAutopilotCycle(): Promise<{
  actions: number;
  durationMs: number;
}> {
  if (state.running) {
    logger.info("Autopilot: cycle already running, skipping");
    return { actions: 0, durationMs: 0 };
  }

  state.running = true;
  const startTime = Date.now();
  let totalActions = 0;

  try {
    logger.info("Autopilot: starting cycle");

    // Step 1: Auto-extract
    const extractions = await autoExtractNewRfqs();
    totalActions += extractions;
    state.stats.extractionsTriggered += extractions;

    // Step 2: Stuck detection
    const stuckAlerts = await detectStuckRfqs();
    totalActions += stuckAlerts;
    state.stats.stuckAlerts += stuckAlerts;

    // Step 3: Overdue supplier contacts
    const followups = await flagOverdueSupplierContacts();
    totalActions += followups;
    state.stats.followupSuggestions += followups;

    // Step 4: Priority scoring (only if there are active RFQs)
    const scored = await scorePriorities();
    state.stats.priorityScores += scored;

    // Step 5: Smart suggestions
    const suggestions = await generateSuggestions();
    totalActions += suggestions;

    // Step 6: Auto-advance stages
    const advances = await autoAdvanceStages();
    totalActions += advances;
    state.stats.stageAdvances += advances;

    const durationMs = Date.now() - startTime;
    state.stats.totalCycles++;
    state.stats.lastCycleActions = totalActions;
    state.stats.lastCycleDurationMs = durationMs;
    state.lastRunAt = new Date();

    logger.info(
      { totalActions, durationMs, extractions, stuckAlerts, followups, scored, suggestions, advances },
      "Autopilot: cycle complete",
    );

    return { actions: totalActions, durationMs };
  } catch (err) {
    logger.error({ err }, "Autopilot: cycle failed");
    return { actions: totalActions, durationMs: Date.now() - startTime };
  } finally {
    state.running = false;
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

function stopTimer(): void {
  if (state.timer !== null) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.nextRunAt = null;
}

function scheduleNext(intervalMinutes: number): void {
  state.nextRunAt = new Date(Date.now() + intervalMinutes * 60_000);
}

async function applySettings(): Promise<void> {
  stopTimer();

  const enabled = await readEnabledSetting();
  const intervalMinutes = await readIntervalSetting();

  state.enabled = enabled;
  state.intervalMinutes = intervalMinutes;

  if (!enabled) {
    logger.info("Autopilot: disabled");
    return;
  }

  const ms = intervalMinutes * 60_000;
  scheduleNext(intervalMinutes);

  state.timer = setInterval(async () => {
    const isEnabled = await readEnabledSetting();
    if (!isEnabled) {
      logger.info("Autopilot: disabled mid-cycle, stopping");
      stopTimer();
      state.enabled = false;
      return;
    }
    scheduleNext(intervalMinutes);
    await runAutopilotCycle();
  }, ms);

  logger.info({ intervalMinutes }, "Autopilot: scheduler started");
}

/** Called once at server boot. */
export async function startAutopilot(): Promise<void> {
  await applySettings();
}

/** Called when AUTOPILOT_ENABLED or AUTOPILOT_INTERVAL_MINUTES changes. */
export async function restartAutopilot(): Promise<void> {
  await applySettings();
}

/** Toggle autopilot on/off. */
export async function toggleAutopilot(enabled: boolean): Promise<void> {
  // Upsert the setting
  const existing = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.key, "AUTOPILOT_ENABLED"))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(appSettingsTable)
      .set({ value: enabled ? "true" : "false" })
      .where(eq(appSettingsTable.key, "AUTOPILOT_ENABLED"));
  } else {
    await db
      .insert(appSettingsTable)
      .values({ key: "AUTOPILOT_ENABLED", value: enabled ? "true" : "false" });
  }

  await applySettings();
}
