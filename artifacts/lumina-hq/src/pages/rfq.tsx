import { useState, useEffect, useRef } from "react";
import { useSearch, useLocation } from "wouter";
import {
  useGetRfqs,
  useUpdateRfqStage,
  useExtractProducts,
  useConfirmExtraction,
  useDraftSupplierEmail,
  useLogSupplierQuote,
  useParseSupplierReply,
  useCompareSupplierQuotes,
  getCompareSupplierQuotesQueryKey,
  useDraftCustomerQuote,
  useDraftFollowup,
  useMarkDraftCopied,
  type RfqProduct,
} from "@workspace/api-client-react";
import { Card, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Form, FormControl, FormField, FormItem, FormLabel } from "@/components/ui/form";
import { useForm, useFieldArray } from "react-hook-form";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink, Copy, Check, ChevronRight, FileText, Bot, Plus, Trash2,
  BarChart2, MessageSquare, User, RefreshCw, AlertTriangle, ClipboardPaste,
  Edit3, CheckCircle2, Paperclip, Eye, Download, Globe, Mail, Clock, XCircle
} from "lucide-react";
import { SupplierOutreachModal } from "@/components/SupplierOutreachModal";
import { FindSuppliersOnlineModal } from "@/components/FindSuppliersOnlineModal";
import { useUpdateSupplierContactStatus, useDraftSupplierFollowup } from "@workspace/api-client-react";

const STAGES = ["NEW", "SOURCING", "COMPARING", "QUOTE_READY", "QUOTE_SENT", "FOLLOW_UP", "WON", "LOST"];

const STAGE_LABELS: Record<string, string> = {
  NEW: "New",
  SOURCING: "Sourcing",
  COMPARING: "Comparing",
  QUOTE_READY: "Quote Ready",
  QUOTE_SENT: "Quote Sent",
  FOLLOW_UP: "Follow Up",
  WON: "Won",
  LOST: "Lost",
};

export default function Pipeline() {
  const { data, isLoading, error } = useGetRfqs();
  const search = useSearch();
  const [, setLocation] = useLocation();
  const focusParam = new URLSearchParams(search).get("focus");
  const focusedRfqId = focusParam ? Number(focusParam) : null;

  // Clear the focus param from the URL once consumed so a refresh doesn't keep re-focusing.
  useEffect(() => {
    if (focusedRfqId != null) {
      const t = setTimeout(() => setLocation("/rfq", { replace: true }), 1500);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [focusedRfqId, setLocation]);

  if (isLoading) return <PipelineSkeleton />;
  if (error) return <div className="p-4 text-destructive">Failed to load pipeline data.</div>;
  if (!data) return null;

  return (
    <div className="space-y-6 flex flex-col h-full overflow-hidden">
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4 shrink-0">
        <MetricCard label="New Today" value={data.metrics.newToday} />
        <MetricCard label="In Sourcing" value={data.metrics.inSourcing} />
        <MetricCard label="Awaiting Customer" value={data.metrics.awaitingCustomer} />
        <MetricCard label="Won This Month" value={data.metrics.wonThisMonth} />
        <MetricCard
          label="Pipeline Value"
          value={`${data.metrics.totalPipelineValue.toLocaleString()} ${data.metrics.currency}`}
        />
        <MetricCard
          label="Stuck"
          value={data.metrics.stuckCount}
          alert={data.metrics.stuckCount > 0}
        />
      </div>

      <div className="flex gap-4 overflow-x-auto pb-4 flex-1">
        {STAGES.map(stage => (
          <div key={stage} className="min-w-[300px] w-[300px] flex flex-col gap-3 bg-sidebar rounded-xl border border-border p-3 h-full">
            <div className="flex items-center justify-between font-bold text-xs px-1 text-muted-foreground uppercase tracking-widest">
              <span>{STAGE_LABELS[stage]}</span>
              <Badge variant="secondary" className="bg-background text-[10px] h-4 px-1.5">{data.rfqs[stage]?.length || 0}</Badge>
            </div>
            <div className="flex-1 overflow-y-auto space-y-2 pr-0.5">
              {(data.rfqs[stage] || []).map((rfq: any) => (
                <RfqCard key={rfq.id} rfq={rfq} focused={focusedRfqId === rfq.id} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MetricCard({ label, value, alert }: { label: string; value: string | number; alert?: boolean }) {
  return (
    <Card className={`p-4 flex flex-col justify-center bg-sidebar border-border ${alert ? "border-amber-500/40" : ""}`}>
      <div className="text-[10px] text-muted-foreground mb-1 font-medium tracking-widest uppercase">{label}</div>
      <div className={`text-2xl font-bold tracking-tight ${alert ? "text-amber-500" : ""}`}>{value}</div>
    </Card>
  );
}

type ModalType = "supplier-outreach" | "find-online" | "supplier-followup" | "supplier-quote-form" | "comparison" | "customer-quote" | "followup" | "extraction-review";

interface ModalState {
  type: ModalType;
  rfqId: number;
  data?: any;
}

function RfqAttachmentsPopover({
  threadId,
  attachments,
}: {
  threadId: number;
  attachments: Array<{ attachmentId: string; name: string; size?: number | null; type?: string | null }>;
}) {
  if (!attachments || attachments.length === 0) {
    // Server signals hasAttachments=true but list isn't materialized yet
    return (
      <Paperclip
        className="w-3 h-3 text-muted-foreground"
        aria-label="Has attachments"
      />
    );
  }
  return (
    <Popover>
      <PopoverTrigger asChild onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="text-muted-foreground hover:text-primary transition-colors p-0.5 -m-0.5 rounded"
          aria-label={`${attachments.length} attachment${attachments.length === 1 ? "" : "s"}`}
          title={`${attachments.length} attachment${attachments.length === 1 ? "" : "s"}`}
        >
          <Paperclip className="w-3.5 h-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-72 p-2"
        align="end"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[11px] font-medium text-muted-foreground px-1 pb-1.5">
          Attachments ({attachments.length})
        </div>
        <div className="flex flex-col gap-1">
          {attachments.map((att) => {
            const base = `/api/threads/${threadId}/attachments/${att.attachmentId}`;
            return (
              <div
                key={att.attachmentId}
                className="flex items-center gap-1.5 bg-muted/30 hover:bg-muted/50 rounded px-2 py-1.5"
              >
                <Paperclip className="w-3 h-3 text-muted-foreground shrink-0" />
                <span
                  className="text-[11px] truncate flex-1"
                  title={att.name}
                >
                  {att.name}
                </span>
                <a
                  href={`${base}?inline=1`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-primary p-1 rounded"
                  aria-label={`View ${att.name}`}
                  title="View"
                >
                  <Eye className="w-3 h-3" />
                </a>
                <a
                  href={base}
                  download={att.name}
                  className="text-muted-foreground hover:text-primary p-1 rounded"
                  aria-label={`Download ${att.name}`}
                  title="Download"
                >
                  <Download className="w-3 h-3" />
                </a>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function RfqCard({ rfq, focused = false }: { rfq: any; focused?: boolean }) {
  const [expanded, setExpanded] = useState(focused);
  const [modal, setModal] = useState<ModalState | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [highlight, setHighlight] = useState(false);

  useEffect(() => {
    if (!focused) return;
    setExpanded(true);
    setHighlight(true);
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    const t = setTimeout(() => setHighlight(false), 2000);
    return () => clearTimeout(t);
  }, [focused]);

  const queryClient = useQueryClient();
  const updateStage = useUpdateRfqStage();
  const extractProducts = useExtractProducts();
  const draftSupplier = useDraftSupplierEmail();
  const draftCustomer = useDraftCustomerQuote();
  const draftFollowup = useDraftFollowup();

  const daysInStage = Math.floor((Date.now() - new Date(rfq.stageUpdatedAt).getTime()) / (1000 * 3600 * 24));
  const needsFollowup = rfq.stage === "QUOTE_SENT" && daysInStage > 3;

  const invalidateRfqs = () => queryClient.invalidateQueries({ queryKey: ["/api/rfq"] });

  const handleStageChange = (newStage: string) => {
    updateStage.mutate(
      { id: rfq.id, data: { stage: newStage } },
      { onSuccess: invalidateRfqs }
    );
  };

  const handleExtract = (e: React.MouseEvent) => {
    e.stopPropagation();
    extractProducts.mutate(
      { id: rfq.id },
      {
        onSuccess: (res) => {
          // Open extraction review modal with extracted products
          setModal({ type: "extraction-review", rfqId: rfq.id, data: res });
        },
        onError: (err: any) => toast.error(err?.response?.data?.error || "Failed to extract products")
      }
    );
  };

  const handleSourceSuppliers = (e: React.MouseEvent) => {
    e.stopPropagation();
    setModal({ type: "supplier-outreach", rfqId: rfq.id });
  };

  const handleFindOnline = (e: React.MouseEvent) => {
    e.stopPropagation();
    setModal({ type: "find-online", rfqId: rfq.id });
  };

  const handleDraftCustomer = (e: React.MouseEvent) => {
    e.stopPropagation();
    draftCustomer.mutate(
      { id: rfq.id, data: {} },
      {
        onSuccess: (res) => setModal({ type: "customer-quote", rfqId: rfq.id, data: res }),
        onError: () => toast.error("Failed to draft customer quote")
      }
    );
  };

  const handleDraftFollowup = (e: React.MouseEvent) => {
    e.stopPropagation();
    draftFollowup.mutate(
      { id: rfq.id },
      {
        onSuccess: (res) => setModal({ type: "followup", rfqId: rfq.id, data: res }),
        onError: () => toast.error("Failed to draft follow-up")
      }
    );
  };

  const stageIndex = STAGES.indexOf(rfq.stage);
  const nextStageIndex = Math.min(stageIndex + 1, STAGES.length - 1);
  const prevStageIndex = Math.max(stageIndex - 1, 0);
  const canAdvance = rfq.stage !== "WON" && rfq.stage !== "LOST";
  const canGoBack = stageIndex > 0;

  return (
    <>
      <Card
        ref={cardRef}
        className={`p-3 cursor-pointer hover:border-primary/40 transition-colors flex flex-col gap-2.5 bg-card border-border ${rfq.isStuck ? "border-amber-500/50" : ""} ${highlight ? "ring-2 ring-cyan-400 shadow-[0_0_24px_rgba(34,211,238,0.35)]" : ""}`}
        onClick={() => setExpanded(!expanded)}
      >
        {/* Stuck banner */}
        {rfq.isStuck && (
          <div className="bg-amber-500/10 border border-amber-500/25 text-amber-500 text-[10px] px-2 py-1 rounded flex items-center gap-1.5 font-medium -mx-0.5">
            <AlertTriangle className="w-3 h-3 shrink-0" />
            Stuck in {STAGE_LABELS[rfq.stage]}
          </div>
        )}

        <div className="flex justify-between items-start gap-2">
          <div className="font-semibold text-sm truncate text-card-foreground leading-tight flex-1 min-w-0">
            {rfq.customerCompany || rfq.customerName || "Unknown"}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {rfq.hasAttachments && rfq.threadDbId && (
              <RfqAttachmentsPopover
                threadId={rfq.threadDbId}
                attachments={rfq.attachments || []}
              />
            )}
            <Badge
              variant={rfq.isStuck ? "default" : daysInStage > 2 ? "destructive" : "secondary"}
              className={`text-[9px] px-1 py-0 h-4 rounded-sm ${rfq.isStuck ? "bg-amber-500/20 text-amber-500 border-amber-500/30" : ""}`}
            >
              {daysInStage}d
            </Badge>
          </div>
        </div>

        <div className="text-[11px] text-muted-foreground line-clamp-2 leading-relaxed">
          {rfq.emailSubject || "No subject"}
        </div>

        {needsFollowup && (
          <div className="text-[10px] text-destructive bg-destructive/10 px-2 py-1 rounded border border-destructive/20 font-medium">
            Follow-up overdue
          </div>
        )}

        {/* Extraction reviewed badge */}
        {rfq.extractionReviewed && (
          <div className="text-[10px] text-green-500 bg-green-500/10 px-2 py-1 rounded border border-green-500/20 flex items-center gap-1">
            <CheckCircle2 className="w-2.5 h-2.5" /> Products confirmed
          </div>
        )}

        <div className="flex justify-between items-center pt-1.5 border-t border-border">
          <div className="text-[11px] font-medium text-primary flex items-center gap-1">
            <FileText className="w-3 h-3" />
            {rfq.products?.length || 0} items
          </div>
          {rfq.estimatedValue && (
            <div className="text-[11px] font-mono text-muted-foreground">
              {Number(rfq.estimatedValue).toLocaleString()} {rfq.currency}
            </div>
          )}
        </div>

        {rfq.aiNextAction && (
          <div className="bg-primary/10 text-primary text-[10px] px-2 py-1.5 rounded border border-primary/20 flex items-start gap-1.5 leading-tight">
            <Bot className="w-3 h-3 shrink-0 mt-0.5" />
            <span>{rfq.aiNextAction}</span>
          </div>
        )}

        {/* Supplier tracker — SOURCING/COMPARING when contacts exist */}
        {(rfq.stage === "SOURCING" || rfq.stage === "COMPARING") &&
          (rfq.supplierContacts?.length ?? 0) > 0 && (
            <SupplierTracker
              rfq={rfq}
              onDraftFollowup={(data) =>
                setModal({ type: "supplier-followup", rfqId: rfq.id, data })
              }
              onChanged={invalidateRfqs}
            />
          )}

        {expanded && (
          <div className="pt-2 flex flex-col gap-1.5" onClick={e => e.stopPropagation()}>
            {/* Always available: advance stage */}
            {(canAdvance || canGoBack) && (
              <div className="flex gap-1.5">
                {canGoBack && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-xs h-7 px-2 text-muted-foreground"
                    onClick={() => handleStageChange(STAGES[prevStageIndex])}
                    disabled={updateStage.isPending}
                    title={`Move back to ${STAGE_LABELS[STAGES[prevStageIndex]]}`}
                  >
                    <ChevronRight className="w-3 h-3 rotate-180" />
                  </Button>
                )}
                {canAdvance && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="flex-1 text-xs h-7"
                    onClick={() => handleStageChange(STAGES[nextStageIndex])}
                    disabled={updateStage.isPending}
                  >
                    Move to {STAGE_LABELS[STAGES[nextStageIndex]]}
                    <ChevronRight className="w-3 h-3 ml-1" />
                  </Button>
                )}
                {!canAdvance && canGoBack && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="flex-1 text-xs h-7"
                    onClick={() => handleStageChange(STAGES[prevStageIndex])}
                    disabled={updateStage.isPending}
                  >
                    Re-open to {STAGE_LABELS[STAGES[prevStageIndex]]}
                  </Button>
                )}
              </div>
            )}

            {/* NEW: extract products */}
            {rfq.stage === "NEW" && (
              <Button
                size="sm"
                variant="outline"
                className="w-full text-xs h-7"
                onClick={handleExtract}
                disabled={extractProducts.isPending}
              >
                {extractProducts.isPending ? (
                  <><RefreshCw className="w-3 h-3 mr-1.5 animate-spin" /> Extracting...</>
                ) : (
                  <><FileText className="w-3 h-3 mr-1.5" /> Extract & Review Products</>
                )}
              </Button>
            )}

            {/* SOURCING: source suppliers (new combined flow) */}
            {rfq.stage === "SOURCING" && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full text-xs h-7"
                  onClick={handleSourceSuppliers}
                >
                  <Bot className="w-3 h-3 mr-1.5" /> Source Suppliers
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="w-full text-xs h-7 text-primary"
                  onClick={handleFindOnline}
                >
                  <Globe className="w-3 h-3 mr-1.5" /> Find Suppliers Online
                </Button>
              </>
            )}

            {/* SOURCING / COMPARING: log a supplier quote */}
            {(rfq.stage === "SOURCING" || rfq.stage === "COMPARING") && (
              <Button
                size="sm"
                variant="outline"
                className="w-full text-xs h-7"
                onClick={() => setModal({ type: "supplier-quote-form", rfqId: rfq.id })}
              >
                <Plus className="w-3 h-3 mr-1.5" /> Log Supplier Quote
              </Button>
            )}

            {/* COMPARING: run AI comparison */}
            {rfq.stage === "COMPARING" && (
              <Button
                size="sm"
                variant="outline"
                className="w-full text-xs h-7"
                onClick={() => setModal({ type: "comparison", rfqId: rfq.id })}
              >
                <BarChart2 className="w-3 h-3 mr-1.5" /> Compare Quotes
              </Button>
            )}

            {/* QUOTE_READY: draft customer quote */}
            {rfq.stage === "QUOTE_READY" && (
              <Button
                size="sm"
                variant="outline"
                className="w-full text-xs h-7"
                onClick={handleDraftCustomer}
                disabled={draftCustomer.isPending}
              >
                {draftCustomer.isPending ? (
                  <><RefreshCw className="w-3 h-3 mr-1.5 animate-spin" /> Drafting...</>
                ) : (
                  <><User className="w-3 h-3 mr-1.5" /> Draft Customer Quote</>
                )}
              </Button>
            )}

            {/* QUOTE_SENT / FOLLOW_UP: draft follow-up */}
            {(rfq.stage === "QUOTE_SENT" || rfq.stage === "FOLLOW_UP") && (
              <Button
                size="sm"
                variant="outline"
                className="w-full text-xs h-7"
                onClick={handleDraftFollowup}
                disabled={draftFollowup.isPending}
              >
                {draftFollowup.isPending ? (
                  <><RefreshCw className="w-3 h-3 mr-1.5 animate-spin" /> Drafting...</>
                ) : (
                  <><MessageSquare className="w-3 h-3 mr-1.5" /> Draft Follow-up</>
                )}
              </Button>
            )}

            {/* Mark WON or LOST from any active stage */}
            {rfq.stage !== "WON" && rfq.stage !== "LOST" && (
              <div className="flex gap-1.5 pt-0.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1 text-xs h-7 border-green-500/30 text-green-500 hover:bg-green-500/10"
                  onClick={() => handleStageChange("WON")}
                >
                  Mark Won
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1 text-xs h-7 border-destructive/30 text-destructive hover:bg-destructive/10"
                  onClick={() => handleStageChange("LOST")}
                >
                  Mark Lost
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>

      {modal?.type === "extraction-review" && (
        <ExtractionReviewModal
          isOpen
          rfqId={modal.rfqId}
          products={modal.data?.products ?? []}
          onClose={() => setModal(null)}
          onConfirmed={() => { setModal(null); invalidateRfqs(); }}
        />
      )}
      {modal?.type === "supplier-outreach" && (
        <SupplierOutreachModal
          isOpen
          rfqId={modal.rfqId}
          rfq={rfq}
          onClose={() => { setModal(null); invalidateRfqs(); }}
        />
      )}
      {modal?.type === "find-online" && (
        <FindSuppliersOnlineModal
          isOpen
          rfqId={modal.rfqId}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === "supplier-followup" && (
        <DraftModal
          isOpen
          onClose={() => setModal(null)}
          title="Supplier Follow-up Draft"
          description="Gentle nudge to a supplier who hasn't replied. Edit before sending."
          draft={modal.data}
          onCopied={() => {
            const contactId = modal.data?.contactId;
            if (!contactId) return;
            fetch(`/api/rfq/${rfq.id}/supplier-contacts/${contactId}/follow-up-sent`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
            })
              .then(() => invalidateRfqs())
              .catch(() => {/* non-fatal */});
          }}
        />
      )}
      {modal?.type === "customer-quote" && (
        <DraftModal
          isOpen
          onClose={() => setModal(null)}
          title="Customer Quote Draft"
          description="Review and edit the quote before sending via Zoho Mail."
          draft={modal.data}
        />
      )}
      {modal?.type === "followup" && (
        <DraftModal
          isOpen
          onClose={() => setModal(null)}
          title="Follow-up Draft"
          description="Gentle follow-up message. Edit as needed before sending."
          draft={modal.data}
        />
      )}
      {modal?.type === "supplier-quote-form" && (
        <SupplierQuoteModal
          isOpen
          rfqId={modal.rfqId}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); invalidateRfqs(); }}
        />
      )}
      {modal?.type === "comparison" && (
        <ComparisonModal
          isOpen
          rfqId={modal.rfqId}
          onClose={() => setModal(null)}
        />
      )}
    </>
  );
}

// ─── Supplier Tracker (on SOURCING / COMPARING cards) ─────────────────────────

function SupplierTracker({
  rfq,
  onDraftFollowup,
  onChanged,
}: {
  rfq: any;
  onDraftFollowup: (data: any) => void;
  onChanged: () => void;
}) {
  const updateStatus = useUpdateSupplierContactStatus();
  const draftFollowup = useDraftSupplierFollowup();
  const contacts: any[] = rfq.supplierContacts ?? [];
  const noResp = rfq.noResponseCount ?? 0;

  const fmtHours = (h: number) => {
    if (h < 1) return "<1h";
    if (h < 24) return `${Math.round(h)}h`;
    return `${Math.round(h / 24)}d`;
  };

  const handlePatch = (contactId: number, status: "responded" | "no_response") => {
    updateStatus.mutate(
      { id: rfq.id, contactId, data: { status } },
      { onSuccess: onChanged, onError: () => toast.error("Failed to update status") },
    );
  };

  const handleFollowup = (contactId: number) => {
    draftFollowup.mutate(
      { id: rfq.id, data: { contactId, tone: "gentle" } },
      {
        // Attach contactId so DraftModal can post follow-up-sent after copy.
        onSuccess: (res) => onDraftFollowup({ ...res, contactId }),
        onError: () => toast.error("Failed to draft follow-up"),
      },
    );
  };

  return (
    <div
      className="border-t border-border pt-2 mt-1 space-y-1.5"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
        <span className="flex items-center gap-1">
          <Mail className="w-2.5 h-2.5" /> Suppliers contacted
        </span>
        <span>
          {contacts.filter((c) => c.status === "responded").length}/{contacts.length} replied
        </span>
      </div>

      {noResp > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/25 text-amber-500 text-[10px] px-2 py-1 rounded flex items-center gap-1.5 font-medium">
          <AlertTriangle className="w-3 h-3 shrink-0" />
          {noResp} supplier{noResp === 1 ? "" : "s"} silent &gt;48h
        </div>
      )}

      <div className="space-y-1">
        {contacts.map((c) => {
          const isResponded = c.status === "responded";
          const isNoResp = c.status === "no_response";
          const stale = !isResponded && !isNoResp && (c.hoursSinceContact ?? 0) > 48;
          return (
            <div
              key={c.id}
              className={`text-[10px] rounded border px-1.5 py-1 ${isResponded ? "border-green-500/30 bg-green-500/5" : stale ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-muted/30"}`}
            >
              <div className="flex items-center justify-between gap-1">
                <div className="font-medium truncate flex items-center gap-1">
                  {isResponded ? (
                    <Check className="w-2.5 h-2.5 text-green-500 shrink-0" />
                  ) : isNoResp ? (
                    <XCircle className="w-2.5 h-2.5 text-muted-foreground shrink-0" />
                  ) : (
                    <Clock className="w-2.5 h-2.5 text-muted-foreground shrink-0" />
                  )}
                  <span className="truncate">{c.supplierName}</span>
                </div>
                <span className="text-muted-foreground shrink-0">
                  {fmtHours(c.hoursSinceContact ?? 0)}
                </span>
              </div>
              {!isResponded && !isNoResp && (
                <div className="flex gap-1 mt-1">
                  <button
                    onClick={() => handlePatch(c.id, "responded")}
                    disabled={updateStatus.isPending}
                    className="text-[9px] px-1.5 py-0.5 rounded border border-green-500/30 text-green-500 hover:bg-green-500/10"
                  >
                    Responded
                  </button>
                  <button
                    onClick={() => handlePatch(c.id, "no_response")}
                    disabled={updateStatus.isPending}
                    className="text-[9px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:bg-muted/50"
                  >
                    No reply
                  </button>
                  <button
                    onClick={() => handleFollowup(c.id)}
                    disabled={draftFollowup.isPending}
                    className="text-[9px] px-1.5 py-0.5 rounded border border-primary/30 text-primary hover:bg-primary/10 ml-auto"
                  >
                    Follow-up
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Extraction Review Modal ───────────────────────────────────────────────────

interface ReviewProduct {
  id?: number;
  productName: string;
  catalogueNumber: string;
  brand: string;
  quantity: string;
  specifications: string;
  extractionConfidence: string;
}

function ExtractionReviewModal({
  isOpen,
  rfqId,
  products: initialProducts,
  onClose,
  onConfirmed,
}: {
  isOpen: boolean;
  rfqId: number;
  products: RfqProduct[];
  onClose: () => void;
  onConfirmed: () => void;
}) {
  const confirm = useConfirmExtraction();
  const [products, setProducts] = useState<ReviewProduct[]>(() =>
    initialProducts.map(p => ({
      id: p.id,
      productName: p.productName,
      catalogueNumber: p.catalogueNumber ?? "",
      brand: p.brand ?? "",
      quantity: p.quantity ?? "",
      specifications: p.specifications ?? "",
      extractionConfidence: p.extractionConfidence ?? "medium",
    }))
  );

  const updateProduct = (index: number, field: keyof ReviewProduct, value: string) => {
    setProducts(prev => prev.map((p, i) => i === index ? { ...p, [field]: value } : p));
  };

  const removeProduct = (index: number) => {
    setProducts(prev => prev.filter((_, i) => i !== index));
  };

  const addProduct = () => {
    setProducts(prev => [...prev, {
      productName: "",
      catalogueNumber: "",
      brand: "",
      quantity: "",
      specifications: "",
      extractionConfidence: "manual",
    }]);
  };

  const handleConfirm = () => {
    const valid = products.filter(p => p.productName.trim());
    if (valid.length === 0) {
      toast.error("At least one product is required");
      return;
    }

    confirm.mutate(
      {
        id: rfqId,
        data: {
          products: valid.map(p => ({
            id: p.id,
            productName: p.productName,
            catalogueNumber: p.catalogueNumber || undefined,
            brand: p.brand || undefined,
            quantity: p.quantity || undefined,
            specifications: p.specifications || undefined,
            extractionConfidence: p.extractionConfidence,
          })),
        },
      },
      {
        onSuccess: () => {
          toast.success("Products confirmed — moved to Sourcing");
          onConfirmed();
        },
        onError: () => toast.error("Failed to confirm products"),
      }
    );
  };

  const confidenceColor = (c: string) =>
    c === "high" ? "text-green-500" : c === "low" ? "text-amber-500" : "text-muted-foreground";

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Edit3 className="w-4 h-4" /> Review Extracted Products
          </DialogTitle>
          <DialogDescription>
            AI extracted {initialProducts.length} product{initialProducts.length !== 1 ? "s" : ""}. Review and correct before confirming — this will advance the RFQ to Sourcing.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-2 pr-1">
          {products.map((product, index) => (
            <div key={index} className="bg-muted/30 border border-border rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground font-mono w-5">{index + 1}.</span>
                  <span className={`text-[10px] font-medium uppercase ${confidenceColor(product.extractionConfidence)}`}>
                    {product.extractionConfidence} confidence
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-destructive"
                  onClick={() => removeProduct(index)}
                >
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="col-span-2">
                  <label className="text-[10px] text-muted-foreground mb-1 block">Product Name *</label>
                  <Input
                    className="h-7 text-xs"
                    value={product.productName}
                    onChange={e => updateProduct(index, "productName", e.target.value)}
                    placeholder="Product name"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground mb-1 block">Catalogue Number</label>
                  <Input
                    className="h-7 text-xs"
                    value={product.catalogueNumber}
                    onChange={e => updateProduct(index, "catalogueNumber", e.target.value)}
                    placeholder="Cat. No."
                  />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground mb-1 block">Brand</label>
                  <Input
                    className="h-7 text-xs"
                    value={product.brand}
                    onChange={e => updateProduct(index, "brand", e.target.value)}
                    placeholder="Brand"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground mb-1 block">Quantity</label>
                  <Input
                    className="h-7 text-xs"
                    value={product.quantity}
                    onChange={e => updateProduct(index, "quantity", e.target.value)}
                    placeholder="e.g. 5 pcs"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground mb-1 block">Specifications</label>
                  <Input
                    className="h-7 text-xs"
                    value={product.specifications}
                    onChange={e => updateProduct(index, "specifications", e.target.value)}
                    placeholder="Any specs"
                  />
                </div>
              </div>
            </div>
          ))}

          <Button variant="outline" size="sm" className="w-full h-8 text-xs" onClick={addProduct}>
            <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Product
          </Button>
        </div>

        <DialogFooter className="flex justify-between items-center sm:justify-between gap-2 pt-2 border-t border-border">
          <span className="text-xs text-muted-foreground">{products.filter(p => p.productName).length} product{products.filter(p => p.productName).length !== 1 ? "s" : ""} ready</span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={handleConfirm} disabled={confirm.isPending}>
              {confirm.isPending ? (
                <><RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Confirming...</>
              ) : (
                <><CheckCircle2 className="w-3.5 h-3.5 mr-1.5" /> Confirm & Move to Sourcing</>
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Draft Modal ───────────────────────────────────────────────────────────────

function DraftModal({
  isOpen,
  onClose,
  title,
  description,
  draft,
  onCopied,
}: {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description: string;
  draft: any;
  onCopied?: () => void;
}) {
  const [content, setContent] = useState(draft?.draft || "");
  const [copied, setCopied] = useState(false);
  const markCopied = useMarkDraftCopied();

  const handleCopy = () => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      if (draft?.draftId) {
        markCopied.mutate({ draftId: draft.draftId });
      }
      onCopied?.();
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          className="flex-1 min-h-[280px] font-mono text-sm resize-none"
        />
        <DialogFooter className="flex justify-between items-center sm:justify-between gap-2">
          <Button variant="outline" size="sm" onClick={() => window.open("https://mail.zoho.com", "_blank")}>
            <ExternalLink className="w-3.5 h-3.5 mr-1.5" /> Open Zoho Mail
          </Button>
          <Button onClick={handleCopy}>
            {copied ? <Check className="w-3.5 h-3.5 mr-1.5" /> : <Copy className="w-3.5 h-3.5 mr-1.5" />}
            {copied ? "Copied!" : "Copy to Clipboard"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Supplier Quote Modal ──────────────────────────────────────────────────────

interface SupplierQuoteLine {
  productName: string;
  unitPrice: string;
  quantity: string;
  currency: string;
}

interface SupplierQuoteFormData {
  supplierName: string;
  supplierEmail: string;
  notes: string;
  lines: SupplierQuoteLine[];
}

function SupplierQuoteModal({
  isOpen,
  rfqId,
  onClose,
  onSaved
}: {
  isOpen: boolean;
  rfqId: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [tab, setTab] = useState<"manual" | "paste">("manual");
  const [pasteText, setPasteText] = useState("");
  const [parsing, setParsing] = useState(false);
  const logQuote = useLogSupplierQuote();
  const parseReply = useParseSupplierReply();

  const form = useForm<SupplierQuoteFormData>({
    defaultValues: {
      supplierName: "",
      supplierEmail: "",
      notes: "",
      lines: [{ productName: "", unitPrice: "", quantity: "1", currency: "SAR" }],
    }
  });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "lines" });

  const handleParseEmail = () => {
    if (!pasteText.trim()) return;
    setParsing(true);
    parseReply.mutate(
      { id: rfqId, data: { emailText: pasteText } },
      {
        onSuccess: (res) => {
          const parsed = res.parsed;
          if (parsed.supplierName) form.setValue("supplierName", parsed.supplierName);
          if (parsed.supplierEmail) form.setValue("supplierEmail", parsed.supplierEmail);
          if (parsed.notes) form.setValue("notes", parsed.notes);
          if (parsed.lines && parsed.lines.length > 0) {
            form.setValue("lines", parsed.lines.map(l => ({
              productName: l.productName,
              unitPrice: l.unitPrice,
              quantity: "1",
              currency: l.currency || parsed.currency || "SAR",
            })));
          }
          setTab("manual");
          toast.success(`Parsed ${parsed.lines?.length ?? 0} line items from email`);
        },
        onError: () => toast.error("Failed to parse supplier reply"),
        onSettled: () => setParsing(false),
      }
    );
  };

  const onSubmit = (values: SupplierQuoteFormData) => {
    const lines = values.lines.map(l => ({
      productName: l.productName,
      unitPrice: (parseFloat(l.unitPrice) || 0).toString(),
      currency: l.currency || "SAR",
    }));
    const totalAmount = values.lines.reduce((s, l) => s + (parseFloat(l.unitPrice) || 0) * (parseInt(l.quantity) || 1), 0);

    logQuote.mutate(
      {
        id: rfqId,
        data: {
          supplierName: values.supplierName,
          supplierEmail: values.supplierEmail || undefined,
          totalAmount,
          currency: lines[0]?.currency || "SAR",
          notes: values.notes || undefined,
          lines,
        }
      },
      {
        onSuccess: () => {
          toast.success("Supplier quote logged");
          onSaved();
        },
        onError: () => toast.error("Failed to log quote")
      }
    );
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Log Supplier Quote</DialogTitle>
          <DialogDescription>Record pricing received from a supplier.</DialogDescription>
        </DialogHeader>

        {/* Tab switcher */}
        <div className="flex border border-border rounded-lg overflow-hidden shrink-0">
          <button
            type="button"
            className={`flex-1 text-xs py-2 px-3 font-medium transition-colors ${tab === "manual" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"}`}
            onClick={() => setTab("manual")}
          >
            Manual Entry
          </button>
          <button
            type="button"
            className={`flex-1 text-xs py-2 px-3 font-medium transition-colors flex items-center justify-center gap-1.5 ${tab === "paste" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"}`}
            onClick={() => setTab("paste")}
          >
            <ClipboardPaste className="w-3 h-3" /> Paste Supplier Email (AI)
          </button>
        </div>

        {tab === "paste" ? (
          <div className="flex flex-col gap-3 flex-1">
            <Textarea
              className="flex-1 min-h-[240px] text-xs font-mono resize-none"
              placeholder="Paste the supplier's reply email here. AI will extract pricing, lead times, and product details automatically…"
              value={pasteText}
              onChange={e => setPasteText(e.target.value)}
            />
            <div className="flex justify-between items-center gap-2">
              <p className="text-xs text-muted-foreground">
                The parsed data will pre-fill the manual entry form for your review.
              </p>
              <Button onClick={handleParseEmail} disabled={!pasteText.trim() || parsing}>
                {parsing ? (
                  <><RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Parsing...</>
                ) : (
                  <><Bot className="w-3.5 h-3.5 mr-1.5" /> Parse with AI</>
                )}
              </Button>
            </div>
          </div>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4 overflow-y-auto flex-1">
              <div className="grid grid-cols-2 gap-3">
                <FormField control={form.control} name="supplierName" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Supplier Name *</FormLabel>
                    <FormControl><Input {...field} placeholder="e.g. Sigma-Aldrich" required /></FormControl>
                  </FormItem>
                )} />
                <FormField control={form.control} name="supplierEmail" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Supplier Email</FormLabel>
                    <FormControl><Input {...field} type="email" placeholder="supplier@example.com" /></FormControl>
                  </FormItem>
                )} />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Line Items</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => append({ productName: "", unitPrice: "", quantity: "1", currency: "SAR" })}
                  >
                    <Plus className="w-3 h-3 mr-1" /> Add Line
                  </Button>
                </div>

                {fields.map((field, index) => (
                  <div key={field.id} className="grid grid-cols-12 gap-2 items-end">
                    <div className="col-span-5">
                      <FormField control={form.control} name={`lines.${index}.productName`} render={({ field }) => (
                        <FormItem>
                          {index === 0 && <FormLabel className="text-xs">Product</FormLabel>}
                          <FormControl><Input {...field} className="h-8 text-xs" placeholder="Product name" /></FormControl>
                        </FormItem>
                      )} />
                    </div>
                    <div className="col-span-3">
                      <FormField control={form.control} name={`lines.${index}.unitPrice`} render={({ field }) => (
                        <FormItem>
                          {index === 0 && <FormLabel className="text-xs">Unit Price</FormLabel>}
                          <FormControl><Input {...field} type="number" step="0.01" className="h-8 text-xs" placeholder="0.00" /></FormControl>
                        </FormItem>
                      )} />
                    </div>
                    <div className="col-span-2">
                      <FormField control={form.control} name={`lines.${index}.currency`} render={({ field }) => (
                        <FormItem>
                          {index === 0 && <FormLabel className="text-xs">Currency</FormLabel>}
                          <FormControl><Input {...field} className="h-8 text-xs" placeholder="SAR" /></FormControl>
                        </FormItem>
                      )} />
                    </div>
                    <div className="col-span-2 flex justify-end">
                      {index === 0 && <div className="text-xs text-transparent mb-2">del</div>}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        onClick={() => remove(index)}
                        disabled={fields.length === 1}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>

              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes</FormLabel>
                  <FormControl>
                    <Textarea {...field} className="text-sm min-h-[60px]" placeholder="Any terms, conditions, or notes from the supplier…" />
                  </FormControl>
                </FormItem>
              )} />

              <DialogFooter className="pt-2 shrink-0">
                <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
                <Button type="submit" disabled={logQuote.isPending}>
                  {logQuote.isPending ? "Saving…" : "Save Quote"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Comparison Modal ──────────────────────────────────────────────────────────

function ComparisonModal({ isOpen, rfqId, onClose }: { isOpen: boolean; rfqId: number; onClose: () => void }) {
  const { data, isLoading, error, refetch, isFetching } = useCompareSupplierQuotes(rfqId, {
    query: { queryKey: getCompareSupplierQuotesQueryKey(rfqId), enabled: isOpen }
  });

  const supplierNames = data?.quotes?.map(q => q.supplierName) ?? [];

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Supplier Quote Comparison</DialogTitle>
          <DialogDescription>
            AI-powered analysis with{data?.landedCostBufferPercent !== undefined ? ` ${data.landedCostBufferPercent}%` : ""} landed cost buffer (freight/customs/duties).
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto">
          {(isLoading || isFetching) && (
            <div className="space-y-3 p-2">
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          )}

          {error && (
            <div className="p-4 text-destructive text-sm">
              Failed to load comparison. Make sure at least one supplier quote is logged.
            </div>
          )}

          {data && !isFetching && (
            <div className="space-y-5 p-1">
              {/* Summary table */}
              {data.quotes && data.quotes.length > 0 && (
                <div>
                  <div className="text-xs text-muted-foreground font-semibold uppercase tracking-widest mb-2">Quote Summary</div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-xs text-muted-foreground uppercase tracking-wider">
                          <th className="text-left py-2 pr-4 font-medium">Supplier</th>
                          <th className="text-right py-2 pr-4 font-medium">Total</th>
                          <th className="text-right py-2 font-medium">Currency</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {data.quotes.map((q: any, qi: number) => (
                          <tr key={q.id} className={qi === 0 ? "bg-primary/5" : ""}>
                            <td className="py-2 pr-4">
                              <div className="font-medium flex items-center gap-2">
                                {q.supplierName}
                                {qi === 0 && (
                                  <Badge className="text-[9px] h-4 px-1.5 bg-primary text-primary-foreground">Lowest</Badge>
                                )}
                              </div>
                              {q.supplierEmail && <div className="text-xs text-muted-foreground">{q.supplierEmail}</div>}
                            </td>
                            <td className="py-2 pr-4 text-right font-mono font-semibold">
                              {Number(q.totalAmount).toLocaleString()}
                            </td>
                            <td className="py-2 text-right text-muted-foreground">{q.currency}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Per-product comparison table */}
              {data.comparison && data.comparison.length > 0 && (
                <div>
                  <div className="text-xs text-muted-foreground font-semibold uppercase tracking-widest mb-2">
                    Per-Product Comparison
                    {data.landedCostBufferPercent !== undefined && (
                      <span className="ml-2 text-primary font-normal">
                        (landed = cost × {(1 + data.landedCostBufferPercent / 100).toFixed(2)}x)
                      </span>
                    )}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border text-muted-foreground uppercase tracking-wider">
                          <th className="text-left py-2 pr-4 font-medium min-w-[180px]">Product</th>
                          {supplierNames.map(name => (
                            <th key={name} className="text-right py-2 px-2 font-medium min-w-[120px]" colSpan={2}>
                              {name}
                            </th>
                          ))}
                        </tr>
                        <tr className="border-b border-border text-muted-foreground">
                          <th className="text-left py-1 pr-4 text-[10px]"></th>
                          {supplierNames.map(name => (
                            <>
                              <th key={`${name}-cost`} className="text-right py-1 px-2 text-[10px] font-normal text-muted-foreground/70">Cost</th>
                              <th key={`${name}-landed`} className="text-right py-1 px-2 text-[10px] font-normal text-primary">Landed</th>
                            </>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {data.comparison.map((row: any, ri: number) => (
                          <tr key={ri} className="hover:bg-muted/20">
                            <td className="py-2 pr-4">
                              <div className="font-medium text-xs">{row.product}</div>
                              {row.catalogueNumber && <div className="text-[10px] text-muted-foreground">{row.catalogueNumber}</div>}
                            </td>
                            {row.supplierPrices.map((cell: any) => {
                              // Find the lowest landed price across suppliers
                              const lowestLanded = Math.min(
                                ...row.supplierPrices
                                  .filter((c: any) => c.landedUnitPrice)
                                  .map((c: any) => parseFloat(c.landedUnitPrice))
                              );
                              const isLowest = cell.landedUnitPrice && parseFloat(cell.landedUnitPrice) === lowestLanded;

                              return (
                                <>
                                  <td key={`${cell.supplier}-cost`} className="py-2 px-2 text-right font-mono text-muted-foreground">
                                    {cell.unitPrice ? Number(cell.unitPrice).toLocaleString() : "—"}
                                  </td>
                                  <td key={`${cell.supplier}-landed`} className={`py-2 px-2 text-right font-mono font-medium ${isLowest ? "text-primary" : ""}`}>
                                    {cell.landedUnitPrice ? Number(cell.landedUnitPrice).toLocaleString() : "—"}
                                    {cell.leadTimeDays && (
                                      <div className="text-[9px] text-muted-foreground font-normal">{cell.leadTimeDays}d</div>
                                    )}
                                  </td>
                                </>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* AI recommendation */}
              {data.recommendation && (
                <div className="bg-primary/5 border border-primary/20 rounded-lg p-4">
                  <div className="flex items-center gap-2 text-primary text-xs font-semibold mb-2 uppercase tracking-wider">
                    <Bot className="w-3.5 h-3.5" /> AI Recommendation
                  </div>
                  <p className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap">{data.recommendation}</p>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="flex justify-between items-center sm:justify-between gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${isFetching ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PipelineSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-6 gap-4">
        {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-20" />)}
      </div>
      <div className="flex gap-4 overflow-x-auto">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="min-w-[300px] space-y-3">
            <Skeleton className="h-6 w-20" />
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
        ))}
      </div>
    </div>
  );
}
