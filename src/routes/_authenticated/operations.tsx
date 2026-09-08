import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Database,
  RefreshCw,
  Server,
} from "lucide-react";
import { getOperationsHealth, listWebhookJobs, retryWebhookJob } from "@/lib/operations.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/operations")({ component: OperationsPage });

function formatDate(value: string | null | undefined) {
  if (!value) return "Sin registro";
  return new Intl.DateTimeFormat("es-MX", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

function age(value: string | null | undefined) {
  if (!value) return "Sin pendientes";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1_000));
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} min`;
  return `${Math.floor(seconds / 3_600)} h ${Math.floor((seconds % 3_600) / 60)} min`;
}

function OperationsPage() {
  const healthFn = useServerFn(getOperationsHealth);
  const jobsFn = useServerFn(listWebhookJobs);
  const retryFn = useServerFn(retryWebhookJob);
  const queryClient = useQueryClient();
  const health = useQuery({
    queryKey: ["operations-health"],
    queryFn: () => healthFn(),
    refetchInterval: 10_000,
  });
  const failures = useQuery({
    queryKey: ["webhook-jobs", "failed"],
    queryFn: () => jobsFn({ data: { status: "failed", limit: 50 } }),
    refetchInterval: 15_000,
  });
  const retry = useMutation({
    mutationFn: (jobId: string) => retryFn({ data: { jobId } }),
    onSuccess: async () => {
      toast.success("Trabajo enviado nuevamente a la cola");
      await queryClient.invalidateQueries({ queryKey: ["operations-health"] });
      await queryClient.invalidateQueries({ queryKey: ["webhook-jobs"] });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "No fue posible reintentar"),
  });

  const state = health.data;
  const metrics = state?.queue;
  const services = [
    { label: "Aplicación", value: state?.application, icon: Server },
    { label: "PostgreSQL", value: state?.postgres, icon: Database },
    { label: "Redis", value: state?.redis, icon: Activity },
    { label: "Worker", value: state?.worker, icon: RefreshCw },
  ];

  return (
    <div className="space-y-7">
      <section className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">
            Infraestructura
          </p>
          <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight">Operación</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Salud del router y seguimiento de la cola que entrega los eventos a cada cliente.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => void health.refetch()}
          disabled={health.isFetching}
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${health.isFetching ? "animate-spin" : ""}`} />
          Actualizar
        </Button>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {services.map(({ label, value, icon: Icon }) => (
          <Card key={label}>
            <CardContent className="flex items-center justify-between p-5">
              <div>
                <p className="text-xs font-medium text-muted-foreground">{label}</p>
                {health.isLoading ? (
                  <Skeleton className="mt-2 h-6 w-20" />
                ) : (
                  <p
                    className={`mt-1 text-sm font-semibold ${value === "ok" ? "text-success" : "text-destructive"}`}
                  >
                    {value === "ok" ? "Disponible" : "Requiere atención"}
                  </p>
                )}
              </div>
              <span
                className={`grid h-10 w-10 place-items-center rounded-lg ${value === "ok" ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}
              >
                <Icon className="h-5 w-5" />
              </span>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <QueueMetric label="Pendientes" value={(metrics?.pending ?? 0) + (metrics?.queued ?? 0)} />
        <QueueMetric label="Procesando" value={metrics?.processing ?? 0} />
        <QueueMetric
          label="Fallidos"
          value={metrics?.failed ?? 0}
          danger={(metrics?.failed ?? 0) > 0}
        />
        <QueueMetric label="Pendiente más antiguo" value={age(metrics?.oldest_pending_at)} />
        <QueueMetric label="Último éxito" value={formatDate(metrics?.last_completed_at)} />
      </section>

      <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="font-display text-base font-semibold">
              Trabajos que requieren atención
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Se conservan para diagnóstico y reintento manual.
            </p>
          </div>
          {(metrics?.failed ?? 0) > 0 && <AlertTriangle className="h-5 w-5 text-destructive" />}
        </div>
        {failures.isLoading ? (
          <div className="space-y-3 p-5">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : (failures.data?.jobs.length ?? 0) === 0 ? (
          <div className="flex items-center gap-3 p-6 text-sm text-muted-foreground">
            <CheckCircle2 className="h-5 w-5 text-success" /> No hay trabajos fallidos.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[850px] text-left text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-5 py-3">Cliente</th>
                  <th className="px-5 py-3">Intentos</th>
                  <th className="px-5 py-3">Error</th>
                  <th className="px-5 py-3">Fecha</th>
                  <th className="px-5 py-3 text-right">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {failures.data?.jobs.map((job) => (
                  <tr key={job.id}>
                    <td className="px-5 py-4 font-medium">
                      {job.client_name ?? "Sin cliente identificado"}
                    </td>
                    <td className="px-5 py-4">
                      {job.attempts} / {job.max_attempts}
                    </td>
                    <td className="max-w-md px-5 py-4 text-muted-foreground">
                      <span className="line-clamp-2">{job.last_error ?? "Sin detalle"}</span>
                    </td>
                    <td className="px-5 py-4 text-muted-foreground">{formatDate(job.failed_at)}</td>
                    <td className="px-5 py-4 text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={retry.isPending}
                        onClick={() => retry.mutate(job.id)}
                      >
                        <RefreshCw className="mr-2 h-3.5 w-3.5" />
                        Reintentar
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Clock3 className="h-3.5 w-3.5" />
        Actualización automática cada 10 segundos.
      </p>
    </div>
  );
}

function QueueMetric({
  label,
  value,
  danger = false,
}: {
  label: string;
  value: number | string;
  danger?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p
          className={`mt-2 font-display text-xl font-semibold ${danger ? "text-destructive" : "text-foreground"}`}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  );
}
