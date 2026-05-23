# Lumina HQ

B2B RFQ workflow web app for Lumina Supplies (laboratory/scientific supplies, Riyadh, Saudi Arabia).

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/lumina-hq run dev` — run the frontend (port 22509)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec (always run after editing openapi.yaml)
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only, never run in production)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5, port 8080 (proxied via /api)
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec → React Query hooks + Zod schemas)
- Build: esbuild (CJS bundle)
- Frontend: React + Vite + shadcn/ui (dark mode, cyan accent #190 90% 50%)
- AI: Claude Sonnet 4.5 (`claude-sonnet-4-5`) via Anthropic API (direct, no proxy)

## Where things live

- `lib/api-spec/openapi.yaml` — **source of truth** for all API contracts
- `lib/db/src/schema/index.ts` — **source of truth** for DB schema (12 tables)
- `lib/api-client-react/src/generated/` — generated React Query hooks (do not edit)
- `lib/api-zod/src/generated/` — generated Zod schemas (do not edit)
- `artifacts/api-server/src/routes/` — Express route handlers
- `artifacts/api-server/src/lib/` — server utilities (aiClient, encrypt, stuckRfq, aiConstants)
- `artifacts/lumina-hq/src/pages/` — frontend pages (rfq, inbox, suppliers, settings)
- `artifacts/lumina-hq/src/components/` — shared components (layout, ui/)

## Architecture decisions

- Contract-first API: openapi.yaml is always edited first, then `codegen` is run
- AI drafts are never auto-sent — always show to user for review/copy
- Landed cost buffer (default 8%) applied at comparison time, configurable per RFQ
- Stuck RFQ detection is server-side (thresholds in `lib/stuckRfq.ts`), returned with each GET /rfq
- AES-256-GCM encryption for OAuth tokens stored in DB (key: `ENCRYPTION_KEY` secret)
- Zoho Mail OAuth tokens refreshed lazily on each sync cycle

## Product

- **Pipeline** — Kanban board: NEW → SOURCING → COMPARING → QUOTE_READY → QUOTE_SENT → FOLLOW_UP → WON/LOST
- **Inbox** — Synced Zoho Mail threads with AI triage/classification
- **Suppliers** — Full CRUD supplier database with categories, performance metrics, smart suggestions
- **Settings** — Zoho OAuth connection, AI model config, sync settings

### Key workflows
1. Email arrives → AI triage → RFQ created → Extract Products (AI) → Review & Confirm → Move to SOURCING
2. SOURCING → Draft supplier inquiry (AI) → Log supplier quotes (manual or AI email paste) → COMPARING
3. COMPARING → Comparison table with landed cost per product → AI recommendation → Draft customer quote (AI) → QUOTE_READY
4. QUOTE_READY → Copy quote → Send manually via Zoho → QUOTE_SENT
5. QUOTE_SENT/FOLLOW_UP → Draft follow-up (AI) → WON or LOST

## User preferences

- Dark mode only — no light mode
- Cyan accent: `hsl(190 90% 50%)`
- Dense professional design — no large empty whitespace
- All AI drafts must show a copy-to-clipboard flow, never auto-send
- Currency default: SAR
- Claude Sonnet 4.5 (`claude-sonnet-4-5`) as primary AI model; Haiku 4.5 for fast triage

## Gotchas

- **Always run `codegen` after editing `openapi.yaml`** — generated hooks will be stale otherwise
- **Never call service ports directly from bash** — use `localhost:80/api/...` (the shared proxy)
- **Never use `console.log` in server code** — use `req.log` in routes, `logger` elsewhere (pino)
- `pnpm run typecheck:libs` must succeed before `pnpm run typecheck` (leaf packages depend on built lib types)
- Stuck RFQ thresholds: NEW>4h, SOURCING>48h, COMPARING>24h, QUOTE_READY>4h, QUOTE_SENT>72h, FOLLOW_UP>120h

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- AI token limits: EMAIL_TRIAGE=800, PRODUCT_EXTRACTION=800, SUPPLIER_DRAFT=600, CUSTOMER_QUOTE=800, COMPARISON=400, FOLLOWUP=300, SUPPLIER_QUOTE_PARSE=600
- RFQ stages enum: `RFQ_STAGES` from `@workspace/db`
