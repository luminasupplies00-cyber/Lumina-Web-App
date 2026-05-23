import { Router } from "express";
import { db } from "@workspace/db";
import { emailThreadsTable, rfqRecordsTable } from "@workspace/db";
import { and, eq, desc, ilike, or, sql, isNull, type SQL } from "drizzle-orm";

const router = Router();

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

export default router;
