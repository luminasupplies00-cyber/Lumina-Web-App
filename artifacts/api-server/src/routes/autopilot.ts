import { Router } from "express";
import { db } from "@workspace/db";
import { autopilotActionsTable } from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";
import {
  getAutopilotState,
  runAutopilotCycle,
  toggleAutopilot,
  generateDailyBriefing,
} from "../lib/autopilot.js";

const router = Router();

// ─── GET /autopilot/status ───────────────────────────────────────────────────

router.get("/autopilot/status", async (req, res) => {
  try {
    const state = getAutopilotState();
    res.json({
      enabled: state.enabled,
      intervalMinutes: state.intervalMinutes,
      lastRunAt: state.lastRunAt,
      nextRunAt: state.nextRunAt,
      running: state.running,
      stats: state.stats,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get autopilot status");
    res.status(500).json({ error: "Failed to get autopilot status" });
  }
});

// ─── POST /autopilot/run ────────────────────────────────────────────────────

router.post("/autopilot/run", async (req, res) => {
  try {
    const result = await runAutopilotCycle();
    res.json({
      ok: true,
      actions: result.actions,
      durationMs: result.durationMs,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to run autopilot cycle");
    res.status(500).json({ error: "Failed to run autopilot cycle" });
  }
});

// ─── GET /autopilot/actions ─────────────────────────────────────────────────

router.get("/autopilot/actions", async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query["limit"] ?? "50")), 200);
    const offset = parseInt(String(req.query["offset"] ?? "0"));

    const actions = await db
      .select()
      .from(autopilotActionsTable)
      .orderBy(desc(autopilotActionsTable.createdAt))
      .limit(limit)
      .offset(offset);

    const [totalRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(autopilotActionsTable);

    res.json({
      actions,
      total: totalRow?.count ?? 0,
      limit,
      offset,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get autopilot actions");
    res.status(500).json({ error: "Failed to get autopilot actions" });
  }
});

// ─── POST /autopilot/actions/:id/dismiss ────────────────────────────────────

router.post("/autopilot/actions/:id/dismiss", async (req, res) => {
  try {
    const id = parseInt(req.params["id"] ?? "0");
    const [updated] = await db
      .update(autopilotActionsTable)
      .set({ status: "dismissed", completedAt: new Date() })
      .where(eq(autopilotActionsTable.id, id))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Action not found" });
      return;
    }

    res.json({ ok: true, action: updated });
  } catch (err) {
    req.log.error({ err }, "Failed to dismiss autopilot action");
    res.status(500).json({ error: "Failed to dismiss action" });
  }
});

// ─── GET /autopilot/briefing ────────────────────────────────────────────────

router.get("/autopilot/briefing", async (req, res) => {
  try {
    const briefing = await generateDailyBriefing();
    res.json({ briefing });
  } catch (err) {
    req.log.error({ err }, "Failed to generate briefing");
    res.status(500).json({ error: "Failed to generate briefing" });
  }
});

// ─── POST /autopilot/toggle ────────────────────────────────────────────────

router.post("/autopilot/toggle", async (req, res) => {
  try {
    const body = req.body as { enabled: boolean };
    if (typeof body.enabled !== "boolean") {
      res.status(400).json({ error: "enabled (boolean) is required" });
      return;
    }

    await toggleAutopilot(body.enabled);
    const state = getAutopilotState();

    res.json({
      ok: true,
      enabled: state.enabled,
      intervalMinutes: state.intervalMinutes,
      nextRunAt: state.nextRunAt,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to toggle autopilot");
    res.status(500).json({ error: "Failed to toggle autopilot" });
  }
});

export default router;
