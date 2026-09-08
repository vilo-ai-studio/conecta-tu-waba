import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BrandMark } from "@/components/brand/BrandMark";
import { toast } from "sonner";
import { Activity, ArrowRight, Lock, Mail, Network, ShieldCheck } from "lucide-react";

export const Route = createFileRoute("/auth")({
  ssr: false,
  component: AuthPage,
});

const systemPoints = [
  { icon: Network, label: "Enrutamiento por cliente" },
  { icon: Activity, label: "Monitoreo de entregas y webhooks" },
  { icon: ShieldCheck, label: "Credenciales protegidas en el servidor" },
];

function AuthPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    authClient.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/dashboard" });
    });
  }, [navigate]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { error } = await authClient.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      toast.error("No se pudo iniciar sesión", { description: error.message });
      return;
    }
    navigate({ to: "/dashboard" });
  };

  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-[minmax(0,1.15fr)_minmax(440px,0.85fr)]">
      <section className="relative hidden overflow-hidden border-r border-border bg-sidebar px-12 py-10 lg:flex lg:flex-col">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_12%_15%,rgba(30,74,149,0.24),transparent_34%),radial-gradient(circle_at_80%_85%,rgba(231,254,83,0.08),transparent_28%)]" />
        <div className="relative z-10">
          <BrandMark size="md" />
        </div>

        <div className="relative z-10 my-auto max-w-xl py-16">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-success/25 bg-success/10 px-3 py-1.5 text-xs font-semibold text-success">
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            Infraestructura operativa
          </div>
          <p className="mb-3 text-sm font-semibold uppercase tracking-[0.18em] text-accent">
            Control de conexiones
          </p>
          <h1 className="max-w-lg font-display text-4xl font-semibold leading-tight text-foreground xl:text-5xl">
            Una sola operación para todas tus cuentas de WhatsApp.
          </h1>
          <p className="mt-5 max-w-lg text-base leading-7 text-muted-foreground">
            Administra clientes, conexiones con Meta y destinos de automatización desde un panel
            privado construido para operación diaria.
          </p>

          <div className="mt-10 space-y-3">
            {systemPoints.map(({ icon: Icon, label }) => (
              <div key={label} className="flex items-center gap-3 text-sm text-foreground/85">
                <span className="grid h-9 w-9 place-items-center rounded-lg border border-border bg-white/[0.04]">
                  <Icon className="h-4 w-4 text-accent" />
                </span>
                {label}
              </div>
            ))}
          </div>
        </div>

        <p className="relative z-10 text-xs text-muted-foreground">
          Portal privado · Acceso exclusivo para operadores autorizados
        </p>
      </section>

      <main className="flex min-h-screen items-center justify-center px-6 py-12 sm:px-10">
        <div className="w-full max-w-md">
          <div className="mb-10 lg:hidden">
            <BrandMark size="md" />
          </div>

          <div className="mb-8">
            <div className="mb-5 grid h-11 w-11 place-items-center rounded-xl border border-border bg-card shadow-sm">
              <Lock className="h-5 w-5 text-accent" />
            </div>
            <p className="text-sm font-medium text-accent">Portal de administración</p>
            <h2 className="mt-2 font-display text-3xl font-semibold text-foreground">
              Inicia sesión
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Ingresa tus credenciales para acceder al centro de control.
            </p>
          </div>

          <form onSubmit={handleLogin} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email">Correo electrónico</Label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  placeholder="nombre@empresa.com"
                  className="h-12 bg-card pl-10"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Contraseña</Label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="password"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  className="h-12 bg-card pl-10"
                />
              </div>
            </div>
            <Button type="submit" size="xl" className="h-12 w-full" disabled={loading}>
              {loading ? "Validando acceso…" : "Entrar al centro de control"}
              {!loading && <ArrowRight className="ml-2 h-4 w-4" />}
            </Button>
          </form>

          <div className="mt-8 flex items-start gap-3 rounded-xl border border-border bg-card/50 p-4">
            <ShieldCheck className="mt-0.5 h-4 w-4 flex-none text-success" />
            <p className="text-xs leading-5 text-muted-foreground">
              El registro público está desactivado. Los accesos se administran directamente desde la
              infraestructura privada.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
