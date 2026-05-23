import { Router } from "express";
import { db } from "@workspace/db";
import { zohoConnectionsTable, appSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { encrypt, decrypt } from "../lib/encrypt.js";

const router = Router();

async function getSetting(key: string): Promise<string | null> {
  const rows = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.key, key))
    .limit(1);
  if (!rows[0]) return null;
  try {
    return decrypt(rows[0].value);
  } catch {
    return rows[0].value;
  }
}

// GET /auth/zoho/connect?label=Sales (any free-text label, max 32 chars)
router.get("/auth/zoho/connect", async (req, res) => {
  try {
    const label = (req.query["label"] as string) || "General";
    const clientId = await getSetting("ZOHO_CLIENT_ID");
    const redirectUri = await getSetting("ZOHO_REDIRECT_URI");
    const accountsDomain = (await getSetting("ZOHO_ACCOUNTS_DOMAIN")) ?? "accounts.zoho.com";

    if (!clientId || !redirectUri) {
      res.status(400).json({
        error: "ZOHO_CLIENT_ID and ZOHO_REDIRECT_URI must be configured in Settings before connecting.",
      });
      return;
    }

    // Encode label in state so callback knows which label to use
    const state = Buffer.from(JSON.stringify({ label })).toString("base64url");

    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      scope: "ZohoMail.messages.READ,ZohoMail.accounts.READ",
      redirect_uri: redirectUri,
      access_type: "offline",
      state,
    });

    const authUrl = `https://${accountsDomain}/oauth/v2/auth?${params.toString()}`;
    res.json({ authUrl });
  } catch (err) {
    req.log.error({ err }, "Failed to build Zoho auth URL");
    res.status(500).json({ error: "Failed to initiate Zoho connection" });
  }
});

// GET /auth/zoho/callback
router.get("/auth/zoho/callback", async (req, res) => {
  const { code, error: oauthError, state } = req.query as Record<string, string>;

  if (oauthError) {
    res.status(400).json({ error: `Zoho OAuth error: ${oauthError}` });
    return;
  }
  if (!code) {
    res.status(400).json({ error: "No authorization code received" });
    return;
  }

  // Decode label from state
  let accountLabel = "General";
  if (state) {
    try {
      const decoded = JSON.parse(Buffer.from(state, "base64url").toString("utf-8"));
      accountLabel = decoded.label || "General";
    } catch {
      // Ignore decode errors — use default label
    }
  }

  try {
    const clientId = await getSetting("ZOHO_CLIENT_ID");
    const clientSecret = await getSetting("ZOHO_CLIENT_SECRET");
    const redirectUri = await getSetting("ZOHO_REDIRECT_URI");
    const accountsDomain = (await getSetting("ZOHO_ACCOUNTS_DOMAIN")) ?? "accounts.zoho.com";

    if (!clientId || !clientSecret || !redirectUri) {
      res.status(400).json({ error: "Zoho credentials not configured" });
      return;
    }

    const tokenParams = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });

    const tokenRes = await fetch(`https://${accountsDomain}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenParams.toString(),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      req.log.error({ status: tokenRes.status, text }, "Zoho token exchange failed");
      res.status(502).json({ error: "Failed to exchange code for tokens" });
      return;
    }

    const tokenData = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
    };

    if (!tokenData.access_token || !tokenData.refresh_token) {
      res.status(502).json({
        error: `Zoho token response missing tokens: ${tokenData.error ?? "unknown error"}`,
      });
      return;
    }

    const tokenExpiry = new Date(Date.now() + (tokenData.expires_in ?? 3600) * 1000);

    // Fetch account info to get accountId and email
    const accountRes = await fetch("https://mail.zoho.com/api/accounts", {
      headers: {
        Authorization: `Zoho-oauthtoken ${tokenData.access_token}`,
        "Content-Type": "application/json",
      },
    });

    let accountId = `unknown_${Date.now()}`;
    let email = "unknown";

    if (accountRes.ok) {
      const accountData = (await accountRes.json()) as {
        data?: Array<{
          accountId: string;
          primaryEmailAddress?: string;
          emailAddress?: Array<{ mailId: string }>;
        }>;
      };
      const account = accountData.data?.[0];
      if (account) {
        accountId = account.accountId;
        email = account.primaryEmailAddress ?? account.emailAddress?.[0]?.mailId ?? "unknown";
      }
    }

    // Upsert: if same accountId exists, update it; otherwise insert
    const existing = await db
      .select({ id: zohoConnectionsTable.id })
      .from(zohoConnectionsTable)
      .where(eq(zohoConnectionsTable.accountId, accountId))
      .limit(1);

    if (existing[0]) {
      await db
        .update(zohoConnectionsTable)
        .set({
          email,
          accountLabel,
          accessToken: encrypt(tokenData.access_token),
          refreshToken: encrypt(tokenData.refresh_token),
          tokenExpiry,
          accountsDomain,
          isActive: true,
        })
        .where(eq(zohoConnectionsTable.accountId, accountId));
    } else {
      await db.insert(zohoConnectionsTable).values({
        accountId,
        email,
        accountLabel,
        accessToken: encrypt(tokenData.access_token),
        refreshToken: encrypt(tokenData.refresh_token),
        tokenExpiry,
        accountsDomain,
        isActive: true,
      });
    }

    req.log.info({ accountId, email, accountLabel }, "Zoho account connected");

    const domains = process.env["REPLIT_DOMAINS"]?.split(",")[0];
    const redirectTarget = domains ? `https://${domains}/settings` : "/settings";
    res.redirect(redirectTarget);
  } catch (err) {
    req.log.error({ err }, "Zoho callback failed");
    res.status(500).json({ error: "Zoho connection failed" });
  }
});

// GET /auth/zoho/accounts — list all connected accounts
router.get("/auth/zoho/accounts", async (req, res) => {
  try {
    const rows = await db
      .select({
        id: zohoConnectionsTable.id,
        accountId: zohoConnectionsTable.accountId,
        email: zohoConnectionsTable.email,
        accountLabel: zohoConnectionsTable.accountLabel,
        connectedAt: zohoConnectionsTable.connectedAt,
        lastSyncedAt: zohoConnectionsTable.lastSyncedAt,
        tokenExpiry: zohoConnectionsTable.tokenExpiry,
        isActive: zohoConnectionsTable.isActive,
      })
      .from(zohoConnectionsTable)
      .where(eq(zohoConnectionsTable.isActive, true))
      .orderBy(zohoConnectionsTable.connectedAt);

    res.json({ accounts: rows });
  } catch (err) {
    req.log.error({ err }, "Failed to list Zoho accounts");
    res.status(500).json({ error: "Failed to list accounts" });
  }
});

// PATCH /auth/zoho/accounts/:id — update account label (role)
router.patch("/auth/zoho/accounts/:id", async (req, res) => {
  try {
    const id = parseInt(req.params["id"] ?? "0");
    const raw = (req.body as { accountLabel?: string }).accountLabel;
    if (!raw || typeof raw !== "string") {
      res.status(400).json({ error: "accountLabel is required" });
      return;
    }
    const accountLabel = raw.trim();
    if (accountLabel.length < 1 || accountLabel.length > 32) {
      res.status(400).json({ error: "accountLabel must be 1-32 characters" });
      return;
    }
    await db
      .update(zohoConnectionsTable)
      .set({ accountLabel })
      .where(eq(zohoConnectionsTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to update Zoho account label");
    res.status(500).json({ error: "Failed to update account label" });
  }
});

// DELETE /auth/zoho/accounts/:id — disconnect a specific account
router.delete("/auth/zoho/accounts/:id", async (req, res) => {
  try {
    const id = parseInt(req.params["id"] ?? "0");
    await db
      .update(zohoConnectionsTable)
      .set({ isActive: false })
      .where(eq(zohoConnectionsTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to disconnect Zoho account");
    res.status(500).json({ error: "Failed to disconnect" });
  }
});

// GET /auth/zoho/status — single-account compat (first active connection)
router.get("/auth/zoho/status", async (req, res) => {
  try {
    const rows = await db
      .select({
        id: zohoConnectionsTable.id,
        email: zohoConnectionsTable.email,
        accountId: zohoConnectionsTable.accountId,
        accountLabel: zohoConnectionsTable.accountLabel,
        connectedAt: zohoConnectionsTable.connectedAt,
        lastSyncedAt: zohoConnectionsTable.lastSyncedAt,
        tokenExpiry: zohoConnectionsTable.tokenExpiry,
      })
      .from(zohoConnectionsTable)
      .where(eq(zohoConnectionsTable.isActive, true))
      .orderBy(zohoConnectionsTable.connectedAt);

    if (rows.length === 0) {
      res.json({ connected: false });
      return;
    }

    const primary = rows[0]!;
    res.json({
      connected: true,
      email: primary.email,
      accountId: primary.accountId,
      accountLabel: primary.accountLabel,
      connectedAt: primary.connectedAt,
      lastSyncedAt: primary.lastSyncedAt,
      tokenExpiry: primary.tokenExpiry,
      totalAccounts: rows.length,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get Zoho status");
    res.status(500).json({ error: "Failed to get connection status" });
  }
});

// DELETE /auth/zoho/disconnect — disconnect all (kept for backward compat)
router.delete("/auth/zoho/disconnect", async (req, res) => {
  try {
    await db.update(zohoConnectionsTable).set({ isActive: false });
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to disconnect Zoho");
    res.status(500).json({ error: "Failed to disconnect" });
  }
});

export default router;
