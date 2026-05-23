import { useEffect, useState } from "react";
import { useSendThreadReply } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Send, X, Loader2, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";

export interface ComposeInitial {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  quoted?: string;
  quotedFrom?: string;
  quotedDate?: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  threadId: number;
  initial: ComposeInitial;
  onSent?: () => void;
}

export function ComposeModal({ open, onOpenChange, threadId, initial, onSent }: Props) {
  const [to, setTo] = useState(initial.to);
  const [cc, setCc] = useState(initial.cc ?? "");
  const [subject, setSubject] = useState(initial.subject);
  const [body, setBody] = useState(initial.body);
  const [showCc, setShowCc] = useState(!!initial.cc);
  const [showQuoted, setShowQuoted] = useState(false);

  const send = useSendThreadReply();

  // Reset form whenever the upstream "initial" changes (e.g. AI draft arrives,
  // user switches between manual Reply and AI Draft for the same thread).
  useEffect(() => {
    setTo(initial.to);
    setCc(initial.cc ?? "");
    setSubject(initial.subject);
    setBody(initial.body);
    setShowCc(!!initial.cc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.to, initial.subject, initial.body, initial.cc]);

  const handleSend = () => {
    if (!to.trim() || !subject.trim() || !body.trim()) {
      toast.error("To, Subject, and Body are required");
      return;
    }
    const data: { to: string; subject: string; body: string; cc?: string; mailFormat?: "plaintext" } = {
      to: to.trim(),
      subject: subject.trim(),
      body: body.trim(),
      mailFormat: "plaintext",
    };
    if (cc.trim()) data.cc = cc.trim();
    send.mutate(
      { id: threadId, data },
      {
        onSuccess: () => {
          toast.success("Email sent via Zoho");
          onSent?.();
        },
        onError: (err) => {
          if (/scope/i.test(err.message)) {
            toast.error("Reconnect Zoho with full scopes to send email");
          } else {
            toast.error(`Send failed: ${err.message}`);
          }
        },
      },
    );
  };

  const handleClose = () => {
    if (body.trim() && body !== initial.body) {
      if (!confirm("Discard this draft?")) return;
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : handleClose())}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Reply</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="compose-to" className="text-xs">To</Label>
              {!showCc && (
                <button
                  type="button"
                  className="text-xs text-cyan-400 hover:underline"
                  onClick={() => setShowCc(true)}
                >
                  + Add Cc
                </button>
              )}
            </div>
            <Input
              id="compose-to"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="recipient@example.com"
              className="h-9"
            />
          </div>
          {showCc && (
            <div className="space-y-1.5">
              <Label htmlFor="compose-cc" className="text-xs">Cc</Label>
              <Input
                id="compose-cc"
                value={cc}
                onChange={(e) => setCc(e.target.value)}
                placeholder="cc@example.com"
                className="h-9"
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="compose-subject" className="text-xs">Subject</Label>
            <Input
              id="compose-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="h-9"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="compose-body" className="text-xs">Message</Label>
            <textarea
              id="compose-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-sans resize-y focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder="Write your reply…"
            />
          </div>
          {initial.quoted && (
            <div className="border border-border rounded-md">
              <button
                type="button"
                onClick={() => setShowQuoted((v) => !v)}
                className="w-full px-3 py-2 text-xs text-muted-foreground flex items-center gap-1.5 hover:bg-muted/20"
              >
                {showQuoted ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                Quoted original
              </button>
              {showQuoted && (
                <pre className="px-3 py-2 text-xs text-muted-foreground whitespace-pre-wrap font-sans border-t border-border max-h-48 overflow-y-auto">
                  On {initial.quotedDate ?? ""}, {initial.quotedFrom ?? ""} wrote:{"\n"}
                  {initial.quoted.split("\n").map((l) => `> ${l}`).join("\n")}
                </pre>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={send.isPending}>
            <X className="h-4 w-4 mr-1.5" /> Cancel
          </Button>
          <Button onClick={handleSend} disabled={send.isPending}>
            {send.isPending ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <Send className="h-4 w-4 mr-1.5" />
            )}
            Send via Zoho
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
