import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  useRunAiCommand,
  useGetAiBrainCommands,
} from "@workspace/api-client-react";
import type { AiCommandResult } from "@workspace/api-client-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Brain, Copy, Check, Loader2, Send, ArrowRight, Sparkles,
  AlertCircle, BookmarkCheck, ListChecks, Mail,
} from "lucide-react";
import { toast } from "sonner";

const SUGGESTED_COMMANDS = [
  "Draft a supplier email for the most recent RFQ",
  "Show open RFQs",
  "Show stuck RFQs",
  "Which suppliers have not responded",
  "Show quotes awaiting customer response",
  "Remember: our payment terms are Net 30",
];

// Single component owns the dialog open state, the floating launcher, and
// the global ⌘K listener. No synthetic key events, no duplicated listeners.
export function AICommandRoot() {
  const [isOpen, setIsOpen] = useState(false);
  const [text, setText] = useState("");
  const [result, setResult] = useState<AiCommandResult | null>(null);
  const [editedBody, setEditedBody] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [, setLocation] = useLocation();

  const runCommand = useRunAiCommand();
  const { data: recentData } = useGetAiBrainCommands(
    { limit: 6 },
    { query: { enabled: isOpen, refetchOnWindowFocus: false } as never },
  );
  const recent = recentData?.commands ?? [];

  // Single global ⌘K / Ctrl+K listener — the only place open state is toggled by hotkey.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setIsOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Reset transient state when the dialog opens/closes.
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setText("");
      setResult(null);
      setEditedBody(null);
      setCopied(false);
    }
  }, [isOpen]);

  const submit = async (commandText?: string) => {
    const finalText = (commandText ?? text).trim();
    if (!finalText) return;
    setText(finalText);
    setResult(null);
    setEditedBody(null);
    try {
      const res = await runCommand.mutateAsync({ data: { text: finalText } });
      setResult(res);
      if (res.draft) setEditedBody(res.draft.body);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      toast.error(e.response?.data?.error ?? e.message ?? "Command failed");
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const copyDraft = async () => {
    if (!result?.draft) return;
    const body = editedBody ?? result.draft.body;
    const clipboard = `Subject: ${result.draft.subject}\n\n${body}`;
    try {
      await navigator.clipboard.writeText(clipboard);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Clipboard write failed");
    }
  };

  return (
    <>
      {/* Floating launcher — just sets state directly. */}
      <button
        onClick={() => setIsOpen(true)}
        title="AI Command  ·  ⌘K"
        className="fixed bottom-5 right-5 z-40 h-12 w-12 rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/30 flex items-center justify-center hover:scale-105 transition-transform"
      >
        <Brain className="w-5 h-5" />
      </button>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-2xl p-0 overflow-hidden top-[15%] translate-y-0">
          {/* Header / input */}
          <div className="p-4 border-b border-border bg-sidebar">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-md bg-primary/15 border border-primary/30 flex items-center justify-center shrink-0 mt-0.5">
                <Brain className="w-4 h-4 text-primary" />
              </div>
              <div className="flex-1">
                <Textarea
                  ref={inputRef}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={onKey}
                  placeholder="Ask the AI brain… (e.g. 'Draft a supplier email for the KFSH RFQ' · 'Show stuck RFQs' · 'Remember: our markup is 35%')"
                  className="min-h-[44px] max-h-[160px] resize-none border-0 bg-transparent text-sm focus-visible:ring-0 focus-visible:ring-offset-0 p-0"
                  rows={1}
                  disabled={runCommand.isPending}
                />
                <div className="flex items-center justify-between mt-2">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">
                    AI Command · Phase 1
                  </div>
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => submit()}
                    disabled={!text.trim() || runCommand.isPending}
                  >
                    {runCommand.isPending ? (
                      <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
                    ) : (
                      <Send className="w-3 h-3 mr-1.5" />
                    )}
                    Send <span className="ml-1.5 text-[10px] opacity-70">↵</span>
                  </Button>
                </div>
              </div>
            </div>
          </div>

          {/* Body */}
          <div className="max-h-[60vh] overflow-y-auto p-4 space-y-4">
            {runCommand.isPending && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Thinking…
              </div>
            )}

            {result && !runCommand.isPending && (
              <ResultView
                result={result}
                editedBody={editedBody}
                setEditedBody={setEditedBody}
                copied={copied}
                onCopy={copyDraft}
                onNavigate={(href) => {
                  setLocation(href);
                  setIsOpen(false);
                }}
                onSuggestion={(s) => submit(s)}
              />
            )}

            {!result && !runCommand.isPending && (
              <>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2 flex items-center gap-1.5">
                    <Sparkles className="w-3 h-3" /> Try
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {SUGGESTED_COMMANDS.map((c) => (
                      <button
                        key={c}
                        onClick={() => submit(c)}
                        className="text-[11px] px-2 py-1 rounded border border-border bg-card hover:border-primary/40 hover:bg-primary/5 text-left"
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                </div>

                {recent.length > 0 && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
                      Recent
                    </div>
                    <div className="space-y-1">
                      {recent.map((r) => (
                        <button
                          key={r.id}
                          onClick={() => submit(r.commandText)}
                          className="w-full text-left p-2 rounded border border-border bg-card hover:border-primary/40 flex items-start gap-2 group"
                        >
                          <IntentIcon intent={r.intentDetected} success={r.success} />
                          <div className="flex-1 min-w-0">
                            <div className="text-xs truncate">{r.commandText}</div>
                            {r.responseSummary && (
                              <div className="text-[10px] text-muted-foreground truncate mt-0.5">
                                {r.responseSummary}
                              </div>
                            )}
                          </div>
                          <ArrowRight className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0 mt-1" />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="border-t border-border px-4 py-2 bg-sidebar text-[10px] text-muted-foreground flex items-center justify-between">
            <span>⌘K / Ctrl+K to toggle · Enter to send · Shift+Enter for newline</span>
            <span>Esc to close</span>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ResultView({
  result, editedBody, setEditedBody, copied, onCopy, onNavigate, onSuggestion,
}: {
  result: AiCommandResult;
  editedBody: string | null;
  setEditedBody: (v: string) => void;
  copied: boolean;
  onCopy: () => void;
  onNavigate: (href: string) => void;
  onSuggestion: (s: string) => void;
}) {
  const intentColor =
    result.responseType === "error" ? "text-destructive"
    : result.responseType === "memory_saved" ? "text-green-400"
    : "text-primary";

  return (
    <div className="space-y-3">
      <div className={`flex items-start gap-2 text-xs ${intentColor}`}>
        {result.responseType === "error" && <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />}
        {result.responseType === "memory_saved" && <BookmarkCheck className="w-4 h-4 shrink-0 mt-0.5" />}
        {result.responseType === "list" && <ListChecks className="w-4 h-4 shrink-0 mt-0.5" />}
        {result.responseType === "draft" && <Mail className="w-4 h-4 shrink-0 mt-0.5" />}
        {result.responseType === "message" && <Brain className="w-4 h-4 shrink-0 mt-0.5" />}
        <span className="text-foreground">{result.message}</span>
      </div>

      {result.responseType === "memory_saved" && result.memorySaved && (
        <div className="border border-green-500/30 bg-green-500/5 rounded-md p-3 text-xs">
          <div className="text-[10px] uppercase tracking-wider text-green-400 font-semibold mb-1">
            Saved · {result.memorySaved.category.replace(/_/g, " ")}
          </div>
          <div className="font-medium text-foreground">{result.memorySaved.key}</div>
          <div className="text-muted-foreground mt-0.5">{result.memorySaved.value}</div>
        </div>
      )}

      {result.responseType === "list" && result.items && result.items.length > 0 && (
        <div className="space-y-1">
          {result.items.map((it, i) => (
            <button
              key={`${it.id ?? i}-${it.title}`}
              onClick={() => it.href && onNavigate(it.href)}
              disabled={!it.href}
              className="w-full text-left p-2 rounded border border-border bg-card hover:border-primary/40 disabled:opacity-60 disabled:hover:border-border flex items-start gap-2 group"
            >
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium truncate">{it.title}</div>
                {it.subtitle && (
                  <div className="text-[10px] text-muted-foreground truncate mt-0.5">{it.subtitle}</div>
                )}
                {it.badges && it.badges.length > 0 && (
                  <div className="flex gap-1 mt-1 flex-wrap">
                    {it.badges.map((b) => (
                      <Badge key={b} variant="secondary" className="text-[9px] h-4 px-1.5">{b}</Badge>
                    ))}
                  </div>
                )}
              </div>
              {it.href && <ArrowRight className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0 mt-1" />}
            </button>
          ))}
        </div>
      )}

      {result.responseType === "draft" && result.draft && (
        <div className="border border-border rounded-md overflow-hidden">
          <div className="px-3 py-2 bg-muted/40 border-b border-border flex items-center justify-between gap-2">
            <div className="text-xs font-semibold truncate">{result.draft.subject}</div>
            <Button size="sm" variant="outline" className="h-7 text-xs shrink-0" onClick={onCopy}>
              {copied ? <Check className="w-3 h-3 mr-1.5" /> : <Copy className="w-3 h-3 mr-1.5" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <Textarea
            value={editedBody ?? result.draft.body}
            onChange={(e) => setEditedBody(e.target.value)}
            className="border-0 rounded-none font-mono text-xs leading-relaxed resize-y min-h-[200px] focus-visible:ring-0 focus-visible:ring-offset-0"
          />
          {result.draft.rfqId && (
            <div className="px-3 py-2 border-t border-border bg-muted/20 flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">
                Linked to RFQ #{result.draft.rfqId}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 text-[11px] text-primary"
                onClick={() => onNavigate(`/rfq?id=${result.draft!.rfqId}`)}
              >
                Open RFQ <ArrowRight className="w-3 h-3 ml-1" />
              </Button>
            </div>
          )}
        </div>
      )}

      {result.suggestions && result.suggestions.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1.5">
            Next
          </div>
          <div className="flex flex-wrap gap-1.5">
            {result.suggestions.map((s) => (
              <button
                key={s}
                onClick={() => onSuggestion(s)}
                className="text-[11px] px-2 py-1 rounded border border-border bg-card hover:border-primary/40 hover:bg-primary/5"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function IntentIcon({ intent, success }: { intent?: string | null; success: boolean }) {
  const color = !success ? "text-destructive" : intent === "training" ? "text-green-400" : intent === "draft" ? "text-primary" : "text-muted-foreground";
  const Icon =
    intent === "training" ? BookmarkCheck
    : intent === "draft" ? Mail
    : intent === "find" ? ListChecks
    : Brain;
  return <Icon className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${color}`} />;
}
