import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { listClients, createClient, deleteClient } from "@/lib/admin.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";
import { StatusBadge } from "@/components/StatusBadge";
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  CheckCircle2,
  CircleDashed,
  Plus,
  RouteIcon,
  Trash2,
  Users,
  Webhook,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: Dashboard,
});

type ClientRow = {
  id: string;
  name: string;
  email: string | null;
  company_name: string | null;
  status: string;
  n8n_enabled?: boolean;
  created_at: string;
  whatsapp_accounts?: Array<{
    id: string;
    status: string;
    display_phone_number: string | null;
    verified_name: string | null;
    waba_id: string | null;
    phone_number_id: string | null;
    webhook_subscribed: boolean;
  }>;
};

function Dashboard() {
  const list = useServerFn(listClients);
  const router = useRouter();
  const { data, isLoading } = useQuery({ queryKey: ["clients"], queryFn: () => list() });
  const [open, setOpen] = useState(false);
  const clients = (data ?? []) as ClientRow[];
  const connected = clients.filter((client) => client.status === "connected").length;
  const pending = clients.filter((client) =>
    ["pending", "onboarding_started", "in_progress"].includes(client.status),
  ).length;
  const attention = clients.filter((client) =>
    ["error", "onboarding_error"].includes(client.status),
  ).length;
  const routesEnabled = clients.filter((client) => client.n8n_enabled).length;

  return (
    <div className="space-y-7">
      <section className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">
            Centro de control
          </p>
          <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-foreground">
            Clientes y rutas
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Supervisa las conexiones de WhatsApp y administra el destino de cada cliente desde un
            solo lugar.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="lg">
              <Plus className="mr-2 h-4 w-4" />
              Agregar cliente
            </Button>
          </DialogTrigger>
          <NewClientDialog
            onDone={() => {
              setOpen(false);
              router.invalidate();
            }}
          />
        </Dialog>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Resumen operativo">
        <MetricCard
          label="Clientes totales"
          value={clients.length}
          detail="Registrados en el router"
          icon={Building2}
          loading={isLoading}
        />
        <MetricCard
          label="Conectados"
          value={connected}
          detail="WhatsApp listo para operar"
          icon={CheckCircle2}
          tone="success"
          loading={isLoading}
        />
        <MetricCard
          label="En configuración"
          value={pending}
          detail="Pendientes de completar"
          icon={CircleDashed}
          tone="warning"
          loading={isLoading}
        />
        <MetricCard
          label="Rutas activas"
          value={routesEnabled}
          detail={attention > 0 ? `${attention} requieren atención` : "Sin incidencias registradas"}
          icon={attention > 0 ? AlertTriangle : RouteIcon}
          tone={attention > 0 ? "danger" : "primary"}
          loading={isLoading}
        />
      </section>

      <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="flex flex-col justify-between gap-2 border-b border-border px-5 py-4 sm:flex-row sm:items-center">
          <div>
            <h2 className="font-display text-base font-semibold">Directorio operativo</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Estado de conexión y enrutamiento de cada cliente.
            </p>
          </div>
          {!isLoading && clients.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {clients.length} {clients.length === 1 ? "registro" : "registros"}
            </span>
          )}
        </div>

        {isLoading && (
          <div className="space-y-3 p-5">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        )}

        {!isLoading && clients.length === 0 && (
          <div className="p-5">
            <EmptyState
              icon={Users}
              title="Todavía no hay clientes"
              description="Agrega el primero para configurar su conexión, credenciales y ruta de automatización."
            />
          </div>
        )}

        {!isLoading && clients.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[850px] text-left">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <th className="px-5 py-3">Cliente</th>
                  <th className="px-5 py-3">Cuenta de WhatsApp</th>
                  <th className="px-5 py-3">Ruta</th>
                  <th className="px-5 py-3">Estado</th>
                  <th className="w-24 px-5 py-3 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {clients.map((client) => {
                  const wa = client.whatsapp_accounts?.[0];
                  return (
                    <tr key={client.id} className="group transition-colors hover:bg-muted/25">
                      <td className="px-5 py-4">
                        <Link
                          to="/clients/$id"
                          params={{ id: client.id }}
                          className="flex items-center gap-3"
                        >
                          <span className="grid h-10 w-10 flex-none place-items-center rounded-lg border border-primary/20 bg-primary/10 font-display text-sm font-bold text-primary">
                            {client.name?.[0]?.toUpperCase() ?? "?"}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold text-foreground group-hover:text-accent">
                              {client.company_name || client.name}
                            </span>
                            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                              {client.company_name ? client.name : client.email || "Sin contacto"}
                            </span>
                          </span>
                        </Link>
                      </td>
                      <td className="px-5 py-4">
                        <p className="text-sm text-foreground">
                          {wa?.display_phone_number || "Sin número conectado"}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {wa?.verified_name ||
                            (wa ? "Identidad por validar" : "Onboarding pendiente")}
                        </p>
                      </td>
                      <td className="px-5 py-4">
                        <span className="inline-flex items-center gap-2 text-sm">
                          <Webhook
                            className={`h-4 w-4 ${client.n8n_enabled ? "text-success" : "text-muted-foreground"}`}
                          />
                          {client.n8n_enabled ? "Automatización activa" : "Sin destino activo"}
                        </span>
                      </td>
                      <td className="px-5 py-4">
                        <StatusBadge status={client.status} />
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="icon" asChild aria-label="Abrir cliente">
                            <Link to="/clients/$id" params={{ id: client.id }}>
                              <ArrowRight className="h-4 w-4" />
                            </Link>
                          </Button>
                          <DeleteClientButton
                            id={client.id}
                            name={client.name}
                            onDone={() => router.invalidate()}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
  tone = "primary",
  loading,
}: {
  label: string;
  value: number;
  detail: string;
  icon: typeof Building2;
  tone?: "primary" | "success" | "warning" | "danger";
  loading: boolean;
}) {
  const toneClass = {
    primary: "bg-primary/10 text-primary",
    success: "bg-success/10 text-success",
    warning: "bg-warning/10 text-warning",
    danger: "bg-destructive/10 text-destructive",
  }[tone];

  return (
    <Card className="border-border bg-card shadow-sm">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            {loading ? (
              <Skeleton className="mt-3 h-8 w-12" />
            ) : (
              <p className="mt-2 font-display text-3xl font-semibold tracking-tight">{value}</p>
            )}
          </div>
          <span className={`grid h-10 w-10 place-items-center rounded-lg ${toneClass}`}>
            <Icon className="h-5 w-5" />
          </span>
        </div>
        <p className="mt-4 text-[11px] text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}

function DeleteClientButton({
  id,
  name,
  onDone,
}: {
  id: string;
  name: string;
  onDone: () => void;
}) {
  const del = useServerFn(deleteClient);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const handleDelete = async () => {
    setLoading(true);
    try {
      await del({ data: { id } });
      toast.success("Cliente eliminado");
      setOpen(false);
      onDone();
    } catch (err: unknown) {
      toast.error("Error al eliminar", {
        description: err instanceof Error ? err.message : "Error desconocido",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>¿Eliminar cliente?</AlertDialogTitle>
          <AlertDialogDescription>
            Se eliminará <strong>{name}</strong> junto con sus enlaces de onboarding y cuentas de
            WhatsApp asociadas. Esta acción no se puede deshacer.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={loading}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {loading ? "Eliminando…" : "Eliminar"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function NewClientDialog({ onDone }: { onDone: () => void }) {
  const create = useServerFn(createClient);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await create({ data: { name, email, company_name: company } });
      toast.success("Cliente creado");
      onDone();
    } catch (err: unknown) {
      toast.error("Error al crear cliente", {
        description: err instanceof Error ? err.message : "Error desconocido",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Agregar cliente</DialogTitle>
        <DialogDescription>
          Crea el registro operativo. Después podrás conectar WhatsApp y configurar su destino.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="company">Empresa</Label>
          <Input
            id="company"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            maxLength={200}
            placeholder="Nombre comercial"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="name">Contacto responsable *</Label>
          <Input
            id="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            placeholder="Nombre completo"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">Correo electrónico</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={255}
            placeholder="contacto@empresa.com"
          />
        </div>
        <DialogFooter>
          <Button type="submit" disabled={loading}>
            {loading ? "Creando registro…" : "Crear cliente"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
