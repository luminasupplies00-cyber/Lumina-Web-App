import * as XLSX from "xlsx";

export type RfqExcelProduct = {
  productName: string;
  catalogueNumber?: string | null;
  brand?: string | null;
  quantity?: string | null;
  specifications?: string | null;
  notes?: string | null;
};

export type RfqExcelMeta = {
  rfqId: number;
  customerName?: string | null;
  customerCompany?: string | null;
  deadline?: string | null;
};

/** Build the Excel workbook in memory — shared by download + attach flows. */
function buildRfqWorkbook(meta: RfqExcelMeta, products: RfqExcelProduct[]): {
  workbook: XLSX.WorkBook;
  filename: string;
} {
  const wb = XLSX.utils.book_new();

  const header = [
    ["Lumina Supplies — Product Request"],
    [`RFQ #${meta.rfqId}`, "", `Date: ${new Date().toLocaleDateString()}`],
    meta.customerCompany || meta.customerName
      ? [`Client: ${meta.customerCompany || meta.customerName}`]
      : [""],
    meta.deadline ? [`Needed by: ${meta.deadline}`] : [""],
    [""],
    [
      "#",
      "Product Name",
      "Catalogue No.",
      "Brand",
      "Quantity",
      "Specifications",
      "Notes",
      "Unit Price",
      "Currency",
      "Lead Time (days)",
      "MOQ",
      "Validity",
    ],
  ];

  const rows = products.map((p, i) => [
    i + 1,
    p.productName,
    p.catalogueNumber ?? "",
    p.brand ?? "",
    p.quantity ?? "",
    p.specifications ?? "",
    p.notes ?? "",
    "", "", "", "", "",
  ]);

  const aoa = [...header, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Column widths
  ws["!cols"] = [
    { wch: 4 }, { wch: 36 }, { wch: 18 }, { wch: 16 }, { wch: 10 },
    { wch: 32 }, { wch: 24 }, { wch: 12 }, { wch: 8 }, { wch: 12 },
    { wch: 10 }, { wch: 12 },
  ];

  // Merge title row across columns
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 11 } }];

  XLSX.utils.book_append_sheet(wb, ws, "Product Request");

  const safeClient = (meta.customerCompany || meta.customerName || "client")
    .replace(/[^a-z0-9]+/gi, "_")
    .slice(0, 30);
  const filename = `RFQ_${meta.rfqId}_${safeClient}.xlsx`;
  return { workbook: wb, filename };
}

/**
 * Generate a supplier-ready Excel workbook and trigger a browser download.
 * Returns the suggested filename.
 */
export function downloadRfqExcel(meta: RfqExcelMeta, products: RfqExcelProduct[]): string {
  const { workbook, filename } = buildRfqWorkbook(meta, products);
  XLSX.writeFile(workbook, filename);
  return filename;
}

/**
 * Generate the same workbook and return it as a base64-encoded .xlsx blob,
 * suitable for shipping to the API server as a Zoho Mail attachment payload.
 */
export function buildRfqExcelBase64(meta: RfqExcelMeta, products: RfqExcelProduct[]): {
  filename: string;
  base64: string;
  contentType: string;
} {
  const { workbook, filename } = buildRfqWorkbook(meta, products);
  // `XLSX.write` returns a binary string when type is "base64".
  const base64 = XLSX.write(workbook, { type: "base64", bookType: "xlsx" }) as string;
  return {
    filename,
    base64,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
}
