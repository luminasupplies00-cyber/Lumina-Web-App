import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { useGetSettings, useUpdateSettings, useGetZohoStatus, useGetZohoAuthUrl, getGetZohoAuthUrlQueryKey, useDisconnectZoho } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";

export default function Settings() {
  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings & Integrations</h1>
        <p className="text-muted-foreground mt-1">Manage external connections and AI model preferences.</p>
      </div>

      <ZohoSettings />
      <AISettings />
    </div>
  );
}

function ZohoSettings() {
  const { data: status, isLoading: statusLoading } = useGetZohoStatus();
  const { data: authData, refetch: fetchAuthUrl, isFetching: fetchingUrl } = useGetZohoAuthUrl({ query: { queryKey: getGetZohoAuthUrlQueryKey(), enabled: false } });
  const disconnect = useDisconnectZoho();

  const handleConnect = async () => {
    const result = await fetchAuthUrl();
    if (result.data?.authUrl) {
      window.open(result.data.authUrl, '_blank');
    }
  };

  const handleDisconnect = () => {
    disconnect.mutate(undefined, {
      onSuccess: () => toast.success("Disconnected from Zoho")
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Zoho Mail Integration</CardTitle>
        <CardDescription>Connect to Zoho to sync emails into your RFQ pipeline.</CardDescription>
      </CardHeader>
      <CardContent>
        {statusLoading ? (
          <div>Loading status...</div>
        ) : status?.connected ? (
          <div className="bg-green-500/10 border border-green-500/20 p-4 rounded-md">
            <div className="flex items-center gap-2 text-green-500 font-medium mb-1">
              <div className="w-2 h-2 bg-green-500 rounded-full" />
              Connected
            </div>
            <div className="text-sm text-muted-foreground mb-4">
              Authenticated as: {status.email || "Unknown"}
              <br/>
              Last synced: {status.lastSyncedAt ? new Date(status.lastSyncedAt).toLocaleString() : "Never"}
            </div>
            <Button variant="destructive" size="sm" onClick={handleDisconnect} disabled={disconnect.isPending}>
              Disconnect Zoho
            </Button>
          </div>
        ) : (
          <div className="bg-muted p-4 rounded-md border border-border">
            <div className="text-sm text-muted-foreground mb-4">
              Not currently connected to Zoho Mail. You need to configure OAuth credentials and connect.
            </div>
            <Button onClick={handleConnect} disabled={fetchingUrl}>
              {fetchingUrl ? "Preparing..." : "Connect to Zoho Mail"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

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
      AI_MODEL: "claude-3-5-sonnet-20241022",
    }
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
        AI_MODEL: settingsData.settings.AI_MODEL || "claude-3-5-sonnet-20241022",
      });
    }
  }, [settingsData, form]);

  const onSubmit = (data: any) => {
    updateSettings.mutate({ data }, {
      onSuccess: () => toast.success("Settings saved successfully"),
      onError: () => toast.error("Failed to save settings")
    });
  };

  if (isLoading) return <div>Loading settings...</div>;

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
              <h3 className="text-sm font-medium border-b pb-2">AI Models</h3>
              <div className="grid gap-4 md:grid-cols-2">
                <FormField control={form.control} name="ANTHROPIC_API_KEY" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Anthropic API Key</FormLabel>
                    <FormControl><Input type="password" {...field} /></FormControl>
                  </FormItem>
                )} />
                <FormField control={form.control} name="PERPLEXITY_API_KEY" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Perplexity API Key</FormLabel>
                    <FormControl><Input type="password" {...field} /></FormControl>
                  </FormItem>
                )} />
                <FormField control={form.control} name="AI_MODEL" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Primary Model</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger><SelectValue placeholder="Select a model" /></SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="claude-3-5-sonnet-20241022">Claude 3.5 Sonnet</SelectItem>
                        <SelectItem value="sonar">Sonar</SelectItem>
                        <SelectItem value="sonar-pro">Sonar Pro</SelectItem>
                        <SelectItem value="sonar-reasoning">Sonar Reasoning</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormItem>
                )} />
              </div>
            </div>

            <div className="space-y-4 pt-4">
              <h3 className="text-sm font-medium border-b pb-2">Zoho OAuth Credentials</h3>
              <div className="grid gap-4 md:grid-cols-2">
                <FormField control={form.control} name="ZOHO_CLIENT_ID" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Client ID</FormLabel>
                    <FormControl><Input {...field} /></FormControl>
                  </FormItem>
                )} />
                <FormField control={form.control} name="ZOHO_CLIENT_SECRET" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Client Secret</FormLabel>
                    <FormControl><Input type="password" {...field} /></FormControl>
                  </FormItem>
                )} />
                <FormField control={form.control} name="ZOHO_REDIRECT_URI" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Redirect URI</FormLabel>
                    <FormControl><Input {...field} /></FormControl>
                  </FormItem>
                )} />
                <FormField control={form.control} name="ZOHO_ACCOUNTS_DOMAIN" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Accounts Domain</FormLabel>
                    <FormControl><Input {...field} /></FormControl>
                  </FormItem>
                )} />
              </div>
            </div>
          </CardContent>
          <CardFooter>
            <Button type="submit" disabled={updateSettings.isPending}>
              {updateSettings.isPending ? "Saving..." : "Save Configuration"}
            </Button>
          </CardFooter>
        </form>
      </Form>
    </Card>
  );
}
