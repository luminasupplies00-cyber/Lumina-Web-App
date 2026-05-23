import type { RfqStage } from "@workspace/db";

const STUCK_THRESHOLDS_HOURS: Partial<Record<RfqStage, number>> = {
  NEW: 4,
  SOURCING: 48,
  COMPARING: 24,
  QUOTE_READY: 4,
  QUOTE_SENT: 72,
  FOLLOW_UP: 120,
};

export function isRfqStuck(stage: string, stageUpdatedAt: Date): boolean {
  const thresholdHours = STUCK_THRESHOLDS_HOURS[stage as RfqStage];
  if (!thresholdHours) return false;
  const hoursInStage = (Date.now() - stageUpdatedAt.getTime()) / (1000 * 60 * 60);
  return hoursInStage > thresholdHours;
}

export function stuckSinceDate(stage: string, stageUpdatedAt: Date): Date | null {
  const thresholdHours = STUCK_THRESHOLDS_HOURS[stage as RfqStage];
  if (!thresholdHours) return null;
  return new Date(stageUpdatedAt.getTime() + thresholdHours * 60 * 60 * 1000);
}
