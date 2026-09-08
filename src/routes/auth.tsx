import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BrandBadge } from "@/components/brand/BrandMark";
import { toast } from "sonner";
import { Mail, Lock } from "lucide-react";

export const Route = createFileRoute("/auth")({
  ssr: false,
  component: AuthPage,
});

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
    toast.success("Bienvenido");
    navigate({ to: "/dashboard" });
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4">
      <div
        aria-hidden
        className="glow-primary pointer-events-none absolute -right-40 -top-40 h-[520px] w-[520px] rounded-full blur-3xl"
      />
      <div
        aria-hidden
        className="glow-accent pointer-events-none absolute -left-40 bottom-0 h-[420px] w-[420px] rounded-full blur-3xl"
      />

      <div className="animate-in fade-in slide-in-from-bottom-2 relative z-10 w-full max-w-md duration-500">
        {/* Brand Header */}
        <div className="mb-8 flex flex-col items-center gap-4">
          <BrandBadge size="md" />
          <div className="text-center">
            <h1 className="font-display text-2xl font-bold text-foreground">
              Panel de administración
            </h1>
            <p className="text-sm text-muted-foreground">Onboarding de WhatsApp Business</p>
          </div>
        </div>

        {/* Login Card */}
        <Card className="border-border/60 bg-card/80 shadow-glow-primary backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="font-display text-xl">Acceso administrador</CardTitle>
            <CardDescription>
              Solo administradores pueden gestionar clientes y conexiones.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    className="h-11 pl-9"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Contraseña</Label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="password"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    className="h-11 pl-9"
                  />
                </div>
              </div>
              <Button
                type="submit"
                size="xl"
                className="w-full bg-accent text-accent-foreground hover:bg-accent/90"
                disabled={loading}
              >
                {loading ? "Entrando…" : "Entrar"}
              </Button>
            </form>
            <p className="mt-6 text-xs text-muted-foreground">
              El registro público está desactivado. Un administrador debe crear tu usuario desde el
              servidor mediante el procedimiento de administración.
            </p>
          </CardContent>
        </Card>

        {/* Footer */}
        <div className="mt-8 text-center">
          <p className="text-xs text-muted-foreground">
            Powered by <span className="font-semibold text-accent">Vilo AI Studio</span> ×{" "}
            <span className="font-semibold text-primary">Búho Solutions</span>
          </p>
        </div>
      </div>
    </div>
  );
}
