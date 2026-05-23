import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/components/layout";
import Pipeline from "@/pages/rfq";
import Inbox from "@/pages/inbox";
import Suppliers from "@/pages/suppliers";
import Settings from "@/pages/settings";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient();

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL?.replace(/\/$/, "") || ""}>
          <Layout>
            <Switch>
              <Route path="/" component={Pipeline} />
              <Route path="/rfq" component={Pipeline} />
              <Route path="/inbox" component={Inbox} />
              <Route path="/suppliers" component={Suppliers} />
              <Route path="/settings" component={Settings} />
              <Route component={NotFound} />
            </Switch>
          </Layout>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
