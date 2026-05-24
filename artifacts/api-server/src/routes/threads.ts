import { Router } from "express";
import { db } from "@workspace/db";
import { emailThreadsTable, rfqRecordsTable, zohoConnectionsTable } from "@workspace/db";
import { and, eq, desc, ilike, or, sql, isNull, type SQL } from "drizzle-orm";
import {
  getAllZohoConnections,
  fetchFullMessage,
  findMessageFolderId,
  searchMessagesBySubject,
  normalizeSubject,
  markMessageRead,
  archiveMessage,
  trashMessage,
  sendMessage,
  downloadAttachment,
} from "../lib/zohoClient.js";
import { callClaude, AI_MODELS } from "../lib/aiClient.js";
import { AI_MAX_TOKENS } from "../lib/aiConstants.js";

const router = Router();

async function getConnForThread(threadId: number) {
  const [row] = await db
    .select()
    .from(emailThreadsTable)
    .where(eq(emailThreadsTable.id, threadId))
    .limit(1);
  if (!row) return { thread: null as null, conn: null as null };
  if (!row.accountId) return { thread: row, conn: null };
  const conns = await getAllZohoConnections();
  const conn = conns.find((c) => c.accountId === row.accountId) ?? null;
  return { thread: row, conn };
}

function extractMessageId(threadKey: string): string {
  // Stored as "{accountId}:{messageId}"
  const idx = threadKey.indexOf(":");
  return idx >= 0 ? threadKey.slice(idx + 1) : threadKey;
}

router.get("/threads", async (req, res) => {
  try {
    const { classification, search, accountId } = req.query as Record<string, string>;

    const conditions: SQL[] = [];
    if (classification && classification !== "all" && classification !== "All") {
      conditions.push(eq(emailThreadsTable.classification, classification));
    }
    if (accountId && accountId !== "all" && accountId !== "All") {
      conditions.push(eq(emailThreadsTable.accountId, accountId));
    }
    if (search) {
      const like = `%${search}%`;
      const matched = or(
        ilike(emailThreadsTable.senderName, like),
        ilike(emailThreadsTable.senderEmail, like),
        ilike(emailThreadsTable.subject, like),
      );
      if (matched) conditions.push(matched);
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select({
        thread: emailThreadsTable,
        rfqId: rfqRecordsTable.id,
      })
      .from(emailThreadsTable)
      .leftJoin(rfqRecordsTable, eq(rfqRecordsTable.emailThreadId, emailThreadsTable.id))
      .where(where)
      .orderBy(desc(emailThreadsTable.receivedAt));

    const threads = rows.map((r) => ({ ...r.thread, rfqId: r.rfqId }));
    res.json({ threads });
  } catch (err) {
    req.log.error({ err }, "Failed to get threads");
    res.status(500).json({ error: "Failed to retrieve email threads" });
  }
});

// POST /threads/:id/create-rfq — manually create an rfq_record from an email thread (idempotent)
router.post("/threads/:id/create-rfq", async (req, res) => {
  try {
    const id = parseInt(req.params["id"] ?? "0");
    const [thread] = await db.select().from(emailThreadsTable).where(eq(emailThreadsTable.id, id)).limit(1);
    if (!thread) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }
    const [existing] = await db
      .select({ id: rfqRecordsTable.id })
      .from(rfqRecordsTable)
      .where(eq(rfqRecordsTable.emailThreadId, thread.id))
      .limit(1);
    if (existing) {
      res.json({ ok: true, rfqId: existing.id, created: false });
      return;
    }
    const [created] = await db
      .insert(rfqRecordsTable)
      .values({
        emailThreadId: thread.id,
        customerName: thread.senderName,
        customerEmail: thread.senderEmail,
        stage: "NEW",
        urgency: "medium",
        sourceChannel: "inbound_email",
        aiNextAction: "Extract products from email and contact suppliers",
      })
      .returning({ id: rfqRecordsTable.id });
    req.log.info({ threadId: thread.id, rfqId: created?.id, subject: thread.subject }, "Created RFQ record from thread");
    res.json({ ok: true, rfqId: created?.id, created: true });
  } catch (err) {
    req.log.error({ err }, "Failed to create RFQ from thread");
    res.status(500).json({ error: "Failed to create RFQ" });
  }
});

// POST /threads/backfill-rfqs — create rfq_records for any RFQ-classified threads missing one
router.post("/threads/backfill-rfqs", async (req, res) => {
  try {
    const orphans = await db
      .select({ thread: emailThreadsTable })
      .from(emailThreadsTable)
      .leftJoin(rfqRecordsTable, eq(rfqRecordsTable.emailThreadId, emailThreadsTable.id))
      .where(and(eq(emailThreadsTable.classification, "RFQ"), isNull(rfqRecordsTable.id)));

    let created = 0;
    for (const { thread } of orphans) {
      await db.insert(rfqRecordsTable).values({
        emailThreadId: thread.id,
        customerName: thread.senderName,
        customerEmail: thread.senderEmail,
        stage: "NEW",
        urgency: "medium",
        sourceChannel: "inbound_email",
        aiNextAction: "Extract products from email and contact suppliers",
      });
      created++;
    }
    req.log.info({ created, scanned: orphans.length }, "Backfilled RFQ records from email threads");
    res.json({ ok: true, created, scanned: orphans.length });
  } catch (err) {
    req.log.error({ err }, "Failed to backfill RFQ records");
    res.status(500).json({ error: "Failed to backfill RFQ records" });
  }
});

// Per-account counts — used by the inbox tabs
router.get("/threads/counts", async (req, res) => {
  try {
    const rows = await db
      .select({
        accountId: emailThreadsTable.accountId,
        count: sql<number>`count(*)::int`,
      })
      .from(emailThreadsTable)
      .groupBy(emailThreadsTable.accountId);

    const counts: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      total += row.count;
      if (row.accountId) counts[row.accountId] = row.count;
    }
    res.json({ counts, total });
  } catch (err) {
    req.log.error({ err }, "Failed to get thread counts");
    res.status(500).json({ error: "Failed to retrieve thread counts" });
  }
});

router.get("/threads/:id", async (req, res) => {
  try {
    const id = parseInt(req.params["id"] ?? "0");
    const rows = await db
      .select()
      .from(emailThreadsTable)
      .where(eq(emailThreadsTable.id, id))
      .limit(1);

    if (!rows[0]) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }

    res.json({ thread: rows[0] });
  } catch (err) {
    req.log.error({ err }, "Failed to get thread");
    res.status(500).json({ error: "Failed to retrieve thread" });
  }
});

// GET /threads/:id/conversation — return all messages in the same conversation (across folders)
router.get("/threads/:id/conversation", async (req, res) => {
  try {
    const id = parseInt(req.params["id"] ?? "0");
    const { thread, conn } = await getConnForThread(id);
    if (!thread) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }
    if (!conn) {
      res.status(400).json({ error: "Zoho account for this thread is no longer connected" });
      return;
    }
    const currentMessageId = extractMessageId(thread.threadId);
    const normalized = normalizeSubject(thread.subject);
    const candidates = await searchMessagesBySubject(conn, normalized);

    // Ensure the current message is included (search may miss it for older items)
    const seen = new Set<string>();
    type Item = {
      messageId: string;
      folderId: string;
      fromAddress?: string;
      fromDisplayName?: string;
      toAddress?: string;
      subject?: string;
      summary?: string;
      receivedTime?: string;
    };
    const items: Item[] = [];
    for (const c of candidates) {
      if (!c.messageId || !c.folderId || seen.has(c.messageId)) continue;
      // Strict normalized-subject match to avoid false positives from substring hits.
      if (normalizeSubject(c.subject ?? "") !== normalized) continue;
      seen.add(c.messageId);
      const item: Item = { messageId: c.messageId, folderId: c.folderId };
      if (c.fromAddress) item.fromAddress = c.fromAddress;
      if (c.fromDisplayName) item.fromDisplayName = c.fromDisplayName;
      if (c.toAddress) item.toAddress = c.toAddress;
      if (c.subject) item.subject = c.subject;
      if (c.summary) item.summary = c.summary;
      if (c.receivedTime) item.receivedTime = c.receivedTime;
      items.push(item);
    }
    if (!seen.has(currentMessageId) && thread.folderId) {
      items.push({
        messageId: currentMessageId,
        folderId: thread.folderId,
        fromAddress: thread.senderEmail,
        fromDisplayName: thread.senderName,
        subject: thread.subject,
        summary: thread.snippet ?? undefined,
        receivedTime: String(thread.receivedAt.getTime()),
      });
    }
    // Cap to 25 to avoid runaway parallel fetches
    const limited = items.slice(0, 25);
    // Fetch each body in parallel (with light concurrency)
    const detailed = await Promise.all(
      limited.map(async (m) => {
        try {
          const d = await fetchFullMessage(conn, m.messageId, m.folderId);
          const fromEmail = m.fromAddress ?? "";
          return {
            messageId: m.messageId,
            folderId: m.folderId,
            fromName: m.fromDisplayName ?? fromEmail.split("@")[0] ?? fromEmail,
            fromEmail,
            toAddress: m.toAddress ?? null,
            subject: m.subject ?? null,
            receivedAt: m.receivedTime
              ? new Date(parseInt(m.receivedTime)).toISOString()
              : new Date().toISOString(),
            snippet: m.summary ?? null,
            bodyHtml: d.bodyHtml,
            bodyText: d.bodyText,
            attachments: d.attachments,
            isCurrent: m.messageId === currentMessageId,
            direction: fromEmail.toLowerCase() === conn.email.toLowerCase() ? "outgoing" : "incoming",
          };
        } catch (err) {
          req.log.warn({ err, messageId: m.messageId }, "Conversation: skipping message that failed to fetch");
          return null;
        }
      }),
    );
    const messages = detailed
      .filter((m): m is NonNullable<typeof m> => m !== null)
      .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
    res.json({ messages, currentMessageId });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch conversation");
    const msg = err instanceof Error ? err.message : "Failed to fetch conversation";
    res.status(500).json({ error: msg });
  }
});

// GET /threads/:id/full — fetch HTML body + attachments from Zoho, cache to DB, mark read
router.get("/threads/:id/full", async (req, res) => {
  try {
    const id = parseInt(req.params["id"] ?? "0");
    const { thread, conn } = await getConnForThread(id);
    if (!thread) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }
    // Cache hit if the full body has previously been fetched. We treat the
    // presence of bodyHtml OR a non-empty bodyText (after first fetch) as a
    // cached state. Empty HTML emails (plaintext-only) would otherwise re-fetch
    // every open.
    // Cache is invalid if we have never confirmed the attachments list against
    // Zoho's /attachmentinfo endpoint (legacy rows where attachments may have
    // been wrongly stored as [] from a buggy fetch).
    const attachmentsCacheStale = thread.attachmentsVerifiedAt == null;
    const isCached = thread.bodyHtml !== null && thread.bodyHtml !== undefined && !attachmentsCacheStale;
    const messageId = extractMessageId(thread.threadId);

    // Always ensure the email is marked read on open (covers both cached and
    // fresh fetch paths). Local DB first; Zoho best-effort if connected.
    const markReadEverywhere = async () => {
      if (!thread.isRead) {
        await db
          .update(emailThreadsTable)
          .set({ isRead: true })
          .where(eq(emailThreadsTable.id, id));
      }
      if (conn) {
        markMessageRead(conn, messageId, true).catch((err) =>
          req.log.warn({ err, threadId: id }, "Failed to mark read in Zoho"),
        );
      }
    };

    if (isCached) {
      await markReadEverywhere();
      res.json({
        thread: { ...thread, isRead: true },
        bodyHtml: thread.bodyHtml ?? "",
        bodyText: thread.bodyText ?? "",
        attachments: thread.attachments ?? [],
        cached: true,
      });
      return;
    }
    if (!conn) {
      res.status(400).json({ error: "Zoho account for this thread is no longer connected" });
      return;
    }
    let folderId = thread.folderId;
    if (!folderId) {
      folderId = await findMessageFolderId(conn, messageId);
      if (!folderId) {
        res.status(404).json({
          error: "Message not found in recent Zoho inbox — it may have been moved or deleted",
        });
        return;
      }
      await db
        .update(emailThreadsTable)
        .set({ folderId })
        .where(eq(emailThreadsTable.id, id));
    }
    const detail = await fetchFullMessage(conn, messageId, folderId);
    await db
      .update(emailThreadsTable)
      .set({
        bodyHtml: detail.bodyHtml,
        bodyText: detail.bodyText || thread.bodyText,
        attachments: detail.attachments,
        // Preserve a prior positive signal — only flip to false when both
        // sources agree there are none. This avoids a transient
        // /attachmentinfo failure clearing the flag and re-poisoning the cache.
        hasAttachments: detail.attachments.length > 0 || thread.hasAttachments === true,
        attachmentsVerifiedAt: new Date(),
        isRead: true,
      })
      .where(eq(emailThreadsTable.id, id));
    markMessageRead(conn, messageId, true).catch((err) =>
      req.log.warn({ err, threadId: id }, "Failed to mark read in Zoho"),
    );
    res.json({
      thread: { ...thread, bodyHtml: detail.bodyHtml, attachments: detail.attachments, isRead: true },
      bodyHtml: detail.bodyHtml,
      bodyText: detail.bodyText,
      attachments: detail.attachments,
      cached: false,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch full thread");
    const msg = err instanceof Error ? err.message : "Failed to fetch full email";
    res.status(500).json({ error: msg });
  }
});

// POST /threads/:id/mark-read — { isRead: boolean }
router.post("/threads/:id/mark-read", async (req, res) => {
  try {
    const id = parseInt(req.params["id"] ?? "0");
    const isRead = !!(req.body as { isRead?: boolean }).isRead;
    const { thread, conn } = await getConnForThread(id);
    if (!thread) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }
    if (conn) {
      await markMessageRead(conn, extractMessageId(thread.threadId), isRead);
    }
    await db.update(emailThreadsTable).set({ isRead }).where(eq(emailThreadsTable.id, id));
    res.json({ ok: true, isRead });
  } catch (err) {
    req.log.error({ err }, "Failed to update read state");
    const msg = err instanceof Error ? err.message : "Failed to update read state";
    res.status(500).json({ error: msg });
  }
});

// POST /threads/:id/archive — move to Archive folder in Zoho, remove from local inbox view
router.post("/threads/:id/archive", async (req, res) => {
  try {
    const id = parseInt(req.params["id"] ?? "0");
    const { thread, conn } = await getConnForThread(id);
    if (!thread) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }
    if (!conn) {
      res.status(400).json({ error: "Zoho account no longer connected" });
      return;
    }
    await archiveMessage(conn, extractMessageId(thread.threadId));
    await db.delete(emailThreadsTable).where(eq(emailThreadsTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to archive");
    const msg = err instanceof Error ? err.message : "Failed to archive";
    res.status(500).json({ error: msg });
  }
});

// DELETE /threads/:id — move to Trash in Zoho, remove from local inbox view
router.delete("/threads/:id", async (req, res) => {
  try {
    const id = parseInt(req.params["id"] ?? "0");
    const { thread, conn } = await getConnForThread(id);
    if (!thread) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }
    if (!conn) {
      res.status(400).json({ error: "Zoho account no longer connected" });
      return;
    }
    await trashMessage(conn, extractMessageId(thread.threadId));
    await db.delete(emailThreadsTable).where(eq(emailThreadsTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete");
    const msg = err instanceof Error ? err.message : "Failed to delete";
    res.status(500).json({ error: msg });
  }
});

// POST /threads/:id/summarize — Claude summary
router.post("/threads/:id/summarize", async (req, res) => {
  try {
    const id = parseInt(req.params["id"] ?? "0");
    const [thread] = await db
      .select()
      .from(emailThreadsTable)
      .where(eq(emailThreadsTable.id, id))
      .limit(1);
    if (!thread) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }
    const body = thread.bodyText || thread.snippet || "";
    if (!body) {
      res.status(400).json({ error: "Email has no body to summarize. Open the email first." });
      return;
    }
    const system =
      "You summarize a single business email for a B2B sales operator. Always reply in strict JSON with keys: summary (2-3 sentences), action (one short imperative sentence describing what the operator should do next), deadline (string like '2026-05-30' or 'none'). No markdown.";
    const userMessage = `Subject: ${thread.subject}\nFrom: ${thread.senderName} <${thread.senderEmail}>\n\n${body.slice(0, 8000)}`;
    const text = await callClaude({
      system,
      userMessage,
      maxTokens: AI_MAX_TOKENS.SUMMARIZE,
      model: AI_MODELS.HAIKU,
    });
    // Try to parse JSON robustly
    let parsed: { summary: string; action: string; deadline: string } = {
      summary: text.trim(),
      action: "",
      deadline: "none",
    };
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const obj = JSON.parse(jsonMatch[0]) as Partial<typeof parsed>;
        parsed = {
          summary: String(obj.summary ?? parsed.summary),
          action: String(obj.action ?? ""),
          deadline: String(obj.deadline ?? "none"),
        };
      } catch {
        // keep fallback
      }
    }
    res.json(parsed);
  } catch (err) {
    req.log.error({ err }, "Failed to summarize");
    const msg = err instanceof Error ? err.message : "Failed to summarize";
    res.status(500).json({ error: msg });
  }
});

// POST /threads/:id/draft-reply — Claude draft reply
router.post("/threads/:id/draft-reply", async (req, res) => {
  try {
    const id = parseInt(req.params["id"] ?? "0");
    const [thread] = await db
      .select()
      .from(emailThreadsTable)
      .where(eq(emailThreadsTable.id, id))
      .limit(1);
    if (!thread) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }
    const body = thread.bodyText || thread.snippet || "";
    const classification = thread.classification ?? "GENERAL";
    const guidance: Record<string, string> = {
      RFQ:
        "Acknowledge receipt of the RFQ, confirm Lumina Supplies is checking availability and pricing, and commit to revert with a competitive quotation shortly. Mention DDP delivery to KSA if relevant. Keep it warm and professional.",
      SUPPLIER_REPLY:
        "Acknowledge the supplier's quotation, thank them, and confirm Lumina Supplies will review and revert with next steps. Ask for any missing detail (lead time, country of origin, validity).",
      CUSTOMER_FOLLOWUP:
        "Give a polite status update — Lumina Supplies is actively progressing the request and will revert with a firm timeline. Reassure the customer.",
      PO_INVOICE:
        "Acknowledge the PO/invoice and confirm next steps from Lumina Supplies side (delivery / payment / dispatch as appropriate).",
    };
    const system =
      "You draft email replies for Lumina Supplies (B2B laboratory/scientific supplier in Riyadh, Saudi Arabia). Always sign as 'Lumina Supplies Team'. Reply ONLY with the email body in plain prose (no subject, no greeting like 'Hi'/'Dear' — start with the body). Keep it concise, professional, and warm. Use ASCII only, no markdown.";
    const userMessage = `Classification: ${classification}\nGuidance: ${guidance[classification] ?? "Reply professionally and helpfully."}\n\n--- Incoming email ---\nFrom: ${thread.senderName} <${thread.senderEmail}>\nSubject: ${thread.subject}\n\n${body.slice(0, 6000)}\n--- End ---\n\nDraft the reply body now.`;
    const text = await callClaude({
      system,
      userMessage,
      maxTokens: AI_MAX_TOKENS.DRAFT_REPLY,
    });
    const replyTo = `${thread.senderName} <${thread.senderEmail}>`;
    const subject = thread.subject.startsWith("Re:") ? thread.subject : `Re: ${thread.subject}`;
    res.json({
      to: thread.senderEmail,
      replyTo,
      subject,
      body: `Dear ${thread.senderName.split(" ")[0] ?? "Sir"},\n\n${text.trim()}\n\nBest regards,\nLumina Supplies Team`,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to draft reply");
    const msg = err instanceof Error ? err.message : "Failed to draft reply";
    res.status(500).json({ error: msg });
  }
});

// POST /threads/:id/send — send a reply via Zoho Mail
router.post("/threads/:id/send", async (req, res) => {
  try {
    const id = parseInt(req.params["id"] ?? "0");
    const { to, cc, subject, body, mailFormat } = req.body as {
      to?: string;
      cc?: string;
      subject?: string;
      body?: string;
      mailFormat?: "html" | "plaintext";
    };
    if (!to || !subject || !body) {
      res.status(400).json({ error: "to, subject, and body are required" });
      return;
    }
    const { thread, conn } = await getConnForThread(id);
    if (!thread) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }
    if (!conn) {
      res.status(400).json({ error: "Zoho account no longer connected" });
      return;
    }
    const format = mailFormat ?? "plaintext";
    const content = format === "html" ? body : body;
    const sendInput: Parameters<typeof sendMessage>[1] = {
      toAddress: to,
      subject,
      content,
      mailFormat: format,
    };
    if (cc) sendInput.ccAddress = cc;
    const result = await sendMessage(conn, sendInput);
    req.log.info({ threadId: id, to }, "Sent reply via Zoho");
    res.json({ ok: true, result });
  } catch (err) {
    req.log.error({ err }, "Failed to send reply");
    const msg = err instanceof Error ? err.message : "Failed to send reply";
    res.status(500).json({ error: msg });
  }
});

// GET /threads/:id/attachments/:attId — proxy download
router.get("/threads/:id/attachments/:attId", async (req, res) => {
  try {
    const id = parseInt(req.params["id"] ?? "0");
    const attId = req.params["attId"] ?? "";
    const { thread, conn } = await getConnForThread(id);
    if (!thread || !conn) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const att = (thread.attachments ?? []).find((a) => a.attachmentId === attId);
    const messageId = extractMessageId(thread.threadId);
    let folderId = thread.folderId;
    if (!folderId) {
      folderId = await findMessageFolderId(conn, messageId);
      if (!folderId) {
        res.status(404).json({ error: "Folder for this message could not be resolved" });
        return;
      }
    }
    const dl = await downloadAttachment(conn, messageId, attId, folderId);
    const filename = att?.name ?? dl.filename ?? "attachment";
    const inline = req.query["inline"] === "1" || req.query["inline"] === "true";
    res.setHeader("Content-Type", dl.contentType);
    const disposition = inline ? "inline" : "attachment";
    res.setHeader("Content-Disposition", `${disposition}; filename="${filename.replace(/"/g, "")}"`);
    // Allow inline viewing in a new browser tab (PDFs, images, etc.)
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(dl.buffer);
  } catch (err) {
    req.log.error({ err }, "Failed to download attachment");
    const msg = err instanceof Error ? err.message : "Failed to download attachment";
    res.status(500).json({ error: msg });
  }
});

export default router;
// Silence unused: zohoConnectionsTable kept available for future per-account routes
void zohoConnectionsTable;
