import { Router } from "express";
import { db } from "@workspace/db";
import {
  rfqRecordsTable,
  rfqProductsTable,
  rfqSupplierQuotesTable,
  rfqSupplierQuoteLinesTable,
  rfqCustomerQuotesTable,
  rfqSupplierContactsTable,
  suppliersTable,
  supplierCategoriesTable,
  emailThreadsTable,
  RFQ_STAGES,
  type RfqStage,
} from "@workspace/db";
import { eq, desc, and, gte, sql, count, inArray } from "drizzle-orm";
import { isRfqStuck, stuckSinceDate } from "../lib/stuckRfq.js";

const router = Router();

function computeStuck(rfq: { stage: string; stageUpdatedAt: Date | string }) {
  const updatedAt = new Date(rfq.stageUpdatedAt);
  const stuck = isRfqStuck(rfq.stage, updatedAt);
  return {
    isStuck: stuck,
    stuckSince: stuck ? stuckSinceDate(rfq.stage, updatedAt)?.toISOString() ?? null : null,
  };
}

router.get("/rfq", async (req, res) => {
  try {
    const rfqs = await db
      .select()
      .from(rfqRecordsTable)
      .orderBy(desc(rfqRecordsTable.createdAt));

    const rfqsWithProducts = await Promise.all(
      rfqs.map(async (rfq) => {
        const products = await db
          .select()
          .from(rfqProductsTable)
          .where(eq(rfqProductsTable.rfqId, rfq.id));

        const thread = rfq.emailThreadId
          ? await db
              .select({
                id: emailThreadsTable.id,
                subject: emailThreadsTable.subject,
                threadId: emailThreadsTable.threadId,
                hasAttachments: emailThreadsTable.hasAttachments,
                attachments: emailThreadsTable.attachments,
              })
              .from(emailThreadsTable)
              .where(eq(emailThreadsTable.id, rfq.emailThreadId))
              .limit(1)
          : [];

        const stuckInfo = computeStuck(rfq);

        const contactRows = await db
          .select()
          .from(rfqSupplierContactsTable)
          .where(eq(rfqSupplierContactsTable.rfqId, rfq.id))
          .orderBy(rfqSupplierContactsTable.contactedAt);

        const now = Date.now();
        const supplierContacts = contactRows.map((c) => {
          const hours = (now - new Date(c.contactedAt).getTime()) / 3_600_000;
          return { ...c, hoursSinceContact: hours };
        });
        const noResponseCount = supplierContacts.filter(
          (c) => c.status === "contacted" && (c.hoursSinceContact ?? 0) > 48,
        ).length;

        return {
          ...rfq,
          ...stuckInfo,
          products,
          supplierContacts,
          noResponseCount,
          emailSubject: thread[0]?.subject ?? null,
          zohoThreadId: thread[0]?.threadId ?? null,
          threadDbId: thread[0]?.id ?? null,
          hasAttachments: thread[0]?.hasAttachments ?? false,
          attachments: thread[0]?.attachments ?? [],
        };
      }),
    );

    const grouped: Record<string, typeof rfqsWithProducts> = {};
    for (const stage of RFQ_STAGES) {
      grouped[stage] = [];
    }
    for (const rfq of rfqsWithProducts) {
      const stage = rfq.stage as RfqStage;
      if (grouped[stage]) {
        // Stuck RFQs sort to the top within their stage
        if (rfq.isStuck) {
          grouped[stage]!.unshift(rfq);
        } else {
          grouped[stage]!.push(rfq);
        }
      }
    }

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const [newTodayRows, sourcingRows, awaitingRows, wonMonthRows, pipelineValueRows] =
      await Promise.all([
        db.select({ count: count() }).from(rfqRecordsTable).where(gte(rfqRecordsTable.createdAt, startOfDay)),
        db.select({ count: count() }).from(rfqRecordsTable).where(eq(rfqRecordsTable.stage, "SOURCING")),
        db.select({ count: count() }).from(rfqRecordsTable).where(eq(rfqRecordsTable.stage, "QUOTE_SENT")),
        db.select({ count: count() }).from(rfqRecordsTable).where(
          and(eq(rfqRecordsTable.stage, "WON"), gte(rfqRecordsTable.stageUpdatedAt, startOfMonth)),
        ),
        db.select({ total: sql<string>`COALESCE(SUM(estimated_value), 0)` }).from(rfqRecordsTable).where(
          and(sql`stage NOT IN ('WON', 'LOST')`, sql`estimated_value IS NOT NULL`),
        ),
      ]);

    const stuckCount = rfqsWithProducts.filter((r) => r.isStuck).length;

    const metrics = {
      newToday: newTodayRows[0]?.count ?? 0,
      inSourcing: sourcingRows[0]?.count ?? 0,
      awaitingCustomer: awaitingRows[0]?.count ?? 0,
      wonThisMonth: wonMonthRows[0]?.count ?? 0,
      totalPipelineValue: parseFloat(pipelineValueRows[0]?.total ?? "0"),
      currency: "SAR",
      stuckCount,
    };

    res.json({ rfqs: grouped, metrics });
  } catch (err) {
    req.log.error({ err }, "Failed to get RFQs");
    res.status(500).json({ error: "Failed to retrieve RFQs" });
  }
});

router.post("/rfq", async (req, res) => {
  try {
    const body = req.body as {
      customerName: string;
      customerCompany?: string;
      customerEmail?: string;
      emailThreadId?: number;
      notes?: string;
      sourceChannel?: string;
    };

    if (!body.customerName) {
      res.status(400).json({ error: "customerName is required" });
      return;
    }

    const [rfq] = await db
      .insert(rfqRecordsTable)
      .values({
        customerName: body.customerName,
        customerCompany: body.customerCompany,
        customerEmail: body.customerEmail,
        emailThreadId: body.emailThreadId,
        notes: body.notes,
        stage: "NEW",
        sourceChannel: body.sourceChannel ?? "inbound_email",
      })
      .returning();

    res.status(201).json({ rfq });
  } catch (err) {
    req.log.error({ err }, "Failed to create RFQ");
    res.status(500).json({ error: "Failed to create RFQ" });
  }
});

router.get("/rfq/:id", async (req, res) => {
  try {
    const id = parseInt(req.params["id"] ?? "0");
    const rows = await db.select().from(rfqRecordsTable).where(eq(rfqRecordsTable.id, id)).limit(1);

    if (!rows[0]) {
      res.status(404).json({ error: "RFQ not found" });
      return;
    }

    const [products, quotes, thread] = await Promise.all([
      db.select().from(rfqProductsTable).where(eq(rfqProductsTable.rfqId, id)),
      db.select().from(rfqSupplierQuotesTable).where(eq(rfqSupplierQuotesTable.rfqId, id)),
      rows[0].emailThreadId
        ? db.select().from(emailThreadsTable).where(eq(emailThreadsTable.id, rows[0].emailThreadId)).limit(1)
        : Promise.resolve([]),
    ]);

    const quotesWithLines = await Promise.all(
      quotes.map(async (q) => {
        const lines = await db.select().from(rfqSupplierQuoteLinesTable).where(eq(rfqSupplierQuoteLinesTable.quoteId, q.id));
        return { ...q, lines };
      }),
    );

    res.json({
      rfq: { ...rows[0], ...computeStuck(rows[0]) },
      products,
      quotes: quotesWithLines,
      thread: thread[0] ?? null,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get RFQ");
    res.status(500).json({ error: "Failed to retrieve RFQ" });
  }
});

router.patch("/rfq/:id/stage", async (req, res) => {
  try {
    const id = parseInt(req.params["id"] ?? "0");
    const body = req.body as { stage: string; lostReason?: string };

    if (!RFQ_STAGES.includes(body.stage as RfqStage)) {
      res.status(400).json({ error: `Invalid stage. Must be one of: ${RFQ_STAGES.join(", ")}` });
      return;
    }

    const updateData: Record<string, unknown> = {
      stage: body.stage,
      stageUpdatedAt: new Date(),
    };

    if (body.stage === "LOST" && body.lostReason) {
      updateData["lostReason"] = body.lostReason;
    }

    const [updated] = await db
      .update(rfqRecordsTable)
      .set(updateData)
      .where(eq(rfqRecordsTable.id, id))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "RFQ not found" });
      return;
    }

    res.json({ rfq: { ...updated, ...computeStuck(updated) } });
  } catch (err) {
    req.log.error({ err }, "Failed to update RFQ stage");
    res.status(500).json({ error: "Failed to update stage" });
  }
});

router.patch("/rfq/:id", async (req, res) => {
  try {
    const id = parseInt(req.params["id"] ?? "0");
    const body = req.body as {
      notes?: string;
      estimatedValue?: string;
      customerName?: string;
      customerCompany?: string;
      aiNextAction?: string;
      lostReason?: string;
      landedCostBufferPercent?: string;
    };

    const [updated] = await db
      .update(rfqRecordsTable)
      .set({
        ...(body.notes !== undefined && { notes: body.notes }),
        ...(body.estimatedValue !== undefined && { estimatedValue: body.estimatedValue }),
        ...(body.customerName !== undefined && { customerName: body.customerName }),
        ...(body.customerCompany !== undefined && { customerCompany: body.customerCompany }),
        ...(body.aiNextAction !== undefined && { aiNextAction: body.aiNextAction }),
        ...(body.lostReason !== undefined && { lostReason: body.lostReason }),
        ...(body.landedCostBufferPercent !== undefined && { landedCostBufferPercent: body.landedCostBufferPercent }),
      })
      .where(eq(rfqRecordsTable.id, id))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "RFQ not found" });
      return;
    }

    res.json({ rfq: { ...updated, ...computeStuck(updated) } });
  } catch (err) {
    req.log.error({ err }, "Failed to update RFQ");
    res.status(500).json({ error: "Failed to update RFQ" });
  }
});

router.post("/rfq/:id/confirm-extraction", async (req, res) => {
  try {
    const rfqId = parseInt(req.params["id"] ?? "0");
    const body = req.body as {
      products: Array<{
        id?: number;
        productName: string;
        catalogueNumber?: string;
        brand?: string;
        quantity?: string;
        specifications?: string;
        notes?: string;
        extractionConfidence?: string;
      }>;
    };

    if (!body.products || body.products.length === 0) {
      res.status(400).json({ error: "At least one product is required to confirm extraction" });
      return;
    }

    // Replace all products for this RFQ with the reviewed set
    await db.delete(rfqProductsTable).where(eq(rfqProductsTable.rfqId, rfqId));

    const inserted = await db
      .insert(rfqProductsTable)
      .values(
        body.products.map((p) => ({
          rfqId,
          productName: p.productName,
          catalogueNumber: p.catalogueNumber ?? null,
          brand: p.brand ?? null,
          quantity: p.quantity ?? null,
          specifications: p.specifications ?? null,
          notes: p.notes ?? null,
          attachmentType: "body",
          extractionConfidence: p.extractionConfidence ?? "manual",
        })),
      )
      .returning();

    // Mark as reviewed and advance to SOURCING
    const [updated] = await db
      .update(rfqRecordsTable)
      .set({
        extractionReviewed: true,
        extractionReviewedAt: new Date(),
        stage: "SOURCING",
        stageUpdatedAt: new Date(),
      })
      .where(eq(rfqRecordsTable.id, rfqId))
      .returning();

    res.json({ ok: true, products: inserted, rfq: updated });
  } catch (err) {
    req.log.error({ err }, "Failed to confirm extraction");
    res.status(500).json({ error: "Failed to confirm extraction" });
  }
});

router.get("/rfq/:id/suggested-suppliers", async (req, res) => {
  try {
    const rfqId = parseInt(req.params["id"] ?? "0");

    // Get products for this RFQ — use notes/specs to infer categories
    const products = await db.select().from(rfqProductsTable).where(eq(rfqProductsTable.rfqId, rfqId));

    // Heuristic: match keywords in product names to categories
    const CATEGORY_KEYWORDS: Record<string, string[]> = {
      "Lab Equipment & Instruments": ["centrifuge", "microscope", "balance", "pH", "spectrophotometer", "incubator", "autoclave", "pipette", "pump"],
      "Reagents & Chemicals": ["reagent", "chemical", "acid", "buffer", "solvent", "ethanol", "methanol", "agar", "media"],
      "Consumables & Plasticware": ["tube", "plate", "flask", "bottle", "vial", "tip", "pipette tip", "microcentrifuge", "falcon"],
      "Glassware": ["glass", "beaker", "flask", "cylinder", "burette"],
      "Life Science & Kits": ["kit", "elisa", "pcr", "dna", "rna", "assay", "antibody", "protein", "cell"],
      "PPE & Safety": ["glove", "mask", "goggle", "coat", "safety", "ppe", "shield"],
      "Diagnostics": ["diagnostic", "test strip", "lateral flow", "immunoassay", "rapid test"],
      "Refrigeration & Storage": ["fridge", "freezer", "-80", "cryogenic", "liquid nitrogen", "cold"],
      "Environmental Monitoring": ["environmental", "monitoring", "air quality", "water quality", "toc"],
    };

    const inferredCategories = new Set<string>();
    for (const product of products) {
      const text = `${product.productName} ${product.specifications ?? ""} ${product.notes ?? ""}`.toLowerCase();
      for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
        if (keywords.some((kw) => text.includes(kw))) {
          inferredCategories.add(category);
        }
      }
    }

    // Always add General Lab Supplies as a fallback
    inferredCategories.add("General Lab Supplies");

    const categories = Array.from(inferredCategories);

    // Find suppliers with matching categories
    const matchingCatRows = await db
      .select()
      .from(supplierCategoriesTable)
      .where(inArray(supplierCategoriesTable.category, categories));

    const supplierIds = [...new Set(matchingCatRows.map((r) => r.supplierId))];

    if (supplierIds.length === 0) {
      res.json({ suppliers: [] });
      return;
    }

    const suppliers = await db
      .select()
      .from(suppliersTable)
      .where(and(inArray(suppliersTable.id, supplierIds), eq(suppliersTable.isActive, true)));

    const result = suppliers.map((s) => {
      const supplierCats = matchingCatRows.filter((c) => c.supplierId === s.id);
      const matchedCategories = supplierCats.map((c) => c.category);
      const isPreferredForAny = supplierCats.some((c) => c.isPreferred);
      return {
        id: s.id,
        name: s.name,
        company: s.company,
        email: s.email,
        currency: s.currency,
        typicalLeadTimeDays: s.typicalLeadTimeDays,
        typicalResponseTimeHours: s.typicalResponseTimeHours,
        matchedCategories,
        isPreferredForAny,
      };
    });

    // Sort: preferred first, then by matched category count
    result.sort((a, b) => {
      if (a.isPreferredForAny && !b.isPreferredForAny) return -1;
      if (!a.isPreferredForAny && b.isPreferredForAny) return 1;
      return b.matchedCategories.length - a.matchedCategories.length;
    });

    res.json({ suppliers: result });
  } catch (err) {
    req.log.error({ err }, "Failed to get suggested suppliers");
    res.status(500).json({ error: "Failed to get suggested suppliers" });
  }
});

router.post("/rfq/:id/quotes", async (req, res) => {
  try {
    const rfqId = parseInt(req.params["id"] ?? "0");
    const body = req.body as {
      supplierName: string;
      supplierEmail?: string;
      totalAmount?: number;
      currency?: string;
      notes?: string;
      fulfilledAllItems?: boolean;
      partialFulfillmentNotes?: string;
      lines: Array<{
        rfqProductId?: number;
        productName?: string;
        unitPrice: string;
        currency?: string;
        leadTimeDays?: number;
        moq?: string;
        notes?: string;
      }>;
    };

    if (!body.supplierName) {
      res.status(400).json({ error: "supplierName is required" });
      return;
    }

    // Get RFQ to compute response time
    const rfqRows = await db.select().from(rfqRecordsTable).where(eq(rfqRecordsTable.id, rfqId)).limit(1);
    const rfq = rfqRows[0];

    let responseTimeHours: string | undefined;
    if (rfq) {
      const hours = (Date.now() - new Date(rfq.createdAt).getTime()) / (1000 * 60 * 60);
      responseTimeHours = hours.toFixed(2);
    }

    const [quote] = await db
      .insert(rfqSupplierQuotesTable)
      .values({
        rfqId,
        supplierName: body.supplierName,
        supplierEmail: body.supplierEmail,
        totalAmount: body.totalAmount?.toString(),
        currency: body.currency ?? "SAR",
        notes: body.notes,
        fulfilledAllItems: body.fulfilledAllItems ?? true,
        partialFulfillmentNotes: body.partialFulfillmentNotes,
        responseTimeHours,
      })
      .returning();

    if (!quote) {
      res.status(500).json({ error: "Failed to create quote" });
      return;
    }

    let lines: (typeof rfqSupplierQuoteLinesTable.$inferSelect)[] = [];
    if (body.lines?.length > 0) {
      lines = await db.insert(rfqSupplierQuoteLinesTable).values(
        body.lines.map((line) => ({
          quoteId: quote.id,
          rfqProductId: line.rfqProductId,
          productName: line.productName,
          unitPrice: line.unitPrice,
          currency: line.currency ?? body.currency ?? "SAR",
          leadTimeDays: line.leadTimeDays,
          moq: line.moq,
          notes: line.notes,
        })),
      ).returning();
    }

    // Advance to COMPARING if still in SOURCING
    if (rfq?.stage === "SOURCING") {
      await db
        .update(rfqRecordsTable)
        .set({ stage: "COMPARING", stageUpdatedAt: new Date() })
        .where(eq(rfqRecordsTable.id, rfqId));
    }

    res.status(201).json({ quote: { ...quote, lines } });
  } catch (err) {
    req.log.error({ err }, "Failed to log supplier quote");
    res.status(500).json({ error: "Failed to log quote" });
  }
});

router.get("/rfq/:id/quotes", async (req, res) => {
  try {
    const rfqId = parseInt(req.params["id"] ?? "0");
    const quotes = await db.select().from(rfqSupplierQuotesTable).where(eq(rfqSupplierQuotesTable.rfqId, rfqId));

    const quotesWithLines = await Promise.all(
      quotes.map(async (q) => {
        const lines = await db.select().from(rfqSupplierQuoteLinesTable).where(eq(rfqSupplierQuoteLinesTable.quoteId, q.id));
        return { ...q, lines };
      }),
    );

    res.json({ quotes: quotesWithLines });
  } catch (err) {
    req.log.error({ err }, "Failed to get quotes");
    res.status(500).json({ error: "Failed to retrieve quotes" });
  }
});

router.get("/rfq/:id/customer-quotes", async (req, res) => {
  try {
    const rfqId = parseInt(req.params["id"] ?? "0");
    const quotes = await db
      .select()
      .from(rfqCustomerQuotesTable)
      .where(eq(rfqCustomerQuotesTable.rfqId, rfqId))
      .orderBy(rfqCustomerQuotesTable.versionNumber);

    res.json({ quotes });
  } catch (err) {
    req.log.error({ err }, "Failed to get customer quotes");
    res.status(500).json({ error: "Failed to retrieve customer quotes" });
  }
});

router.post("/rfq/:id/customer-quotes/:quoteId/revise", async (req, res) => {
  try {
    const rfqId = parseInt(req.params["id"] ?? "0");
    const parentQuoteId = parseInt(req.params["quoteId"] ?? "0");
    const body = req.body as {
      revisionReason: string;
      markupPercent?: number;
      landedCostBufferPercent?: number;
      changesSummary?: string;
    };

    const parentRows = await db
      .select()
      .from(rfqCustomerQuotesTable)
      .where(eq(rfqCustomerQuotesTable.id, parentQuoteId))
      .limit(1);

    if (!parentRows[0]) {
      res.status(404).json({ error: "Parent quote not found" });
      return;
    }

    const parent = parentRows[0];

    // Mark parent as revised
    await db
      .update(rfqCustomerQuotesTable)
      .set({ wasRevised: true, revisionCount: (parent.revisionCount ?? 0) + 1 })
      .where(eq(rfqCustomerQuotesTable.id, parentQuoteId));

    const [newQuote] = await db
      .insert(rfqCustomerQuotesTable)
      .values({
        rfqId,
        parentQuoteId,
        versionNumber: (parent.versionNumber ?? 1) + 1,
        markupPercent: body.markupPercent?.toString() ?? parent.markupPercent,
        landedCostBufferPercent: body.landedCostBufferPercent?.toString() ?? parent.landedCostBufferPercent,
        currency: parent.currency,
        validityDays: parent.validityDays,
        revisionReason: body.revisionReason,
        changesSummary: body.changesSummary,
        wasRevised: false,
        revisionCount: 0,
      })
      .returning();

    res.status(201).json({ quote: newQuote });
  } catch (err) {
    req.log.error({ err }, "Failed to revise customer quote");
    res.status(500).json({ error: "Failed to create revision" });
  }
});

export default router;
