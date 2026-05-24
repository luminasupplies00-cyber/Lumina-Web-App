import { useEffect, useMemo, useState } from "react";
import {
  useDraftSupplierEmail,
  useGetSuggestedSuppliers,
  useGetSuppliers,
  useCreateSupplier,
  useBulkCreateSupplierContacts,
  useMarkDraftCopied,
  useGetSettings,
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
  Bot, Copy, Check, Download, ExternalLink, Globe, Plus, RefreshCw, Search, Sparkles, Star, Users,
} from "lucide-react";
import { toast } from "sonner";
import { downloadRfqExcel } from "@/lib/excelExport";
import { FindSuppliersOnlineModal } from "./FindSuppliersOnlineModal";

type Picked = { supplierId?: number; supplierName: string; supplierEmail: string };

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

  const { data: suggested } = useGetSuggestedSuppliers(rfqId);
  const { data: allSuppliers } = useGetSuppliers();
  const { data: settingsData } = useGetSettings();
  const suppliers = allSuppliers?.suppliers ?? [];

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
  // We keep the raw AI draft (containing the {{PRODUCTS_BLOCK}} placeholder)
  // separate from the user-visible body. Whenever format.block changes
  // (thresholds load, product count changes), the body is re-derived — but
  // only while the user hasn't manually edited it.
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

  // 1b. Re-inject the product block whenever the raw draft or the format
  // changes — unless the user has edited the body, in which case we leave
  // it alone (their edits win).
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
          // Replace adhoc entry with DB-backed entry
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

  const handleDownloadExcel = () => {
    const filename = downloadRfqExcel(
      {
        rfqId,
        customerName: rfq.customerName,
        customerCompany: rfq.customerCompany,
        deadline: rfq.deadline,
      },
      rfq.products ?? [],
    );
    toast.success(`Downloaded ${filename}`);
  };

  const handleCopyAndLog = async () => {
    const picks = Object.values(selected);
    if (picks.length === 0) {
      toast.error("Select at least one supplier");
      return;
    }

    // 1. Compose clipboard payload (subject + body + chosen emails)
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

    // 2. Mark the AI draft as copied (for analytics)
    if (draftId) markCopied.mutate({ draftId });

    // 3. Log every selected supplier as a contact
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

    // 4. Download the Excel automatically when this RFQ qualifies for an attachment
    if (format.includeExcel) {
      handleDownloadExcel();
    }
  };

  const productCount = format.productCount;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-6xl max-h-[92vh] flex flex-col p-0">
        <DialogHeader className="px-5 pt-4 pb-2">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Bot className="w-4 h-4" /> Source Suppliers — RFQ #{rfqId}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Edit the AI draft, pick suppliers, then copy &amp; send via Zoho.{" "}
            <span className="text-foreground">
              {productCount} product{productCount === 1 ? "" : "s"} · {FORMAT_LABEL[format.mode]}
            </span>
          </DialogDescription>
        </DialogHeader>

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
                  <span className="text-muted-foreground">— {productCount} products</span>
                </div>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleDownloadExcel}>
                  Download .xlsx
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

              {/* Ad-hoc additions selected but not in DB */}
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

        {/* FOOTER */}
        <div className="border-t border-border px-4 py-3 flex items-center justify-between gap-3 bg-sidebar">
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

          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => window.open("https://mail.zoho.com", "_blank")}>
              <ExternalLink className="w-3.5 h-3.5 mr-1.5" /> Open Zoho
            </Button>
            <Button onClick={handleCopyAndLog} disabled={Object.keys(selected).length === 0 || bulkCreate.isPending}>
              {copied ? <Check className="w-3.5 h-3.5 mr-1.5" /> : <Copy className="w-3.5 h-3.5 mr-1.5" />}
              {copied ? "Copied & logged" : "Copy & Log Contacts"}
            </Button>
          </div>
        </div>
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
