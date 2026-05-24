import { useState } from "react";
import {
  useFindSuppliersOnline,
  useSummarizeSupplierWebsite,
  useCreateSupplier,
} from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Globe, RefreshCw, ExternalLink, Plus, Check, Sparkles } from "lucide-react";
import { toast } from "sonner";

/** Only allow http/https URLs — guards against javascript:/data: from AI output. */
function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
  } catch {
    // not a parseable URL
  }
  return null;
}

type Result = {
  name: string;
  website: string | null;
  email: string | null;
  country: string | null;
  relevance: string | null;
  offerings: string | null;
};

type Picked = { supplierId?: number; supplierName: string; supplierEmail: string };

export function FindSuppliersOnlineModal({
  isOpen,
  rfqId,
  onClose,
  onPicked,
}: {
  isOpen: boolean;
  rfqId: number;
  onClose: () => void;
  /** Called when the user clicks "Select for RFQ" on a result. */
  onPicked?: (picked: Picked) => void;
}) {
  const find = useFindSuppliersOnline();
  const summarize = useSummarizeSupplierWebsite();
  const create = useCreateSupplier();

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [citations, setCitations] = useState<string[]>([]);
  const [summary, setSummary] = useState<{ url: string; text: string } | null>(null);
  const [added, setAdded] = useState<Record<string, number>>({});
  const [picked, setPicked] = useState<Record<string, boolean>>({});

  const handleSearch = () => {
    find.mutate(
      { id: rfqId, data: query.trim() ? { query: query.trim() } : {} },
      {
        onSuccess: (res) => {
          setResults((res.results as Result[]) ?? []);
          setCitations(res.citations ?? []);
          if (!query.trim() && res.query) setQuery(res.query);
          if ((res.results ?? []).length === 0) {
            toast.warning("No results — try refining the search.");
          }
        },
        onError: (err: any) => toast.error(err?.response?.data?.error || "Search failed"),
      }
    );
  };

  const handleBrowse = (r: Result) => {
    if (!r.website) return;
    summarize.mutate(
      { data: { url: r.website, supplierName: r.name } },
      {
        onSuccess: (res) => setSummary({ url: r.website!, text: res.summary }),
        onError: () => toast.error("Failed to summarise website"),
      }
    );
  };

  const handleAddToDb = (r: Result) => {
    if (!r.email) {
      toast.error("No email available — cannot add to database");
      return;
    }
    create.mutate(
      {
        data: {
          name: r.name,
          company: r.name,
          email: r.email,
          country: r.country || "SA",
          currency: "SAR",
          notes: r.relevance || undefined,
        },
      },
      {
        onSuccess: (res) => {
          setAdded((p) => ({ ...p, [r.name]: res.supplier.id }));
          toast.success(`Added ${r.name} to suppliers DB`);
        },
        onError: () => toast.error("Failed to add supplier"),
      }
    );
  };

  const handlePick = (r: Result) => {
    if (!r.email) {
      toast.error("No email — cannot select for outreach");
      return;
    }
    const id = added[r.name];
    onPicked?.({ supplierId: id, supplierName: r.name, supplierEmail: r.email });
    setPicked((p) => ({ ...p, [r.name]: true }));
    toast.success(`Selected ${r.name} for this RFQ`);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Globe className="w-4 h-4" /> Find Suppliers Online
          </DialogTitle>
          <DialogDescription>
            AI-powered web search via Perplexity. Add new suppliers to your DB or pick them directly for this RFQ.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2 items-start">
          <Textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Leave blank to auto-build a query from this RFQ's products, or describe what you need…"
            className="text-xs flex-1 min-h-[56px] resize-none"
          />
          <Button onClick={handleSearch} disabled={find.isPending} className="shrink-0">
            {find.isPending ? (
              <><RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Searching…</>
            ) : (
              <><Sparkles className="w-3.5 h-3.5 mr-1.5" /> Search</>
            )}
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-2 pr-1 mt-2">
          {results.length === 0 && !find.isPending && (
            <div className="text-center text-xs text-muted-foreground py-8">
              {find.isError ? "Search failed — try again." : "Run a search to discover suppliers."}
            </div>
          )}

          {results.map((r) => (
            <div key={r.name} className="bg-muted/30 border border-border rounded-lg p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-sm flex items-center gap-2">
                    {r.name}
                    {r.country && <Badge variant="secondary" className="text-[9px] h-4">{r.country}</Badge>}
                    {added[r.name] && (
                      <Badge className="text-[9px] h-4 bg-green-500/20 text-green-500 border-green-500/30">In DB</Badge>
                    )}
                  </div>
                  {r.relevance && (
                    <div className="text-[11px] text-muted-foreground mt-1 leading-snug">{r.relevance}</div>
                  )}
                  {r.offerings && (
                    <div className="text-[10px] text-muted-foreground mt-1 leading-snug italic">{r.offerings}</div>
                  )}
                  <div className="flex gap-3 text-[10px] text-muted-foreground mt-1.5">
                    {safeHref(r.website) && (
                      <a
                        href={safeHref(r.website)!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline flex items-center gap-1"
                      >
                        <ExternalLink className="w-2.5 h-2.5" /> {r.website!.replace(/^https?:\/\//, "").slice(0, 32)}
                      </a>
                    )}
                    {r.email && <span className="font-mono">{r.email}</span>}
                  </div>
                </div>
              </div>

              <div className="flex gap-1.5 flex-wrap">
                {safeHref(r.website) && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-[11px] h-6 px-2"
                    onClick={() => handleBrowse(r)}
                    disabled={summarize.isPending}
                  >
                    Summarise site
                  </Button>
                )}
                {!added[r.name] && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-[11px] h-6 px-2"
                    onClick={() => handleAddToDb(r)}
                    disabled={create.isPending || !r.email}
                  >
                    <Plus className="w-2.5 h-2.5 mr-1" /> Add to DB
                  </Button>
                )}
                {onPicked && (
                  <Button
                    size="sm"
                    variant={picked[r.name] ? "secondary" : "default"}
                    className="text-[11px] h-6 px-2"
                    onClick={() => handlePick(r)}
                    disabled={!r.email}
                  >
                    {picked[r.name] ? (
                      <><Check className="w-2.5 h-2.5 mr-1" /> Selected</>
                    ) : (
                      "Select for RFQ"
                    )}
                  </Button>
                )}
              </div>
            </div>
          ))}

          {summary && (
            <div className="bg-primary/5 border border-primary/20 rounded-lg p-3 text-xs">
              <div className="font-semibold mb-1 flex items-center gap-1">
                <Globe className="w-3 h-3" /> Website summary — {summary.url.replace(/^https?:\/\//, "").slice(0, 40)}
              </div>
              <div className="text-muted-foreground whitespace-pre-wrap leading-relaxed">{summary.text}</div>
            </div>
          )}

          {citations.length > 0 && (
            <div className="text-[10px] text-muted-foreground border-t border-border pt-2 mt-2">
              <span className="font-semibold">Sources:</span>{" "}
              {citations.slice(0, 6).map((c, i) => {
                const href = safeHref(c);
                if (!href) return null;
                return (
                  <a
                    key={c}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline mr-2"
                  >
                    [{i + 1}]
                  </a>
                );
              })}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
