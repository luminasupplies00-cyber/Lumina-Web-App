import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import {
  useGetSettings,
  useUpdateSettings,
  useGetZohoStatus,
  useGetZohoAuthUrl,
  useGetZohoAccounts,
  useDisconnectZohoAccount,
  useUpdateZohoAccountLabel,
  useDisconnectZoho,
  useRunSync,
} from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, RefreshCw, CheckCircle2, AlertCircle, Mail, Pencil } from "lucide-react";

const SUGGESTED_LABELS = ["Owner", "Sales", "Procurement", "Support", "Finance", "General"] as const;
type SuggestedLabel = (typeof SUGGESTED_LABELS)[number];

const LABEL_COLORS: Record<string, string> = {
  Owner: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  Sales: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  Procurement: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  Support: "bg-green-500/20 text-green-400 border-green-500/30",
  Finance: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  General: "bg-muted text-muted-foreground border-border",
};
const CUSTOM_LABEL_COLOR = "bg-cyan-500/20 text-cyan-400 border-cyan-500/30";
const labelClassFor = (label: string) => LABEL_COLORS[label] ?? CUSTOM_LABEL_COLOR;

export default function Settings() {
  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings & Integrations</h1>
        <p className="text-muted-foreground mt-1">Manage external connections and AI model preferences.</p>
      </div>

      <ZohoAccountsCard />
      <AISettings />
    </div>
  );
}

// ─── Zoho Multi-Account Card ──────────────────────────────────────────────────

function ZohoAccountsCard() {
  const queryClient = useQueryClient();
  const { data: accountsData, isLoading, refetch } = useGetZohoAccounts();
  const disconnect = useDisconnectZohoAccount();
  const runSync = useRunSync();
  const [addDialog, setAddDialog] = useState(false);
  const [selectedLabel, setSelectedLabel] = useState<string>("General");
  const [fetchingUrl, setFetchingUrl] = useState(false);

  const accounts = accountsData?.accounts ?? [];
  const hasAccounts = accounts.length > 0;

  const handleGetAuthUrl = async (rawLabel: string) => {
    const label = rawLabel.trim();
    if (!label) {
      toast.error("Please enter a label for this account");
      return;
    }
    if (label.length > 32) {
      toast.error("Label must be 32 characters or fewer");
      return;
    }
    setFetchingUrl(true);
    try {
      const res = await fetch(`/api/auth/zoho/connect?label=${encodeURIComponent(label)}`);
      const data = await res.json();
      if (data.authUrl) {
        window.open(data.authUrl, "_blank", "width=600,height=700,noopener");
        setAddDialog(false);
        toast.info("Complete the Zoho authorization in the new window, then return here.");
        // Poll for new connection after a delay
        setTimeout(() => {
          refetch();
          queryClient.invalidateQueries({ queryKey: ["/api/auth/zoho/status"] });
        }, 5000);
      } else {
        toast.error(data.error || "Failed to get authorization URL");
      }
    } catch {
      toast.error("Failed to initiate Zoho connection");
    } finally {
      setFetchingUrl(false);
    }
  };

  const handleDisconnect = (id: number, email: string) => {
    disconnect.mutate(
      { id },
      {
        onSuccess: () => {
          toast.success(`Disconnected ${email}`);
          refetch();
          queryClient.invalidateQueries({ queryKey: ["/api/auth/zoho/status"] });
        },
        onError: () => toast.error("Failed to disconnect account"),
      },
    );
  };

  const handleSync = () => {
    runSync.mutate(undefined, {
      onSuccess: (res: any) => {
        const parts = [`Synced ${res.synced} messages`];
        if (res.rfqsCreated > 0) parts.push(`${res.rfqsCreated} new RFQs`);
        if (res.accounts?.length > 1) parts.push(`across ${res.accounts.length} accounts`);
        toast.success(parts.join(" · "));
        refetch();
      },
      onError: () => toast.error("Sync failed"),
    });
  };

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle>Zoho Mail Accounts</CardTitle>
              <CardDescription className="mt-1">
                Connect multiple Zoho accounts (Owner, Sales, Procurement, etc.) to sync emails into the RFQ pipeline.
              </CardDescription>
            </div>
            <div className="flex gap-2 shrink-0">
              {hasAccounts && (
                <Button variant="outline" size="sm" onClick={handleSync} disabled={runSync.isPending}>
                  <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${runSync.isPending ? "animate-spin" : ""}`} />
                  {runSync.isPending ? "Syncing…" : "Sync All"}
                </Button>
              )}
              <Button size="sm" onClick={() => setAddDialog(true)}>
                <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Account
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-sm text-muted-foreground">Loading accounts…</div>
          ) : !hasAccounts ? (
            <div className="bg-muted/40 border border-border rounded-lg p-6 text-center">
              <Mail className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm font-medium mb-1">No Zoho accounts connected</p>
              <p className="text-xs text-muted-foreground mb-4">
                Connect at least one account to start syncing emails into your pipeline.
              </p>
              <Button size="sm" onClick={() => setAddDialog(true)}>
                <Plus className="w-3.5 h-3.5 mr-1.5" /> Connect First Account
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {accounts.map((account: any) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  onDisconnect={() => handleDisconnect(account.id, account.email)}
                  onReconnect={() => handleGetAuthUrl(account.accountLabel || "General")}
                  disconnecting={disconnect.isPending}
                  reconnecting={fetchingUrl}
                  onLabelChanged={() => {
                    refetch();
                    queryClient.invalidateQueries({ queryKey: ["/api/threads"] });
                    queryClient.invalidateQueries({ queryKey: ["/api/threads/counts"] });
                  }}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add Account Dialog */}
      <Dialog open={addDialog} onOpenChange={setAddDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Zoho Account</DialogTitle>
            <DialogDescription>
              Choose the role for this account. You'll be redirected to Zoho to authorize access.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div>
              <label className="text-sm font-medium mb-2 block">Account Label</label>
              <Input
                value={selectedLabel}
                onChange={(e) => setSelectedLabel(e.target.value)}
                placeholder="e.g. Owner, Lab Manager, Riyadh Office"
                maxLength={32}
                className="h-9"
              />
              <div className="mt-2">
                <div className="text-[11px] text-muted-foreground mb-1.5">Suggestions:</div>
                <div className="flex flex-wrap gap-1.5">
                  {SUGGESTED_LABELS.map((label) => (
                    <button
                      key={label}
                      type="button"
                      className={`px-2 py-1 rounded-md border text-xs font-medium transition-colors ${
                        selectedLabel === label
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-muted/30 text-muted-foreground hover:text-foreground hover:border-border/80"
                      }`}
                      onClick={() => setSelectedLabel(label)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              A Zoho authorization window will open. Grant access and return here — the account will appear automatically.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setAddDialog(false)}>Cancel</Button>
            <Button onClick={() => handleGetAuthUrl(selectedLabel)} disabled={fetchingUrl}>
              {fetchingUrl ? (
                <><RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Opening…</>
              ) : (
                "Connect with Zoho"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function AccountRow({
  account,
  onDisconnect,
  onReconnect,
  disconnecting,
  reconnecting,
  onLabelChanged,
}: {
  account: any;
  onDisconnect: () => void;
  onReconnect: () => void;
  disconnecting: boolean;
  reconnecting: boolean;
  onLabelChanged: () => void;
}) {
  const updateLabel = useUpdateZohoAccountLabel();
  const label: string = account.accountLabel || "General";
  const labelClass = labelClassFor(label);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);

  useEffect(() => {
    setDraft(label);
  }, [label]);

  const lastSync = account.lastSyncedAt
    ? new Date(account.lastSyncedAt).toLocaleString("en-GB", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Never";

  const tokenExpired = account.tokenExpiry ? new Date(account.tokenExpiry) < new Date() : false;

  const commitLabel = () => {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === label) {
      setDraft(label);
      return;
    }
    if (next.length > 32) {
      toast.error("Label must be 32 characters or fewer");
      setDraft(label);
      return;
    }
    updateLabel.mutate(
      { id: account.id, data: { accountLabel: next } },
      {
        onSuccess: () => {
          toast.success(`Label updated to "${next}"`);
          onLabelChanged();
        },
        onError: () => {
          toast.error("Failed to update label");
          setDraft(label);
        },
      },
    );
  };

  return (
    <div className="flex items-center justify-between gap-3 p-3 rounded-lg border border-border bg-muted/20">
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex items-center gap-1.5 shrink-0">
          {tokenExpired ? (
            <AlertCircle className="w-4 h-4 text-amber-500" />
          ) : (
            <CheckCircle2 className="w-4 h-4 text-green-500" />
          )}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium truncate">{account.email}</span>
            <Badge variant="outline" className={`text-[10px] h-4 px-1.5 border ${labelClass}`}>
              {label}
            </Badge>
            {tokenExpired && (
              <Badge variant="outline" className="text-[10px] h-4 px-1.5 border-amber-500/30 bg-amber-500/10 text-amber-500">
                Token expired
              </Badge>
            )}
            {account.hasWriteScope === false && (
              <Badge variant="outline" className="text-[10px] h-4 px-1.5 border-amber-500/30 bg-amber-500/10 text-amber-400">
                Read-only · Reconnect for send/archive
              </Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            Last synced: {lastSync}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {editing ? (
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitLabel}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitLabel();
              else if (e.key === "Escape") {
                setDraft(label);
                setEditing(false);
              }
            }}
            maxLength={32}
            placeholder="Label"
            className="h-7 w-40 text-xs"
            disabled={updateLabel.isPending}
          />
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setEditing(true)}
            disabled={updateLabel.isPending}
          >
            <Pencil className="w-3.5 h-3.5 mr-1" /> Edit label
          </Button>
        )}
        {account.hasWriteScope === false && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 hover:text-amber-200"
            onClick={onReconnect}
            disabled={reconnecting}
          >
            <RefreshCw className={`w-3.5 h-3.5 mr-1 ${reconnecting ? "animate-spin" : ""}`} /> Reconnect
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10"
          onClick={onDisconnect}
          disabled={disconnecting}
        >
          <Trash2 className="w-3.5 h-3.5 mr-1" /> Remove
        </Button>
      </div>
    </div>
  );
}

// ─── AI / App Settings ────────────────────────────────────────────────────────

function AISettings() {
  const { data: settingsData, isLoading } = useGetSettings();
  const updateSettings = useUpdateSettings();

  const form = useForm({
    defaultValues: {
      ZOHO_CLIENT_ID: "",
      ZOHO_CLIENT_SECRET: "",
      ZOHO_REDIRECT_URI: "",
      ZOHO_ACCOUNTS_DOMAIN: "accounts.zoho.com",
      ANTHROPIC_API_KEY: "",
      PERPLEXITY_API_KEY: "",
      AI_MODEL: "claude-sonnet-4-5",
    },
  });

  useEffect(() => {
    if (settingsData?.settings) {
      form.reset({
        ZOHO_CLIENT_ID: settingsData.settings.ZOHO_CLIENT_ID || "",
        ZOHO_CLIENT_SECRET: settingsData.settings.ZOHO_CLIENT_SECRET || "",
        ZOHO_REDIRECT_URI: settingsData.settings.ZOHO_REDIRECT_URI || "",
        ZOHO_ACCOUNTS_DOMAIN: settingsData.settings.ZOHO_ACCOUNTS_DOMAIN || "accounts.zoho.com",
        ANTHROPIC_API_KEY: settingsData.settings.ANTHROPIC_API_KEY || "",
        PERPLEXITY_API_KEY: settingsData.settings.PERPLEXITY_API_KEY || "",
        AI_MODEL: settingsData.settings.AI_MODEL || "claude-sonnet-4-5",
      });
    }
  }, [settingsData, form]);

  const onSubmit = (data: any) => {
    updateSettings.mutate(
      { data },
      {
        onSuccess: () => toast.success("Settings saved successfully"),
        onError: () => toast.error("Failed to save settings"),
      },
    );
  };

  if (isLoading) return <div className="text-sm text-muted-foreground">Loading settings…</div>;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Application Configuration</CardTitle>
        <CardDescription>API keys and credentials for Lumina HQ.</CardDescription>
      </CardHeader>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)}>
          <CardContent className="space-y-6">
            <div className="space-y-4">
              <h3 className="text-sm font-medium border-b border-border pb-2">AI Models</h3>
              <div className="grid gap-4 md:grid-cols-2">
                <FormField
                  control={form.control}
                  name="ANTHROPIC_API_KEY"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Anthropic API Key</FormLabel>
                      <FormControl>
                        <Input type="password" placeholder="sk-ant-…" {...field} />
                      </FormControl>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="PERPLEXITY_API_KEY"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Perplexity API Key</FormLabel>
                      <FormControl>
                        <Input type="password" placeholder="pplx-…" {...field} />
                      </FormControl>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="AI_MODEL"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Primary Model</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select a model" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="claude-sonnet-4-5">Claude Sonnet 4.5 (Primary)</SelectItem>
                          <SelectItem value="claude-opus-4-5-20251101">Claude Opus 4.5</SelectItem>
                          <SelectItem value="claude-haiku-4-5-20251001">Claude Haiku 4.5 (Fast)</SelectItem>
                          <SelectItem value="sonar">Sonar</SelectItem>
                          <SelectItem value="sonar-pro">Sonar Pro</SelectItem>
                          <SelectItem value="sonar-reasoning">Sonar Reasoning</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />
              </div>
            </div>

            <div className="space-y-4 pt-2">
              <h3 className="text-sm font-medium border-b border-border pb-2">Zoho OAuth Credentials</h3>
              <p className="text-xs text-muted-foreground -mt-2">
                These credentials apply to all connected Zoho accounts. Create a Zoho OAuth client at{" "}
                <a
                  href="https://api-console.zoho.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  api-console.zoho.com
                </a>
                .
              </p>
              <div className="grid gap-4 md:grid-cols-2">
                <FormField
                  control={form.control}
                  name="ZOHO_CLIENT_ID"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Client ID</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="ZOHO_CLIENT_SECRET"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Client Secret</FormLabel>
                      <FormControl>
                        <Input type="password" {...field} />
                      </FormControl>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="ZOHO_REDIRECT_URI"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Redirect URI</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="https://your-domain.replit.app/api/auth/zoho/callback" />
                      </FormControl>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="ZOHO_ACCOUNTS_DOMAIN"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Accounts Domain</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="accounts.zoho.com" />
                      </FormControl>
                    </FormItem>
                  )}
                />
              </div>
            </div>
          </CardContent>
          <CardFooter>
            <Button type="submit" disabled={updateSettings.isPending}>
              {updateSettings.isPending ? "Saving…" : "Save Configuration"}
            </Button>
          </CardFooter>
        </form>
      </Form>
    </Card>
  );
}
