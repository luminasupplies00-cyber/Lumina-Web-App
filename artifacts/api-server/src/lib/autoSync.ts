/**
 * Auto-sync scheduler.
 *
 * Reads SYNC_INTERVAL_MINUTES from app_settings (0 = disabled, default 15).
 * Fires a full Zoho sync on the configured interval and tracks per-account
 * error state so the frontend can show reconnect warnings.
 *
 * Uses a dynamic import of syncAllAccounts to avoid a circular module
 * dependency (sync.ts ← routes ← autoSync ← sync would loop).
 */
import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";

// ─── State ────────────────────────────────────────────────────────────────────

export interface AccountSyncError {
  label: string;
  email: string;
  error: string;
  isAuthError: boolean;
  failedAt: Date;
}

interface AutoSyncState {
  enabled: boolean;
  intervalMinutes: number;
  nextSyncAt: Date | null;
  lastErrors: AccountSyncError[];
  timer: ReturnType<typeof setInterval> | null;
}

const state: AutoSyncState = {
  enabled: false,
  intervalMinutes: 15,
  nextSyncAt: null,
  lastErrors: [],
  timer: null,
};

// ─── Public getters ───────────────────────────────────────────────────────────

export function getAutoSyncState(): {
  enabled: boolean;
  intervalMinutes: number;
  nextSyncAt: Date | null;
  lastErrors: AccountSyncError[];
} {
  return {
    enabled: state.enabled,
    intervalMinutes: state.intervalMinutes,
    nextSyncAt: state.nextSyncAt,
    lastErrors: state.lastErrors,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function readIntervalSetting(): Promise<number> {
  try {
    const rows = await db
      .select({ value: appSettingsTable.value })
      .from(appSettingsTable)
      .where(eq(appSettingsTable.key, "SYNC_INTERVAL_MINUTES"))
      .limit(1);
    const raw = parseInt(rows[0]?.value ?? "15");
    return Number.isFinite(raw) && raw >= 0 ? raw : 15;
  } catch {
    return 15;
  }
}

async function runSync(): Promise<void> {
  logger.info("Auto-sync: starting scheduled sync");
  try {
    // Dynamic import breaks the circular dependency cycle at runtime.
    const { syncAllAccounts } = await import("../routes/sync.js");
    const result = await syncAllAccounts(logger);
    logger.info(
      { synced: result.totalSynced, rfqs: result.totalRfqs, errors: result.totalErrors },
      "Auto-sync: complete",
    );
    // Update per-account error state (clear previous, record new failures).
    state.lastErrors = result.accountResults
      .filter((r) => r.error)
      .map((r) => ({
        label: r.label,
        email: r.email,
        error: r.error!,
        isAuthError:
          r.error!.toLowerCase().includes("invalid_client") ||
          r.error!.toLowerCase().includes("invalid_code") ||
          r.error!.toLowerCase().includes("token refresh") ||
          r.error!.toLowerCase().includes("reconnect required"),
        failedAt: new Date(),
      }));
  } catch (err) {
    logger.error({ err }, "Auto-sync: uncaught error");
  }
}

function scheduleNext(intervalMinutes: number): void {
  state.nextSyncAt = new Date(Date.now() + intervalMinutes * 60_000);
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

function stopTimer(): void {
  if (state.timer !== null) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.enabled = false;
  state.nextSyncAt = null;
}

async function applyInterval(intervalMinutes: number): Promise<void> {
  stopTimer();
  state.intervalMinutes = intervalMinutes;

  if (intervalMinutes === 0) {
    logger.info("Auto-sync: disabled (interval = 0)");
    return;
  }

  const ms = intervalMinutes * 60_000;
  scheduleNext(intervalMinutes);

  state.timer = setInterval(async () => {
    scheduleNext(intervalMinutes);
    await runSync();
  }, ms);

  state.enabled = true;
  logger.info({ intervalMinutes }, "Auto-sync: scheduler started");
}

/** Called once at server boot. Reads the saved setting and starts the timer. */
export async function startAutoSync(): Promise<void> {
  const intervalMinutes = await readIntervalSetting();
  await applyInterval(intervalMinutes);
}

/**
 * Called by the settings route when SYNC_INTERVAL_MINUTES is updated.
 * Re-reads from DB and restarts the timer with the new interval.
 */
export async function restartAutoSync(): Promise<void> {
  const intervalMinutes = await readIntervalSetting();
  await applyInterval(intervalMinutes);
}

/** Trigger an immediate out-of-cycle sync (e.g. "Sync now" button). */
export async function triggerImmediateSync(): Promise<void> {
  await runSync();
  if (state.enabled) scheduleNext(state.intervalMinutes);
}
