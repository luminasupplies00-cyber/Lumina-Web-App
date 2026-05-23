import { useState } from "react";
import { useGetThreads, useCreateRfq } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Search, ExternalLink, ArrowRight, RefreshCw, AlertTriangle } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useMutation } from "@tanstack/react-query";

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

// ─── Reclassify mutation ───────────────────────────────────────────────────────

interface ReclassifyResult {
  ok: boolean;
  total: number;
  processed: number;
  failed: number;
  counts: Record<string, number>;
}

function useReclassifyAll() {
  return useMutation<ReclassifyResult, Error>({
    mutationFn: async () => {
      const res = await fetch("/api/ai/reclassify-all", { method: "POST" });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text);
      }
      return res.json() as Promise<ReclassifyResult>;
    },
  });
}

// ─── Component ─────────────────────────────────────────────────────────────────

export default function Inbox() {
  const [filter, setFilter] = useState<string>("All");
  const [search, setSearch] = useState("");
  const queryClient = useQueryClient();

  const queryParams = {
    ...(filter !== "All" ? { classification: filter } : {}),
    ...(search ? { search } : {}),
  };

  const { data, isLoading } = useGetThreads(queryParams);
  const createRfq = useCreateRfq();
  const reclassify = useReclassifyAll();

  const handleMoveToPipeline = (thread: { id: number; senderName: string; senderEmail: string; subject: string }) => {
    createRfq.mutate(
      {
        data: {
          emailThreadId: thread.id,
          customerName: thread.senderName,
          customerEmail: thread.senderEmail,
          notes: thread.subject,
        },
      },
      {
        onSuccess: () => {
          toast.success("Added to Pipeline");
          void queryClient.invalidateQueries({ queryKey: ["/api/threads"] });
          void queryClient.invalidateQueries({ queryKey: ["/api/rfq"] });
        },
        onError: () => toast.error("Failed to add to pipeline"),
      },
    );
  };

  const handleReclassifyAll = () => {
    reclassify.mutate(undefined, {
      onSuccess: (result) => {
        toast.success(
          `Re-classified ${result.processed} emails — ${result.counts["RFQ"] ?? 0} RFQ, ${result.counts["SUPPLIER_REPLY"] ?? 0} Supplier Reply`,
        );
        void queryClient.invalidateQueries({ queryKey: ["/api/threads"] });
      },
      onError: (err) => toast.error(`Re-classification failed: ${err.message}`),
    });
  };

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row gap-3 justify-between items-start sm:items-center">
        <h1 className="text-2xl font-bold tracking-tight">Inbox</h1>
        <div className="flex gap-2 items-center w-full sm:w-auto">
          <div className="relative flex-1 sm:w-64">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search emails..."
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleReclassifyAll}
            disabled={reclassify.isPending}
            className="shrink-0"
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${reclassify.isPending ? "animate-spin" : ""}`} />
            {reclassify.isPending ? "Re-classifying…" : "Re-classify All"}
          </Button>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex flex-wrap gap-1.5">
        {CLASSIFICATIONS.map((c) => {
          const label = c === "All" ? "All" : (CLASSIFICATION_LABELS[c] ?? c);
          const isActive = filter === c;
          return (
            <button
              key={c}
              onClick={() => setFilter(c)}
              className={`text-xs px-3 py-1 rounded-full border transition-colors ${
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

      {/* Thread list */}
      <div className="rounded-lg border border-border divide-y divide-border">
        {isLoading ? (
          <div className="p-8 text-center text-muted-foreground text-sm">Loading threads…</div>
        ) : !data?.threads || data.threads.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground text-sm">
            No emails found
            {filter !== "All" && (
              <span>
                {" "}
                with classification{" "}
                <span className="text-foreground">{CLASSIFICATION_LABELS[filter] ?? filter}</span>
              </span>
            )}
            .
          </div>
        ) : (
          data.threads.map((thread) => (
            <div
              key={thread.id}
              className="p-3.5 flex flex-col sm:flex-row sm:items-center gap-3 hover:bg-muted/20 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                  <span className="font-medium text-sm">{thread.senderName}</span>
                  <span className="text-xs text-muted-foreground">&lt;{thread.senderEmail}&gt;</span>
                  <ClassificationBadge
                    classification={thread.classification}
                    confidence={(thread as { aiConfidence?: string | null }).aiConfidence}
                    reasoning={(thread as { aiReasoning?: string | null }).aiReasoning}
                  />
                </div>
                <div className="font-semibold text-sm truncate">{thread.subject}</div>
                <div className="text-xs text-muted-foreground truncate mt-0.5">{thread.snippet}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0 sm:flex-col sm:items-end">
                <span className="text-xs text-muted-foreground">
                  {formatDistanceToNow(new Date(thread.receivedAt), { addSuffix: true })}
                </span>
                <div className="flex gap-1.5">
                  <Button variant="outline" size="sm" asChild>
                    <a
                      href={`https://mail.zoho.com/zm/#mail/folder/inbox/p/${thread.threadId}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink className="h-3 w-3 mr-1" /> Zoho
                    </a>
                  </Button>
                  {!thread.isRfq && thread.classification === "RFQ" && (
                    <Button
                      size="sm"
                      onClick={() => handleMoveToPipeline(thread)}
                      disabled={createRfq.isPending}
                    >
                      <ArrowRight className="h-3 w-3 mr-1" /> Pipeline
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Re-classify result summary */}
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
