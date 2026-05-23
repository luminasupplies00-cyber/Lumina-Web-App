import { Router } from "express";
import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { encrypt, decrypt } from "../lib/encrypt.js";

const router = Router();

const SENSITIVE_KEYS = new Set([
  "ZOHO_CLIENT_SECRET",
  "ANTHROPIC_API_KEY",
  "PERPLEXITY_API_KEY",
]);

router.get("/settings", async (req, res) => {
  try {
    const rows = await db.select().from(appSettingsTable);
    const result: Record<string, string> = {};
    for (const row of rows) {
      if (SENSITIVE_KEYS.has(row.key)) {
        result[row.key] = row.value ? "***configured***" : "";
      } else {
        result[row.key] = row.value;
      }
    }
    res.json({ settings: result });
  } catch (err) {
    req.log.error({ err }, "Failed to get settings");
    res.status(500).json({ error: "Failed to retrieve settings" });
  }
});

router.put("/settings", async (req, res) => {
  try {
    const body = req.body as Record<string, string>;
    if (!body || typeof body !== "object") {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    for (const [key, value] of Object.entries(body)) {
      if (typeof value !== "string") continue;
      if (value === "***configured***") continue;

      const storedValue = SENSITIVE_KEYS.has(key) ? encrypt(value) : value;

      const existing = await db
        .select({ id: appSettingsTable.id })
        .from(appSettingsTable)
        .where(eq(appSettingsTable.key, key))
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(appSettingsTable)
          .set({ value: storedValue })
          .where(eq(appSettingsTable.key, key));
      } else {
        await db.insert(appSettingsTable).values({ key, value: storedValue });
      }
    }

    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to save settings");
    res.status(500).json({ error: "Failed to save settings" });
  }
});

router.get("/settings/raw/:key", async (req, res) => {
  try {
    const { key } = req.params;
    if (!key) {
      res.status(400).json({ error: "Key required" });
      return;
    }
    const rows = await db
      .select()
      .from(appSettingsTable)
      .where(eq(appSettingsTable.key, key))
      .limit(1);

    if (!rows[0]) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    let value = rows[0].value;
    if (SENSITIVE_KEYS.has(key)) {
      try {
        value = decrypt(value);
      } catch {
        // already plain
      }
    }
    res.json({ key, value });
  } catch (err) {
    req.log.error({ err }, "Failed to get raw setting");
    res.status(500).json({ error: "Failed to get setting" });
  }
});

export default router;
