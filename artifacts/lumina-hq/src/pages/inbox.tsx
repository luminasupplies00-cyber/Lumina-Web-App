import { useState, useMemo } from "react";
import {
  useGetThreads,
  useCreateRfqFromThread,
  useGetZohoAccounts,
  useGetThreadCounts,
  useRunSyncForAccount,
  useRunSync,
  useDeleteThread,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Search, ArrowRight, RefreshCw, AlertTriangle, Mail, Circle, Trash2, X, MessagesSquare, FileText, Paperclip } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { useQueryClient, useMutation } from "@tanstack/react-query";
import { EmailDetailSheet } from "@/components/EmailDetailSheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// ─── Classification config ─────────────────────────────────────────────────────

const CLASSIFICATION_LABELS: Record<string, string> = {
  RFQ: "RFQ",
  SUPPLIER_REPLY: "Supplier Reply",
  CUSTOMER_FOLLOWUP: "Customer Follow-up",
  PO_INVOICE: "PO / Invoice",
  INTERNAL: "Internal",
  SPAM_NEWSLETTER: "Spam/Newsletter",
  GENERAL: "General",
  UNCLASSIFIED: "Failed",
};

const CLASSIFICATIONS = [
  "All",
  "RFQ",
  "SUPPLIER_REPLY",
  "CUSTOMER_FOLLOWUP",
  "PO_INVOICE",
  "INTERNAL",
  "SPAM_NEWSLETTER",
  "GENERAL",
  "UNCLASSIFIED",
] as const;

const COLORS: Record<string, string> = {
  RFQ: "bg-cyan-500/15 text-cyan-400 border-cyan-500/30",
  SUPPLIER_REPLY: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  CUSTOMER_FOLLOWUP: "bg-violet-500/15 text-violet-400 border-violet-500/30",
  PO_INVOICE: "bg-green-500/15 text-green-400 border-green-500/30",
  INTERNAL: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  SPAM_NEWSLETTER: "bg-gray-500/15 text-gray-400 border-gray-500/30",
  GENERAL: "bg-zinc-700/30 text-zinc-500 border-zinc-600/30",
  UNCLASSIFIED: "bg-red-500/15 text-red-400 border-red-500/30",
};

const ROLE_COLORS: Record<string, string> = {
  Owner: "bg-cyan-500/20 text-cyan-300 border-cyan-500/40",
  Sales: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  Procurement: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  Support: "bg-violet-500/20 text-violet-300 border-violet-500/40",
  Finance: "bg-blue-500/20 text-blue-300 border-blue-500/40",
  General: "bg-zinc-600/30 text-zinc-300 border-zinc-500/40",
};

const ROLE_ORDER = ["Owner", "Sales", "Procurement", "Support", "Finance", "General"];

// ─── Badges ────────────────────────────────────────────────────────────────────

function ClassificationBadge({
  classification,
  confidence,
  reasoning,
}: {
  classification: string | null | undefined;
  confidence?: string | null;
  reasoning?: string | null;
}) {
  if (!classification) return null;
  const label = CLASSIFICATION_LABELS[classification] ?? classification;
  const color = COLORS[classification] ?? COLORS["GENERAL"]!;
  const isLow = confidence === "low";
  return (
    <span
      title={reasoning ?? undefined}
      className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border font-medium ${color}`}
    >
      {isLow && <AlertTriangle className="h-2.5 w-2.5" />}
      {label}
    </span>
  );
}

function RoleBadge({ label }: { label: string }) {
  const color = ROLE_COLORS[label] ?? ROLE_COLORS["General"]!;
  return (
    <span className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded border font-medium ${color}`}>
      {label}
    </span>
  );
}

// ─── Reclassify ─────────────────────────────────────────────────────────────────

function useReclassifyAll() {
  return useMutation<{ ok: boolean; processed: number; failed: number; counts: Record<string, number> }, Error>({
    mutationFn: async () => {
      const res = await fetch("/api/ai/reclassify-all", { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
  });
}

// ─── Per-tab state ─────────────────────────────────────────────────────────────

interface TabState {
  classification: string;
  search: string;
}

const DEFAULT_TAB_STATE: TabState = { classification: "All", search: "" };

// ─── Component ─────────────────────────────────────────────────────────────────

interface ZohoAccount {
  id: number;
  accountId: string;
  email: string;
  accountLabel: string;
  lastSyncedAt?: string | null;
  hasWriteScope?: boolean;
}

export default function Inbox() {
  const queryClient = useQueryClient();
  const { data: accountsData } = useGetZohoAccounts();
  const { data: countsData } = useGetThreadCounts();

  const accounts: ZohoAccount[] = useMemo(() => {
    const list = (accountsData?.accounts ?? []) as ZohoAccount[];
    return [...list].sort((a, b) => {
      const ai = ROLE_ORDER.indexOf(a.accountLabel);
      const bi = ROLE_ORDER.indexOf(b.accountLabel);
      const aRank = ai === -1 ? ROLE_ORDER.length : ai;
      const bRank = bi === -1 ? ROLE_ORDER.length : bi;
      if (aRank === bRank && ai === -1) {
        return a.accountLabel.localeCompare(b.accountLabel);
      }
      if (aRank !== bRank) return aRank - bRank;
      return a.email.localeCompare(b.email);
    });
  }, [accountsData]);

  // Active tab key: "All" or a Zoho accountId
  const [activeTab, setActiveTab] = useState<string>("All");
  const [tabStates, setTabStates] = useState<Record<string, TabState>>({});

  const currentState = tabStates[activeTab] ?? DEFAULT_TAB_STATE;
  const setCurrentState = (patch: Partial<TabState>) => {
    setTabStates((prev) => ({
      ...prev,
      [activeTab]: { ...(prev[activeTab] ?? DEFAULT_TAB_STATE), ...patch },
    }));
  };

  const queryParams: Record<string, string> = {};
  if (currentState.classification !== "All") queryParams["classification"] = currentState.classification;
  if (currentState.search) queryParams["search"] = currentState.search;
  if (activeTab !== "All") queryParams["accountId"] = activeTab;

  const { data, isLoading } = useGetThreads(queryParams);
  const createRfq = useCreateRfqFromThread();
  const reclassify = useReclassifyAll();
  const syncAll = useRunSync();
  const syncOne = useRunSyncForAccount();

  const activeAccount = activeTab === "All" ? null : accounts.find((a) => a.accountId === activeTab) ?? null;

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ["/api/threads"] });
    void queryClient.invalidateQueries({ queryKey: ["/api/threads/counts"] });
    void queryClient.invalidateQueries({ queryKey: ["/api/sync/status"] });
    void queryClient.invalidateQueries({ queryKey: ["/api/auth/zoho/accounts"] });
  };

  const handleMoveToPipeline = (thread: { id: number; subject: string }) => {
    createRfq.mutate(
      { id: thread.id },
      {
        onSuccess: (res) => {
          const r = res as { created?: boolean };
          toast.success(r.created ? "Created RFQ in Pipeline NEW" : "RFQ already existed for this thread");
          invalidateAll();
          void queryClient.invalidateQueries({ queryKey: ["/api/rfq"] });
        },
        onError: () => toast.error("Failed to create RFQ"),
      },
    );
  };

  const handleSyncAll = () => {
    syncAll.mutate(undefined, {
      onSuccess: (res) => {
        const r = res as { synced?: number; rfqsCreated?: number };
        toast.success(`Sync complete — ${r.synced ?? 0} new, ${r.rfqsCreated ?? 0} RFQs`);
        invalidateAll();
      },
      onError: () => toast.error("Sync failed"),
    });
  };

  const handleSyncCurrent = () => {
    if (!activeAccount) return;
    syncOne.mutate(
      { id: activeAccount.id },
      {
        onSuccess: (res) => {
          const r = res as { synced?: number; rfqsCreated?: number };
          toast.success(`${activeAccount.accountLabel} synced — ${r.synced ?? 0} new, ${r.rfqsCreated ?? 0} RFQs`);
          invalidateAll();
        },
        onError: () => toast.error("Sync failed"),
      },
    );
  };

  const handleReclassifyAll = () => {
    reclassify.mutate(undefined, {
      onSuccess: (result) => {
        toast.success(
          `Re-classified ${result.processed} — ${result.counts["RFQ"] ?? 0} RFQ, ${result.counts["SUPPLIER_REPLY"] ?? 0} Supplier`,
        );
        invalidateAll();
      },
      onError: (err) => toast.error(`Re-classification failed: ${err.message}`),
    });
  };

  const counts = countsData?.counts ?? {};
  const totalCount = countsData?.total ?? 0;
  const isSyncing = syncAll.isPending || syncOne.isPending;

  // Email detail panel state
  type ThreadItem = NonNullable<typeof data>["threads"][number];
  const [selectedThread, setSelectedThread] = useState<ThreadItem | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [defaultViewMode, setDefaultViewMode] = useState<"single" | "conversation">(() => {
    if (typeof window === "undefined") return "single";
    return (window.localStorage.getItem("inbox.defaultViewMode") as "single" | "conversation") || "single";
  });
  const toggleDefaultViewMode = () => {
    setDefaultViewMode((v) => {
      const next = v === "single" ? "conversation" : "single";
      try {
        window.localStorage.setItem("inbox.defaultViewMode", next);
      } catch {
        // ignore
      }
      return next;
    });
  };

  // Bulk selection state
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const deleteThread = useDeleteThread();

  const toggleSelected = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const handleDeleteOne = (id: number) => {
    deleteThread.mutate(
      { id },
      {
        onSuccess: () => {
          toast.success("Email deleted");
          setSelectedIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          invalidateAll();
        },
        onError: () => toast.error("Failed to delete email"),
      },
    );
  };

  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setConfirmBulkDelete(false);
    const results = await Promise.allSettled(
      ids.map((id) => deleteThread.mutateAsync({ id })),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.length - ok;
    if (failed === 0) toast.success(`Deleted ${ok} email${ok === 1 ? "" : "s"}`);
    else toast.error(`Deleted ${ok}, failed ${failed}`);
    clearSelection();
    invalidateAll();
  };

  const accountsNeedingReconnect = accounts.filter((a) => a.hasWriteScope === false);
  const apiBase = "/api";

  return (
    <div className="space-y-4 max-w-6xl mx-auto">
      {/* Reconnect banner */}
      {accountsNeedingReconnect.length > 0 && (
        <Alert className="bg-amber-500/10 border-amber-500/30">
          <AlertTriangle className="h-4 w-4 text-amber-400" />
          <AlertDescription className="flex items-center justify-between gap-3 flex-wrap">
            <span className="text-sm">
              <span className="text-amber-300 font-semibold">Reconnect required:</span>{" "}
              {accountsNeedingReconnect.map((a) => a.email).join(", ")} {accountsNeedingReconnect.length === 1 ? "is" : "are"} connected with read-only scope.
              Reply, archive, and delete actions will fail until you reconnect.
            </span>
            <Button size="sm" variant="outline" asChild>
              <a href="/settings"><RefreshCw className="h-3.5 w-3.5 mr-1.5" />Go to Settings</a>
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row gap-3 justify-between items-start sm:items-center">
        <h1 className="text-2xl font-bold tracking-tight">Inbox</h1>
        <div className="flex gap-2 items-center">
          <Button
            variant={defaultViewMode === "conversation" ? "default" : "outline"}
            size="sm"
            onClick={toggleDefaultViewMode}
            title={
              defaultViewMode === "conversation"
                ? "Emails will open in conversation view. Click to switch to single message."
                : "Emails will open as a single message. Click to switch to conversation view."
            }
          >
            {defaultViewMode === "conversation" ? (
              <MessagesSquare className="h-3.5 w-3.5 mr-1.5" />
            ) : (
              <FileText className="h-3.5 w-3.5 mr-1.5" />
            )}
            {defaultViewMode === "conversation" ? "Conversation" : "Single"}
          </Button>
          <Button variant="outline" size="sm" onClick={handleReclassifyAll} disabled={reclassify.isPending}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${reclassify.isPending ? "animate-spin" : ""}`} />
            {reclassify.isPending ? "Re-classifying…" : "Re-classify All"}
          </Button>
          <Button size="sm" onClick={handleSyncAll} disabled={isSyncing}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${syncAll.isPending ? "animate-spin" : ""}`} />
            Sync All
          </Button>
        </div>
      </div>

      {/* Account tabs */}
      <div className="flex flex-wrap gap-1.5 border-b border-border pb-2">
        <button
          onClick={() => setActiveTab("All")}
          className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border transition-colors ${
            activeTab === "All"
              ? "bg-foreground text-background border-foreground"
              : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/40"
          }`}
        >
          <span className="font-medium">All</span>
          <span className="opacity-70">({totalCount})</span>
        </button>
        {accounts.map((acc) => {
          const isActive = activeTab === acc.accountId;
          const count = counts[acc.accountId] ?? 0;
          return (
            <button
              key={acc.id}
              onClick={() => setActiveTab(acc.accountId)}
              className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-md border transition-colors ${
                isActive
                  ? "bg-foreground text-background border-foreground"
                  : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/40"
              }`}
            >
              <RoleBadge label={acc.accountLabel} />
              <span className="font-medium">{acc.email}</span>
              <span className={isActive ? "opacity-80" : "opacity-70"}>({count})</span>
            </button>
          );
        })}
      </div>

      {/* Per-account header strip */}
      {activeAccount && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground px-1">
          <div className="flex items-center gap-2">
            <RoleBadge label={activeAccount.accountLabel} />
            <span className="text-foreground font-medium">{activeAccount.email}</span>
            <span>·</span>
            <span>
              Last sync:{" "}
              {activeAccount.lastSyncedAt
                ? formatDistanceToNow(new Date(activeAccount.lastSyncedAt), { addSuffix: true })
                : "never"}
            </span>
          </div>
          <Button variant="outline" size="sm" onClick={handleSyncCurrent} disabled={isSyncing}>
            <RefreshCw className={`h-3 w-3 mr-1 ${syncOne.isPending ? "animate-spin" : ""}`} />
            Sync this account
          </Button>
        </div>
      )}

      {/* Search + classification filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search this account…"
            className="pl-9"
            value={currentState.search}
            onChange={(e) => setCurrentState({ search: e.target.value })}
          />
        </div>
        <div className="flex flex-wrap gap-1.5 flex-1">
          {CLASSIFICATIONS.map((c) => {
            const label = c === "All" ? "All" : (CLASSIFICATION_LABELS[c] ?? c);
            const isActive = currentState.classification === c;
            return (
              <button
                key={c}
                onClick={() => setCurrentState({ classification: c })}
                className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                  isActive
                    ? "bg-foreground text-background border-foreground"
                    : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/40"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Bulk selection bar */}
      {selectedIds.size > 0 && (() => {
        const visibleIds = (data?.threads ?? []).map((t) => t.id);
        const allVisibleSelected =
          visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
        return (
          <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-cyan-500/40 bg-cyan-500/[0.07]">
            <div className="text-sm flex items-center gap-3 flex-wrap">
              <span>
                <span className="font-semibold text-cyan-300">{selectedIds.size}</span>
                <span className="text-muted-foreground"> selected</span>
              </span>
              {!allVisibleSelected && visibleIds.length > selectedIds.size && (
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-cyan-400 hover:text-cyan-300"
                  onClick={() => setSelectedIds(new Set(visibleIds))}
                >
                  Select all {visibleIds.length} emails
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={clearSelection}>
                <X className="h-3.5 w-3.5 mr-1.5" /> Clear
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setConfirmBulkDelete(true)}
                disabled={deleteThread.isPending}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                Delete {selectedIds.size}
              </Button>
            </div>
          </div>
        );
      })()}

      {/* Thread list */}
      <div className="rounded-lg border border-border divide-y divide-border">
        {isLoading ? (
          <div className="p-8 text-center text-muted-foreground text-sm">Loading threads…</div>
        ) : !data?.threads || data.threads.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground text-sm">No emails match the current filters.</div>
        ) : (
          data.threads.map((thread) => {
            const isRead = (thread as { isRead?: boolean }).isRead ?? false;
            const rfqId = (thread as { rfqId?: number | null }).rfqId;
            const isSelected = selectedIds.has(thread.id);
            const hasAnySelected = selectedIds.size > 0;
            return (
              <div
                key={thread.id}
                role="button"
                tabIndex={0}
                onClick={() => {
                  setSelectedThread(thread);
                  setSheetOpen(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedThread(thread);
                    setSheetOpen(true);
                  }
                }}
                className={`group w-full text-left p-3.5 flex flex-col sm:flex-row sm:items-center gap-3 hover:bg-muted/30 transition-colors cursor-pointer ${
                  isSelected ? "bg-cyan-500/[0.07]" : !isRead ? "bg-cyan-500/[0.03]" : ""
                }`}
              >
                <div
                  className={`shrink-0 transition-opacity ${
                    isSelected || hasAnySelected ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
                  }`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={() => toggleSelected(thread.id)}
                    aria-label="Select email"
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                    {!isRead && <Circle className="h-2 w-2 fill-cyan-400 text-cyan-400 shrink-0" />}
                    <span className={`text-sm ${!isRead ? "font-semibold" : "font-medium"}`}>{thread.senderName}</span>
                    <span className="text-xs text-muted-foreground">&lt;{thread.senderEmail}&gt;</span>
                    <ClassificationBadge
                      classification={thread.classification}
                      confidence={(thread as { aiConfidence?: string | null }).aiConfidence}
                      reasoning={(thread as { aiReasoning?: string | null }).aiReasoning}
                    />
                  </div>
                  <div className={`text-sm truncate flex items-center gap-1.5 ${!isRead ? "font-semibold" : "font-medium"}`}>
                    <span className="truncate">{thread.subject}</span>
                    {thread.hasAttachments && (
                      <Paperclip
                        className="h-3.5 w-3.5 text-muted-foreground shrink-0"
                        aria-label="Has attachments"
                      />
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground truncate mt-0.5">{thread.snippet}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0 sm:flex-col sm:items-end" onClick={(e) => e.stopPropagation()}>
                  <span className="text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(thread.receivedAt), { addSuffix: true })}
                  </span>
                  <div className="flex gap-1.5 items-center">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteOne(thread.id);
                      }}
                      disabled={deleteThread.isPending}
                      title="Delete email"
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-red-400 hover:text-red-300 hover:bg-red-500/10"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => { setSelectedThread(thread); setSheetOpen(true); }} title="Open email">
                      <Mail className="h-3 w-3 mr-1" /> Open
                    </Button>
                    {thread.classification === "RFQ" && !rfqId && (
                      <Button size="sm" onClick={(e) => { e.stopPropagation(); handleMoveToPipeline(thread); }} disabled={createRfq.isPending}>
                        <ArrowRight className="h-3 w-3 mr-1" /> Create RFQ
                      </Button>
                    )}
                    {rfqId && (
                      <Button variant="outline" size="sm" asChild onClick={(e) => e.stopPropagation()}>
                        <a href={`/rfq/${rfqId}`}>
                          <ArrowRight className="h-3 w-3 mr-1" /> Open RFQ
                        </a>
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Email detail slide-over */}
      <EmailDetailSheet
        thread={selectedThread as never}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        apiBase={apiBase}
        defaultViewMode={defaultViewMode}
      />

      <AlertDialog open={confirmBulkDelete} onOpenChange={setConfirmBulkDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selectedIds.size} email{selectedIds.size === 1 ? "" : "s"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The selected email{selectedIds.size === 1 ? "" : "s"} will be moved to Trash in Zoho and removed from
              this inbox view. This cannot be undone from here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={(e) => {
                e.preventDefault();
                void handleBulkDelete();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Re-classify summary */}
      {reclassify.data && (
        <div className="text-xs text-muted-foreground px-1">
          Last re-classification: {reclassify.data.processed} processed, {reclassify.data.failed} failed
          {" · "}
          {Object.entries(reclassify.data.counts)
            .filter(([, v]) => v > 0)
            .map(([k, v]) => `${CLASSIFICATION_LABELS[k] ?? k}: ${v}`)
            .join(", ")}
        </div>
      )}
    </div>
  );
}
