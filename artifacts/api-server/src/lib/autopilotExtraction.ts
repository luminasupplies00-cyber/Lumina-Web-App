/**
 * Autopilot extraction helper — triggers product extraction for an RFQ
 * without going through the HTTP route. Used by the background autopilot
 * processor to auto-extract products for NEW RFQs.
 *
 * This is a simplified version of the /rfq/:id/extract-products route
 * that works without req/res context. It only processes the email body
 * (no attachment download) to keep background cycles fast and cheap.
 */
import { db } from "@workspace/db";
import {
  rfqRecordsTable,
  rfqProductsTable,
  emailThreadsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { callAI, AI_MODELS } from "./aiClient.js";
import { AI_MAX_TOKENS } from "./aiConstants.js";
import { logger } from "./logger.js";

export async function triggerAutopilotExtraction(rfqId: number): Promise<{
  productsInserted: number;
}> {
  const rfqRows = await db
    .select()
    .from(rfqRecordsTable)
    .where(eq(rfqRecordsTable.id, rfqId))
    .limit(1);
  const rfq = rfqRows[0];
  if (!rfq) throw new Error(`RFQ ${rfqId} not found`);

  if (!rfq.emailThreadId) {
    throw new Error(`RFQ ${rfqId} has no linked email thread`);
  }

  const threadRows = await db
    .select()
    .from(emailThreadsTable)
    .where(eq(emailThreadsTable.id, rfq.emailThreadId))
    .limit(1);
  const thread = threadRows[0];
  if (!thread) throw new Error(`Thread ${rfq.emailThreadId} not found`);

  const emailBody = thread.bodyText ?? thread.snippet ?? "";
  if (!emailBody.trim()) {
    throw new Error(`RFQ ${rfqId}: no email body available for extraction`);
  }

  const system = `You are a procurement assistant for Lumina Supplies, a B2B laboratory supplies company in Riyadh, Saudi Arabia.

Extract all laboratory/scientific products mentioned in the email.
ALSO extract customer identity from the email signature or letterhead.

Return ONLY a valid JSON object. No explanation, no markdown, just the JSON object.

Format:
{
  "customer_company": "<official company / organization name or null>",
  "customer_contact_name": "<individual person's name from signature, or null>",
  "products": [
    {
      "product_name": "<full product name>",
      "catalogue_number": "<cat no or null>",
      "brand": "<brand name or null>",
      "quantity": "<quantity and unit or null>",
      "specifications": "<any specs or null>",
      "extraction_confidence": "high|medium|low"
    }
  ]
}

Notes:
- Never put a person's name in "customer_company".
- If no products are found, return "products": [].`;

  const { text } = await callAI({
    system,
    userMessage: `Email body:\n\n${emailBody}`,
    maxTokens: AI_MAX_TOKENS.PRODUCT_EXTRACTION,
    model: AI_MODELS.HAIKU,
  });

  type ExtractedProduct = {
    product_name: string;
    catalogue_number?: string;
    brand?: string;
    quantity?: string;
    specifications?: string;
    extraction_confidence?: string;
  };

  let products: ExtractedProduct[] = [];
  let extractedCompany: string | null = null;
  let extractedContactName: string | null = null;

  const objMatch = text.match(/\{[\s\S]*\}/);
  const arrMatch = text.match(/\[[\s\S]*\]/);

  if (objMatch) {
    const parsed = JSON.parse(objMatch[0]) as {
      customer_company?: string | null;
      customer_contact_name?: string | null;
      products?: ExtractedProduct[];
    };
    products = Array.isArray(parsed.products) ? parsed.products : [];
    extractedCompany = parsed.customer_company?.trim() || null;
    extractedContactName = parsed.customer_contact_name?.trim() || null;
  } else if (arrMatch) {
    products = JSON.parse(arrMatch[0]) as ExtractedProduct[];
  } else {
    throw new Error("AI returned no parseable product data");
  }

  if (products.length === 0) {
    logger.info({ rfqId }, "Autopilot extraction: no products found");
    return { productsInserted: 0 };
  }

  // Backfill customer identity
  const updates: Partial<typeof rfqRecordsTable.$inferInsert> = {};
  const senderNameRaw = thread.senderName ?? "";
  if (extractedCompany && (!rfq.customerCompany || rfq.customerCompany.trim().length === 0)) {
    updates.customerCompany = extractedCompany;
  }
  if (
    extractedContactName &&
    (!rfq.customerName ||
      rfq.customerName.trim().length === 0 ||
      (senderNameRaw.length > 0 && rfq.customerName === senderNameRaw))
  ) {
    updates.customerName = extractedContactName;
  }
  if (Object.keys(updates).length > 0) {
    await db.update(rfqRecordsTable).set(updates).where(eq(rfqRecordsTable.id, rfqId));
  }

  // Insert products
  await db.delete(rfqProductsTable).where(eq(rfqProductsTable.rfqId, rfqId));
  const inserted = await db
    .insert(rfqProductsTable)
    .values(
      products.map((p) => ({
        rfqId,
        productName: p.product_name,
        catalogueNumber: p.catalogue_number ?? null,
        brand: p.brand ?? null,
        quantity: p.quantity ?? null,
        specifications: p.specifications ?? null,
        attachmentType: "body" as const,
        extractionConfidence: (p.extraction_confidence ?? "medium") as "high" | "medium" | "low",
      })),
    )
    .returning();

  logger.info({ rfqId, productsInserted: inserted.length }, "Autopilot extraction: complete");
  return { productsInserted: inserted.length };
}
