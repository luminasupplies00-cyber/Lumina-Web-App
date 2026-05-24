import { useEffect, useMemo, useRef, useState } from "react";
import {
  useDraftSupplierEmail,
  useGetSuggestedSuppliers,
  useGetSuppliers,
  useCreateSupplier,
  useBulkCreateSupplierContacts,
  useMarkDraftCopied,
  useGetSettings,
  useGetZohoAccounts,
  useSendZohoEmail,
} from "@workspace/api-client-react";
import {
  formatProductBlock,
  injectProductBlock,
  parseThresholds,
  type FormatMode,
} from "@/lib/rfqFormatRules";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Bot, Copy, Check, Download, ExternalLink, Globe, Plus, RefreshCw, Search,
  Send, Sparkles, Star, Users, AlertTriangle, Loader2, X,
} from "lucide-react";
import { toast } from "sonner";
import { downloadRfqExcel, buildRfqExcelBase64 } from "@/lib/excelExport";
import { FindSuppliersOnlineModal } from "./FindSuppliersOnlineModal";

type Picked = { supplierId?: number; supplierName: string; supplierEmail: string };

type SendRowStatus = "pending" | "sending" | "sent" | "failed" | "skipped";
type SendRow = Picked & {
  key: string;
  status: SendRowStatus;
  error?: string;
  sentAt?: string;
};

type Props = {
  isOpen: boolean;
  rfqId: number;
  rfq: any;
  onClose: () => void;
};

export function SupplierOutreachModal({ isOpen, rfqId, rfq, onClose }: Props) {
  const queryClient = useQueryClient();
  const draftSupplier = useDraftSupplierEmail();
  const bulkCreate = useBulkCreateSupplierContacts();
  const markCopied = useMarkDraftCopied();
  const createSupplier = useCreateSupplier();
  const sendEmail = useSendZohoEmail();

  const { data: suggested } = useGetSuggestedSuppliers(rfqId);
  const { data: allSuppliers } = useGetSuppliers();
  const { data: settingsData } = useGetSettings();
  const { data: zohoAccountsData } = useGetZohoAccounts();
  const suppliers = allSuppliers?.suppliers ?? [];
  const zohoAccounts = zohoAccountsData?.accounts ?? [];

  const thresholds = useMemo(
    () => parseThresholds(settingsData?.settings as Record<string, string> | undefined),
    [settingsData],
  );
  const format = useMemo(
    () => formatProductBlock(rfq.products ?? [], thresholds),
    [rfq.products, thresholds],
  );
  const FORMAT_LABEL: Record<FormatMode, string> = {
    "table-only": "Inline table only",
    "table-with-excel": "Inline table + Excel attachment",
    "summary-with-excel": "Brief summary + Excel attachment",
  };

  const [subject, setSubject] = useState(
    rfq.emailSubject ? `RE: ${rfq.emailSubject} — Quote Request` : `Quote Request — RFQ #${rfqId}`,
  );
  const [rawDraft, setRawDraft] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [bodyEdited, setBodyEdited] = useState(false);
  const [draftId, setDraftId] = useState<number | undefined>(undefined);
  const [mode, setMode] = useState<"separate" | "bcc">("separate");
  const [selected, setSelected] = useState<Record<string, Picked>>({});
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState<string | null>(null);
  const [showAddInline, setShowAddInline] = useState(false);
  const [showFindOnline, setShowFindOnline] = useState(false);
  const [adhoc, setAdhoc] = useState({ name: "", email: "" });
  const [copied, setCopied] = useState(false);
  const [accountId, setAccountId] = useState<number | null>(null);

  // Send-queue state. `queueCancelled` drives the UI ("Cancel remaining"
  // button label/disabled) while `cancelRef` is what the async loop reads on
  // each iteration — state captured in a closure would be stale.
  const [sendQueue, setSendQueue] = useState<SendRow[] | null>(null);
  const [queueCancelled, setQueueCancelled] = useState(false);
  const cancelRef = useRef(false);

  // 1. Generate the AI draft on open (once per open/rfq)
  useEffect(() => {
    if (!isOpen || rawDraft !== null) return;
    draftSupplier.mutate(
      { id: rfqId },
      {
        onSuccess: (res) => {
          setRawDraft(res.draft);
          setDraftId(res.draftId ?? undefined);
        },
        onError: () => toast.error("Failed to draft supplier email"),
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, rfqId]);

  useEffect(() => {
    if (rawDraft === null || bodyEdited) return;
    setBody(injectProductBlock(rawDraft, format.block));
  }, [rawDraft, format.block, bodyEdited]);

  // 2. Pre-select suggested suppliers once they load
  useEffect(() => {
    if (!suggested?.suppliers || !isOpen) return;
    if (Object.keys(selected).length > 0) return;
    const pre: Record<string, Picked> = {};
    for (const s of suggested.suppliers.slice(0, 5)) {
      const key = `id:${s.id}`;
      pre[key] = { supplierId: s.id, supplierName: s.company, supplierEmail: s.email };
    }
    setSelected(pre);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggested, isOpen]);

  // 3. Pick a default Zoho account once the list loads.
  useEffect(() => {
    if (accountId !== null || zohoAccounts.length === 0) return;
    const settings = (settingsData?.settings ?? {}) as Record<string, string>;
    const defaultLabel = settings["DEFAULT_SUPPLIER_EMAIL_ACCOUNT"];
    const writable = zohoAccounts.filter((a: any) => a.hasWriteScope);
    const pool = writable.length > 0 ? writable : zohoAccounts;
    const byLabel = defaultLabel
      ? pool.find((a: any) => a.accountLabel?.toLowerCase() === defaultLabel.toLowerCase())
      : null;
    const procurement = pool.find((a: any) => a.accountLabel?.toLowerCase() === "procurement");
    const fallback = pool[0];
    const picked = byLabel ?? procurement ?? fallback;
    if (picked) setAccountId(picked.id);
  }, [accountId, zohoAccounts, settingsData]);

  // Reset send state when the modal closes.
  useEffect(() => {
    if (!isOpen) {
      setSendQueue(null);
      setQueueCancelled(false);
      cancelRef.current = false;
    }
  }, [isOpen]);

  const allCategories = useMemo(() => {
    const set = new Set<string>();
    for (const s of suppliers) for (const c of s.categories ?? []) set.add(c.category);
    return Array.from(set).sort();
  }, [suppliers]);

  const filteredSuppliers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return suppliers.filter((s) => {
      if (q && ![s.company, s.name, s.email].some((v) => v.toLowerCase().includes(q))) return false;
      if (filterCategory && !(s.categories ?? []).some((c) => c.category === filterCategory)) return false;
      return true;
    });
  }, [suppliers, search, filterCategory]);

  const suggestedIds = new Set((suggested?.suppliers ?? []).map((s) => s.id));
  const selectedAccount = zohoAccounts.find((a: any) => a.id === accountId);
  const canSend = !!selectedAccount?.hasWriteScope;

  const toggle = (key: string, p: Picked) =>
    setSelected((prev) => {
      const next = { ...prev };
      if (next[key]) delete next[key];
      else next[key] = p;
      return next;
    });

  const handleAddAdhoc = () => {
    if (!adhoc.name.trim() || !adhoc.email.trim()) {
      toast.error("Name and email required");
      return;
    }
    const key = `adhoc:${adhoc.email.toLowerCase().trim()}`;
    setSelected((prev) => ({
      ...prev,
      [key]: { supplierName: adhoc.name.trim(), supplierEmail: adhoc.email.trim() },
    }));
    setAdhoc({ name: "", email: "" });
    setShowAddInline(false);
    toast.success("Added to outreach list");
  };

  const handleSaveAdhocToDb = (picked: Picked) => {
    createSupplier.mutate(
      {
        data: {
          name: picked.supplierName,
          company: picked.supplierName,
          email: picked.supplierEmail,
          country: "SA",
          currency: "SAR",
        },
      },
      {
        onSuccess: (res) => {
          const oldKey = `adhoc:${picked.supplierEmail.toLowerCase()}`;
          const newKey = `id:${res.supplier.id}`;
          setSelected((prev) => {
            const next = { ...prev };
            delete next[oldKey];
            next[newKey] = { ...picked, supplierId: res.supplier.id };
            return next;
          });
          toast.success("Saved to suppliers database");
        },
      },
    );
  };

  const excelMeta = {
    rfqId,
    customerName: rfq.customerName,
    customerCompany: rfq.customerCompany,
    deadline: rfq.deadline,
  };

  const handleDownloadExcel = () => {
    const filename = downloadRfqExcel(excelMeta, rfq.products ?? []);
    toast.success(`Downloaded ${filename}`);
  };

  // ─── Copy & log (kept as secondary action) ─────────────────────────────────
  const handleCopyAndLog = async () => {
    const picks = Object.values(selected);
    if (picks.length === 0) {
      toast.error("Select at least one supplier");
      return;
    }
    const emailList = picks.map((p) => p.supplierEmail).join(", ");
    const header = mode === "bcc"
      ? `To: <yourself>\nBcc: ${emailList}\n`
      : `To: ${emailList}\n(Send each recipient separately in Zoho)\n`;
    const footer = format.includeExcel
      ? "\n\n— Attach the Excel file downloaded alongside this email."
      : "";
    const clipboard = `${header}Subject: ${subject}\n\n${body}${footer}`;
    try {
      await navigator.clipboard.writeText(clipboard);
    } catch {
      toast.error("Clipboard write failed");
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2200);
    if (draftId) markCopied.mutate({ draftId });
    bulkCreate.mutate(
      {
        id: rfqId,
        data: {
          contactMode: mode,
          ...(draftId && { emailDraftId: draftId }),
          contacts: picks.map((p) => ({
            supplierId: p.supplierId,
            supplierName: p.supplierName,
            supplierEmail: p.supplierEmail,
            contactMode: mode,
          })),
        },
      },
      {
        onSuccess: () => {
          toast.success(`Logged ${picks.length} supplier contact${picks.length === 1 ? "" : "s"}`);
          queryClient.invalidateQueries({ queryKey: ["/api/rfq"] });
        },
        onError: () => toast.error("Failed to log supplier contacts"),
      },
    );
    if (format.includeExcel) handleDownloadExcel();
  };

  // ─── SEND VIA ZOHO ─────────────────────────────────────────────────────────
  // Build the attachment payload once per send batch — same workbook for every
  // supplier in the queue.
  const buildAttachment = () => {
    if (!format.includeExcel) return undefined;
    const { filename, base64, contentType } = buildRfqExcelBase64(excelMeta, rfq.products ?? []);
    return { filename, base64, contentType };
  };

  // 1. Create the supplier-contact rows first, then drive the send queue from
  //    the returned ids. This keeps tracking consistent even if a send fails
  //    mid-batch — the contact row already exists.
  const handleSendViaZoho = async () => {
    const picks = Object.values(selected);
    if (picks.length === 0) {
      toast.error("Select at least one supplier");
      return;
    }
    if (!accountId) {
      toast.error("Pick a Zoho account to send from");
      return;
    }
    if (!canSend) {
      toast.error("This Zoho account needs reconnection to grant send permission");
      return;
    }

    let createdContacts: Array<{ id: number; supplierEmail: string }> = [];
    try {
      const res = await bulkCreate.mutateAsync({
        id: rfqId,
        data: {
          contactMode: mode,
          ...(draftId && { emailDraftId: draftId }),
          contacts: picks.map((p) => ({
            supplierId: p.supplierId,
            supplierName: p.supplierName,
            supplierEmail: p.supplierEmail,
            contactMode: mode,
          })),
        },
      });
      createdContacts = (res.contacts ?? []).map((c: any) => ({
        id: c.id,
        supplierEmail: (c.supplierEmail ?? "").toLowerCase(),
      }));
    } catch {
      toast.error("Failed to log supplier contacts — send aborted");
      return;
    }

    const findContactId = (email: string): number | undefined =>
      createdContacts.find((c) => c.supplierEmail === email.toLowerCase())?.id;

    const attachment = buildAttachment();
    setQueueCancelled(false);
    cancelRef.current = false;

    if (mode === "bcc") {
      // Single send — first supplier as To, rest as BCC.
      const [first, ...rest] = picks;
      if (!first) return;
      const queue: SendRow[] = picks.map((p) => ({
        ...p,
        key: `${p.supplierId ?? "adhoc"}:${p.supplierEmail}`,
        status: "sending",
      }));
      setSendQueue(queue);

      const contactIds = picks
        .map((p) => findContactId(p.supplierEmail))
        .filter((v): v is number => typeof v === "number");
      try {
        const result = await sendEmail.mutateAsync({
          data: {
            accountId,
            to: first.supplierEmail,
            ...(rest.length > 0 && { bcc: rest.map((p) => p.supplierEmail).join(", ") }),
            subject,
            body,
            mailFormat: "plaintext",
            rfqId,
            ...(draftId && { draftId }),
            contactIds,
            ...(attachment && { attachment }),
          },
        });
        const now = result.sentAt ?? new Date().toISOString();
        setSendQueue(queue.map((r) => ({ ...r, status: "sent", sentAt: now })));
        toast.success(`Sent to ${picks.length} supplier${picks.length === 1 ? "" : "s"} (BCC)`);
      } catch (err: any) {
        const message = err?.response?.data?.error ?? err?.message ?? "Send failed";
        setSendQueue(queue.map((r) => ({ ...r, status: "failed", error: message })));
        toast.error(message, { duration: 8000 });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/rfq"] });
      return;
    }

    // Separate mode — one send per supplier.
    const initial: SendRow[] = picks.map((p) => ({
      ...p,
      key: `${p.supplierId ?? "adhoc"}:${p.supplierEmail}`,
      status: "pending",
    }));
    setSendQueue(initial);

    // Track results in a local accumulator — `sendQueue` state inside this
    // async closure is always stale and unsafe for counting.
    let sentLocal = 0;
    let failedLocal = 0;
    let skippedLocal = 0;
    for (let i = 0; i < picks.length; i++) {
      if (cancelRef.current) {
        setSendQueue((prev) =>
          (prev ?? initial).map((r, idx) => (idx >= i && r.status === "pending" ? { ...r, status: "skipped" } : r)),
        );
        skippedLocal += picks.length - i;
        break;
      }
      const p = picks[i]!;
      setSendQueue((prev) =>
        (prev ?? initial).map((r, idx) => (idx === i ? { ...r, status: "sending" } : r)),
      );
      const cid = findContactId(p.supplierEmail);
      try {
        const result = await sendEmail.mutateAsync({
          data: {
            accountId,
            to: p.supplierEmail,
            subject,
            body,
            mailFormat: "plaintext",
            rfqId,
            ...(draftId && { draftId }),
            ...(cid && { contactIds: [cid] }),
            ...(attachment && { attachment }),
          },
        });
        sentLocal += 1;
        const now = result.sentAt ?? new Date().toISOString();
        setSendQueue((prev) =>
          (prev ?? initial).map((r, idx) => (idx === i ? { ...r, status: "sent", sentAt: now } : r)),
        );
      } catch (err: any) {
        failedLocal += 1;
        const message = err?.response?.data?.error ?? err?.message ?? "Send failed";
        setSendQueue((prev) =>
          (prev ?? initial).map((r, idx) => (idx === i ? { ...r, status: "failed", error: message } : r)),
        );
      }
    }

    queryClient.invalidateQueries({ queryKey: ["/api/rfq"] });

    // Honest summary based on the local accumulator, not React state.
    if (sentLocal > 0 && failedLocal === 0 && skippedLocal === 0) {
      toast.success(`Sent ${sentLocal} supplier email${sentLocal === 1 ? "" : "s"} via Zoho`);
    } else if (sentLocal > 0) {
      toast.warning(
        `Sent ${sentLocal} of ${picks.length} — ${failedLocal} failed${skippedLocal ? `, ${skippedLocal} skipped` : ""}`,
        { duration: 8000 },
      );
    } else if (failedLocal > 0) {
      toast.error(`All ${failedLocal} send${failedLocal === 1 ? "" : "s"} failed`, { duration: 8000 });
    }
  };

  const productCount = format.productCount;

  // Send-queue view (replaces composer when active).
  const sentCount = sendQueue?.filter((r) => r.status === "sent").length ?? 0;
  const totalQueue = sendQueue?.length ?? 0;
  const sendingIndex = sendQueue?.findIndex((r) => r.status === "sending") ?? -1;
  const queueDone = sendQueue !== null && sendQueue.every((r) => r.status !== "pending" && r.status !== "sending");

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-6xl max-h-[92vh] flex flex-col p-0">
        <DialogHeader className="px-5 pt-4 pb-2">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Bot className="w-4 h-4" /> Source Suppliers — RFQ #{rfqId}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Edit the AI draft, pick suppliers, then send via Zoho Mail.{" "}
            <span className="text-foreground">
              {productCount} product{productCount === 1 ? "" : "s"} · {FORMAT_LABEL[format.mode]}
            </span>
          </DialogDescription>
        </DialogHeader>

        {sendQueue ? (
          // ─── SEND PROGRESS VIEW ──────────────────────────────────────────────
          <div className="flex-1 overflow-y-auto p-5 border-t border-border">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-semibold">
                {queueDone
                  ? `Done — ${sentCount} of ${totalQueue} sent`
                  : `Sending ${Math.max(sendingIndex + 1, 1)} of ${totalQueue}…`}
              </div>
              {!queueDone && mode === "separate" && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => {
                    cancelRef.current = true;
                    setQueueCancelled(true);
                  }}
                >
                  Cancel remaining
                </Button>
              )}
            </div>
            <div className="space-y-1.5">
              {sendQueue.map((r) => (
                <div
                  key={r.key}
                  className={`flex items-center gap-3 p-2.5 rounded border text-xs ${
                    r.status === "sent" ? "border-green-500/30 bg-green-500/5"
                    : r.status === "failed" ? "border-destructive/40 bg-destructive/5"
                    : r.status === "sending" ? "border-primary/40 bg-primary/5"
                    : r.status === "skipped" ? "border-border bg-muted/20 opacity-60"
                    : "border-border bg-card"
                  }`}
                >
                  <div className="w-4 h-4 flex items-center justify-center shrink-0">
                    {r.status === "sent" && <Check className="w-4 h-4 text-green-500" />}
                    {r.status === "failed" && <X className="w-4 h-4 text-destructive" />}
                    {r.status === "sending" && <Loader2 className="w-4 h-4 animate-spin text-primary" />}
                    {r.status === "skipped" && <span className="text-muted-foreground text-[10px]">—</span>}
                    {r.status === "pending" && <span className="w-2 h-2 rounded-full bg-muted-foreground/40" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{r.supplierName}</div>
                    <div className="font-mono text-[10px] text-muted-foreground truncate">{r.supplierEmail}</div>
                    {r.error && (
                      <div className="text-[10px] text-destructive mt-0.5 truncate" title={r.error}>{r.error}</div>
                    )}
                  </div>
                  {r.sentAt && (
                    <div className="text-[10px] text-muted-foreground shrink-0 font-mono">
                      {new Date(r.sentAt).toLocaleTimeString()}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {queueDone && (
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setSendQueue(null)}>
                  Back to composer
                </Button>
                <Button size="sm" onClick={onClose}>Done</Button>
              </div>
            )}
          </div>
        ) : (
          // ─── COMPOSER VIEW ───────────────────────────────────────────────────
          <div className="flex-1 grid grid-cols-5 gap-0 overflow-hidden border-t border-border">
            {/* LEFT — email composer */}
            <div className="col-span-3 flex flex-col p-4 gap-2 overflow-hidden border-r border-border">
              <div>
                <label className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Subject</label>
                <Input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="h-8 text-sm mt-0.5"
                />
              </div>
              <div className="flex-1 flex flex-col overflow-hidden">
                <div className="flex items-center justify-between mt-1">
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Email body</label>
                  {draftSupplier.isPending && (
                    <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                      <RefreshCw className="w-3 h-3 animate-spin" /> Drafting…
                    </span>
                  )}
                </div>
                <Textarea
                  value={body}
                  onChange={(e) => {
                    setBody(e.target.value);
                    setBodyEdited(true);
                  }}
                  placeholder="AI draft will appear here…"
                  className="flex-1 mt-0.5 font-mono text-xs leading-relaxed resize-none"
                />
              </div>

              {format.includeExcel ? (
                <div className="flex items-center justify-between bg-muted/40 border border-border rounded p-2">
                  <div className="flex items-center gap-2 text-xs">
                    <Download className="w-3.5 h-3.5 text-primary" />
                    <span className="font-medium">Excel attachment</span>
                    <span className="text-muted-foreground">— {productCount} products · auto-attached on send</span>
                  </div>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleDownloadExcel}>
                    Preview .xlsx
                  </Button>
                </div>
              ) : (
                <div className="text-[11px] text-muted-foreground italic px-1">
                  Short list — products are shown inline in the email body. No attachment needed.
                </div>
              )}
            </div>

            {/* RIGHT — supplier selector */}
            <div className="col-span-2 flex flex-col overflow-hidden">
              <div className="px-3 pt-3 pb-2 space-y-2 border-b border-border">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold flex items-center gap-1.5">
                    <Users className="w-3.5 h-3.5" /> Suppliers
                    <Badge variant="secondary" className="text-[9px] h-4 px-1.5">
                      {Object.keys(selected).length} selected
                    </Badge>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-[11px] text-primary"
                    onClick={() => setShowFindOnline(true)}
                  >
                    <Globe className="w-3 h-3 mr-1" /> Find online
                  </Button>
                </div>
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search…"
                    className="h-7 pl-7 text-xs"
                  />
                </div>
                {allCategories.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    <button
                      onClick={() => setFilterCategory(null)}
                      className={`text-[9px] px-1.5 py-0.5 rounded border ${filterCategory === null ? "bg-primary/20 border-primary/40 text-primary" : "border-border text-muted-foreground hover:bg-muted/50"}`}
                    >
                      All
                    </button>
                    {allCategories.slice(0, 8).map((c) => (
                      <button
                        key={c}
                        onClick={() => setFilterCategory(c === filterCategory ? null : c)}
                        className={`text-[9px] px-1.5 py-0.5 rounded border ${filterCategory === c ? "bg-primary/20 border-primary/40 text-primary" : "border-border text-muted-foreground hover:bg-muted/50"}`}
                      >
                        {c.replace(/&/g, "&")}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex-1 overflow-y-auto p-2 space-y-1">
                {suggested?.suppliers && suggested.suppliers.length > 0 && !search && !filterCategory && (
                  <div className="text-[9px] uppercase tracking-wider text-muted-foreground px-1.5 py-1 font-semibold flex items-center gap-1">
                    <Sparkles className="w-2.5 h-2.5" /> Suggested for these products
                  </div>
                )}
                {filteredSuppliers.map((s) => {
                  const key = `id:${s.id}`;
                  const isSelected = !!selected[key];
                  const isSuggested = suggestedIds.has(s.id);
                  const isPreferred = (s.categories ?? []).some((c) => c.isPreferred);
                  const rate = s.responseRatePercent;
                  return (
                    <button
                      key={s.id}
                      onClick={() => toggle(key, { supplierId: s.id, supplierName: s.company, supplierEmail: s.email })}
                      className={`w-full text-left p-2 rounded border flex items-start gap-2 transition-colors ${isSelected ? "bg-primary/10 border-primary/40" : "bg-card border-border hover:border-primary/30"}`}
                    >
                      <Checkbox checked={isSelected} className="mt-0.5 pointer-events-none" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1 text-xs font-medium truncate">
                          {s.company}
                          {isPreferred && <Star className="w-2.5 h-2.5 text-amber-400 fill-amber-400 shrink-0" />}
                          {isSuggested && (
                            <Badge variant="secondary" className="text-[8px] h-3.5 px-1 bg-primary/15 text-primary border-primary/30">match</Badge>
                          )}
                        </div>
                        <div className="text-[10px] text-muted-foreground truncate font-mono">{s.email}</div>
                        <div className="flex gap-2 text-[9px] text-muted-foreground mt-0.5">
                          {typeof rate === "number" && <span>{rate}% reply</span>}
                          {(s.totalContacts ?? 0) > 0 && <span>{s.totalResponses ?? 0}/{s.totalContacts} responded</span>}
                          {s.typicalLeadTimeDays && <span>~{s.typicalLeadTimeDays}d lead</span>}
                        </div>
                      </div>
                    </button>
                  );
                })}

                {filteredSuppliers.length === 0 && (
                  <div className="text-[11px] text-muted-foreground text-center py-4">
                    No suppliers match your filter.
                  </div>
                )}

                {Object.entries(selected)
                  .filter(([k]) => k.startsWith("adhoc:"))
                  .map(([k, p]) => (
                    <div key={k} className="p-2 rounded border border-amber-500/30 bg-amber-500/5 flex items-start gap-2">
                      <Checkbox checked className="mt-0.5" onClick={() => toggle(k, p)} />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium truncate">{p.supplierName}</div>
                        <div className="text-[10px] text-muted-foreground truncate font-mono">{p.supplierEmail}</div>
                      </div>
                      <button
                        onClick={() => handleSaveAdhocToDb(p)}
                        className="text-[10px] text-primary hover:underline shrink-0"
                      >
                        Save to DB
                      </button>
                    </div>
                  ))}
              </div>

              <div className="border-t border-border p-2">
                {showAddInline ? (
                  <div className="space-y-1.5">
                    <Input
                      placeholder="Supplier company"
                      value={adhoc.name}
                      onChange={(e) => setAdhoc({ ...adhoc, name: e.target.value })}
                      className="h-7 text-xs"
                    />
                    <Input
                      placeholder="email@example.com"
                      value={adhoc.email}
                      onChange={(e) => setAdhoc({ ...adhoc, email: e.target.value })}
                      className="h-7 text-xs font-mono"
                    />
                    <div className="flex gap-1.5">
                      <Button size="sm" className="flex-1 h-7 text-xs" onClick={handleAddAdhoc}>Add</Button>
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShowAddInline(false)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <Button size="sm" variant="ghost" className="w-full h-7 text-xs text-muted-foreground" onClick={() => setShowAddInline(true)}>
                    <Plus className="w-3 h-3 mr-1" /> Add ad-hoc supplier
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* FOOTER */}
        {!sendQueue && (
          <div className="border-t border-border px-4 py-3 flex items-center justify-between gap-3 bg-sidebar flex-wrap">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-1 border border-border rounded-md p-0.5 bg-card">
                <button
                  onClick={() => setMode("separate")}
                  className={`text-[11px] px-2 py-1 rounded ${mode === "separate" ? "bg-primary/20 text-primary font-semibold" : "text-muted-foreground hover:text-foreground"}`}
                  title="Send a separate email to each supplier (recommended)"
                >
                  Separate emails
                </button>
                <button
                  onClick={() => setMode("bcc")}
                  className={`text-[11px] px-2 py-1 rounded ${mode === "bcc" ? "bg-primary/20 text-primary font-semibold" : "text-muted-foreground hover:text-foreground"}`}
                  title="Send one email with all suppliers as BCC"
                >
                  Single BCC
                </button>
              </div>

              <div className="flex items-center gap-1.5">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">From</span>
                {zohoAccounts.length === 0 ? (
                  <span className="text-[11px] text-amber-400 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" /> No Zoho account connected
                  </span>
                ) : (
                  <Select
                    value={accountId ? String(accountId) : ""}
                    onValueChange={(v) => setAccountId(parseInt(v))}
                  >
                    <SelectTrigger className="h-7 text-xs w-[200px]">
                      <SelectValue placeholder="Pick account" />
                    </SelectTrigger>
                    <SelectContent>
                      {zohoAccounts.map((a: any) => (
                        <SelectItem key={a.id} value={String(a.id)} className="text-xs">
                          <span className="flex items-center gap-1.5">
                            <span className="font-medium">{a.accountLabel}</span>
                            <span className="text-muted-foreground">— {a.email}</span>
                            {!a.hasWriteScope && (
                              <span className="text-[9px] text-amber-400">(read-only)</span>
                            )}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              {selectedAccount && !canSend && (
                <a
                  href="/settings"
                  className="text-[11px] text-amber-400 hover:underline flex items-center gap-1"
                  title="This account is missing the send scope. Reconnect from Settings."
                >
                  <AlertTriangle className="w-3 h-3" /> Reconnect for send
                </a>
              )}
              <Button variant="outline" size="sm" onClick={handleCopyAndLog} disabled={Object.keys(selected).length === 0 || bulkCreate.isPending}>
                {copied ? <Check className="w-3.5 h-3.5 mr-1.5" /> : <Copy className="w-3.5 h-3.5 mr-1.5" />}
                {copied ? "Copied" : "Copy & Log"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => window.open("https://mail.zoho.com", "_blank")}>
                <ExternalLink className="w-3.5 h-3.5 mr-1.5" /> Open Zoho
              </Button>
              <Button
                onClick={handleSendViaZoho}
                disabled={
                  Object.keys(selected).length === 0 ||
                  !accountId ||
                  !canSend ||
                  bulkCreate.isPending ||
                  sendEmail.isPending
                }
              >
                <Send className="w-3.5 h-3.5 mr-1.5" />
                Send via Zoho
              </Button>
            </div>
          </div>
        )}
      </DialogContent>

      {showFindOnline && (
        <FindSuppliersOnlineModal
          isOpen
          rfqId={rfqId}
          onClose={() => setShowFindOnline(false)}
          onPicked={(p) => {
            const key = p.supplierId ? `id:${p.supplierId}` : `adhoc:${p.supplierEmail.toLowerCase()}`;
            setSelected((prev) => ({ ...prev, [key]: p }));
          }}
        />
      )}
    </Dialog>
  );
}
