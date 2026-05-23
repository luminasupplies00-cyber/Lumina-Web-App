import { db } from "@workspace/db";
import { zohoConnectionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { decrypt, encrypt } from "./encrypt.js";
import { logger } from "./logger.js";

type ConnRow = typeof zohoConnectionsTable.$inferSelect;

export type DecryptedZohoConnection = Omit<ConnRow, "accessToken" | "refreshToken"> & {
  accessToken: string;
  refreshToken: string;
};

export async function getAllZohoConnections(): Promise<DecryptedZohoConnection[]> {
  const rows = await db
    .select()
    .from(zohoConnectionsTable)
    .where(eq(zohoConnectionsTable.isActive, true));
  return rows.map((conn) => ({
    ...conn,
    accessToken: decrypt(conn.accessToken),
    refreshToken: decrypt(conn.refreshToken),
  }));
}

export async function getZohoConnection(): Promise<DecryptedZohoConnection | null> {
  const all = await getAllZohoConnections();
  return all[0] ?? null;
}

export async function refreshZohoTokenIfNeeded(conn: DecryptedZohoConnection): Promise<string> {
  const now = new Date();
  const expiryWithBuffer = new Date(conn.tokenExpiry.getTime() - 5 * 60 * 1000);

  if (now < expiryWithBuffer) {
    const rows = await db
      .select({ accessToken: zohoConnectionsTable.accessToken })
      .from(zohoConnectionsTable)
      .where(eq(zohoConnectionsTable.id, conn.id))
      .limit(1);
    const raw = rows[0]?.accessToken;
    if (!raw) throw new Error("No access token found");
    return decrypt(raw);
  }

  logger.info({ connId: conn.id, label: conn.accountLabel }, "Refreshing Zoho access token");

  const domain = conn.accountsDomain || "accounts.zoho.com";
  const clientId = await getSettingValue("ZOHO_CLIENT_ID");
  const clientSecret = await getSettingValue("ZOHO_CLIENT_SECRET");

  if (!clientId || !clientSecret) {
    throw new Error("Zoho client credentials not configured in settings");
  }

  const params = new URLSearchParams({
    refresh_token: conn.refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  });

  const res = await fetch(`https://${domain}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zoho token refresh failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  };

  if (!data.access_token) {
    throw new Error(`Zoho token refresh error: ${data.error ?? "unknown"}`);
  }

  const newExpiry = new Date(Date.now() + (data.expires_in ?? 3600) * 1000);

  await db
    .update(zohoConnectionsTable)
    .set({
      accessToken: encrypt(data.access_token),
      tokenExpiry: newExpiry,
    })
    .where(eq(zohoConnectionsTable.id, conn.id));

  return data.access_token;
}

export async function zohoGetForConnection(
  conn: DecryptedZohoConnection,
  path: string,
): Promise<unknown> {
  const token = await refreshZohoTokenIfNeeded(conn);

  const res = await fetch(`https://mail.zoho.com/api${path}`, {
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zoho API error ${res.status}: ${text}`);
  }

  return res.json();
}

export async function zohoGet(path: string): Promise<unknown> {
  const conn = await getZohoConnection();
  if (!conn) throw new Error("Zoho not connected");
  return zohoGetForConnection(conn, path);
}

async function getSettingValue(key: string): Promise<string | null> {
  const { appSettingsTable } = await import("@workspace/db");
  const rows = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.key, key))
    .limit(1);
  return rows[0]?.value ?? null;
}
