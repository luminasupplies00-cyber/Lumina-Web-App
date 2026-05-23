import { Router } from "express";
import { db } from "@workspace/db";
import { emailThreadsTable } from "@workspace/db";
import { and, eq, desc, ilike, or, sql, type SQL } from "drizzle-orm";

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

    const threads = await db
      .select()
      .from(emailThreadsTable)
      .where(where)
      .orderBy(desc(emailThreadsTable.receivedAt));

    res.json({ threads });
  } catch (err) {
    req.log.error({ err }, "Failed to get threads");
    res.status(500).json({ error: "Failed to retrieve email threads" });
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
