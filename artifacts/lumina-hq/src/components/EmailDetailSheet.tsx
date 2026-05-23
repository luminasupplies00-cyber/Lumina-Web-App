import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetThreadFull,
  useMarkThreadRead,
  useArchiveThread,
  useDeleteThread,
  useSummarizeThread,
  useDraftReplyForThread,
  useCreateRfqFromThread,
} from "@workspace/api-client-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import {
  Reply,
  Archive,
  Trash2,
  MailOpen,
  Mail,
  Sparkles,
  PenSquare,
  ArrowRight,
  Loader2,
  Paperclip,
  AlertTriangle,
  Download,
} from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow, format } from "date-fns";
import DOMPurify from "dompurify";
import { ComposeModal, type ComposeInitial } from "./ComposeModal";

const SANITIZE_OPTS = {
  FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "button", "meta", "link"],
  FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur", "formaction"],
  ALLOW_DATA_ATTR: false,
};

interface EmailThreadLite {
  id: number;
  threadId: string;
  subject: string;
  senderName: string;
  senderEmail: string;
  receivedAt: string;
  classification?: string | null;
  aiConfidence?: string | null;
  aiReasoning?: string | null;
  rfqId?: number | null;
  isRead?: boolean;
  isRfq?: boolean;
}

interface Props {
  thread: EmailThreadLite | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apiBase: string;
}

const CLASSIFICATION_COLOR: Record<string, string> = {
  RFQ: "bg-cyan-500/15 text-cyan-400 border-cyan-500/30",
  SUPPLIER_REPLY: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  CUSTOMER_FOLLOWUP: "bg-violet-500/15 text-violet-400 border-violet-500/30",
  PO_INVOICE: "bg-green-500/15 text-green-400 border-green-500/30",
  INTERNAL: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  SPAM_NEWSLETTER: "bg-gray-500/15 text-gray-400 border-gray-500/30",
  GENERAL: "bg-zinc-700/30 text-zinc-400 border-zinc-600/30",
  UNCLASSIFIED: "bg-red-500/15 text-red-400 border-red-500/30",
};

function formatBytes(n?: number): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function EmailDetailSheet({ thread, open, onOpenChange, apiBase }: Props) {
  const queryClient = useQueryClient();
  const enabled = !!thread && open;

  const { data: full, isLoading, error, refetch } = useGetThreadFull(thread?.id ?? 0, {
    query: { enabled } as never,
  });
  const markRead = useMarkThreadRead();
  const archive = useArchiveThread();
  const del = useDeleteThread();
  const summarize = useSummarizeThread();
  const draftReply = useDraftReplyForThread();
  const createRfq = useCreateRfqFromThread();

  const [summary, setSummary] = useState<{ summary: string; action: string; deadline: string } | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeInitial, setComposeInitial] = useState<ComposeInitial | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Reset state when switching threads
  useEffect(() => {
    setSummary(null);
    setComposeInitial(null);
    setComposeOpen(false);
  }, [thread?.id]);

  // After the full-fetch resolves, refresh the inbox list so unread dot clears
  const lastInvalidatedFor = useRef<number | null>(null);
  useEffect(() => {
    if (full && thread && lastInvalidatedFor.current !== thread.id) {
      lastInvalidatedFor.current = thread.id;
      void queryClient.invalidateQueries({ queryKey: ["/api/threads"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/threads/counts"] });
    }
  }, [full, thread, queryClient]);

  const invalidateThreads = () => {
    void queryClient.invalidateQueries({ queryKey: ["/api/threads"] });
    void queryClient.invalidateQueries({ queryKey: ["/api/threads/counts"] });
  };

  if (!thread) return null;

  const bodyHtml = full?.bodyHtml ?? "";
  const bodyText = full?.bodyText ?? "";
  const attachments = full?.attachments ?? [];
  const isRead = full?.thread?.isRead ?? thread.isRead ?? false;

  const handleReply = () => {
    setComposeInitial({
      to: thread.senderEmail,
      subject: thread.subject.startsWith("Re:") ? thread.subject : `Re: ${thread.subject}`,
      body: "",
      quoted: bodyText || "",
      quotedFrom: `${thread.senderName} <${thread.senderEmail}>`,
      quotedDate: thread.receivedAt,
    });
    setComposeOpen(true);
  };

  const handleAIDraft = () => {
    draftReply.mutate(
      { id: thread.id },
      {
        onSuccess: (res) => {
          const r = res as { to: string; subject: string; body: string };
          setComposeInitial({
            to: r.to,
            subject: r.subject,
            body: r.body,
            quoted: bodyText || "",
            quotedFrom: `${thread.senderName} <${thread.senderEmail}>`,
            quotedDate: thread.receivedAt,
          });
          setComposeOpen(true);
          toast.success("AI draft ready — review and send");
        },
        onError: (err) => toast.error(`AI draft failed: ${err.message}`),
      },
    );
  };

  const handleSummarize = () => {
    summarize.mutate(
      { id: thread.id },
      {
        onSuccess: (res) => {
          setSummary(res as { summary: string; action: string; deadline: string });
        },
        onError: (err) => toast.error(`Summary failed: ${err.message}`),
      },
    );
  };

  const handleToggleRead = () => {
    const next = !isRead;
    markRead.mutate(
      { id: thread.id, data: { isRead: next } },
      {
        onSuccess: () => {
          toast.success(next ? "Marked as read" : "Marked as unread");
          invalidateThreads();
          void refetch();
        },
        onError: (err) => toast.error(`Failed: ${err.message}`),
      },
    );
  };

  const handleArchive = () => {
    archive.mutate(
      { id: thread.id },
      {
        onSuccess: () => {
          toast.success("Archived in Zoho");
          invalidateThreads();
          onOpenChange(false);
        },
        onError: (err) => {
          if (/scope/i.test(err.message)) toast.error("Reconnect Zoho with full scopes to archive");
          else toast.error(`Archive failed: ${err.message}`);
        },
      },
    );
  };

  const handleDelete = () => {
    del.mutate(
      { id: thread.id },
      {
        onSuccess: () => {
          toast.success("Moved to Trash in Zoho");
          invalidateThreads();
          setConfirmDelete(false);
          onOpenChange(false);
        },
        onError: (err) => {
          if (/scope/i.test(err.message)) toast.error("Reconnect Zoho with full scopes to delete");
          else toast.error(`Delete failed: ${err.message}`);
        },
      },
    );
  };

  const handleCreateRfq = () => {
    createRfq.mutate(
      { id: thread.id },
      {
        onSuccess: (res) => {
          const r = res as { created?: boolean; rfqId?: number };
          toast.success(r.created ? "Added to RFQ Pipeline" : "RFQ already exists for this thread");
          invalidateThreads();
          void queryClient.invalidateQueries({ queryKey: ["/api/rfq"] });
        },
        onError: () => toast.error("Failed to create RFQ"),
      },
    );
  };

  const classification = thread.classification ?? "UNCLASSIFIED";
  const classColor = CLASSIFICATION_COLOR[classification] ?? CLASSIFICATION_COLOR["UNCLASSIFIED"]!;
  const errorMsg = error instanceof Error ? error.message : null;
  const scopeIssue = !!errorMsg && /scope|reconnect/i.test(errorMsg);

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full sm:max-w-2xl p-0 flex flex-col gap-0 overflow-hidden">
          <SheetHeader className="px-5 py-3 border-b border-border space-y-2 shrink-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className={classColor}>
                {classification}
              </Badge>
              {!isRead && <Badge variant="outline" className="bg-cyan-500/15 text-cyan-300 border-cyan-500/30">NEW</Badge>}
              {thread.rfqId && (
                <Badge variant="outline" className="bg-cyan-500/15 text-cyan-400 border-cyan-500/30">
                  RFQ #{thread.rfqId}
                </Badge>
              )}
            </div>
            <SheetTitle className="text-base font-semibold leading-tight pr-6">
              {thread.subject}
            </SheetTitle>
            <SheetDescription asChild>
              <div className="text-xs text-muted-foreground space-y-0.5">
                <div>
                  <span className="text-foreground font-medium">{thread.senderName}</span>{" "}
                  &lt;{thread.senderEmail}&gt;
                </div>
                <div>
                  {format(new Date(thread.receivedAt), "PPp")} ·{" "}
                  {formatDistanceToNow(new Date(thread.receivedAt), { addSuffix: true })}
                </div>
              </div>
            </SheetDescription>
          </SheetHeader>

          {/* Toolbar */}
          <div className="px-5 py-2 border-b border-border flex flex-wrap gap-1.5 shrink-0 bg-muted/10">
            <Button size="sm" onClick={handleReply}>
              <Reply className="h-3.5 w-3.5 mr-1.5" /> Reply
            </Button>
            <Button size="sm" variant="outline" onClick={handleAIDraft} disabled={draftReply.isPending}>
              {draftReply.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <PenSquare className="h-3.5 w-3.5 mr-1.5" />
              )}
              AI Draft
            </Button>
            <Button size="sm" variant="outline" onClick={handleSummarize} disabled={summarize.isPending}>
              {summarize.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5 mr-1.5" />
              )}
              Summarize
            </Button>
            {classification === "RFQ" && !thread.rfqId && (
              <Button size="sm" variant="outline" onClick={handleCreateRfq} disabled={createRfq.isPending}>
                <ArrowRight className="h-3.5 w-3.5 mr-1.5" /> Move to Pipeline
              </Button>
            )}
            {thread.rfqId && (
              <Button size="sm" variant="outline" asChild>
                <a href={`/rfq/${thread.rfqId}`}>
                  <ArrowRight className="h-3.5 w-3.5 mr-1.5" /> Open RFQ
                </a>
              </Button>
            )}
            <div className="ml-auto flex gap-1.5">
              <Button size="sm" variant="ghost" onClick={handleToggleRead} disabled={markRead.isPending} title={isRead ? "Mark unread" : "Mark read"}>
                {isRead ? <Mail className="h-3.5 w-3.5" /> : <MailOpen className="h-3.5 w-3.5" />}
              </Button>
              <Button size="sm" variant="ghost" onClick={handleArchive} disabled={archive.isPending} title="Archive">
                <Archive className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)} title="Move to Trash" className="text-red-400 hover:text-red-300">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            {summary && (
              <Alert className="bg-cyan-500/5 border-cyan-500/30">
                <Sparkles className="h-4 w-4 text-cyan-400" />
                <AlertDescription className="space-y-1.5">
                  <div className="text-sm text-foreground">{summary.summary}</div>
                  {summary.action && (
                    <div className="text-xs">
                      <span className="text-cyan-400 font-semibold">Action: </span>
                      <span className="text-muted-foreground">{summary.action}</span>
                    </div>
                  )}
                  {summary.deadline && summary.deadline.toLowerCase() !== "none" && (
                    <div className="text-xs">
                      <span className="text-amber-400 font-semibold">Deadline: </span>
                      <span className="text-muted-foreground">{summary.deadline}</span>
                    </div>
                  )}
                </AlertDescription>
              </Alert>
            )}

            {errorMsg && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  {scopeIssue
                    ? "Zoho scope is insufficient. Reconnect this account from Settings to enable read/send/archive."
                    : errorMsg}
                </AlertDescription>
              </Alert>
            )}

            {isLoading ? (
              <div className="space-y-2">
                <div className="h-3 bg-muted/40 rounded animate-pulse" />
                <div className="h-3 bg-muted/40 rounded animate-pulse w-5/6" />
                <div className="h-3 bg-muted/40 rounded animate-pulse w-4/6" />
              </div>
            ) : bodyHtml ? (
              <div
                className="text-sm prose-email max-w-none [&_a]:text-cyan-400 [&_a]:underline [&_img]:max-w-full [&_table]:max-w-full [&_table]:text-xs [&_*]:!font-sans"
                // eslint-disable-next-line react/no-danger
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(bodyHtml, SANITIZE_OPTS) }}
              />
            ) : bodyText ? (
              <pre className="text-sm whitespace-pre-wrap font-sans text-foreground/90">{bodyText}</pre>
            ) : (
              <div className="text-sm text-muted-foreground italic">No body content.</div>
            )}

            {attachments.length > 0 && (
              <div className="border-t border-border pt-3 space-y-1.5">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                  <Paperclip className="h-3 w-3" /> Attachments ({attachments.length})
                </div>
                <div className="space-y-1">
                  {attachments.map((a) => (
                    <a
                      key={a.attachmentId}
                      href={`${apiBase}/threads/${thread.id}/attachments/${a.attachmentId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center justify-between p-2 rounded border border-border hover:bg-muted/30 text-sm"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Paperclip className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="truncate">{a.name}</span>
                        {a.size != null && (
                          <span className="text-xs text-muted-foreground shrink-0">{formatBytes(a.size)}</span>
                        )}
                      </div>
                      <Download className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    </a>
                  ))}
                </div>
              </div>
            )}

            {thread.aiReasoning && (
              <div className="border-t border-border pt-3 text-xs text-muted-foreground italic">
                AI: {thread.aiReasoning}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {composeInitial && (
        <ComposeModal
          open={composeOpen}
          onOpenChange={setComposeOpen}
          threadId={thread.id}
          initial={composeInitial}
          onSent={() => {
            invalidateThreads();
            setComposeOpen(false);
          }}
        />
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this email?</AlertDialogTitle>
            <AlertDialogDescription>
              This will move the email to Trash in Zoho Mail and remove it from your inbox here.
              You can still restore it from Zoho Trash within 30 days.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={del.isPending}
              className="bg-red-600 hover:bg-red-700"
            >
              {del.isPending ? "Deleting…" : "Move to Trash"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
