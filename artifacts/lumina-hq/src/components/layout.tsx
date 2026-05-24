import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { LayoutDashboard, Inbox as InboxIcon, Settings as SettingsIcon, Zap, Building2 } from "lucide-react";
import { useGetSyncStatus, useRunSync } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { formatDistanceToNow } from "date-fns";
import { AICommandRoot } from "@/components/AICommandBar";

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  
  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
      <Sidebar location={location} />
      <div className="flex flex-col flex-1 overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8">
          {children}
        </main>
      </div>
      <AICommandRoot />
    </div>
  );
}

function Sidebar({ location }: { location: string }) {
  const navItems = [
    { label: "Pipeline", href: "/rfq", icon: LayoutDashboard },
    { label: "Inbox", href: "/inbox", icon: InboxIcon },
    { label: "Suppliers", href: "/suppliers", icon: Building2 },
    { label: "Settings", href: "/settings", icon: SettingsIcon },
  ];

  return (
    <div className="w-64 bg-sidebar border-r border-sidebar-border flex flex-col h-full hidden md:flex">
      <div className="h-16 flex items-center px-6 border-b border-sidebar-border font-bold text-lg tracking-tight text-sidebar-foreground">
        <Zap className="w-5 h-5 mr-2 text-primary" />
        Lumina HQ
      </div>
      <nav className="flex-1 py-4 px-3 space-y-1">
        {navItems.map((item) => {
          const isActive = location === item.href || (location === "/" && item.href === "/rfq");
          return (
            <Link key={item.href} href={item.href}>
              <div
                className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors cursor-pointer text-sm font-medium ${
                  isActive 
                    ? "bg-sidebar-primary/10 text-sidebar-primary" 
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                }`}
              >
                <item.icon className="w-4 h-4" />
                {item.label}
              </div>
            </Link>
          );
        })}
      </nav>
      <div className="p-4 border-t border-sidebar-border text-xs text-sidebar-foreground/50">
        Lumina Supplies Trading
      </div>
    </div>
  );
}

function Header() {
  const { data: syncStatus, isLoading: isLoadingSync } = useGetSyncStatus();
  const runSync = useRunSync();

  return (
    <header className="h-16 border-b border-border bg-background/95 backdrop-blur flex items-center justify-between px-4 md:px-6 z-10 shrink-0">
      <div className="flex items-center gap-4">
        {/* Mobile menu could go here */}
        <h1 className="font-semibold text-lg hidden md:block">Lumina HQ</h1>
      </div>
      <div className="flex items-center gap-4 text-sm">
        {syncStatus && (
          <div className="flex items-center gap-2 text-muted-foreground hidden sm:flex">
            <div className={`w-2 h-2 rounded-full ${syncStatus.connected ? "bg-green-500" : "bg-destructive"}`} />
            {syncStatus.connected ? (
              <span>Zoho Connected</span>
            ) : (
              <span>Zoho Disconnected</span>
            )}
            {syncStatus.lastSyncedAt && (
              <span className="ml-2">
                Last sync: {formatDistanceToNow(new Date(syncStatus.lastSyncedAt), { addSuffix: true })}
              </span>
            )}
          </div>
        )}
        <Button 
          variant="outline" 
          size="sm" 
          onClick={() => runSync.mutate(undefined)}
          disabled={runSync.isPending || (syncStatus && !syncStatus.connected)}
        >
          {runSync.isPending ? "Syncing..." : "Sync Now"}
        </Button>
      </div>
    </header>
  );
}
