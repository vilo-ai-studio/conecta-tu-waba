import { createFileRoute, Outlet, redirect, Link, useNavigate } from "@tanstack/react-router";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { BrandMark } from "@/components/brand/BrandMark";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await authClient.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
    return { user: data.user };
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  const { user } = Route.useRouteContext();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const signOut = async () => {
    await qc.cancelQueries();
    qc.clear();
    await authClient.auth.signOut();
    navigate({ to: "/auth", replace: true });
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-foreground">
      {/* Ambient glow effects */}
      <div
        aria-hidden
        className="glow-primary pointer-events-none absolute -right-40 -top-40 h-[520px] w-[520px] rounded-full blur-3xl"
      />
      <div
        aria-hidden
        className="glow-accent pointer-events-none absolute -left-40 bottom-0 h-[420px] w-[420px] rounded-full blur-3xl"
      />

      {/* Header */}
      <header className="relative z-10 border-b border-border/50 backdrop-blur-sm">
        <div className="container mx-auto flex items-center justify-between px-6 py-4">
          <Link to="/dashboard" className="flex items-center gap-3">
            <BrandMark size="sm" />
            <span className="hidden text-sm font-medium text-muted-foreground sm:inline">
              Admin Panel
            </span>
          </Link>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-muted-foreground sm:inline">{user.email}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={signOut}
              className="h-9 text-muted-foreground hover:bg-accent/10 hover:text-accent"
            >
              <LogOut className="mr-2 h-4 w-4" />
              Salir
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container relative z-10 mx-auto px-6 py-10">
        <Outlet />
      </main>
    </div>
  );
}
