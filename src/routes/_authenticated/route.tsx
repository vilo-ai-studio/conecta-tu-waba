import { createFileRoute, Outlet, redirect, Link, useNavigate } from "@tanstack/react-router";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Activity, Building2, ChevronDown, LogOut, Network, Server } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { BrandMark } from "@/components/brand/BrandMark";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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

  const userInitial = user.email?.[0]?.toUpperCase() ?? "A";

  return (
    <div className="min-h-screen bg-background text-foreground lg:grid lg:grid-cols-[248px_minmax(0,1fr)]">
      <aside className="hidden min-h-screen border-r border-border bg-sidebar lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col">
        <div className="flex h-20 items-center border-b border-border px-6">
          <BrandMark size="sm" />
        </div>

        <nav className="flex-1 px-3 py-6" aria-label="Navegación principal">
          <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
            Operación
          </p>
          <Link
            to="/dashboard"
            className="flex items-center gap-3 rounded-lg bg-accent px-3 py-2.5 text-sm font-semibold text-accent-foreground shadow-sm"
          >
            <Building2 className="h-4 w-4" />
            Clientes y rutas
          </Link>

          <div className="mt-8">
            <p className="mb-3 px-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
              Infraestructura
            </p>
            <div className="mx-1 rounded-xl border border-border bg-white/[0.025] p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span className="grid h-8 w-8 place-items-center rounded-lg bg-success/10">
                    <Server className="h-4 w-4 text-success" />
                  </span>
                  <div>
                    <p className="text-xs font-medium text-foreground">Router</p>
                    <p className="text-[11px] text-muted-foreground">VPS propio</p>
                  </div>
                </div>
                <span className="h-2 w-2 rounded-full bg-success shadow-[0_0_0_3px_rgba(34,197,94,0.12)]" />
              </div>
              <div className="my-3 h-px bg-border" />
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <Network className="h-3.5 w-3.5" />
                Enrutamiento central activo
              </div>
            </div>
          </div>
        </nav>

        <div className="border-t border-border p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Activity className="h-3.5 w-3.5 text-success" />
            Plataforma operativa
          </div>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-border bg-background/90 px-4 backdrop-blur-xl sm:px-6 lg:h-20 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="lg:hidden">
              <BrandMark size="sm" />
            </div>
            <div className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex lg:ml-0">
              <span className="h-2 w-2 rounded-full bg-success" />
              Entorno operativo
            </div>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="h-10 gap-2 px-2 hover:bg-card">
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-xs font-bold text-primary-foreground">
                  {userInitial}
                </span>
                <span className="hidden max-w-48 truncate text-sm sm:block">{user.email}</span>
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>
                <span className="block text-xs font-normal text-muted-foreground">
                  Sesión activa
                </span>
                <span className="mt-1 block truncate text-sm">{user.email}</span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={signOut}
                className="text-destructive focus:text-destructive"
              >
                <LogOut className="mr-2 h-4 w-4" />
                Cerrar sesión
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <main className="mx-auto w-full max-w-[1500px] px-4 py-7 sm:px-6 lg:px-8 lg:py-9">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
