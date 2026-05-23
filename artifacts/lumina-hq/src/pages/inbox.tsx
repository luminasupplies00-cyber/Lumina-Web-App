import { useState } from "react";
import { useGetThreads, useCreateRfq } from "@workspace/api-client-react";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Search, ExternalLink, ArrowRight } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

const CLASSIFICATIONS = ["All", "RFQ", "Supplier Reply", "Customer Follow-up", "PO/Invoice", "Internal", "Spam/Newsletter", "General"];

const COLORS: Record<string, string> = {
  "RFQ": "bg-cyan-500/10 text-cyan-500 border-cyan-500/20",
  "Supplier Reply": "bg-amber-500/10 text-amber-500 border-amber-500/20",
  "Customer Follow-up": "bg-green-500/10 text-green-500 border-green-500/20",
  "PO/Invoice": "bg-purple-500/10 text-purple-500 border-purple-500/20",
  "Internal": "bg-slate-500/10 text-slate-500 border-slate-500/20",
  "Spam/Newsletter": "bg-red-500/10 text-red-500 border-red-500/20",
  "General": "bg-gray-500/10 text-gray-500 border-gray-500/20",
};

export default function Inbox() {
  const [filter, setFilter] = useState("All");
  const [search, setSearch] = useState("");
  
  const queryParams = {
    ...(filter !== "All" ? { classification: filter } : {}),
    ...(search ? { search } : {})
  };
  
  const { data, isLoading } = useGetThreads(queryParams);
  const createRfq = useCreateRfq();
  const queryClient = useQueryClient();

  const handleMoveToPipeline = (thread: any) => {
    createRfq.mutate(
      { data: { emailThreadId: thread.id, customerName: thread.senderName, customerEmail: thread.senderEmail, notes: thread.subject } },
      {
        onSuccess: () => {
          toast.success("Added to Pipeline");
          queryClient.invalidateQueries({ queryKey: ["/api/threads"] });
          queryClient.invalidateQueries({ queryKey: ["/api/rfq"] });
        },
        onError: () => toast.error("Failed to add to pipeline")
      }
    );
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex flex-col md:flex-row gap-4 justify-between items-start md:items-center">
        <h1 className="text-2xl font-bold tracking-tight">Inbox</h1>
        <div className="relative w-full md:w-64">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input 
            placeholder="Search emails..." 
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2 pb-2">
        {CLASSIFICATIONS.map(c => (
          <Badge 
            key={c}
            variant={filter === c ? "default" : "outline"}
            className={`cursor-pointer ${filter === c ? "" : "hover:bg-muted"}`}
            onClick={() => setFilter(c)}
          >
            {c}
          </Badge>
        ))}
      </div>

      <Card>
        <div className="divide-y divide-border">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">Loading threads...</div>
          ) : !data?.threads || data.threads.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">No emails found matching criteria.</div>
          ) : (
            data.threads.map((thread) => (
              <div key={thread.id} className="p-4 flex flex-col sm:flex-row sm:items-center gap-4 hover:bg-muted/30 transition-colors">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-sm truncate">{thread.senderName}</span>
                    <span className="text-xs text-muted-foreground truncate">&lt;{thread.senderEmail}&gt;</span>
                    {thread.classification && (
                      <span className={`text-[10px] px-2 py-0.5 rounded-full border ${COLORS[thread.classification] || COLORS["General"]}`}>
                        {thread.classification}
                      </span>
                    )}
                  </div>
                  <div className="font-semibold text-sm truncate mb-1">{thread.subject}</div>
                  <div className="text-xs text-muted-foreground truncate">{thread.snippet}</div>
                </div>
                <div className="flex items-center gap-3 sm:flex-col sm:items-end shrink-0">
                  <span className="text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(thread.receivedAt), { addSuffix: true })}
                  </span>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" asChild>
                      <a href={`https://mail.zoho.com/zm/#mail/folder/inbox/p/${thread.threadId}`} target="_blank" rel="noreferrer">
                        <ExternalLink className="h-3 w-3 mr-1" /> Zoho
                      </a>
                    </Button>
                    {!thread.isRfq && thread.classification === "RFQ" && (
                      <Button size="sm" onClick={() => handleMoveToPipeline(thread)} disabled={createRfq.isPending}>
                        <ArrowRight className="h-3 w-3 mr-1" /> Pipeline
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}
