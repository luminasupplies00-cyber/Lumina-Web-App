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

// ─── Write helpers (require ZohoMail.messages.ALL scope) ─────────────────────

async function zohoRequestForConnection(
  conn: DecryptedZohoConnection,
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const token = await refreshZohoTokenIfNeeded(conn);
  const res = await fetch(`https://mail.zoho.com/api${path}`, {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401 || /OAUTH_SCOPE_MISMATCH|INVALID_OAUTHTOKEN/i.test(text)) {
      throw new Error(`Zoho scope insufficient — reconnect required (${res.status})`);
    }
    throw new Error(`Zoho API error ${res.status}: ${text}`);
  }
  // Some Zoho update endpoints return empty body
  const txt = await res.text();
  if (!txt) return {};
  try {
    return JSON.parse(txt);
  } catch {
    return { raw: txt };
  }
}

export function zohoPostForConnection(
  conn: DecryptedZohoConnection,
  path: string,
  body: unknown,
): Promise<unknown> {
  return zohoRequestForConnection(conn, "POST", path, body);
}

export function zohoPutForConnection(
  conn: DecryptedZohoConnection,
  path: string,
  body: unknown,
): Promise<unknown> {
  return zohoRequestForConnection(conn, "PUT", path, body);
}

export function zohoDeleteForConnection(
  conn: DecryptedZohoConnection,
  path: string,
): Promise<unknown> {
  return zohoRequestForConnection(conn, "DELETE", path);
}

// Fetch raw binary (attachment download)
export async function zohoGetBinaryForConnection(
  conn: DecryptedZohoConnection,
  path: string,
): Promise<{ buffer: Buffer; contentType: string; filename?: string }> {
  const token = await refreshZohoTokenIfNeeded(conn);
  const res = await fetch(`https://mail.zoho.com/api${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zoho download error ${res.status}: ${text}`);
  }
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  const disposition = res.headers.get("content-disposition") ?? "";
  const filenameMatch = /filename\*?=(?:UTF-8'')?\"?([^\";]+)\"?/i.exec(disposition);
  const buffer = Buffer.from(await res.arrayBuffer());
  const result: { buffer: Buffer; contentType: string; filename?: string } = { buffer, contentType };
  if (filenameMatch?.[1]) {
    result.filename = decodeURIComponent(filenameMatch[1]);
  }
  return result;
}

// ─── Domain helpers ──────────────────────────────────────────────────────────

export type ZohoMessageDetail = {
  bodyText: string;
  bodyHtml: string;
  attachments: Array<{ attachmentId: string; name: string; size?: number; type?: string }>;
  folderId?: string;
  isRead?: boolean;
};

// Look up the folderId of a single message by searching the recent message list.
// Used when an older thread row was synced before folderId was persisted.
export async function findMessageFolderId(
  conn: DecryptedZohoConnection,
  messageId: string,
): Promise<string | null> {
  type ListResp = { data?: Array<{ messageId?: string; folderId?: string }> };
  // Zoho `view` endpoint, scanning the most recent 200 messages.
  const resp = (await zohoGetForConnection(
    conn,
    `/accounts/${conn.accountId}/messages/view?limit=200&start=1`,
  )) as ListResp;
  const hit = (resp.data ?? []).find((m) => m.messageId === messageId);
  return hit?.folderId ?? null;
}

export async function fetchFullMessage(
  conn: DecryptedZohoConnection,
  messageId: string,
  folderId: string,
): Promise<ZohoMessageDetail> {
  type Detail = {
    data?: {
      content?: string;
      summary?: string;
      folderId?: string;
      status?: number | string;
      flagid?: string;
      attachments?: Array<{
        attachmentId?: string;
        id?: string;
        attachmentName?: string;
        fileName?: string;
        attachmentSize?: number | string;
        size?: number | string;
        attachmentType?: string;
        contentType?: string;
      }>;
    };
  };
  // Zoho Mail API requires folderId in path AND separate /details + /content
  // suffixes. /details returns metadata + attachments; /content returns HTML.
  const base = `/accounts/${conn.accountId}/folders/${folderId}/messages/${messageId}`;
  const [detailResp, contentResp] = await Promise.all([
    zohoGetForConnection(conn, `${base}/details`) as Promise<Detail>,
    zohoGetForConnection(conn, `${base}/content`).catch(() => ({ data: { content: "" } })) as Promise<{
      data?: { content?: string };
    }>,
  ]);
  const data = { ...(detailResp.data ?? {}), content: contentResp.data?.content ?? detailResp.data?.content };
  const html = data.content ?? "";
  // Strip HTML for plaintext fallback
  const text = html
    ? html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
    : (data.summary ?? "");
  const attachments = (data.attachments ?? []).map((a) => {
    const sizeRaw = a.attachmentSize ?? a.size;
    const sizeNum = typeof sizeRaw === "string" ? parseInt(sizeRaw, 10) : sizeRaw;
    const att: { attachmentId: string; name: string; size?: number; type?: string } = {
      attachmentId: a.attachmentId ?? a.id ?? "",
      name: a.attachmentName ?? a.fileName ?? "attachment",
    };
    if (sizeNum !== undefined && !Number.isNaN(sizeNum)) att.size = sizeNum;
    const tp = a.attachmentType ?? a.contentType;
    if (tp) att.type = tp;
    return att;
  });
  const result: ZohoMessageDetail = {
    bodyText: text,
    bodyHtml: html,
    attachments,
  };
  if (data.folderId) result.folderId = String(data.folderId);
  // Zoho: status 0 = unread, 1 = read (varies by endpoint version)
  if (data.status !== undefined) result.isRead = String(data.status) !== "0";
  return result;
}

// Normalize email subject for conversation matching: strip leading Re:/Fwd:
// (and i18n variants like RE:, RES:, Fw:, FWD:) plus surrounding whitespace.
export function normalizeSubject(subject: string): string {
  let s = subject.trim();
  // Repeatedly strip prefixes like "Re:", "Fwd:", "RES:", "FW:", in any case
  // (handles "Re: Re: Fwd: Foo").
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const stripped = s.replace(/^(re|res|aw|antw|fw|fwd|fwd?)\s*:\s*/i, "");
    if (stripped === s) break;
    s = stripped;
  }
  return s.trim();
}

type ZohoListItem = {
  messageId?: string;
  folderId?: string;
  fromAddress?: string;
  toAddress?: string;
  fromDisplayName?: string;
  subject?: string;
  summary?: string;
  receivedTime?: string;
};

// Search Zoho across all folders by subject. Returns the most recent 50 matches.
export async function searchMessagesBySubject(
  conn: DecryptedZohoConnection,
  normalizedSubject: string,
): Promise<ZohoListItem[]> {
  if (!normalizedSubject) return [];
  // Zoho search expects the searchKey value to be URL-encoded.
  const key = `subject:${normalizedSubject}`;
  const resp = (await zohoGetForConnection(
    conn,
    `/accounts/${conn.accountId}/messages/search?searchKey=${encodeURIComponent(key)}&start=1&limit=50`,
  )) as { data?: ZohoListItem[] };
  return resp.data ?? [];
}

export async function markMessageRead(
  conn: DecryptedZohoConnection,
  messageId: string,
  isRead: boolean,
): Promise<void> {
  await zohoPutForConnection(conn, `/accounts/${conn.accountId}/updatemessage`, {
    mode: isRead ? "markAsRead" : "markAsUnread",
    messageId: [messageId],
  });
}

type FolderCache = { archiveId?: string; trashId?: string; fetchedAt: number };
const folderCacheByAccount = new Map<string, FolderCache>();

export async function getFolderIds(
  conn: DecryptedZohoConnection,
): Promise<{ archiveId?: string; trashId?: string }> {
  const cached = folderCacheByAccount.get(conn.accountId);
  if (cached && Date.now() - cached.fetchedAt < 10 * 60 * 1000) {
    const out: { archiveId?: string; trashId?: string } = {};
    if (cached.archiveId) out.archiveId = cached.archiveId;
    if (cached.trashId) out.trashId = cached.trashId;
    return out;
  }
  type FoldersResp = { data?: Array<{ folderId: string; folderName: string; folderType?: string }> };
  const resp = (await zohoGetForConnection(
    conn,
    `/accounts/${conn.accountId}/folders`,
  )) as FoldersResp;
  const folders = resp.data ?? [];
  const archive = folders.find((f) => /archive/i.test(f.folderName) || f.folderType === "Archive");
  const trash = folders.find((f) => /trash/i.test(f.folderName) || f.folderType === "Trash");
  const cache: FolderCache = { fetchedAt: Date.now() };
  if (archive?.folderId) cache.archiveId = archive.folderId;
  if (trash?.folderId) cache.trashId = trash.folderId;
  folderCacheByAccount.set(conn.accountId, cache);
  const out: { archiveId?: string; trashId?: string } = {};
  if (cache.archiveId) out.archiveId = cache.archiveId;
  if (cache.trashId) out.trashId = cache.trashId;
  return out;
}

export async function archiveMessage(
  conn: DecryptedZohoConnection,
  messageId: string,
): Promise<void> {
  const { archiveId } = await getFolderIds(conn);
  if (!archiveId) throw new Error("No Archive folder found in Zoho account");
  await zohoPutForConnection(conn, `/accounts/${conn.accountId}/updatemessage`, {
    mode: "moveMessage",
    messageId: [messageId],
    destfolderId: archiveId,
  });
}

export async function trashMessage(
  conn: DecryptedZohoConnection,
  messageId: string,
): Promise<void> {
  await zohoPutForConnection(conn, `/accounts/${conn.accountId}/updatemessage`, {
    mode: "moveToTrash",
    messageId: [messageId],
  });
}

export type SendMessageInput = {
  toAddress: string;     // comma-separated
  ccAddress?: string;
  subject: string;
  content: string;
  mailFormat?: "html" | "plaintext";
  fromAddress?: string;  // defaults to conn.email
};

export async function sendMessage(
  conn: DecryptedZohoConnection,
  input: SendMessageInput,
): Promise<unknown> {
  const body: Record<string, unknown> = {
    fromAddress: input.fromAddress ?? conn.email,
    toAddress: input.toAddress,
    subject: input.subject,
    content: input.content,
    mailFormat: input.mailFormat ?? "html",
  };
  if (input.ccAddress) body["ccAddress"] = input.ccAddress;
  return zohoPostForConnection(conn, `/accounts/${conn.accountId}/messages`, body);
}

export async function downloadAttachment(
  conn: DecryptedZohoConnection,
  messageId: string,
  attachmentId: string,
): Promise<{ buffer: Buffer; contentType: string; filename?: string }> {
  return zohoGetBinaryForConnection(
    conn,
    `/accounts/${conn.accountId}/messages/${messageId}/attachments/${attachmentId}`,
  );
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
