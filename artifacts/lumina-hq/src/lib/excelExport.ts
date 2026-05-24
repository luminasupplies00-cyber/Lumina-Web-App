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

/**
 * Generate a supplier-ready Excel workbook listing all products in an RFQ.
 * Triggers download in the browser. Returns the suggested filename.
 */
export function downloadRfqExcel(meta: RfqExcelMeta, products: RfqExcelProduct[]): string {
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
  XLSX.writeFile(wb, filename);
  return filename;
}
