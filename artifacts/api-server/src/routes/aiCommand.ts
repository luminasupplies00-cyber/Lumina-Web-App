import { Router } from "express";
import { db } from "@workspace/db";
import {
  aiBrainMemoryTable,
  aiCommandsLogTable,
  rfqRecordsTable,
  rfqProductsTable,
  rfqSupplierContactsTable,
  RFQ_STAGES,
  BRAIN_MEMORY_CATEGORIES,
  type BrainMemoryCategory,
} from "@workspace/db";
import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { callClaude, AI_MODELS } from "../lib/aiClient.js";
import { invalidateBrainContextCache } from "../lib/aiBrainContext.js";

const router = Router();

// ─── Types ────────────────────────────────────────────────────────────────────
type Intent = "draft" | "find" | "training" | "unknown";
type ResponseType = "draft" | "list" | "memory_saved" | "message" | "error";

type DraftKind = "supplier_inquiry" | "customer_quote" | "follow_up" | "reply" | "other";
type FindKind =
  | "open_rfqs"
  | "stuck_rfqs"
  | "no_supplier_response"
  | "sent_quotes"
  | "won_rfqs"
  | "lost_rfqs";

interface Classification {
  intent: Intent;
  // For DRAFT
  draftKind?: DraftKind;
  target?: string;            // customer/RFQ identifier mentioned (e.g. "KFSH")
  draftBriefHint?: string;    // any extra direction the user gave
  // For FIND
  findKind?: FindKind;
  // For TRAINING
  ruleText?: string;          // the rule text after "Remember:"
  ruleCategory?: BrainMemoryCategory;
  ruleKey?: string;
  reason?: string;            // why unknown / why this classification
}

interface ResultItem {
  id?: number;
  title: string;
  subtitle?: string;
  href?: string;
  badges?: string[];
}

interface CommandResult {
  intent: Intent;
  responseType: ResponseType;
  message: string;
  draft?: { subject: string; body: string; rfqId?: number; draftKind?: string };
  items?: ResultItem[];
  memorySaved?: { category: string; key: string; value: string };
  suggestions?: string[];
  tokensUsed?: number;
}

// ─── Intent classifier ────────────────────────────────────────────────────────
const CLASSIFIER_SYSTEM = `You are an intent classifier for a B2B RFQ workflow tool. Given a user command, output STRICT JSON with the following schema and NOTHING ELSE:

{
  "intent": "draft" | "find" | "training" | "unknown",
  "draftKind": "supplier_inquiry" | "customer_quote" | "follow_up" | "reply" | "other" | null,
  "target": string | null,
  "draftBriefHint": string | null,
  "findKind": "open_rfqs" | "stuck_rfqs" | "no_supplier_response" | "sent_quotes" | "won_rfqs" | "lost_rfqs" | null,
  "ruleText": string | null,
  "ruleCategory": "company_profile" | "team" | "supplier_rule" | "customer_rule" | "behavior" | "template" | null,
  "ruleKey": string | null,
  "reason": string | null
}

Rules:
- "draft" = user wants you to write an email or text. Set draftKind. If they mention a customer / supplier / RFQ name, put it in "target".
- "find" = user wants you to look up data. Pick the closest findKind from the enum. If none fits, use "unknown" instead of guessing.
- "training" = command starts with "Remember", "Always", "Never", "From now on", or otherwise teaches a rule to remember. Put the rule body in ruleText and pick the best ruleCategory. ruleKey = a short label (3–6 words) summarising the rule.
- "unknown" = anything else (analysis questions, action commands, vague queries). Set "reason" to a brief explanation.
- Output JSON only. No prose, no markdown fences.`;

const VALID_INTENTS: Intent[] = ["draft", "find", "training", "unknown"];
const VALID_DRAFT_KINDS: DraftKind[] = [
  "supplier_inquiry", "customer_quote", "follow_up", "reply", "other",
];
const VALID_FIND_KINDS: FindKind[] = [
  "open_rfqs", "stuck_rfqs", "no_supplier_response", "sent_quotes", "won_rfqs", "lost_rfqs",
];

function normalizeEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (typeof value !== "string") return undefined;
  const lower = value.trim().toLowerCase();
  return allowed.find((a) => a === lower);
}

function normalizeClassification(raw: unknown): Classification {
  if (!raw || typeof raw !== "object") {
    return { intent: "unknown", reason: "Classifier returned a non-object" };
  }
  const o = raw as Record<string, unknown>;
  const intent = normalizeEnum(o["intent"], VALID_INTENTS) ?? "unknown";
  const cls: Classification = { intent };
  if (intent === "draft") {
    cls.draftKind = normalizeEnum(o["draftKind"], VALID_DRAFT_KINDS) ?? "other";
    if (typeof o["target"] === "string" && o["target"]) cls.target = o["target"];
    if (typeof o["draftBriefHint"] === "string" && o["draftBriefHint"]) cls.draftBriefHint = o["draftBriefHint"];
  } else if (intent === "find") {
    const k = normalizeEnum(o["findKind"], VALID_FIND_KINDS);
    if (k) cls.findKind = k;
    else {
      // Unknown find kind — drop to "unknown" so the user gets useful guidance.
      return { intent: "unknown", reason: "Could not match the query to a known find type" };
    }
  } else if (intent === "training") {
    if (typeof o["ruleText"] === "string") cls.ruleText = o["ruleText"];
    const cat = normalizeEnum(o["ruleCategory"], BRAIN_MEMORY_CATEGORIES);
    if (cat) cls.ruleCategory = cat as BrainMemoryCategory;
    if (typeof o["ruleKey"] === "string") cls.ruleKey = o["ruleKey"];
  }
  if (typeof o["reason"] === "string") cls.reason = o["reason"];
  return cls;
}

async function classify(text: string): Promise<{ cls: Classification }> {
  const raw = await callClaude({
    system: CLASSIFIER_SYSTEM,
    userMessage: text,
    maxTokens: 400,
    model: AI_MODELS.HAIKU,
    skipBrainContext: true,
  });
  const stripped = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    const parsed = JSON.parse(stripped) as unknown;
    return { cls: normalizeClassification(parsed) };
  } catch {
    return { cls: { intent: "unknown", reason: "Failed to parse classifier output" } };
  }
}

// ─── TRAINING handler ─────────────────────────────────────────────────────────
async function handleTraining(cls: Classification, originalText: string): Promise<CommandResult> {
  const rule = (cls.ruleText ?? originalText.replace(/^remember[:\s-]*/i, "")).trim();
  if (!rule) {
    return {
      intent: "training",
      responseType: "error",
      message: "I couldn't parse the rule. Try: 'Remember: our payment terms are Net 30'.",
    };
  }
  const category =
    cls.ruleCategory && BRAIN_MEMORY_CATEGORIES.includes(cls.ruleCategory)
      ? cls.ruleCategory
      : ("behavior" as BrainMemoryCategory);
  const key = (cls.ruleKey ?? rule.split(/[.,;]/)[0] ?? rule).slice(0, 80).trim();

  const [inserted] = await db
    .insert(aiBrainMemoryTable)
    .values({ category, key, value: rule, isActive: true })
    .returning();
  invalidateBrainContextCache();

  return {
    intent: "training",
    responseType: "memory_saved",
    message: `Got it — I'll remember this under ${formatCategory(category)}.`,
    memorySaved: { category, key: inserted?.key ?? key, value: inserted?.value ?? rule },
    suggestions: [
      "Show my saved rules",
      "Draft a supplier email for the latest RFQ",
    ],
  };
}

function formatCategory(cat: string): string {
  return cat.replace(/_/g, " ");
}

// ─── FIND handler ─────────────────────────────────────────────────────────────
async function handleFind(cls: Classification): Promise<CommandResult> {
  const kind = cls.findKind ?? "open_rfqs";
  switch (kind) {
    case "open_rfqs": {
      const rows = await db
        .select()
        .from(rfqRecordsTable)
        .where(inArray(rfqRecordsTable.stage, ["NEW", "SOURCING", "COMPARING", "QUOTE_READY"]))
        .orderBy(desc(rfqRecordsTable.createdAt))
        .limit(20);
      return listResult(
        rows.length === 0 ? "No open RFQs right now — your pipeline is clear." : `${rows.length} open RFQ${rows.length === 1 ? "" : "s"} found.`,
        rows.map((r) => ({
          id: r.id,
          title: `RFQ #${r.id} — ${r.customerCompany ?? r.customerName ?? "Unknown customer"}`,
          subtitle: r.notes ?? undefined,
          href: `/rfq?id=${r.id}`,
          badges: [r.stage],
        })),
      );
    }
    case "stuck_rfqs": {
      // Reuse the stuck-rfq logic by re-implementing the basic threshold check inline.
      const now = Date.now();
      const thresholds: Record<string, number> = {
        NEW: 4, SOURCING: 48, COMPARING: 24, QUOTE_READY: 4, QUOTE_SENT: 72, FOLLOW_UP: 120,
      };
      const rows = await db
        .select()
        .from(rfqRecordsTable)
        .where(inArray(rfqRecordsTable.stage, Object.keys(thresholds) as any))
        .orderBy(desc(rfqRecordsTable.stageUpdatedAt))
        .limit(50);
      const stuck = rows.filter((r) => {
        const hours = (now - new Date(r.stageUpdatedAt).getTime()) / 3_600_000;
        return hours > (thresholds[r.stage] ?? 999);
      });
      return listResult(
        stuck.length === 0
          ? "Nothing stuck — every RFQ is within its expected dwell time."
          : `${stuck.length} RFQ${stuck.length === 1 ? "" : "s"} past the expected stage time.`,
        stuck.map((r) => {
          const hours = Math.round((now - new Date(r.stageUpdatedAt).getTime()) / 3_600_000);
          return {
            id: r.id,
            title: `RFQ #${r.id} — ${r.customerCompany ?? r.customerName ?? "Unknown"}`,
            subtitle: `Stuck in ${r.stage} for ${hours}h`,
            href: `/rfq?id=${r.id}`,
            badges: [r.stage, `${hours}h`],
          };
        }),
      );
    }
    case "no_supplier_response": {
      const rows = await db
        .select()
        .from(rfqSupplierContactsTable)
        .where(
          and(
            eq(rfqSupplierContactsTable.status, "contacted"),
            isNull(rfqSupplierContactsTable.respondedAt),
          ),
        )
        .orderBy(desc(rfqSupplierContactsTable.contactedAt))
        .limit(20);
      const now = Date.now();
      return listResult(
        rows.length === 0 ? "All contacted suppliers have replied." : `${rows.length} supplier contact${rows.length === 1 ? "" : "s"} still awaiting reply.`,
        rows.map((r) => {
          const hours = Math.round((now - new Date(r.contactedAt).getTime()) / 3_600_000);
          return {
            id: r.id,
            title: r.supplierName,
            subtitle: `RFQ #${r.rfqId} · contacted ${hours}h ago · ${r.supplierEmail}`,
            href: `/rfq?id=${r.rfqId}`,
            badges: [`${hours}h`],
          };
        }),
      );
    }
    case "sent_quotes": {
      const rows = await db
        .select()
        .from(rfqRecordsTable)
        .where(inArray(rfqRecordsTable.stage, ["QUOTE_SENT", "FOLLOW_UP"]))
        .orderBy(desc(rfqRecordsTable.stageUpdatedAt))
        .limit(20);
      return listResult(
        rows.length === 0 ? "No quotes are currently awaiting a customer response." : `${rows.length} quote${rows.length === 1 ? "" : "s"} awaiting customer response.`,
        rows.map((r) => ({
          id: r.id,
          title: `RFQ #${r.id} — ${r.customerCompany ?? r.customerName ?? "Unknown"}`,
          subtitle: r.notes ?? undefined,
          href: `/rfq?id=${r.id}`,
          badges: [r.stage],
        })),
      );
    }
    case "won_rfqs":
    case "lost_rfqs": {
      const stage = kind === "won_rfqs" ? "WON" : "LOST";
      const rows = await db
        .select()
        .from(rfqRecordsTable)
        .where(eq(rfqRecordsTable.stage, stage))
        .orderBy(desc(rfqRecordsTable.stageUpdatedAt))
        .limit(20);
      return listResult(
        rows.length === 0 ? `No ${stage.toLowerCase()} RFQs.` : `${rows.length} ${stage.toLowerCase()} RFQ${rows.length === 1 ? "" : "s"}.`,
        rows.map((r) => ({
          id: r.id,
          title: `RFQ #${r.id} — ${r.customerCompany ?? r.customerName ?? "Unknown"}`,
          subtitle: r.notes ?? undefined,
          href: `/rfq?id=${r.id}`,
          badges: [r.stage],
        })),
      );
    }
  }
}

function listResult(message: string, items: ResultItem[]): CommandResult {
  return { intent: "find", responseType: "list", message, items };
}

// ─── DRAFT handler ────────────────────────────────────────────────────────────
async function findRfqByTarget(target: string | undefined | null): Promise<typeof rfqRecordsTable.$inferSelect | null> {
  if (!target) return null;
  const idMatch = target.match(/\b(\d+)\b/);
  if (idMatch) {
    const id = parseInt(idMatch[1]!);
    const byId = await db.select().from(rfqRecordsTable).where(eq(rfqRecordsTable.id, id)).limit(1);
    if (byId[0]) return byId[0];
  }
  const needle = `%${target.trim()}%`;
  const rows = await db
    .select()
    .from(rfqRecordsTable)
    .where(
      or(
        ilike(rfqRecordsTable.customerCompany, needle),
        ilike(rfqRecordsTable.customerName, needle),
        ilike(rfqRecordsTable.notes, needle),
        ilike(rfqRecordsTable.customerEmail, needle),
      ),
    )
    .orderBy(desc(rfqRecordsTable.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

async function handleDraft(cls: Classification, originalText: string): Promise<CommandResult> {
  const rfq = await findRfqByTarget(cls.target);
  let rfqContext = "";
  if (rfq) {
    const products = await db
      .select()
      .from(rfqProductsTable)
      .where(eq(rfqProductsTable.rfqId, rfq.id))
      .limit(20);
    const productLines = products
      .map((p) => `- ${p.productName}${p.quantity ? ` x${p.quantity}` : ""}${p.specifications ? ` (${p.specifications})` : ""}`)
      .join("\n");
    rfqContext = `\n\nRFQ #${rfq.id} context:
- Customer: ${rfq.customerCompany ?? rfq.customerName ?? "Unknown"}${rfq.customerEmail ? ` <${rfq.customerEmail}>` : ""}
- Stage: ${rfq.stage}
- Subject: ${rfq.notes ?? "(none)"}
${productLines ? `- Products:\n${productLines}` : ""}`;
  }

  const kind = cls.draftKind ?? "other";
  const KIND_GUIDE: Record<DraftKind, string> = {
    supplier_inquiry: "an RFQ inquiry to a supplier asking for pricing, availability, lead time, MOQ. Keep it concise and professional. End with a clear deadline if relevant.",
    customer_quote: "a customer quotation cover email. Include greeting, brief intro, mention the attached quote, validity (30 days unless overridden), payment terms (Net 30 unless overridden), and a polite call to action.",
    follow_up: "a polite follow-up to check on a previously-sent email. Reference the prior context briefly and ask for a status update.",
    reply: "a contextual reply to the customer or supplier's last message.",
    other: "the email the user described.",
  };

  const system = `Draft ${KIND_GUIDE[kind]}

Output STRICT JSON only:
{ "subject": string, "body": string }

Rules:
- subject is a short, descriptive line. No "Re:" unless explicitly a reply.
- body is plaintext (no markdown), 80–180 words typical.
- Use the company signoff from the AI behavior settings.
- Do NOT include placeholder tokens like [Name] or [Date] unless the actual value isn't available — in that case use a clean placeholder like "[YOUR NAME]".
- Reference the RFQ details below if provided.${rfqContext}`;

  const userMessage = `User command: ${originalText}${cls.draftBriefHint ? `\n\nExtra direction: ${cls.draftBriefHint}` : ""}`;

  const raw = await callClaude({
    system,
    userMessage,
    maxTokens: 800,
    model: AI_MODELS.CLAUDE,
  });
  const stripped = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let parsed: { subject?: string; body?: string };
  try {
    parsed = JSON.parse(stripped);
  } catch {
    // Fallback — treat the entire raw output as the body and synthesize a subject.
    parsed = { subject: cls.target ? `Re: ${cls.target}` : "Draft", body: raw.trim() };
  }
  if (!parsed.subject || !parsed.body) {
    return {
      intent: "draft",
      responseType: "error",
      message: "The AI returned an unexpected format. Try rephrasing your command.",
    };
  }
  const message = rfq
    ? `Drafted for RFQ #${rfq.id} — ${rfq.customerCompany ?? rfq.customerName ?? "Unknown"}.`
    : cls.target
    ? `Drafted (couldn't match "${cls.target}" to a specific RFQ — added context where possible).`
    : "Draft ready.";
  return {
    intent: "draft",
    responseType: "draft",
    message,
    draft: {
      subject: parsed.subject,
      body: parsed.body,
      ...(rfq && { rfqId: rfq.id }),
      draftKind: kind,
    },
    suggestions: rfq
      ? [`Open RFQ #${rfq.id}`, "Show stuck RFQs", "Show suppliers awaiting reply"]
      : ["Show open RFQs", "Show stuck RFQs"],
  };
}

// ─── Route ────────────────────────────────────────────────────────────────────
router.post("/ai/command", async (req, res) => {
  const startedAt = Date.now();
  const text = ((req.body as { text?: string })?.text ?? "").trim();
  if (!text) {
    res.status(400).json({ error: "text is required" });
    return;
  }

  let intent: Intent = "unknown";
  let result: CommandResult;
  let success = false;
  let errorMessage: string | null = null;

  try {
    const { cls } = await classify(text);
    intent = cls.intent;
    switch (cls.intent) {
      case "training":
        result = await handleTraining(cls, text);
        break;
      case "find":
        result = await handleFind(cls);
        break;
      case "draft":
        result = await handleDraft(cls, text);
        break;
      default:
        result = {
          intent: "unknown",
          responseType: "message",
          message:
            cls.reason
              ? `I didn't catch that — ${cls.reason}. Phase 1 supports drafting emails, finding RFQs/suppliers, and 'Remember:' rules.`
              : "I'm not sure how to handle that yet. Phase 1 supports drafting emails, finding RFQs/suppliers, and 'Remember:' rules.",
          suggestions: [
            "Draft a supplier email for the most recent RFQ",
            "Show open RFQs",
            "Show stuck RFQs",
            "Remember: our payment terms are Net 30",
          ],
        };
    }
    success = result.responseType !== "error";
  } catch (err) {
    req.log.error({ err }, "AI command failed");
    errorMessage = (err as Error)?.message ?? String(err);
    result = {
      intent,
      responseType: "error",
      message: `Command failed: ${errorMessage}`,
    };
  }

  // Log to ai_commands_log — best effort, never block the response.
  void db
    .insert(aiCommandsLogTable)
    .values({
      commandText: text,
      intentDetected: intent,
      responseType: result.responseType,
      responseSummary: result.message.slice(0, 500),
      executionTimeMs: Date.now() - startedAt,
      success,
      errorMessage,
    })
    .catch((logErr) => req.log.warn({ err: logErr }, "ai_commands_log insert failed"));

  res.json(result);
});

router.get("/ai/brain/commands", async (req, res) => {
  const limit = Math.min(parseInt((req.query["limit"] as string) ?? "10") || 10, 50);
  const rows = await db
    .select()
    .from(aiCommandsLogTable)
    .orderBy(desc(aiCommandsLogTable.createdAt))
    .limit(limit);
  res.json({
    commands: rows.map((r) => ({
      id: r.id,
      commandText: r.commandText,
      intentDetected: r.intentDetected,
      responseType: r.responseType,
      responseSummary: r.responseSummary,
      success: r.success,
      createdAt: r.createdAt,
    })),
  });
});

export default router;

// Silence unused-import warnings for symbols kept for future phases.
void sql;
