import { Router } from "express";
import { db } from "@workspace/db";
import {
  rfqSupplierContactsTable,
  suppliersTable,
  type RfqSupplierContact,
} from "@workspace/db";
import { eq, and, sql, desc } from "drizzle-orm";

const router = Router();

type ContactWithComputed = RfqSupplierContact & { hoursSinceContact: number | null };

function withComputed(c: RfqSupplierContact): ContactWithComputed {
  const hours = c.contactedAt
    ? (Date.now() - new Date(c.contactedAt).getTime()) / 3_600_000
    : null;
  return { ...c, hoursSinceContact: hours };
}

router.get("/rfq/:id/supplier-contacts", async (req, res) => {
  try {
    const rfqId = parseInt(req.params["id"] ?? "0");
    const rows = await db
      .select()
      .from(rfqSupplierContactsTable)
      .where(eq(rfqSupplierContactsTable.rfqId, rfqId))
      .orderBy(rfqSupplierContactsTable.contactedAt);
    res.json({ contacts: rows.map(withComputed) });
  } catch (err) {
    req.log.error({ err }, "Failed to list supplier contacts");
    res.status(500).json({ error: "Failed to list supplier contacts" });
  }
});

router.post("/rfq/:id/supplier-contacts", async (req, res) => {
  try {
    const rfqId = parseInt(req.params["id"] ?? "0");
    const body = req.body as {
      contactMode?: "separate" | "bcc";
      emailDraftId?: number;
      contacts: Array<{
        supplierId?: number;
        supplierName: string;
        supplierEmail: string;
        contactMode?: "separate" | "bcc";
        emailDraftId?: number;
        notes?: string;
      }>;
    };

    if (!body.contacts || body.contacts.length === 0) {
      res.status(400).json({ error: "At least one contact is required" });
      return;
    }

    const mode = body.contactMode ?? "separate";
    const draftId = body.emailDraftId;

    const rows = await db
      .insert(rfqSupplierContactsTable)
      .values(
        body.contacts.map((c) => ({
          rfqId,
          supplierId: c.supplierId ?? null,
          supplierName: c.supplierName,
          supplierEmail: c.supplierEmail.toLowerCase().trim(),
          contactMode: c.contactMode ?? mode,
          status: "contacted" as const,
          emailDraftId: c.emailDraftId ?? draftId ?? null,
          notes: c.notes ?? null,
        })),
      )
      .returning();

    // Bump aggregated metrics on supplier rows
    const supplierIds = body.contacts
      .map((c) => c.supplierId)
      .filter((v): v is number => typeof v === "number");
    if (supplierIds.length > 0) {
      for (const sid of supplierIds) {
        await db
          .update(suppliersTable)
          .set({
            totalContacts: sql`${suppliersTable.totalContacts} + 1`,
            lastContactedAt: new Date(),
          })
          .where(eq(suppliersTable.id, sid));
      }
    }

    res.status(201).json({ contacts: rows.map(withComputed) });
  } catch (err) {
    req.log.error({ err }, "Failed to record supplier contacts");
    res.status(500).json({ error: "Failed to record supplier contacts" });
  }
});

router.patch("/rfq/:id/supplier-contacts/:contactId", async (req, res) => {
  try {
    const rfqId = parseInt(req.params["id"] ?? "0");
    const contactId = parseInt(req.params["contactId"] ?? "0");
    const body = req.body as { status: string; notes?: string };

    const validStatuses = ["responded", "no_response", "declined", "partial", "contacted"];
    if (!validStatuses.includes(body.status)) {
      res.status(400).json({ error: `Invalid status. One of: ${validStatuses.join(", ")}` });
      return;
    }

    const existing = await db
      .select()
      .from(rfqSupplierContactsTable)
      .where(
        and(
          eq(rfqSupplierContactsTable.id, contactId),
          eq(rfqSupplierContactsTable.rfqId, rfqId),
        ),
      )
      .limit(1);
    const prev = existing[0];
    if (!prev) {
      res.status(404).json({ error: "Contact not found for this RFQ" });
      return;
    }

    const wasResponded = prev.status === "responded";
    const nowResponded = body.status === "responded";

    const update: Record<string, unknown> = {
      status: body.status,
      ...(body.notes !== undefined && { notes: body.notes }),
    };

    if (nowResponded && !prev.respondedAt) {
      const respondedAt = new Date();
      update["respondedAt"] = respondedAt;
      const hours = Math.round(
        (respondedAt.getTime() - new Date(prev.contactedAt).getTime()) / 3_600_000,
      );
      update["responseTimeHours"] = hours;
    }

    const [updated] = await db
      .update(rfqSupplierContactsTable)
      .set(update)
      .where(
        and(
          eq(rfqSupplierContactsTable.id, contactId),
          eq(rfqSupplierContactsTable.rfqId, rfqId),
        ),
      )
      .returning();

    if (updated && prev.supplierId && !wasResponded && nowResponded) {
      await db
        .update(suppliersTable)
        .set({
          totalResponses: sql`${suppliersTable.totalResponses} + 1`,
          lastRespondedAt: new Date(),
        })
        .where(eq(suppliersTable.id, prev.supplierId));
    }

    res.json({ contact: updated ? withComputed(updated) : null });
  } catch (err) {
    req.log.error({ err }, "Failed to update supplier contact");
    res.status(500).json({ error: "Failed to update supplier contact" });
  }
});

// Mark follow-up sent — invoked when user copies a follow-up draft for a contact.
router.patch("/rfq/:id/supplier-contacts/:contactId/follow-up-sent", async (req, res) => {
  try {
    const rfqId = parseInt(req.params["id"] ?? "0");
    const contactId = parseInt(req.params["contactId"] ?? "0");
    const [updated] = await db
      .update(rfqSupplierContactsTable)
      .set({ followUpSentAt: new Date() })
      .where(
        and(
          eq(rfqSupplierContactsTable.id, contactId),
          eq(rfqSupplierContactsTable.rfqId, rfqId),
        ),
      )
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Contact not found for this RFQ" });
      return;
    }
    res.json({ contact: withComputed(updated) });
  } catch (err) {
    req.log.error({ err }, "Failed to mark follow-up sent");
    res.status(500).json({ error: "Failed to mark follow-up sent" });
  }
});

// Helper for sync.ts auto-linking. Returns matched contact ids.
export async function autoLinkSupplierReply(opts: {
  senderEmail: string;
  emailThreadId: number;
}): Promise<number[]> {
  const email = opts.senderEmail.toLowerCase().trim();
  if (!email) return [];

  // Only link the single most-recently-contacted open record for this sender.
  // Email-only matching across multiple RFQs is unsafe: one supplier reply
  // could otherwise close unrelated contacts. The most recent outreach is the
  // best heuristic; the user can manually mark other RFQs responded.
  const open = await db
    .select()
    .from(rfqSupplierContactsTable)
    .where(
      and(
        eq(rfqSupplierContactsTable.supplierEmail, email),
        eq(rfqSupplierContactsTable.status, "contacted"),
      ),
    )
    .orderBy(desc(rfqSupplierContactsTable.contactedAt))
    .limit(1);

  const target = open[0];
  if (!target) return [];

  const respondedAt = new Date();
  const hours = Math.round(
    (respondedAt.getTime() - new Date(target.contactedAt).getTime()) / 3_600_000,
  );
  await db
    .update(rfqSupplierContactsTable)
    .set({
      status: "responded",
      respondedAt,
      responseTimeHours: hours,
      replyThreadId: opts.emailThreadId,
    })
    .where(eq(rfqSupplierContactsTable.id, target.id));
  if (target.supplierId) {
    await db
      .update(suppliersTable)
      .set({
        totalResponses: sql`${suppliersTable.totalResponses} + 1`,
        lastRespondedAt: respondedAt,
      })
      .where(eq(suppliersTable.id, target.supplierId));
  }
  return [target.id];
}

export default router;
