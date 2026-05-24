import { Router } from "express";
import { db } from "@workspace/db";
import {
  zohoConnectionsTable,
  rfqSupplierContactsTable,
  aiDraftsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { decrypt } from "../lib/encrypt.js";
import {
  sendMessage,
  uploadZohoAttachment,
  type DecryptedZohoConnection,
} from "../lib/zohoClient.js";

const router = Router();

type SendBody = {
  accountId: number;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  mailFormat?: "html" | "plaintext";
  rfqId: number;
  draftId?: number;
  contactIds?: number[];
  attachment?: {
    filename: string;
    contentType?: string;
    base64: string;
  };
};

function nonEmpty(s: string | undefined | null): string | undefined {
  if (!s) return undefined;
  const trimmed = s.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function loadConnection(id: number): Promise<DecryptedZohoConnection | null> {
  const rows = await db
    .select()
    .from(zohoConnectionsTable)
    .where(eq(zohoConnectionsTable.id, id))
    .limit(1);
  const conn = rows[0];
  if (!conn || !conn.isActive) return null;
  return {
    ...conn,
    accessToken: decrypt(conn.accessToken),
    refreshToken: decrypt(conn.refreshToken),
  };
}

router.get("/mail/zoho/scopes/:accountId", async (req, res) => {
  const id = parseInt(req.params["accountId"] ?? "", 10);
  if (!id || Number.isNaN(id)) {
    res.status(400).json({ error: "accountId must be an integer" });
    return;
  }
  const rows = await db
    .select({ scope: zohoConnectionsTable.scope, isActive: zohoConnectionsTable.isActive })
    .from(zohoConnectionsTable)
    .where(eq(zohoConnectionsTable.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    res.status(404).json({ error: "Zoho account not found" });
    return;
  }
  const scope = row.scope ?? "";
  const hasSendScope =
    scope.includes("ZohoMail.messages.ALL") || scope.includes("ZohoMail.messages.CREATE");
  res.json({ hasSendScope, scope: row.scope ?? null });
});

router.post("/mail/zoho/send", async (req, res) => {
  const body = req.body as SendBody;

  if (!body?.accountId || !body?.to || !body?.subject || !body?.body || !body?.rfqId) {
    res.status(400).json({ error: "accountId, to, subject, body, rfqId are required" });
    return;
  }

  const conn = await loadConnection(body.accountId);
  if (!conn) {
    res.status(404).json({ error: "Zoho account not found or inactive" });
    return;
  }

  // Scope guard — accept either ALL or CREATE; both are send-capable per
  // Zoho's OAuth scope model.
  const scope = conn.scope ?? "";
  const hasSendScope =
    scope.includes("ZohoMail.messages.ALL") || scope.includes("ZohoMail.messages.CREATE");
  if (!hasSendScope) {
    res.status(403).json({
      error:
        "This Zoho account does not have send permission. Reconnect it from Settings to grant ZohoMail.messages.ALL or ZohoMail.messages.CREATE.",
    });
    return;
  }

  // Ownership guards — prevent a crafted request from writing tracking
  // fields on draft/contact rows that don't belong to this rfqId.
  if (body.draftId) {
    const draftRow = await db
      .select({ id: aiDraftsTable.id, rfqId: aiDraftsTable.rfqId })
      .from(aiDraftsTable)
      .where(eq(aiDraftsTable.id, body.draftId))
      .limit(1);
    if (!draftRow[0] || draftRow[0].rfqId !== body.rfqId) {
      res.status(400).json({ error: "draftId does not belong to rfqId" });
      return;
    }
  }
  if (body.contactIds && body.contactIds.length > 0) {
    const owned = await db
      .select({ id: rfqSupplierContactsTable.id })
      .from(rfqSupplierContactsTable)
      .where(
        and(
          inArray(rfqSupplierContactsTable.id, body.contactIds),
          eq(rfqSupplierContactsTable.rfqId, body.rfqId),
        ),
      );
    if (owned.length !== body.contactIds.length) {
      res.status(400).json({ error: "One or more contactIds do not belong to rfqId" });
      return;
    }
  }

  try {
    // 1. Upload attachment first (if provided) — failure must abort the send.
    const attachments: Array<{ attachmentId: string; storeName?: string; attachmentName?: string }> = [];
    if (body.attachment?.base64 && body.attachment.filename) {
      const buffer = Buffer.from(body.attachment.base64, "base64");
      const uploaded = await uploadZohoAttachment(conn, {
        buffer,
        filename: body.attachment.filename,
        contentType: body.attachment.contentType ?? "application/octet-stream",
      });
      attachments.push(uploaded);
    }

    // 2. Send the email.
    const sendInput: Parameters<typeof sendMessage>[1] = {
      toAddress: body.to,
      subject: body.subject,
      content: body.body,
      mailFormat: body.mailFormat ?? "html",
    };
    const cc = nonEmpty(body.cc);
    const bcc = nonEmpty(body.bcc);
    if (cc) sendInput.ccAddress = cc;
    if (bcc) sendInput.bccAddress = bcc;
    if (attachments.length > 0) {
      sendInput.attachments = attachments.map((a) => {
        const entry: Record<string, string> = { attachmentId: a.attachmentId };
        if (a.storeName) entry["storeName"] = a.storeName;
        if (a.attachmentName) entry["attachmentName"] = a.attachmentName;
        return entry as { attachmentId: string };
      });
    }

    const sendResult = await sendMessage(conn, sendInput);
    const zohoMessageId = sendResult.messageId ?? null;
    const allRecipients = [body.to, bcc].filter(Boolean).join(", ");
    const now = new Date();

    // 3. Update draft tracking.
    if (body.draftId) {
      await db
        .update(aiDraftsTable)
        .set({
          sentAt: now,
          sentFromAccount: conn.accountLabel,
          sentTo: allRecipients,
          zohoMessageId,
          sendStatus: "sent",
          sendError: null,
        })
        .where(eq(aiDraftsTable.id, body.draftId));
    }

    // 4. Update supplier-contact tracking. Supplier-level metrics are
    //    incremented by POST /rfq/:id/supplier-contacts (creation time);
    //    do NOT double-count them here on send success.
    if (body.contactIds && body.contactIds.length > 0) {
      await db
        .update(rfqSupplierContactsTable)
        .set({
          status: "contacted",
          contactedAt: now,
          emailSentVia: "zoho_api",
          zohoMessageId,
          ...(body.draftId && { emailDraftId: body.draftId }),
        })
        .where(inArray(rfqSupplierContactsTable.id, body.contactIds));
    }

    req.log.info(
      { accountId: body.accountId, rfqId: body.rfqId, zohoMessageId, contactCount: body.contactIds?.length ?? 0 },
      "Sent supplier email via Zoho",
    );

    res.json({ ok: true, zohoMessageId, sentFromAccount: conn.accountLabel, sentAt: now.toISOString() });
  } catch (err) {
    req.log.error({ err, accountId: body.accountId, rfqId: body.rfqId }, "Zoho send failed");

    // Record the failure on the draft so the user has a paper trail.
    if (body.draftId) {
      const msg = (err as Error)?.message ?? String(err);
      await db
        .update(aiDraftsTable)
        .set({ sendStatus: "failed", sendError: msg.slice(0, 500) })
        .where(eq(aiDraftsTable.id, body.draftId))
        .catch(() => undefined);
    }

    const message = (err as Error)?.message ?? String(err);
    if (/scope insufficient|OAUTH_SCOPE_MISMATCH/i.test(message)) {
      res.status(403).json({
        error: "Zoho rejected the request due to insufficient OAuth scope. Reconnect this account from Settings.",
      });
      return;
    }
    if (/INVALID_OAUTHTOKEN|401/.test(message)) {
      res.status(401).json({
        error: "Zoho access token rejected. Try again — if it persists, reconnect the account from Settings.",
      });
      return;
    }
    res.status(502).json({ error: `Zoho send failed: ${message}` });
  }
});

export default router;
