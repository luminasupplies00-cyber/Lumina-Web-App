export const AI_MAX_TOKENS = {
  EMAIL_TRIAGE: 150,       // small JSON: classification + confidence + reasoning
  PRODUCT_EXTRACTION: 800,
  SUPPLIER_DRAFT: 600,
  CUSTOMER_QUOTE: 800,
  COMPARISON: 400,
  FOLLOWUP: 300,
  SUPPLIER_QUOTE_PARSE: 600,
  ATTACHMENT_IMAGE: 1000,
  RECLASSIFY: 150,
  SUMMARIZE: 250,           // 2-3 sentence summary + key action + deadlines
  DRAFT_REPLY: 500,         // editable email reply body
} as const;
