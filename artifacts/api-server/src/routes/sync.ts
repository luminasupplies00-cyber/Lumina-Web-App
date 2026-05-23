import { Router } from "express";
import { db } from "@workspace/db";
import {
  zohoConnectionsTable,
  emailThreadsTable,
  rfqRecordsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { zohoGet, getZohoConnection, refreshZohoTokenIfNeeded } from "../lib/zohoClient.js";
import { callAI } from "../lib/aiClient.js";
import { AI_MAX_TOKENS } from "../lib/aiConstants.js";
import { logger } from "../lib/logger.js";

const router = Router();

interface ZohoThread {
  threadId: string;
  subject: string;
  fromAddress: string;
  fromDisplayName?: string;
  receivedTime: string;
  summary?: string;
  messageId?: string;
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
  "products": [
    {
      "product_name": "<string>",
      "catalogue_number": "<string or null>",
      "brand": "<string or null>",
      "quantity": "<string or null>",
      "specifications": "<string or null>"
    }
  ]
}

Only include products array if classification is RFQ and products are mentioned.
If not RFQ, set products to [].`;

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

router.post("/sync/run", async (req, res) => {
  try {
    const conn = await getZohoConnection();
    if (!conn) {
      res.status(400).json({ error: "Zoho not connected. Configure it in Settings." });
      return;
    }

    await refreshZohoTokenIfNeeded(conn);

    const accountData = (await zohoGet(`/accounts/${conn.accountId}/messages/view?limit=50&start=1`)) as {
      data?: ZohoThread[];
    };

    const threads = accountData.data ?? [];
    let synced = 0;
    let rfqsCreated = 0;

    for (const thread of threads) {
      const existing = await db
        .select({ id: emailThreadsTable.id })
        .from(emailThreadsTable)
        .where(eq(emailThreadsTable.threadId, thread.threadId))
        .limit(1);

      const receivedAt = thread.receivedTime
        ? new Date(parseInt(thread.receivedTime))
        : new Date();

      const senderParts = thread.fromAddress?.split("@") ?? [];
      const senderEmail = thread.fromAddress ?? "";
      const senderName = thread.fromDisplayName ?? senderParts[0] ?? senderEmail;
      const snippet = thread.summary ?? "";

      let classification = "General";
      let isRfq = false;
      let triageResult: TriageResult | null = null;

      try {
        triageResult = await triageEmail({
          subject: thread.subject ?? "(no subject)",
          senderName,
          senderEmail,
          snippet,
        });
        classification = triageResult.classification;
        isRfq = classification === "RFQ";
      } catch (err) {
        logger.warn({ err, threadId: thread.threadId }, "AI triage failed, skipping classification");
      }

      if (existing.length === 0) {
        const [inserted] = await db
          .insert(emailThreadsTable)
          .values({
            threadId: thread.threadId,
            subject: thread.subject ?? "(no subject)",
            senderName,
            senderEmail,
            receivedAt,
            snippet,
            classification,
            isRfq,
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
              aiNextAction: "Extract products from email and contact suppliers",
            });
            rfqsCreated++;
          }
        }
        synced++;
      } else {
        await db
          .update(emailThreadsTable)
          .set({ classification, isRfq })
          .where(eq(emailThreadsTable.threadId, thread.threadId));
      }
    }

    await db
      .update(zohoConnectionsTable)
      .set({ lastSyncedAt: new Date() })
      .where(eq(zohoConnectionsTable.id, conn.id));

    req.log.info({ synced, rfqsCreated }, "Sync complete");
    res.json({ ok: true, synced, rfqsCreated });
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
      })
      .from(zohoConnectionsTable)
      .limit(1);

    if (rows.length === 0) {
      res.json({ connected: false, lastSyncedAt: null });
      return;
    }

    res.json({
      connected: true,
      email: rows[0]!.email,
      lastSyncedAt: rows[0]!.lastSyncedAt,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get sync status");
    res.status(500).json({ error: "Failed to get sync status" });
  }
});

export default router;
