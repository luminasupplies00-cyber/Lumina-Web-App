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

router.get("/auth/zoho/connect", async (req, res) => {
  try {
    const clientId = await getSetting("ZOHO_CLIENT_ID");
    const redirectUri = await getSetting("ZOHO_REDIRECT_URI");
    const accountsDomain = (await getSetting("ZOHO_ACCOUNTS_DOMAIN")) ?? "accounts.zoho.com";

    if (!clientId || !redirectUri) {
      res.status(400).json({
        error: "ZOHO_CLIENT_ID and ZOHO_REDIRECT_URI must be configured in Settings before connecting.",
      });
      return;
    }

    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      scope: "ZohoMail.messages.READ,ZohoMail.accounts.READ",
      redirect_uri: redirectUri,
      access_type: "offline",
    });

    const authUrl = `https://${accountsDomain}/oauth/v2/auth?${params.toString()}`;
    res.json({ authUrl });
  } catch (err) {
    req.log.error({ err }, "Failed to build Zoho auth URL");
    res.status(500).json({ error: "Failed to initiate Zoho connection" });
  }
});

router.get("/auth/zoho/callback", async (req, res) => {
  const { code, error: oauthError } = req.query as Record<string, string>;

  if (oauthError) {
    res.status(400).json({ error: `Zoho OAuth error: ${oauthError}` });
    return;
  }
  if (!code) {
    res.status(400).json({ error: "No authorization code received" });
    return;
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

    const accountRes = await fetch("https://mail.zoho.com/api/accounts", {
      headers: {
        Authorization: `Zoho-oauthtoken ${tokenData.access_token}`,
        "Content-Type": "application/json",
      },
    });

    let accountId = "unknown";
    let email = "unknown";

    if (accountRes.ok) {
      const accountData = (await accountRes.json()) as {
        data?: Array<{ accountId: string; primaryEmailAddress?: string; emailAddress?: Array<{ mailId: string }> }>;
      };
      const account = accountData.data?.[0];
      if (account) {
        accountId = account.accountId;
        email = account.primaryEmailAddress ?? account.emailAddress?.[0]?.mailId ?? "unknown";
      }
    }

    await db.delete(zohoConnectionsTable);

    await db.insert(zohoConnectionsTable).values({
      accountId,
      email,
      accessToken: encrypt(tokenData.access_token),
      refreshToken: encrypt(tokenData.refresh_token),
      tokenExpiry,
      accountsDomain,
    });

    req.log.info({ accountId, email }, "Zoho connected successfully");

    const domains = process.env["REPLIT_DOMAINS"]?.split(",")[0];
    const redirectTarget = domains ? `https://${domains}/settings` : "/settings";
    res.redirect(redirectTarget);
  } catch (err) {
    req.log.error({ err }, "Zoho callback failed");
    res.status(500).json({ error: "Zoho connection failed" });
  }
});

router.delete("/auth/zoho/disconnect", async (req, res) => {
  try {
    await db.delete(zohoConnectionsTable);
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to disconnect Zoho");
    res.status(500).json({ error: "Failed to disconnect" });
  }
});

router.get("/auth/zoho/status", async (req, res) => {
  try {
    const rows = await db
      .select({
        id: zohoConnectionsTable.id,
        email: zohoConnectionsTable.email,
        accountId: zohoConnectionsTable.accountId,
        connectedAt: zohoConnectionsTable.connectedAt,
        lastSyncedAt: zohoConnectionsTable.lastSyncedAt,
        tokenExpiry: zohoConnectionsTable.tokenExpiry,
      })
      .from(zohoConnectionsTable)
      .limit(1);

    if (rows.length === 0) {
      res.json({ connected: false });
      return;
    }

    const conn = rows[0]!;
    res.json({
      connected: true,
      email: conn.email,
      accountId: conn.accountId,
      connectedAt: conn.connectedAt,
      lastSyncedAt: conn.lastSyncedAt,
      tokenExpiry: conn.tokenExpiry,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get Zoho status");
    res.status(500).json({ error: "Failed to get connection status" });
  }
});

export default router;
