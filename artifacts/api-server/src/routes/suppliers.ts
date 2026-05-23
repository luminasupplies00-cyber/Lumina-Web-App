import { Router } from "express";
import { db } from "@workspace/db";
import {
  suppliersTable,
  supplierCategoriesTable,
  supplierPerformanceTable,
  rfqSupplierQuotesTable,
} from "@workspace/db";
import { eq, and, desc, sql, count, avg } from "drizzle-orm";

const router = Router();

router.get("/suppliers", async (req, res) => {
  try {
    const includeInactive = req.query["includeInactive"] === "true";
    const rows = await db
      .select()
      .from(suppliersTable)
      .where(includeInactive ? undefined : eq(suppliersTable.isActive, true))
      .orderBy(suppliersTable.company);

    const suppliersWithCategories = await Promise.all(
      rows.map(async (s) => {
        const cats = await db
          .select()
          .from(supplierCategoriesTable)
          .where(eq(supplierCategoriesTable.supplierId, s.id));
        return { ...s, categories: cats };
      }),
    );

    res.json({ suppliers: suppliersWithCategories });
  } catch (err) {
    req.log.error({ err }, "Failed to list suppliers");
    res.status(500).json({ error: "Failed to list suppliers" });
  }
});

router.post("/suppliers", async (req, res) => {
  try {
    const body = req.body as {
      name: string;
      company: string;
      email: string;
      phone?: string;
      country?: string;
      currency?: string;
      typicalLeadTimeDays?: number;
      typicalResponseTimeHours?: number;
      paymentTerms?: string;
      notes?: string;
      categories?: Array<{ category: string; isPreferred?: boolean; notes?: string }>;
    };

    if (!body.name || !body.company || !body.email) {
      res.status(400).json({ error: "name, company, and email are required" });
      return;
    }

    const [supplier] = await db
      .insert(suppliersTable)
      .values({
        name: body.name,
        company: body.company,
        email: body.email,
        phone: body.phone,
        country: body.country ?? "SA",
        currency: body.currency ?? "SAR",
        typicalLeadTimeDays: body.typicalLeadTimeDays,
        typicalResponseTimeHours: body.typicalResponseTimeHours,
        paymentTerms: body.paymentTerms,
        notes: body.notes,
        isActive: true,
      })
      .returning();

    if (!supplier) {
      res.status(500).json({ error: "Failed to create supplier" });
      return;
    }

    const categories = [];
    if (body.categories && body.categories.length > 0) {
      const catRows = await db
        .insert(supplierCategoriesTable)
        .values(
          body.categories.map((c) => ({
            supplierId: supplier.id,
            category: c.category,
            isPreferred: c.isPreferred ?? false,
            notes: c.notes,
          })),
        )
        .returning();
      categories.push(...catRows);
    }

    res.status(201).json({ supplier: { ...supplier, categories } });
  } catch (err) {
    req.log.error({ err }, "Failed to create supplier");
    res.status(500).json({ error: "Failed to create supplier" });
  }
});

router.get("/suppliers/:id", async (req, res) => {
  try {
    const id = parseInt(req.params["id"] ?? "0");
    const rows = await db
      .select()
      .from(suppliersTable)
      .where(eq(suppliersTable.id, id))
      .limit(1);

    if (!rows[0]) {
      res.status(404).json({ error: "Supplier not found" });
      return;
    }

    const categories = await db
      .select()
      .from(supplierCategoriesTable)
      .where(eq(supplierCategoriesTable.supplierId, id));

    res.json({ supplier: { ...rows[0], categories } });
  } catch (err) {
    req.log.error({ err }, "Failed to get supplier");
    res.status(500).json({ error: "Failed to get supplier" });
  }
});

router.patch("/suppliers/:id", async (req, res) => {
  try {
    const id = parseInt(req.params["id"] ?? "0");
    const body = req.body as {
      name?: string;
      company?: string;
      email?: string;
      phone?: string;
      country?: string;
      currency?: string;
      typicalLeadTimeDays?: number;
      typicalResponseTimeHours?: number;
      paymentTerms?: string;
      notes?: string;
      isActive?: boolean;
    };

    const [updated] = await db
      .update(suppliersTable)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.company !== undefined && { company: body.company }),
        ...(body.email !== undefined && { email: body.email }),
        ...(body.phone !== undefined && { phone: body.phone }),
        ...(body.country !== undefined && { country: body.country }),
        ...(body.currency !== undefined && { currency: body.currency }),
        ...(body.typicalLeadTimeDays !== undefined && { typicalLeadTimeDays: body.typicalLeadTimeDays }),
        ...(body.typicalResponseTimeHours !== undefined && { typicalResponseTimeHours: body.typicalResponseTimeHours }),
        ...(body.paymentTerms !== undefined && { paymentTerms: body.paymentTerms }),
        ...(body.notes !== undefined && { notes: body.notes }),
        ...(body.isActive !== undefined && { isActive: body.isActive }),
      })
      .where(eq(suppliersTable.id, id))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Supplier not found" });
      return;
    }

    const categories = await db
      .select()
      .from(supplierCategoriesTable)
      .where(eq(supplierCategoriesTable.supplierId, id));

    res.json({ supplier: { ...updated, categories } });
  } catch (err) {
    req.log.error({ err }, "Failed to update supplier");
    res.status(500).json({ error: "Failed to update supplier" });
  }
});

router.delete("/suppliers/:id", async (req, res) => {
  try {
    const id = parseInt(req.params["id"] ?? "0");
    const [updated] = await db
      .update(suppliersTable)
      .set({ isActive: false })
      .where(eq(suppliersTable.id, id))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Supplier not found" });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to deactivate supplier");
    res.status(500).json({ error: "Failed to deactivate supplier" });
  }
});

router.post("/suppliers/:id/categories", async (req, res) => {
  try {
    const supplierId = parseInt(req.params["id"] ?? "0");
    const body = req.body as { category: string; isPreferred?: boolean; notes?: string };

    if (!body.category) {
      res.status(400).json({ error: "category is required" });
      return;
    }

    const existing = await db
      .select()
      .from(supplierCategoriesTable)
      .where(
        and(
          eq(supplierCategoriesTable.supplierId, supplierId),
          eq(supplierCategoriesTable.category, body.category),
        ),
      )
      .limit(1);

    if (existing[0]) {
      res.json({ category: existing[0] });
      return;
    }

    const [cat] = await db
      .insert(supplierCategoriesTable)
      .values({
        supplierId,
        category: body.category,
        isPreferred: body.isPreferred ?? false,
        notes: body.notes,
      })
      .returning();

    res.status(201).json({ category: cat });
  } catch (err) {
    req.log.error({ err }, "Failed to add supplier category");
    res.status(500).json({ error: "Failed to add category" });
  }
});

router.delete("/suppliers/:id/categories/:catId", async (req, res) => {
  try {
    const catId = parseInt(req.params["catId"] ?? "0");
    await db.delete(supplierCategoriesTable).where(eq(supplierCategoriesTable.id, catId));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to remove supplier category");
    res.status(500).json({ error: "Failed to remove category" });
  }
});

router.get("/suppliers/:id/performance", async (req, res) => {
  try {
    const supplierId = parseInt(req.params["id"] ?? "0");

    const perfRows = await db
      .select()
      .from(supplierPerformanceTable)
      .where(eq(supplierPerformanceTable.supplierId, supplierId))
      .orderBy(desc(supplierPerformanceTable.recordedAt));

    const totalContacted = perfRows.filter((r) => r.wasContacted).length;
    const totalResponded = perfRows.filter((r) => r.responded).length;
    const totalSelected = perfRows.filter((r) => r.selected).length;

    const responseTimes = perfRows
      .filter((r) => r.responseTimeHours !== null)
      .map((r) => r.responseTimeHours!);

    const avgResponseHours =
      responseTimes.length > 0
        ? responseTimes.reduce((s, v) => s + v, 0) / responseTimes.length
        : null;

    const responseRate = totalContacted > 0 ? (totalResponded / totalContacted) * 100 : 0;
    const selectionRate = totalContacted > 0 ? (totalSelected / totalContacted) * 100 : 0;

    res.json({
      performance: {
        totalRfqs: perfRows.length,
        totalContacted,
        totalResponded,
        totalSelected,
        responseRatePercent: Math.round(responseRate),
        selectionRatePercent: Math.round(selectionRate),
        avgResponseTimeHours: avgResponseHours ? Math.round(avgResponseHours * 10) / 10 : null,
      },
      history: perfRows.slice(0, 20),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get supplier performance");
    res.status(500).json({ error: "Failed to get performance data" });
  }
});

export default router;
