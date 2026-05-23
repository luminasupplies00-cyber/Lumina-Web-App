export const AI_MODELS = {
  CLAUDE: "claude-3-5-sonnet-20241022",
  PERPLEXITY: "sonar-pro",
} as const;

export const AI_MAX_TOKENS = {
  EMAIL_TRIAGE: 800,
  PRODUCT_EXTRACTION: 800,
  SUPPLIER_DRAFT: 600,
  CUSTOMER_QUOTE: 800,
  COMPARISON: 400,
  FOLLOWUP: 300,
  SUPPLIER_QUOTE_PARSE: 600,
  ATTACHMENT_IMAGE: 1000,
} as const;

const MIN_TOKENS = 16;

function assertMinTokens(label: string, value: number): void {
  if (value < MIN_TOKENS) {
    throw new Error(
      `AI_MAX_TOKENS.${label} is ${value}, which is below the minimum of ${MIN_TOKENS}`,
    );
  }
}

for (const [label, value] of Object.entries(AI_MAX_TOKENS)) {
  assertMinTokens(label, value);
}
