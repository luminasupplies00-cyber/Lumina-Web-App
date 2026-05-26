import { useState } from "react";
import {
  useGetAutopilotStatus,
  useGetAutopilotActions,
  useGetAutopilotBriefing,
  useRunAutopilotCycle,
  useDismissAutopilotAction,
  useToggleAutopilot,
} from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Bot,
  Zap,
  Clock,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  X,
  AlertTriangle,
  ArrowRight,
  FileText,
  Star,
  Bell,
  TrendingUp,
} from "lucide-react";

const ACTION_TYPE_LABELS: Record<string, string> = {
  auto_extract: "Auto Extract",
  priority_score: "Priority Score",
  stuck_alert: "Stuck Alert",
  followup_suggestion: "Follow-up Needed",
  stage_advance: "Stage Advanced",
  daily_briefing: "Daily Briefing",
};

const ACTION_TYPE_ICONS: Record<string, typeof Bot> = {
  auto_extract: FileText,
  priority_score: Star,
  stuck_alert: AlertTriangle,
  followup_suggestion: Bell,
  stage_advance: ArrowRight,
  daily_briefing: TrendingUp,
};

const ACTION_TYPE_COLORS: Record<string, string> = {
  auto_extract: "text-cyan-400 bg-cyan-400/10 border-cyan-400/20",
  priority_score: "text-violet-400 bg-violet-400/10 border-violet-400/20",
  stuck_alert: "text-amber-400 bg-amber-400/10 border-amber-400/20",
  followup_suggestion: "text-orange-400 bg-orange-400/10 border-orange-400/20",
  stage_advance: "text-green-400 bg-green-400/10 border-green-400/20",
  daily_briefing: "text-blue-400 bg-blue-400/10 border-blue-400/20",
};

function formatRelativeTime(date: string | null | undefined): string {
  if (!date) return "never";
  const diff = Date.now() - new Date(date).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function AutopilotPanel() {
  const [expanded, setExpanded] = useState(false);
  const [briefingExpanded, setBriefingExpanded] = useState(false);
  const queryClient = useQueryClient();

  const { data: status } = useGetAutopilotStatus({
    query: { refetchInterval: 30_000 },
  });
  const { data: actionsData } = useGetAutopilotActions(
    { limit: 10, offset: 0 },
    { query: { refetchInterval: 30_000, enabled: expanded } },
  );
  const { data: briefingData, isLoading: briefingLoading } =
    useGetAutopilotBriefing({
      query: { enabled: briefingExpanded },
    });

  const runCycle = useRunAutopilotCycle();
  const toggleAutopilot = useToggleAutopilot();
  const dismissAction = useDismissAutopilotAction();

  const invalidateAll = () => {
    queryClient.invalidateQueries({
      queryKey: ["/api/autopilot/status"],
    });
    queryClient.invalidateQueries({
      queryKey: ["/api/autopilot/actions"],
    });
    queryClient.invalidateQueries({ queryKey: ["/api/rfq"] });
  };

  const handleToggle = (enabled: boolean) => {
    toggleAutopilot.mutate(
      { data: { enabled } },
      {
        onSuccess: () => {
          toast.success(enabled ? "Autopilot enabled" : "Autopilot disabled");
          invalidateAll();
        },
        onError: () => toast.error("Failed to toggle autopilot"),
      },
    );
  };

  const handleRunCycle = () => {
    runCycle.mutate(undefined, {
      onSuccess: (res) => {
        toast.success(
          `Autopilot cycle complete: ${res.actions} action(s) in ${res.durationMs}ms`,
        );
        invalidateAll();
      },
      onError: () => toast.error("Failed to run autopilot cycle"),
    });
  };

  const handleDismiss = (id: number) => {
    dismissAction.mutate(
      { id },
      {
        onSuccess: () => {
          toast.success("Action dismissed");
          queryClient.invalidateQueries({
            queryKey: ["/api/autopilot/actions"],
          });
        },
        onError: () => toast.error("Failed to dismiss action"),
      },
    );
  };

  const isEnabled = status?.enabled ?? false;
  const pendingActions =
    actionsData?.actions?.filter((a) => a.status === "pending" || a.status === "completed") ?? [];

  return (
    <Card className="bg-sidebar border-border overflow-hidden">
      {/* Header bar — always visible */}
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2.5">
          <div
            className={`w-2 h-2 rounded-full ${isEnabled ? "bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.5)]" : "bg-muted-foreground/40"}`}
          />
          <Bot className="w-4 h-4 text-primary" />
          <span className="text-xs font-bold tracking-wide uppercase text-muted-foreground">
            AI Autopilot
          </span>
          {isEnabled && status?.stats && (
            <Badge
              variant="secondary"
              className="text-[9px] h-4 px-1.5 bg-primary/10 text-primary border-primary/20"
            >
              {status.stats.totalCycles} cycles
            </Badge>
          )}
          {status?.lastRunAt && (
            <span className="text-[10px] text-muted-foreground flex items-center gap-1">
              <Clock className="w-2.5 h-2.5" />
              {formatRelativeTime(status.lastRunAt)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div onClick={(e) => e.stopPropagation()}>
            <Switch
              checked={isEnabled}
              onCheckedChange={handleToggle}
              className="data-[state=checked]:bg-primary h-4 w-7"
            />
          </div>
          {expanded ? (
            <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
          )}
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border px-4 py-3 space-y-3">
          {/* Controls row */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
              <span>
                Interval:{" "}
                <strong className="text-foreground">
                  {status?.intervalMinutes ?? 5}m
                </strong>
              </span>
              {status?.nextRunAt && (
                <span>
                  Next:{" "}
                  <strong className="text-foreground">
                    {formatRelativeTime(status.nextRunAt).replace(" ago", "")}
                  </strong>
                </span>
              )}
              {status?.running && (
                <Badge
                  variant="secondary"
                  className="text-[9px] h-4 px-1.5 bg-cyan-400/10 text-cyan-400 animate-pulse"
                >
                  Running
                </Badge>
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              className="text-[10px] h-6 px-2"
              onClick={handleRunCycle}
              disabled={runCycle.isPending}
            >
              {runCycle.isPending ? (
                <>
                  <RefreshCw className="w-3 h-3 mr-1 animate-spin" /> Running...
                </>
              ) : (
                <>
                  <Zap className="w-3 h-3 mr-1" /> Run Now
                </>
              )}
            </Button>
          </div>

          {/* Stats row */}
          {status?.stats && (
            <div className="grid grid-cols-4 gap-2">
              <StatBadge
                label="Extractions"
                value={status.stats.extractionsTriggered}
              />
              <StatBadge
                label="Stuck Alerts"
                value={status.stats.stuckAlerts}
              />
              <StatBadge
                label="Follow-ups"
                value={status.stats.followupSuggestions}
              />
              <StatBadge
                label="Advances"
                value={status.stats.stageAdvances}
              />
            </div>
          )}

          {/* Daily Briefing */}
          <div className="border border-border rounded-lg overflow-hidden">
            <button
              type="button"
              className="w-full flex items-center justify-between px-3 py-2 hover:bg-muted/20 transition-colors"
              onClick={() => setBriefingExpanded(!briefingExpanded)}
            >
              <div className="flex items-center gap-2">
                <TrendingUp className="w-3.5 h-3.5 text-blue-400" />
                <span className="text-[11px] font-semibold text-foreground">
                  Daily Briefing
                </span>
              </div>
              {briefingExpanded ? (
                <ChevronUp className="w-3 h-3 text-muted-foreground" />
              ) : (
                <ChevronDown className="w-3 h-3 text-muted-foreground" />
              )}
            </button>
            {briefingExpanded && (
              <div className="px-3 pb-3 border-t border-border">
                {briefingLoading ? (
                  <div className="text-[11px] text-muted-foreground py-2 flex items-center gap-2">
                    <RefreshCw className="w-3 h-3 animate-spin" /> Generating
                    briefing...
                  </div>
                ) : briefingData?.briefing ? (
                  <div className="text-[11px] text-muted-foreground leading-relaxed pt-2 whitespace-pre-wrap">
                    {briefingData.briefing}
                  </div>
                ) : (
                  <div className="text-[11px] text-muted-foreground py-2">
                    No briefing available yet.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Action queue */}
          {pendingActions.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground">
                Recent Actions
              </div>
              {pendingActions.slice(0, 10).map((action) => {
                const Icon =
                  ACTION_TYPE_ICONS[action.actionType] ?? Bot;
                const colorClass =
                  ACTION_TYPE_COLORS[action.actionType] ??
                  "text-muted-foreground bg-muted/10 border-border";
                const payload = action.payload as Record<string, unknown>;

                return (
                  <div
                    key={action.id}
                    className={`flex items-start gap-2.5 px-2.5 py-2 rounded-lg border ${colorClass}`}
                  >
                    <Icon className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Badge
                          variant="secondary"
                          className="text-[8px] h-3.5 px-1 bg-background/50"
                        >
                          {ACTION_TYPE_LABELS[action.actionType] ??
                            action.actionType}
                        </Badge>
                        <span className="text-[9px] text-muted-foreground">
                          {formatRelativeTime(action.createdAt)}
                        </span>
                      </div>
                      <div className="text-[11px] mt-0.5 leading-tight">
                        {(payload?.message as string) ?? "Action logged"}
                      </div>
                    </div>
                    {action.status !== "dismissed" && (
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground p-0.5 rounded"
                        onClick={() => handleDismiss(action.id)}
                        title="Dismiss"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {pendingActions.length === 0 && (
            <div className="text-[11px] text-muted-foreground text-center py-2">
              No recent autopilot actions.
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function StatBadge({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-muted/20 rounded px-2 py-1.5 text-center">
      <div className="text-sm font-bold text-foreground">{value}</div>
      <div className="text-[8px] text-muted-foreground uppercase tracking-wider">
        {label}
      </div>
    </div>
  );
}
