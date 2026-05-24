import { Router } from "express";
import { db } from "@workspace/db";
import { zohoConnectionsTable, emailThreadsTable, rfqRecordsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  getAllZohoConnections,
  zohoGetForConnection,
  type DecryptedZohoConnection,
} from "../lib/zohoClient.js";
import { callAI } from "../lib/aiClient.js";
import { AI_MODELS } from "../lib/aiClient.js";
import { AI_MAX_TOKENS } from "../lib/aiConstants.js";
import { logger } from "../lib/logger.js";

const router = Router();

// ─── Types ────────────────────────────────────────────────────────────────────

interface ZohoMessage {
  messageId: string;
  folderId?: string;
  subject?: string;
  fromAddress?: string;
  fromDisplayName?: string;
  receivedTime?: string;
  summary?: string;
  hasAttachment?: boolean;
}

interface ZohoMessageDetail {
  content?: string;           // HTML body
  textContent?: string;       // plain text body
  attachments?: Array<{ attachmentName?: string; fileName?: string }>;
}

export interface TriageResult {
  classification:
    | "RFQ"
    | "SUPPLIER_REPLY"
    | "CUSTOMER_FOLLOWUP"
    | "PO_INVOICE"
    | "INTERNAL"
    | "SPAM_NEWSLETTER"
    | "GENERAL"
    | "UNCLASSIFIED";
  confidence: "high" | "medium" | "low";
  reasoning: string;
}

// ─── HTML stripping ───────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ─── Fetch full message body from Zoho ───────────────────────────────────────

export async function fetchMessageBody(
  conn: DecryptedZohoConnection,
  messageId: string,
): Promise<{ bodyText: string; attachmentNames: string }> {
  try {
    const raw = (await zohoGetForConnection(
      conn,
      `/accounts/${conn.accountId}/messages/${messageId}`,
    )) as { data?: ZohoMessageDetail };

    const detail = raw.data ?? (raw as ZohoMessageDetail);
    const html = detail.content ?? detail.textContent ?? "";
    const bodyText = stripHtml(html).slice(0, 3000); // store up to 3000

    const attachmentNames =
      detail.attachments
        ?.map((a) => a.attachmentName ?? a.fileName ?? "attachment")
        .join(", ") || "none";

    return { bodyText, attachmentNames };
  } catch {
    return { bodyText: "", attachmentNames: "none" };
  }
}

// ─── AI triage ───────────────────────────────────────────────────────────────

const TRIAGE_SYSTEM = `You are an email classifier for Lumina Supplies, a B2B laboratory and scientific supplies company in Riyadh, Saudi Arabia.

Classify into ONE of:
RFQ, SUPPLIER_REPLY, CUSTOMER_FOLLOWUP, PO_INVOICE, INTERNAL, SPAM_NEWSLETTER, GENERAL

RFQ signals — classify as RFQ if ANY present:
- Subject or body contains: RFQ, quotation, quote, pricing, inquiry, enquiry, "please quote", "kindly provide", "we need", "price for", "request for quotation"
- Any catalogue numbers, part numbers, CAS numbers
- Sender from hospital, clinic, lab, university, or research institution domain
- Product names + quantities mentioned together
- Arabic pricing requests (طلب عرض سعر، تسعيرة، عرض أسعار)

SUPPLIER_REPLY signals:
- Sender is manufacturer or distributor
- Contains unit prices, lead times, MOQ
- "our best price", "please find attached our quotation"
- Price tables or product availability info

CRITICAL RULES:
- If unsure between RFQ and GENERAL and sender is a business — classify as RFQ
- Arabic emails: classify same as English, never default to GENERAL for Arabic content
- Emails with catalogue or part numbers = RFQ or SUPPLIER_REPLY, never GENERAL
- Automated system emails, alerts, notifications = SPAM_NEWSLETTER

Return ONLY valid JSON, no text outside JSON:
{
  "classification": "RFQ|SUPPLIER_REPLY|CUSTOMER_FOLLOWUP|PO_INVOICE|INTERNAL|SPAM_NEWSLETTER|GENERAL",
  "confidence": "high|medium|low",
  "reasoning": "one sentence max"
}`;

export async function triageEmail(opts: {
  senderName: string;
  senderEmail: string;
  subject: string;
  bodyText: string;
  attachmentNames: string;
}): Promise<TriageResult> {
  const senderDomain = opts.senderEmail.split("@")[1] ?? "";
  const truncatedBody = opts.bodyText.slice(0, 2000);

  const userMessage = `From: ${opts.senderName} <${opts.senderEmail}>
Domain: ${senderDomain}
Subject: ${opts.subject}
Attachments: ${opts.attachmentNames}
Body:
${truncatedBody || "(no body)"}`;

  const { text } = await callAI({
    system: TRIAGE_SYSTEM,
    userMessage,
    maxTokens: AI_MAX_TOKENS.EMAIL_TRIAGE,
    model: AI_MODELS.HAIKU,
  });

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    logger.warn({ text, subject: opts.subject }, "Triage returned no JSON");
    return { classification: "UNCLASSIFIED", confidence: "low", reasoning: "No JSON in response" };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Partial<TriageResult>;
    return {
      classification: parsed.classification ?? "UNCLASSIFIED",
      confidence: parsed.confidence ?? "low",
      reasoning: parsed.reasoning ?? "",
    };
  } catch {
    return { classification: "UNCLASSIFIED", confidence: "low", reasoning: "JSON parse failed" };
  }
}

// ─── Sync a single account ────────────────────────────────────────────────────

export async function syncAccount(
  conn: DecryptedZohoConnection,
  log: typeof logger,
): Promise<{ synced: number; rfqsCreated: number; errors: number }> {
  let synced = 0;
  let rfqsCreated = 0;
  let errors = 0;

  const accountData = (await zohoGetForConnection(
    conn,
    `/accounts/${conn.accountId}/messages/view?limit=50&start=1`,
  )) as { data?: ZohoMessage[] };

  const messages = accountData.data ?? [];
  log.info({ accountId: conn.accountId, label: conn.accountLabel, count: messages.length }, "Fetched messages");

  for (const message of messages) {
    const uniqueId = message.messageId;
    if (!uniqueId) {
      log.warn({ message }, "Message has no messageId — skipping");
      errors++;
      continue;
    }

    const threadKey = `${conn.accountId}:${uniqueId}`;

    const existing = await db
      .select({ id: emailThreadsTable.id })
      .from(emailThreadsTable)
      .where(eq(emailThreadsTable.threadId, threadKey))
      .limit(1);

    const receivedAt = message.receivedTime
      ? new Date(parseInt(message.receivedTime))
      : new Date();

    const senderEmail = message.fromAddress ?? "";
    const senderName = message.fromDisplayName ?? senderEmail.split("@")[0] ?? senderEmail;
    const subject = message.subject ?? "(no subject)";
    const snippet = message.summary ?? "";

    if (existing.length > 0) {
      // Already stored — skip (body already fetched)
      continue;
    }

    // ── Fetch full message body ──────────────────────────────────────────────
    const { bodyText, attachmentNames } = await fetchMessageBody(conn, uniqueId);

    // ── AI Triage ────────────────────────────────────────────────────────────
    let triageResult: TriageResult = {
      classification: "UNCLASSIFIED",
      confidence: "low",
      reasoning: "Triage not attempted",
    };

    try {
      triageResult = await triageEmail({
        senderName,
        senderEmail,
        subject,
        bodyText: bodyText || snippet,
        attachmentNames,
      });
      log.info(
        { messageId: uniqueId, classification: triageResult.classification, confidence: triageResult.confidence },
        "Triage complete",
      );
    } catch (err) {
      log.error(
        { err, messageId: uniqueId, subject },
        "AI triage failed — storing as UNCLASSIFIED (not General)",
      );
      triageResult = {
        classification: "UNCLASSIFIED",
        confidence: "low",
        reasoning: String(err),
      };
    }

    const isRfq = triageResult.classification === "RFQ";

    try {
      const [inserted] = await db
        .insert(emailThreadsTable)
        .values({
          threadId: threadKey,
          accountId: conn.accountId,
          folderId: message.folderId ?? null,
          subject,
          senderName,
          senderEmail,
          receivedAt,
          snippet: snippet || null,
          bodyText: bodyText || null,
          classification: triageResult.classification,
          aiConfidence: triageResult.confidence,
          aiReasoning: triageResult.reasoning,
          isRfq,
          hasAttachments: message.hasAttachment ?? false,
        })
        .returning();

      // Auto-link supplier replies to any open contact records by sender email.
      if (inserted && triageResult.classification === "SUPPLIER_REPLY") {
        try {
          const { autoLinkSupplierReply } = await import("./supplierContacts.js");
          const linked = await autoLinkSupplierReply({
            senderEmail,
            emailThreadId: inserted.id,
          });
          if (linked.length > 0) {
            log.info({ count: linked.length, threadId: inserted.id }, "Linked supplier reply to contacts");
          }
        } catch (err) {
          log.error({ err }, "autoLinkSupplierReply failed");
        }
      }

      if (isRfq && inserted) {
        const existingRfq = await db
          .select({ id: rfqRecordsTable.id })
          .from(rfqRecordsTable)
          .where(eq(rfqRecordsTable.emailThreadId, inserted.id))
          .limit(1);

        if (existingRfq.length === 0) {
          await db.insert(rfqRecordsTable).values({
            emailThreadId: inserted.id,
            customerName: senderName,
            customerEmail: senderEmail,
            stage: "NEW",
            urgency: "medium",
            sourceChannel: "inbound_email",
            aiNextAction: "Extract products from email and contact suppliers",
          });
          rfqsCreated++;
        }
      }
      synced++;
    } catch (err) {
      log.error({ err, messageId: uniqueId }, "Failed to save message to DB");
      errors++;
    }
  }

  await db
    .update(zohoConnectionsTable)
    .set({ lastSyncedAt: new Date() })
    .where(eq(zohoConnectionsTable.id, conn.id));

  return { synced, rfqsCreated, errors };
}

// ─── Shared syncAllAccounts (used by routes + auto-sync scheduler) ─────────────

export async function syncAllAccounts(log: typeof logger): Promise<{
  totalSynced: number;
  totalRfqs: number;
  totalErrors: number;
  accountResults: Array<{
    label: string;
    email: string;
    synced: number;
    rfqsCreated: number;
    errors: number;
    error?: string;
  }>;
}> {
  const connections = await getAllZohoConnections();
  let totalSynced = 0;
  let totalRfqs = 0;
  let totalErrors = 0;
  const accountResults: Array<{
    label: string;
    email: string;
    synced: number;
    rfqsCreated: number;
    errors: number;
    error?: string;
  }> = [];

  for (const conn of connections) {
    try {
      const result = await syncAccount(conn, log);
      totalSynced += result.synced;
      totalRfqs += result.rfqsCreated;
      totalErrors += result.errors;
      accountResults.push({ label: conn.accountLabel, email: conn.email, ...result });
    } catch (err) {
      log.error({ err, label: conn.accountLabel }, "Account sync failed");
      accountResults.push({
        label: conn.accountLabel,
        email: conn.email,
        synced: 0,
        rfqsCreated: 0,
        errors: 1,
        error: String(err),
      });
      totalErrors++;
    }
  }

  log.info({ totalSynced, totalRfqs, totalErrors }, "Full sync complete");
  return { totalSynced, totalRfqs, totalErrors, accountResults };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

router.post("/sync/run", async (req, res) => {
  try {
    const connections = await getAllZohoConnections();
    if (connections.length === 0) {
      res.status(400).json({ error: "No Zoho accounts connected. Configure them in Settings." });
      return;
    }

    const { totalSynced, totalRfqs, accountResults } = await syncAllAccounts(req.log);
    res.json({ ok: true, synced: totalSynced, rfqsCreated: totalRfqs, accounts: accountResults });
  } catch (err) {
    req.log.error({ err }, "Sync failed");
    res.status(500).json({ error: String(err) });
  }
});

// Sync a single Zoho account
router.post("/sync/run/:id", async (req, res) => {
  try {
    const id = parseInt(req.params["id"] ?? "0");
    const connections = await getAllZohoConnections();
    const conn = connections.find((c) => c.id === id);
    if (!conn) {
      res.status(404).json({ error: "Zoho account not found or inactive" });
      return;
    }
    const result = await syncAccount(conn, req.log);
    res.json({
      ok: true,
      synced: result.synced,
      rfqsCreated: result.rfqsCreated,
      accounts: [{ label: conn.accountLabel, email: conn.email, ...result }],
    });
  } catch (err) {
    req.log.error({ err }, "Per-account sync failed");
    res.status(500).json({ error: String(err) });
  }
});

router.get("/sync/status", async (req, res) => {
  try {
    const rows = await db
      .select({
        lastSyncedAt: zohoConnectionsTable.lastSyncedAt,
        email: zohoConnectionsTable.email,
        isActive: zohoConnectionsTable.isActive,
      })
      .from(zohoConnectionsTable)
      .where(eq(zohoConnectionsTable.isActive, true));

    const { getAutoSyncState } = await import("../lib/autoSync.js");
    const autoSync = getAutoSyncState();

    if (rows.length === 0) {
      res.json({
        connected: false,
        lastSyncedAt: null,
        autoSyncEnabled: autoSync.enabled,
        syncIntervalMinutes: autoSync.intervalMinutes,
        nextSyncAt: autoSync.nextSyncAt,
        accountErrors: autoSync.lastErrors,
      });
      return;
    }

    const latestSync = rows.reduce<Date | null>((latest, row) => {
      if (!row.lastSyncedAt) return latest;
      if (!latest) return row.lastSyncedAt;
      return row.lastSyncedAt > latest ? row.lastSyncedAt : latest;
    }, null);

    res.json({
      connected: true,
      email: rows[0]!.email,
      lastSyncedAt: latestSync,
      totalAccounts: rows.length,
      autoSyncEnabled: autoSync.enabled,
      syncIntervalMinutes: autoSync.intervalMinutes,
      nextSyncAt: autoSync.nextSyncAt,
      accountErrors: autoSync.lastErrors,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get sync status");
    res.status(500).json({ error: "Failed to get sync status" });
  }
});

export default router;
