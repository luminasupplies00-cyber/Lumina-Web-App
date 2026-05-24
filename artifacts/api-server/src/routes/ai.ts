import { Router } from "express";
import { db } from "@workspace/db";
import {
  rfqRecordsTable,
  rfqProductsTable,
  rfqSupplierQuotesTable,
  rfqSupplierQuoteLinesTable,
  rfqCustomerQuotesTable,
  aiDraftsTable,
  emailThreadsTable,
} from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { callAI, callPerplexity, type AIAttachment } from "../lib/aiClient.js";
import { rfqSupplierContactsTable } from "@workspace/db";
import { AI_MAX_TOKENS } from "../lib/aiConstants.js";
import {
  getAllZohoConnections,
  downloadAttachment,
  findMessageFolderId,
  fetchFullMessage,
} from "../lib/zohoClient.js";
import * as XLSX from "xlsx";

// Anthropic limits: ~5MB per image, ~32MB per PDF. We cap each file at 4.5MB
// to leave headroom for base64 overhead, and cap the total payload to keep
// AI calls fast and within model input limits.
const MAX_ATTACHMENT_BYTES = 4_500_000;
const MAX_TOTAL_ATTACHMENT_BYTES = 15_000_000;
const MAX_ATTACHMENT_COUNT = 8;
// Anthropic-supported image media types only.
const ANTHROPIC_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type AttachmentKind = "image" | "pdf" | "spreadsheet" | null;

function classifyAttachment(name: string, fallback?: string): { kind: AttachmentKind; mime: string | null } {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (ext === "pdf") return { kind: "pdf", mime: "application/pdf" };
  if (ext === "png") return { kind: "image", mime: "image/png" };
  if (ext === "jpg" || ext === "jpeg") return { kind: "image", mime: "image/jpeg" };
  if (ext === "gif") return { kind: "image", mime: "image/gif" };
  if (ext === "webp") return { kind: "image", mime: "image/webp" };
  if (ext === "xlsx" || ext === "xls" || ext === "xlsm" || ext === "csv") {
    return { kind: "spreadsheet", mime: null };
  }
  if (fallback) {
    const m = fallback.toLowerCase().split(";")[0]?.trim() ?? "";
    if (m === "application/pdf") return { kind: "pdf", mime: m };
    if (ANTHROPIC_IMAGE_MIMES.has(m)) return { kind: "image", mime: m };
    if (
      m === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      m === "application/vnd.ms-excel" ||
      m === "text/csv"
    ) {
      return { kind: "spreadsheet", mime: null };
    }
  }
  return { kind: null, mime: null };
}

// Parse an .xlsx/.xls/.csv buffer into a compact text representation that
// Claude can read as part of the user message.
function spreadsheetToText(buffer: Buffer, filename: string): string {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const parts: string[] = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false, strip: true });
    const trimmed = csv.trim();
    if (!trimmed) continue;
    parts.push(`--- Sheet: ${sheetName} ---\n${trimmed}`);
  }
  if (parts.length === 0) return `(${filename}: empty spreadsheet)`;
  // Hard cap on text length to keep prompts small.
  const joined = parts.join("\n\n");
  const MAX_CHARS = 60_000;
  return joined.length > MAX_CHARS
    ? `${joined.slice(0, MAX_CHARS)}\n…(truncated — file too large)`
    : joined;
}

const router = Router();

async function getRfqOrFail(id: number) {
  const rows = await db.select().from(rfqRecordsTable).where(eq(rfqRecordsTable.id, id)).limit(1);
  return rows[0] ?? null;
}

router.post("/rfq/:id/extract-products", async (req, res) => {
  try {
    const rfqId = parseInt(req.params["id"] ?? "0");
    const rfq = await getRfqOrFail(rfqId);
    if (!rfq) {
      res.status(404).json({ error: "RFQ not found" });
      return;
    }

    let emailBody = "";
    let threadRow: typeof emailThreadsTable.$inferSelect | null = null;
    if (rfq.emailThreadId) {
      const rows = await db
        .select()
        .from(emailThreadsTable)
        .where(eq(emailThreadsTable.id, rfq.emailThreadId))
        .limit(1);
      threadRow = rows[0] ?? null;
      emailBody = threadRow?.bodyText ?? threadRow?.snippet ?? "";
    }

    // Fetch supported attachments (PDFs, images, spreadsheets) from the thread
    // and pass them to Claude so it can extract products from quote sheets /
    // spec docs too. PDFs/images go as native multimodal blocks; spreadsheets
    // (.xlsx/.xls/.csv) are parsed locally to text and appended to the prompt.
    const aiAttachments: AIAttachment[] = [];
    const spreadsheetTexts: Array<{ name: string; text: string }> = [];
    const attachmentDebug: Array<{ name: string; included: boolean; reason?: string }> = [];
    if (threadRow && threadRow.accountId && (threadRow.hasAttachments || (threadRow.attachments ?? []).length > 0)) {
      const conns = await getAllZohoConnections();
      const conn = conns.find((c) => c.accountId === threadRow!.accountId) ?? null;
      if (conn) {
        const messageId = (() => {
          const idx = threadRow!.threadId.indexOf(":");
          return idx >= 0 ? threadRow!.threadId.slice(idx + 1) : threadRow!.threadId;
        })();
        let folderId = threadRow.folderId;
        if (!folderId) {
          folderId = await findMessageFolderId(conn, messageId);
          if (folderId) {
            await db.update(emailThreadsTable).set({ folderId }).where(eq(emailThreadsTable.id, threadRow.id));
          }
        }
        // Lazily materialize the attachment list if it hasn't been fetched yet
        // (user hasn't opened the email's detail view yet). Without this, the
        // attachments array stays empty and extraction silently skips them.
        if (
          folderId &&
          (threadRow.attachmentsVerifiedAt == null || (threadRow.attachments ?? []).length === 0)
        ) {
          try {
            const detail = await fetchFullMessage(conn, messageId, folderId);
            const merged = detail.attachments.length > 0 ? detail.attachments : (threadRow.attachments ?? []);
            await db
              .update(emailThreadsTable)
              .set({
                bodyHtml: detail.bodyHtml,
                bodyText: detail.bodyText || threadRow.bodyText,
                attachments: merged,
                hasAttachments: merged.length > 0 || threadRow.hasAttachments,
                attachmentsVerifiedAt: new Date(),
              })
              .where(eq(emailThreadsTable.id, threadRow.id));
            threadRow = { ...threadRow, attachments: merged, bodyHtml: detail.bodyHtml };
            if (!emailBody && detail.bodyText) emailBody = detail.bodyText;
          } catch (e) {
            req.log.warn({ err: e, threadId: threadRow.id }, "Failed to lazy-fetch attachments for extraction");
          }
        }
        if (folderId) {
          let totalBytes = 0;
          // Spreadsheets are typically larger raw but parse down to small text,
          // so allow a higher per-file size cap for them.
          const SPREADSHEET_MAX_BYTES = 15_000_000;
          for (const att of threadRow.attachments) {
            if (aiAttachments.length + spreadsheetTexts.length >= MAX_ATTACHMENT_COUNT) {
              attachmentDebug.push({ name: att.name, included: false, reason: "attachment count cap reached" });
              continue;
            }
            const { kind, mime } = classifyAttachment(att.name, att.type);
            if (!kind) {
              attachmentDebug.push({ name: att.name, included: false, reason: "unsupported type" });
              continue;
            }
            const perFileCap = kind === "spreadsheet" ? SPREADSHEET_MAX_BYTES : MAX_ATTACHMENT_BYTES;
            if (att.size != null && att.size > perFileCap) {
              attachmentDebug.push({ name: att.name, included: false, reason: "too large" });
              continue;
            }
            try {
              const dl = await downloadAttachment(conn, messageId, att.attachmentId, folderId);
              if (dl.buffer.byteLength > perFileCap) {
                attachmentDebug.push({ name: att.name, included: false, reason: "too large after download" });
                continue;
              }
              if (kind === "spreadsheet") {
                try {
                  const text = spreadsheetToText(dl.buffer, att.name);
                  spreadsheetTexts.push({ name: att.name, text });
                  attachmentDebug.push({ name: att.name, included: true });
                } catch (e) {
                  req.log.warn({ err: e, attachment: att.name }, "Spreadsheet parse failed");
                  attachmentDebug.push({ name: att.name, included: false, reason: "spreadsheet parse failed" });
                }
                continue;
              }
              // PDF or image — send as native multimodal block.
              if (totalBytes + dl.buffer.byteLength > MAX_TOTAL_ATTACHMENT_BYTES) {
                attachmentDebug.push({ name: att.name, included: false, reason: "total payload cap reached" });
                continue;
              }
              totalBytes += dl.buffer.byteLength;
              aiAttachments.push({
                mediaType: mime!,
                base64: dl.buffer.toString("base64"),
                name: att.name,
              });
              attachmentDebug.push({ name: att.name, included: true });
            } catch (e) {
              req.log.warn({ err: e, attachment: att.name }, "Failed to download attachment for AI extraction");
              attachmentDebug.push({ name: att.name, included: false, reason: "download failed" });
            }
          }
        }
      }
    }

    if (!emailBody && aiAttachments.length === 0 && spreadsheetTexts.length === 0) {
      res.status(400).json({
        error: "No email body or readable attachments available for this RFQ.",
        zohoLink: rfq.emailThreadId ? `https://mail.zoho.com` : null,
      });
      return;
    }

    const system = `You are a procurement assistant for Lumina Supplies, a B2B laboratory supplies company in Riyadh, Saudi Arabia.

Extract all laboratory/scientific products mentioned in the email AND in any attached documents (PDFs, images of quote sheets, spec sheets, photos of products).
ALSO extract customer identity from the email signature, letterhead, or any attached document header.

Return ONLY a valid JSON object. No explanation, no markdown, just the JSON object.

Format:
{
  "customer_company": "<official company / organization / institution name as it appears in signature or letterhead, or null>",
  "customer_contact_name": "<individual person's name from signature, or null>",
  "products": [
    {
      "product_name": "<full product name>",
      "catalogue_number": "<cat no or null>",
      "brand": "<brand name or null>",
      "quantity": "<quantity and unit or null>",
      "specifications": "<any specs or null>",
      "source": "body|attachment",
      "extraction_confidence": "high|medium|low"
    }
  ]
}

Notes:
- The COMPANY is the buying organization (university, hospital, lab, research institute, company). Prefer formal names from letterheads, signatures, or domain-derived branding over generic words like "Lab" or "Research".
- Never put a person's name in "customer_company". If unsure of the company, return null.
- De-duplicate products that appear in both the email body and an attachment.
- If no products are found, return "products": [].`;

    // Allow many more tokens when attachments are involved — quote sheets can
    // contain 50+ line items and a truncated JSON array will fail to parse.
    const hasAnyAttachment = aiAttachments.length > 0 || spreadsheetTexts.length > 0;
    const maxTokens = hasAnyAttachment
      ? 8000
      : AI_MAX_TOKENS.PRODUCT_EXTRACTION;

    const messageParts: string[] = [];
    if (emailBody.trim().length > 0) {
      messageParts.push(`Email body:\n\n${emailBody}`);
    }
    if (aiAttachments.length > 0) {
      messageParts.push(
        `Also examine the ${aiAttachments.length} attached file(s) above (${aiAttachments.map((a) => a.name).join(", ")}).`,
      );
    }
    for (const s of spreadsheetTexts) {
      messageParts.push(`Spreadsheet attachment "${s.name}" contents (CSV):\n\n${s.text}`);
    }
    if (messageParts.length === 0) {
      messageParts.push("Extract products from the attached files above.");
    }
    const userMessage = messageParts.join("\n\n");

    const { text, model } = await callAI({
      system,
      userMessage,
      maxTokens,
      attachments: aiAttachments,
    });

    type ExtractedProduct = {
      product_name: string;
      catalogue_number?: string;
      brand?: string;
      quantity?: string;
      specifications?: string;
      source?: string;
      extraction_confidence?: string;
    };
    let products: ExtractedProduct[] = [];
    let extractedCompany: string | null = null;
    let extractedContactName: string | null = null;

    const objMatch = text.match(/\{[\s\S]*\}/);
    const arrMatch = text.match(/\[[\s\S]*\]/);
    try {
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
        // Backward compat: AI returned a bare array (legacy prompt response)
        products = JSON.parse(arrMatch[0]) as ExtractedProduct[];
      } else {
        res.status(422).json({ error: "AI could not extract a structured product list.", rawResponse: text });
        return;
      }
    } catch {
      res.status(422).json({ error: "AI returned malformed product data", rawResponse: text });
      return;
    }

    if (!Array.isArray(products) || products.length === 0) {
      res.status(422).json({ error: "No products could be extracted from this email." });
      return;
    }

    // Backfill customer identity onto the RFQ row when fields are empty or
    // still equal to the raw sender name from the email thread. Never
    // overwrite values the user has explicitly edited — we use the email
    // thread's senderName as the immutable "system-provided" baseline; any
    // divergence from it implies a user edit.
    const updates: Partial<typeof rfqRecordsTable.$inferInsert> = {};
    const senderNameRaw = threadRow?.senderName ?? "";
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
          // Map AI-reported source to the schema's attachment_type enum
          // (body | pdf | image | excel). We can only know "pdf" vs "image"
          // when the AI signals "attachment"; default to "pdf" since most
          // quote sheets are PDFs and excel parsing isn't supported here.
          attachmentType: (p.source === "attachment" ? "pdf" : "body") as "body" | "pdf" | "image",
          extractionConfidence: (p.extraction_confidence ?? "medium") as "high" | "medium" | "low",
        })),
      )
      .returning();

    res.json({ products: inserted, model, attachmentsAnalyzed: attachmentDebug });
  } catch (err) {
    req.log.error({ err }, "Product extraction failed");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/rfq/:id/parse-supplier-reply", async (req, res) => {
  try {
    const rfqId = parseInt(req.params["id"] ?? "0");
    const body = req.body as { emailText: string; supplierName?: string };

    if (!body.emailText || body.emailText.trim().length === 0) {
      res.status(400).json({ error: "emailText is required" });
      return;
    }

    const rfq = await getRfqOrFail(rfqId);
    if (!rfq) {
      res.status(404).json({ error: "RFQ not found" });
      return;
    }

    const system = `You are a procurement assistant parsing a supplier reply email for Lumina Supplies, a B2B laboratory supplies company in Riyadh, Saudi Arabia.

Extract pricing and availability information from the supplier's reply.
Return ONLY a valid JSON object. No explanation, no markdown.

Format:
{
  "supplier_name": "<supplier name if found, or null>",
  "supplier_email": "<supplier email if found, or null>",
  "currency": "<currency code, default SAR>",
  "notes": "<any important notes, terms, conditions, or null>",
  "lines": [
    {
      "product_name": "<product description>",
      "unit_price": "<price as string, e.g. '245.50'>",
      "currency": "<currency code>",
      "lead_time_days": <integer or null>,
      "moq": "<minimum order quantity or null>",
      "notes": "<per-line notes or null>"
    }
  ]
}

If prices are unclear, use your best estimate. Always include all products mentioned.`;

    const { text, model } = await callAI({
      system,
      userMessage: body.emailText,
      maxTokens: AI_MAX_TOKENS.SUPPLIER_QUOTE_PARSE,
    });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      res.status(422).json({ error: "AI could not parse the supplier reply.", rawResponse: text });
      return;
    }

    let parsed: {
      supplier_name?: string;
      supplier_email?: string;
      currency?: string;
      notes?: string;
      lines: Array<{
        product_name: string;
        unit_price: string;
        currency?: string;
        lead_time_days?: number | null;
        moq?: string | null;
        notes?: string | null;
      }>;
    };

    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      res.status(422).json({ error: "AI returned malformed parse data", rawResponse: text });
      return;
    }

    // Save the raw input + parsed result for audit
    const [draft] = await db
      .insert(aiDraftsTable)
      .values({
        rfqId,
        draftType: "supplier_quote_parse",
        content: JSON.stringify(parsed),
        rawInput: body.emailText,
        modelUsed: model,
      })
      .returning();

    const result = {
      supplierName: body.supplierName ?? parsed.supplier_name ?? null,
      supplierEmail: parsed.supplier_email ?? null,
      currency: parsed.currency ?? "SAR",
      notes: parsed.notes ?? null,
      lines: (parsed.lines ?? []).map((l) => ({
        productName: l.product_name,
        unitPrice: l.unit_price,
        currency: l.currency ?? parsed.currency ?? "SAR",
        leadTimeDays: l.lead_time_days ?? null,
        moq: l.moq ?? null,
        notes: l.notes ?? null,
      })),
    };

    res.json({ parsed: result, draftId: draft?.id, model });
  } catch (err) {
    req.log.error({ err }, "Supplier reply parse failed");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/rfq/:id/draft-supplier", async (req, res) => {
  try {
    const rfqId = parseInt(req.params["id"] ?? "0");
    const rfq = await getRfqOrFail(rfqId);
    if (!rfq) {
      res.status(404).json({ error: "RFQ not found" });
      return;
    }

    const products = await db.select().from(rfqProductsTable).where(eq(rfqProductsTable.rfqId, rfqId));

    const system = `You are writing a professional supplier inquiry email on behalf of Lumina Supplies, a B2B laboratory and scientific supplies company based in Riyadh, Saudi Arabia.

The email must:
- Have a professional, concise business tone
- Briefly mention what kind of items are being requested (one short sentence is enough)
- Request: unit price (SAR preferred), lead time, MOQ, and quote validity
- End with a professional closing from Lumina Supplies
- Leave a clearly-marked placeholder line "{{PRODUCTS_BLOCK}}" on its own line where the product list / table / attachment reference should go — the system will inject the correct format afterwards based on the number of items.

Do NOT enumerate the products yourself, do NOT generate a Markdown or ASCII table, and do NOT mention an attachment unless instructed. Plain text only, no HTML.`;

    const productSummary = products.length > 0
      ? `${products.length} line item${products.length === 1 ? "" : "s"} (e.g. ${products
          .slice(0, 3)
          .map((p) => p.productName)
          .join("; ")}${products.length > 3 ? "; …" : ""})`
      : "items to be specified";

    const userMessage = `Client inquiry context:
Customer: ${rfq.customerName}${rfq.customerCompany ? ` from ${rfq.customerCompany}` : ""}
Urgency: ${rfq.urgency ?? rfq.intentSignal ?? "standard"}
${rfq.deadline ? `Deadline: ${rfq.deadline}` : ""}

Request summary: ${productSummary}

Please draft the supplier inquiry email. Remember to include the literal placeholder line {{PRODUCTS_BLOCK}} where the items should go.`;

    const { text, model } = await callAI({ system, userMessage, maxTokens: AI_MAX_TOKENS.SUPPLIER_DRAFT });

    const [draft] = await db
      .insert(aiDraftsTable)
      .values({ rfqId, draftType: "supplier_email", content: text, modelUsed: model })
      .returning();

    res.json({ draft: text, draftId: draft?.id, model });
  } catch (err) {
    req.log.error({ err }, "Supplier draft failed");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/rfq/:id/draft-customer", async (req, res) => {
  try {
    const rfqId = parseInt(req.params["id"] ?? "0");
    const body = req.body as {
      markupPercent?: number;
      landedCostBufferPercent?: number;
      revisionReason?: string;
      parentQuoteId?: number;
    };

    const markup = body.markupPercent ?? 30;
    const landedBuffer = body.landedCostBufferPercent ?? 8;

    const rfq = await getRfqOrFail(rfqId);
    if (!rfq) {
      res.status(404).json({ error: "RFQ not found" });
      return;
    }

    const products = await db.select().from(rfqProductsTable).where(eq(rfqProductsTable.rfqId, rfqId));
    const quotes = await db.select().from(rfqSupplierQuotesTable).where(eq(rfqSupplierQuotesTable.rfqId, rfqId));

    let pricedProducts = "";
    let totalValue = 0;

    if (quotes.length > 0) {
      // Use the quote with the lowest total amount
      const sorted = quotes
        .filter((q) => q.totalAmount)
        .sort((a, b) => parseFloat(a.totalAmount ?? "0") - parseFloat(b.totalAmount ?? "0"));

      const bestQuote = sorted[0] ?? quotes[0]!;
      const lines = await db
        .select()
        .from(rfqSupplierQuoteLinesTable)
        .where(eq(rfqSupplierQuoteLinesTable.quoteId, bestQuote.id));

      pricedProducts = lines
        .map((line, i) => {
          const cost = parseFloat(line.unitPrice);
          let sellingPrice = "TBD";
          if (!isNaN(cost)) {
            const landed = cost * (1 + landedBuffer / 100);
            const selling = landed * (1 + markup / 100);
            sellingPrice = selling.toFixed(2);
            totalValue += selling;
          }
          const product = products.find((p) => p.id === line.rfqProductId);
          const name = product?.productName ?? line.productName ?? `Item ${i + 1}`;
          return `${i + 1}. ${name} | ${product?.catalogueNumber ?? "N/A"} | ${product?.brand ?? "N/A"} | ${product?.quantity ?? "1"} | ${sellingPrice} ${bestQuote.currency}`;
        })
        .join("\n");
    } else {
      pricedProducts = products
        .map(
          (p, i) =>
            `${i + 1}. ${p.productName} | ${p.catalogueNumber ?? "N/A"} | ${p.brand ?? "N/A"} | ${p.quantity ?? "1"} | Price TBD`,
        )
        .join("\n");
    }

    const isRevision = !!body.parentQuoteId;
    const system = `You are writing a professional customer quotation email on behalf of Lumina Supplies, a B2B laboratory and scientific supplies company based in Riyadh, Saudi Arabia.

The email must:
- Begin with a professional greeting to the customer by name${isRevision ? "\n- Note this is a revised quotation (Rev ${body.parentQuoteId})" : ""}
- Include a numbered product table: # | Description | Cat No | Brand | Qty | Unit Price (SAR) | Total (SAR)
- State payment terms: Net 30
- State quote validity: 30 days from date
- End with a professional closing from Lumina Supplies team

Pricing already includes landed cost buffer (${landedBuffer}%) and markup (${markup}%).
Do not use HTML. Plain text email format only. Currency in SAR.`;

    const userMessage = `Customer: ${rfq.customerName}${rfq.customerCompany ? ` at ${rfq.customerCompany}` : ""}
${isRevision && body.revisionReason ? `Revision reason: ${body.revisionReason}` : ""}

Products with selling prices:
${pricedProducts}

Please generate the professional customer quotation email.`;

    const { text, model } = await callAI({ system, userMessage, maxTokens: AI_MAX_TOKENS.CUSTOMER_QUOTE });

    // Get next version number
    const existingQuotes = await db
      .select()
      .from(rfqCustomerQuotesTable)
      .where(eq(rfqCustomerQuotesTable.rfqId, rfqId))
      .orderBy(desc(rfqCustomerQuotesTable.versionNumber))
      .limit(1);

    const nextVersion = (existingQuotes[0]?.versionNumber ?? 0) + 1;

    const [savedQuote] = await db
      .insert(rfqCustomerQuotesTable)
      .values({
        rfqId,
        markupPercent: markup.toString(),
        landedCostBufferPercent: landedBuffer.toString(),
        markupApplied: markup.toString(),
        totalValue: totalValue > 0 ? totalValue.toFixed(2) : null,
        currency: "SAR",
        validityDays: 30,
        draft: text,
        versionNumber: nextVersion,
        parentQuoteId: body.parentQuoteId ?? null,
        revisionReason: body.revisionReason ?? null,
        wasRevised: false,
        revisionCount: 0,
      })
      .returning();

    const [draft] = await db
      .insert(aiDraftsTable)
      .values({ rfqId, draftType: "customer_quote", content: text, modelUsed: model })
      .returning();

    await db
      .update(rfqRecordsTable)
      .set({ stage: "QUOTE_READY", stageUpdatedAt: new Date() })
      .where(eq(rfqRecordsTable.id, rfqId));

    res.json({ draft: text, draftId: draft?.id, quoteId: savedQuote?.id, versionNumber: nextVersion, model });
  } catch (err) {
    req.log.error({ err }, "Customer quote draft failed");
    res.status(500).json({ error: String(err) });
  }
});

router.get("/rfq/:id/compare", async (req, res) => {
  try {
    const rfqId = parseInt(req.params["id"] ?? "0");

    // Get landed cost buffer — from query param or RFQ record
    const rfq = await getRfqOrFail(rfqId);
    const bufferFromQuery = req.query["landedCostBufferPercent"]
      ? parseFloat(req.query["landedCostBufferPercent"] as string)
      : null;
    const landedBuffer = bufferFromQuery ?? parseFloat(rfq?.landedCostBufferPercent ?? "8") ?? 8;

    const products = await db.select().from(rfqProductsTable).where(eq(rfqProductsTable.rfqId, rfqId));
    const quotes = await db.select().from(rfqSupplierQuotesTable).where(eq(rfqSupplierQuotesTable.rfqId, rfqId));

    const quotesWithLines = await Promise.all(
      quotes.map(async (q) => {
        const lines = await db.select().from(rfqSupplierQuoteLinesTable).where(eq(rfqSupplierQuoteLinesTable.quoteId, q.id));
        return { ...q, lines };
      }),
    );

    if (quotesWithLines.length === 0) {
      res.json({ comparison: null, recommendation: null, quotes: [], landedCostBufferPercent: landedBuffer });
      return;
    }

    const comparisonData = products.map((product) => {
      const supplierPrices = quotesWithLines.map((q) => {
        const line = q.lines.find((l) => l.rfqProductId === product.id);
        const unitPrice = line?.unitPrice ?? null;
        let landedUnitPrice: string | null = null;
        let sellingUnitPrice: string | null = null;

        if (unitPrice) {
          const cost = parseFloat(unitPrice);
          if (!isNaN(cost)) {
            const landed = cost * (1 + landedBuffer / 100);
            landedUnitPrice = landed.toFixed(2);
            // Show 30% markup as default for comparison
            sellingUnitPrice = (landed * 1.3).toFixed(2);
          }
        }

        return {
          supplier: q.supplierName,
          unitPrice,
          landedUnitPrice,
          sellingUnitPrice,
          currency: line?.currency ?? "SAR",
          leadTimeDays: line?.leadTimeDays ?? null,
          moq: line?.moq ?? null,
        };
      });
      return { product: product.productName, catalogueNumber: product.catalogueNumber, supplierPrices };
    });

    const system = `You are a procurement advisor for Lumina Supplies, a B2B laboratory supplies company in Riyadh.
Analyze the supplier quotes below and recommend the best option, considering price, lead time, and reliability.
A ${landedBuffer}% landed cost buffer (freight/customs) is already applied to all prices.
Be concise — 2-3 sentences maximum. State which supplier you recommend and the key reason.`;

    const { text: recommendation, model } = await callAI({
      system,
      userMessage: JSON.stringify(comparisonData, null, 2),
      maxTokens: AI_MAX_TOKENS.COMPARISON,
    });

    res.json({
      comparison: comparisonData,
      recommendation,
      quotes: quotesWithLines,
      model,
      landedCostBufferPercent: landedBuffer,
    });
  } catch (err) {
    req.log.error({ err }, "Comparison failed");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/rfq/:id/draft-followup", async (req, res) => {
  try {
    const rfqId = parseInt(req.params["id"] ?? "0");
    const rfq = await getRfqOrFail(rfqId);
    if (!rfq) {
      res.status(404).json({ error: "RFQ not found" });
      return;
    }

    const daysSinceStageUpdate = Math.floor(
      (Date.now() - new Date(rfq.stageUpdatedAt).getTime()) / (1000 * 60 * 60 * 24),
    );

    const system = `You are writing a short, polite follow-up email on behalf of Lumina Supplies, a B2B laboratory supplies company in Riyadh, Saudi Arabia.

The email must:
- Reference the original quotation sent ${daysSinceStageUpdate} days ago
- Politely ask if the customer needs any clarification or has questions
- Keep it to 3-4 sentences maximum
- Professional, friendly tone — not pushy

Do not use HTML. Plain text only.`;

    const userMessage = `Customer: ${rfq.customerName}${rfq.customerCompany ? ` at ${rfq.customerCompany}` : ""}
Days since quote sent: ${daysSinceStageUpdate}

Please draft the follow-up email.`;

    const { text, model } = await callAI({ system, userMessage, maxTokens: AI_MAX_TOKENS.FOLLOWUP });

    const [draft] = await db
      .insert(aiDraftsTable)
      .values({ rfqId, draftType: "followup", content: text, modelUsed: model })
      .returning();

    res.json({ draft: text, draftId: draft?.id, model, daysSinceStageUpdate });
  } catch (err) {
    req.log.error({ err }, "Follow-up draft failed");
    res.status(500).json({ error: String(err) });
  }
});

router.patch("/ai/drafts/:draftId/copied", async (req, res) => {
  try {
    const draftId = parseInt(req.params["draftId"] ?? "0");
    await db.update(aiDraftsTable).set({ copiedAt: new Date() }).where(eq(aiDraftsTable.id, draftId));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to mark draft as copied");
    res.status(500).json({ error: "Failed to update draft" });
  }
});

// ─── Re-classify all stored email threads ─────────────────────────────────────
router.post("/ai/reclassify-all", async (req, res) => {
  try {
    const { triageEmail, fetchMessageBody } = await import("./sync.js");
    const { getAllZohoConnections } = await import("../lib/zohoClient.js");

    const threads = await db.select().from(emailThreadsTable);

    // Build a map of accountId → Zoho connection for body re-fetching
    const connections = await getAllZohoConnections();
    const connByAccountId = new Map(connections.map((c) => [c.accountId, c]));

    const counts: Record<string, number> = {
      RFQ: 0, SUPPLIER_REPLY: 0, CUSTOMER_FOLLOWUP: 0,
      PO_INVOICE: 0, INTERNAL: 0, SPAM_NEWSLETTER: 0,
      GENERAL: 0, UNCLASSIFIED: 0,
    };
    let processed = 0;
    let failed = 0;

    for (const thread of threads) {
      try {
        // Parse accountId:messageId from threadId
        const colonIdx = thread.threadId.indexOf(":");
        const accountId = colonIdx > 0 ? thread.threadId.slice(0, colonIdx) : null;
        const messageId = colonIdx > 0 ? thread.threadId.slice(colonIdx + 1) : thread.threadId;

        // Try to get full body — re-fetch from Zoho if we have the connection
        let bodyText = thread.bodyText ?? thread.snippet ?? "";
        let attachmentNames = "none";

        if (accountId && connByAccountId.has(accountId)) {
          const conn = connByAccountId.get(accountId)!;
          const fetched = await fetchMessageBody(conn, messageId);
          if (fetched.bodyText) {
            bodyText = fetched.bodyText;
            attachmentNames = fetched.attachmentNames;
          }
        }

        const result = await triageEmail({
          senderName: thread.senderName,
          senderEmail: thread.senderEmail,
          subject: thread.subject,
          bodyText,
          attachmentNames,
        });

        const isRfq = result.classification === "RFQ";

        await db
          .update(emailThreadsTable)
          .set({
            classification: result.classification,
            aiConfidence: result.confidence,
            aiReasoning: result.reasoning,
            isRfq,
            bodyText: bodyText || thread.bodyText,
          })
          .where(eq(emailThreadsTable.id, thread.id));

        // Create rfq_record on-the-fly if newly classified as RFQ and none exists
        if (isRfq) {
          const [existingRfq] = await db
            .select({ id: rfqRecordsTable.id })
            .from(rfqRecordsTable)
            .where(eq(rfqRecordsTable.emailThreadId, thread.id))
            .limit(1);
          if (!existingRfq) {
            await db.insert(rfqRecordsTable).values({
              emailThreadId: thread.id,
              customerName: thread.senderName,
              customerEmail: thread.senderEmail,
              stage: "NEW",
              urgency: "medium",
              sourceChannel: "inbound_email",
              aiNextAction: "Extract products from email and contact suppliers",
            });
          }
        }

        counts[result.classification] = (counts[result.classification] ?? 0) + 1;
        processed++;
      } catch (err) {
        req.log.error({ err, threadId: thread.threadId }, "Reclassify failed for thread");
        await db
          .update(emailThreadsTable)
          .set({ classification: "UNCLASSIFIED", aiConfidence: "low" })
          .where(eq(emailThreadsTable.id, thread.id));
        counts["UNCLASSIFIED"] = (counts["UNCLASSIFIED"] ?? 0) + 1;
        failed++;
      }
    }

    req.log.info({ processed, failed, counts }, "Reclassification complete");
    res.json({ ok: true, total: threads.length, processed, failed, counts });
  } catch (err) {
    req.log.error({ err }, "Reclassify-all failed");
    res.status(500).json({ error: String(err) });
  }
});

// ─── Perplexity: Find suppliers online ────────────────────────────────────────
router.post("/rfq/:id/find-suppliers-online", async (req, res) => {
  try {
    const rfqId = parseInt(req.params["id"] ?? "0");
    const body = (req.body ?? {}) as { query?: string };

    const rfq = await getRfqOrFail(rfqId);
    if (!rfq) {
      res.status(404).json({ error: "RFQ not found" });
      return;
    }

    let query = body.query?.trim();
    if (!query) {
      const products = await db.select().from(rfqProductsTable).where(eq(rfqProductsTable.rfqId, rfqId));
      const productSummary = products.slice(0, 10)
        .map((p) => `${p.productName}${p.catalogueNumber ? ` (${p.catalogueNumber})` : ""}${p.brand ? ` ${p.brand}` : ""}`)
        .join("; ");
      query = `Suppliers or distributors in Saudi Arabia (or international suppliers shipping to KSA) for laboratory / scientific products: ${productSummary || "lab supplies"}.`;
    }

    const system = `You are a B2B sourcing assistant for Lumina Supplies (a Saudi Arabia lab supplier).
Your job is to find real, verifiable supplier or distributor companies for the requested products.

Return ONLY valid JSON in this exact shape, no prose, no markdown fences:
{"results":[{"name":"...","website":"...","email":"...","country":"...","relevance":"...","offerings":"..."}]}

Rules:
- 5-10 results max, ranked by relevance.
- Prefer suppliers based in or shipping to Saudi Arabia / GCC.
- Use only contact emails you can verify on the company's website. If unknown, set "email" to null.
- "relevance" is one short sentence on why they fit.
- Never invent emails or URLs.`;

    const { text, citations, model } = await callPerplexity({
      system,
      userMessage: query,
      maxTokens: 1500,
    });

    // Extract JSON
    type Result = {
      name: string;
      website: string | null;
      email: string | null;
      country: string | null;
      relevance: string | null;
      offerings: string | null;
    };
    let results: Result[] = [];
    try {
      const cleaned = text.replace(/```json\s*|\s*```/g, "").trim();
      const match = cleaned.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match ? match[0] : cleaned) as { results?: Result[] };
      results = Array.isArray(parsed.results) ? parsed.results : [];
    } catch (e) {
      req.log.warn({ err: e, text }, "Failed to parse Perplexity supplier search result");
    }

    res.json({ query, results, citations, model });
  } catch (err) {
    req.log.error({ err }, "find-suppliers-online failed");
    res.status(500).json({ error: String(err) });
  }
});

// ─── Perplexity: summarize a supplier website ─────────────────────────────────
router.post("/ai/summarize-supplier-website", async (req, res) => {
  try {
    const body = req.body as { url: string; supplierName?: string };
    if (!body.url) {
      res.status(400).json({ error: "url is required" });
      return;
    }

    const system = `You are a B2B sourcing analyst. Given a supplier website URL, summarise:
- What they sell (1-2 sentences)
- Key product categories or brands carried
- Country / region
- Contact email (only if found on the site)

Return ONLY valid JSON, no prose:
{"summary":"...","offerings":"...","contactEmail":"... or null","country":"... or null"}`;

    const userMessage = `Supplier website: ${body.url}${body.supplierName ? `\nCompany name: ${body.supplierName}` : ""}\n\nSummarise this supplier.`;

    const { text, citations, model } = await callPerplexity({
      system,
      userMessage,
      maxTokens: 800,
    });

    type Parsed = { summary: string; offerings?: string | null; contactEmail?: string | null; country?: string | null };
    let parsed: Parsed = { summary: text };
    try {
      const cleaned = text.replace(/```json\s*|\s*```/g, "").trim();
      const match = cleaned.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(match ? match[0] : cleaned) as Parsed;
    } catch (e) {
      req.log.warn({ err: e }, "Falling back to raw text for website summary");
    }

    res.json({
      summary: parsed.summary ?? text,
      offerings: parsed.offerings ?? null,
      contactEmail: parsed.contactEmail ?? null,
      country: parsed.country ?? null,
      citations,
      model,
    });
  } catch (err) {
    req.log.error({ err }, "summarize-supplier-website failed");
    res.status(500).json({ error: String(err) });
  }
});

// ─── Per-contact supplier follow-up draft ─────────────────────────────────────
router.post("/rfq/:id/draft-supplier-followup", async (req, res) => {
  try {
    const rfqId = parseInt(req.params["id"] ?? "0");
    const body = req.body as { contactId?: number; tone?: "gentle" | "urgent" };

    const rfq = await getRfqOrFail(rfqId);
    if (!rfq) {
      res.status(404).json({ error: "RFQ not found" });
      return;
    }

    let supplierName = "Supplier";
    let hoursSince: number | null = null;
    if (body.contactId) {
      const { and } = await import("drizzle-orm");
      const rows = await db
        .select()
        .from(rfqSupplierContactsTable)
        .where(
          and(
            eq(rfqSupplierContactsTable.id, body.contactId),
            eq(rfqSupplierContactsTable.rfqId, rfqId),
          ),
        )
        .limit(1);
      if (!rows[0]) {
        res.status(404).json({ error: "Contact not found for this RFQ" });
        return;
      }
      supplierName = rows[0].supplierName;
      hoursSince = (Date.now() - new Date(rows[0].contactedAt).getTime()) / 3_600_000;
    }

    const products = await db.select().from(rfqProductsTable).where(eq(rfqProductsTable.rfqId, rfqId));
    const productList = products.slice(0, 8)
      .map((p, i) => `${i + 1}. ${p.productName}${p.catalogueNumber ? ` (${p.catalogueNumber})` : ""}${p.quantity ? ` × ${p.quantity}` : ""}`)
      .join("\n");

    const tone = body.tone ?? "gentle";
    const system = `You are writing a ${tone} follow-up email from Lumina Supplies (a Saudi Arabia B2B lab supplier) to a supplier we asked for a quote.
Style:
- Professional, concise (4-6 short sentences).
- ${tone === "urgent" ? "Make clear the client needs a fast response." : "Polite reminder; do not pressure."}
- Reference the original inquiry briefly.
- Re-attach the request: ask for unit price (SAR preferred), lead time, MOQ, validity.
- Plain text only, no HTML.
- End with a Lumina Supplies sign-off.`;

    const userMessage = `Supplier: ${supplierName}
Customer: ${rfq.customerName}${rfq.customerCompany ? ` (${rfq.customerCompany})` : ""}
Original inquiry sent ${hoursSince ? `${Math.round(hoursSince)}h ago` : "previously"}.

Products requested:
${productList || "(see original email)"}

Draft the follow-up email.`;

    const { text, model } = await callAI({
      system,
      userMessage,
      maxTokens: AI_MAX_TOKENS.FOLLOWUP,
    });

    const [draft] = await db
      .insert(aiDraftsTable)
      .values({ rfqId, draftType: "supplier_followup", content: text, modelUsed: model })
      .returning();

    res.json({ draft: text, draftId: draft?.id, model });
  } catch (err) {
    req.log.error({ err }, "draft-supplier-followup failed");
    res.status(500).json({ error: String(err) });
  }
});

export default router;
