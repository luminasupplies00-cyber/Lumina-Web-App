import { Router } from "express";
import { db } from "@workspace/db";
import { emailThreadsTable } from "@workspace/db";
import { eq, desc, ilike, or } from "drizzle-orm";

const router = Router();

router.get("/threads", async (req, res) => {
  try {
    const { classification, search } = req.query as Record<string, string>;

    let query = db.select().from(emailThreadsTable).$dynamic();

    if (classification && classification !== "all") {
      query = query.where(eq(emailThreadsTable.classification, classification));
    }

    if (search) {
      query = query.where(
        or(
          ilike(emailThreadsTable.senderName, `%${search}%`),
          ilike(emailThreadsTable.senderEmail, `%${search}%`),
          ilike(emailThreadsTable.subject, `%${search}%`),
        ),
      );
    }

    const threads = await query.orderBy(desc(emailThreadsTable.receivedAt));
    res.json({ threads });
  } catch (err) {
    req.log.error({ err }, "Failed to get threads");
    res.status(500).json({ error: "Failed to retrieve email threads" });
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
