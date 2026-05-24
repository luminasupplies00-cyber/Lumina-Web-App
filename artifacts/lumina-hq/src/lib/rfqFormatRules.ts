export type Product = {
  productName?: string | null;
  catalogueNumber?: string | null;
  brand?: string | null;
  quantity?: string | null;
  specifications?: string | null;
};

export type FormatMode = "table-only" | "table-with-excel" | "summary-with-excel";

export type FormatResult = {
  mode: FormatMode;
  block: string;
  includeExcel: boolean;
  productCount: number;
};

export const DEFAULT_SMALL_MAX = 5;
export const DEFAULT_MEDIUM_MAX = 15;

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export function parseThresholds(settings: Record<string, string> | undefined): {
  smallMax: number;
  mediumMax: number;
} {
  const sRaw = parseInt(settings?.["RFQ_TABLE_SMALL_MAX"] ?? "", 10);
  const mRaw = parseInt(settings?.["RFQ_TABLE_MEDIUM_MAX"] ?? "", 10);
  const smallMax = Number.isFinite(sRaw) && sRaw > 0 ? clamp(sRaw, 1, 200) : DEFAULT_SMALL_MAX;
  let mediumMax = Number.isFinite(mRaw) && mRaw > 0 ? clamp(mRaw, 1, 500) : DEFAULT_MEDIUM_MAX;
  if (mediumMax <= smallMax) mediumMax = smallMax + 1;
  return { smallMax, mediumMax };
}

function padRight(s: string, n: number) {
  if (s.length >= n) return s;
  return s + " ".repeat(n - s.length);
}

function fit(s: string | null | undefined, max: number) {
  const v = (s ?? "").toString().trim() || "—";
  if (v.length <= max) return v;
  return v.slice(0, max - 1) + "…";
}

/** Plain-text table that survives copy/paste into Zoho / Gmail / Outlook. */
function renderTable(products: Product[]): string {
  const widths = { idx: 3, name: 36, cat: 14, brand: 14, qty: 10, specs: 28 };
  const header =
    `${padRight("#", widths.idx)} | ` +
    `${padRight("Product", widths.name)} | ` +
    `${padRight("Cat No", widths.cat)} | ` +
    `${padRight("Brand", widths.brand)} | ` +
    `${padRight("Qty", widths.qty)} | ` +
    `${padRight("Specs", widths.specs)}`;
  const sep =
    "-".repeat(widths.idx) + "-+-" +
    "-".repeat(widths.name) + "-+-" +
    "-".repeat(widths.cat) + "-+-" +
    "-".repeat(widths.brand) + "-+-" +
    "-".repeat(widths.qty) + "-+-" +
    "-".repeat(widths.specs);
  const rows = products.map((p, i) =>
    `${padRight(String(i + 1), widths.idx)} | ` +
    `${padRight(fit(p.productName, widths.name), widths.name)} | ` +
    `${padRight(fit(p.catalogueNumber, widths.cat), widths.cat)} | ` +
    `${padRight(fit(p.brand, widths.brand), widths.brand)} | ` +
    `${padRight(fit(p.quantity, widths.qty), widths.qty)} | ` +
    `${padRight(fit(p.specifications, widths.specs), widths.specs)}`,
  );
  return [header, sep, ...rows].join("\n");
}

function renderSummary(products: Product[]): string {
  const brands = Array.from(
    new Set(products.map((p) => (p.brand ?? "").trim()).filter((b) => b.length > 0)),
  ).slice(0, 5);
  const examples = products
    .slice(0, 3)
    .map((p) => (p.productName ?? "").trim())
    .filter((n) => n.length > 0);
  const bits: string[] = [];
  if (examples.length > 0) bits.push(`Items include: ${examples.join("; ")}${products.length > examples.length ? "; and more" : ""}.`);
  if (brands.length > 0) bits.push(`Key brands: ${brands.join(", ")}.`);
  return bits.join(" ") || "Full product list is provided in the attached Excel file.";
}

export function formatProductBlock(
  products: Product[],
  thresholds: { smallMax: number; mediumMax: number },
): FormatResult {
  const productCount = products.length;
  if (productCount === 0) {
    return {
      mode: "table-only",
      block: "(No products specified yet.)",
      includeExcel: false,
      productCount,
    };
  }

  if (productCount <= thresholds.smallMax) {
    return {
      mode: "table-only",
      block: renderTable(products),
      includeExcel: false,
      productCount,
    };
  }

  if (productCount <= thresholds.mediumMax) {
    return {
      mode: "table-with-excel",
      block:
        renderTable(products) +
        "\n\nPlease also find attached the full product list in Excel format for your convenience.",
      includeExcel: true,
      productCount,
    };
  }

  return {
    mode: "summary-with-excel",
    block:
      `Please find attached our RFQ with ${productCount} line items in Excel format.\n\n` +
      renderSummary(products),
    includeExcel: true,
    productCount,
  };
}

// Non-global regex — safe to reuse across calls; no stateful lastIndex.
const PLACEHOLDER_RE = /\{\{\s*PRODUCTS_BLOCK\s*\}\}/;
// Global variant only used inside `replace` (replace doesn't depend on lastIndex).
const PLACEHOLDER_RE_ALL = /\{\{\s*PRODUCTS_BLOCK\s*\}\}/g;

export function injectProductBlock(draftBody: string, block: string): string {
  if (PLACEHOLDER_RE.test(draftBody)) {
    return draftBody.replace(PLACEHOLDER_RE_ALL, block);
  }
  // No placeholder — append at end, separated by blank line.
  const trimmed = draftBody.replace(/\s+$/, "");
  return `${trimmed}\n\n${block}`;
}
