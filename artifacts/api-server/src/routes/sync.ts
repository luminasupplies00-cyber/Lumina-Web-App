import { Router } from "express";
import { db } from "@workspace/db";
import {
  zohoConnectionsTable,
  emailThreadsTable,
  rfqRecordsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { getAllZohoConnections, zohoGetForConnection, type DecryptedZohoConnection } from "../lib/zohoClient.js";
import { callAI } from "../lib/aiClient.js";
import { AI_MAX_TOKENS } from "../lib/aiConstants.js";
import { logger } from "../lib/logger.js";

const router = Router();

// Zoho Mail API message structure (messages/view endpoint)
interface ZohoMessage {
  messageId: string;       // primary identifier
  threadId?: string;       // may or may not be present
  subject?: string;
  fromAddress?: string;
  fromDisplayName?: string;
  receivedTime?: string;   // unix ms as string
  summary?: string;
  hasAttachment?: boolean;
  folderId?: string;
}

interface TriageResult {
  classification:
    | "RFQ"
    | "Supplier Reply"
    | "Customer Follow-up"
    | "PO/Invoice"
    | "Internal"
    | "Spam/Newsletter"
    | "General";
  customer_name?: string;
  customer_company?: string;
  deadline?: string;
  urgency?: "low" | "medium" | "high";
  products?: Array<{
    product_name: string;
    catalogue_number?: string;
    brand?: string;
    quantity?: string;
    specifications?: string;
  }>;
}

async function triageEmail(thread: {
  subject: string;
  senderName: string;
  senderEmail: string;
  snippet: string;
}): Promise<TriageResult> {
  const system = `You are an email classifier for Lumina Supplies, a B2B laboratory supplies company in Riyadh, Saudi Arabia.

Classify the email into exactly one of these categories:
- RFQ (customer requesting a quotation for products)
- Supplier Reply (a supplier responding to our inquiry for pricing)
- Customer Follow-up (customer asking about a quote we sent)
- PO/Invoice (purchase order or invoice related)
- Internal (internal company email)
- Spam/Newsletter (marketing, spam, newsletters)
- General (anything else)

Respond ONLY with valid JSON in this exact format:
{
  "classification": "<one of the above categories>",
  "customer_name": "<string or null>",
  "customer_company": "<string or null>",
  "deadline": "<string or null>",
  "urgency": "<low|medium|high>",
  "products": []
}

Only populate products array if classification is RFQ and products are clearly mentioned.`;

  const userMessage = `Subject: ${thread.subject}
From: ${thread.senderName} <${thread.senderEmail}>

${thread.snippet}`;

  const { text } = await callAI({
    system,
    userMessage,
    maxTokens: AI_MAX_TOKENS.EMAIL_TRIAGE,
  });

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    logger.warn({ text }, "Triage response has no JSON, defaulting to General");
    return { classification: "General" };
  }

  try {
    return JSON.parse(jsonMatch[0]) as TriageResult;
  } catch {
    logger.warn({ text }, "Failed to parse triage JSON, defaulting to General");
    return { classification: "General" };
  }
}

async function syncAccount(
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
    // Use messageId as the unique identifier — this is what Zoho actually returns
    const uniqueId = message.messageId;
    if (!uniqueId) {
      log.warn({ message }, "Message has no messageId — skipping");
      errors++;
      continue;
    }

    // Prefix with account to avoid cross-account collisions
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
    const snippet = message.summary ?? "";
    const subject = message.subject ?? "(no subject)";

    let classification = "General";
    let isRfq = false;
    let triageResult: TriageResult | null = null;

    try {
      triageResult = await triageEmail({ subject, senderName, senderEmail, snippet });
      classification = triageResult.classification;
      isRfq = classification === "RFQ";
    } catch (err) {
      log.warn({ err, messageId: uniqueId }, "AI triage failed, skipping classification");
    }

    try {
      if (existing.length === 0) {
        const [inserted] = await db
          .insert(emailThreadsTable)
          .values({
            threadId: threadKey,
            subject,
            senderName,
            senderEmail,
            receivedAt,
            snippet: snippet || null,
            classification,
            isRfq,
            hasAttachments: message.hasAttachment ?? false,
          })
          .returning();

        if (isRfq && triageResult && inserted) {
          const existingRfq = await db
            .select({ id: rfqRecordsTable.id })
            .from(rfqRecordsTable)
            .where(eq(rfqRecordsTable.emailThreadId, inserted.id))
            .limit(1);

          if (existingRfq.length === 0) {
            await db.insert(rfqRecordsTable).values({
              emailThreadId: inserted.id,
              customerName: triageResult.customer_name ?? senderName,
              customerCompany: triageResult.customer_company ?? null,
              customerEmail: senderEmail,
              stage: "NEW",
              urgency: triageResult.urgency ?? "medium",
              deadline: triageResult.deadline ?? null,
              sourceChannel: "inbound_email",
              aiNextAction: "Extract products from email and contact suppliers",
            });
            rfqsCreated++;
          }
        }
        synced++;
      } else {
        // Update classification on existing threads
        await db
          .update(emailThreadsTable)
          .set({ classification, isRfq })
          .where(eq(emailThreadsTable.threadId, threadKey));
      }
    } catch (err) {
      log.error({ err, messageId: uniqueId }, "Failed to save message to DB");
      errors++;
    }
  }

  // Update last synced timestamp for this connection
  await db
    .update(zohoConnectionsTable)
    .set({ lastSyncedAt: new Date() })
    .where(eq(zohoConnectionsTable.id, conn.id));

  return { synced, rfqsCreated, errors };
}

router.post("/sync/run", async (req, res) => {
  try {
    const connections = await getAllZohoConnections();

    if (connections.length === 0) {
      res.status(400).json({ error: "No Zoho accounts connected. Configure them in Settings." });
      return;
    }

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
        const result = await syncAccount(conn, req.log);
        totalSynced += result.synced;
        totalRfqs += result.rfqsCreated;
        totalErrors += result.errors;
        accountResults.push({
          label: conn.accountLabel,
          email: conn.email,
          ...result,
        });
        req.log.info(
          { label: conn.accountLabel, email: conn.email, ...result },
          "Account sync complete",
        );
      } catch (err) {
        req.log.error({ err, label: conn.accountLabel, email: conn.email }, "Account sync failed");
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

    req.log.info({ totalSynced, totalRfqs, totalErrors }, "Full sync complete");
    res.json({
      ok: true,
      synced: totalSynced,
      rfqsCreated: totalRfqs,
      accounts: accountResults,
    });
  } catch (err) {
    req.log.error({ err }, "Sync failed");
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

    if (rows.length === 0) {
      res.json({ connected: false, lastSyncedAt: null });
      return;
    }

    // Return the most recent sync time across all accounts
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
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get sync status");
    res.status(500).json({ error: "Failed to get sync status" });
  }
});

export default router;
