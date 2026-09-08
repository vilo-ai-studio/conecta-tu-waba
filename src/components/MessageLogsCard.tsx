import { useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { listMessageLogs } from "@/lib/message-logs.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Copy,
  CheckCircle2,
  XCircle,
  Radio,
  ScrollText,
  Inbox,
} from "lucide-react";
import { toast } from "sonner";

type LogRow = {
  id: string;
  client_id: string;
  phone_number_id: string | null;
  to: string;
  message_preview: string | null;
  status: string;
  meta_message_id: string | null;
  error_message: string | null;
  raw_response: any;
  request_payload: any;
  http_status: number | null;
  source: string;
  created_at: string;
};

const STATUS_FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "Todos" },
  { key: "success", label: "Exitosos" },
  { key: "error", label: "Errores" },
];

export function MessageLogsCard({ clientId }: { clientId: string }) {
  const load = useServerFn(listMessageLogs);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [live, setLive] = useState(true);
  const pulse = false;

  const query = useQuery({
    queryKey: ["message-logs", clientId, statusFilter],
    queryFn: () => load({ data: { client_id: clientId, limit: 200, status: statusFilter } }),
    refetchOnWindowFocus: false,
    refetchInterval: live ? 3_000 : false,
  });

  const rows = (query.data as LogRow[] | undefined) ?? [];

  const stats = useMemo(() => {
    const total = rows.length;
    const ok = rows.filter((r) => r.status === "success").length;
    const err = rows.filter((r) => r.status === "error").length;
    return { total, ok, err };
  }, [rows]);

  const copyRaw = (row: LogRow) => {
    const text = JSON.stringify(
      {
        created_at: row.created_at,
        source: row.source,
        to: row.to,
        status: row.status,
        http_status: row.http_status,
        meta_message_id: row.meta_message_id,
        error_message: row.error_message,
        request_payload: row.request_payload,
        raw_response: row.raw_response,
      },
      null,
      2,
    );
    navigator.clipboard.writeText(text);
    toast.success("Log copiado");
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ScrollText className="h-4 w-4 text-primary" />
              Módulo de logs
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                  live
                    ? "border-success/40 bg-success/10 text-success"
                    : "border-muted-foreground/30 bg-muted text-muted-foreground"
                }`}
                title={live ? "Escuchando en tiempo real" : "En vivo desactivado"}
              >
                <Radio className={`h-3 w-3 ${live && pulse ? "animate-ping" : ""}`} />
                {live ? "En vivo" : "Pausado"}
              </span>
            </CardTitle>
            <CardDescription>
              Cada envío (panel o n8n) queda registrado con la respuesta completa de Meta. Filtra
              por estado y expande cada fila para ver el error exacto.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1 rounded-md border p-0.5 text-xs">
              {STATUS_FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setStatusFilter(f.key)}
                  className={`rounded px-2 py-1 ${
                    statusFilter === f.key ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <Button variant="outline" size="sm" onClick={() => setLive((v) => !v)}>
              {live ? "Pausar" : "Reanudar"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => query.refetch()}
              disabled={query.isFetching}
            >
              <RefreshCw className={`mr-1 h-3 w-3 ${query.isFetching ? "animate-spin" : ""}`} />
              Recargar
            </Button>
          </div>
        </div>
        <div className="flex gap-3 pt-2 text-xs text-muted-foreground">
          <span>
            Total: <span className="font-medium text-foreground">{stats.total}</span>
          </span>
          <span>
            Éxitos: <span className="font-medium text-success">{stats.ok}</span>
          </span>
          <span>
            Errores: <span className="font-medium text-destructive">{stats.err}</span>
          </span>
        </div>
      </CardHeader>
      <CardContent>
        {query.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center">
            <Inbox className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Aún no hay envíos registrados{statusFilter !== "all" ? " con ese filtro" : ""}.
            </p>
          </div>
        ) : (
          <div className="divide-y rounded-md border">
            {rows.map((r) => {
              const isOpen = !!expanded[r.id];
              const isErr = r.status === "error";
              return (
                <div key={r.id} className="text-sm">
                  <button
                    type="button"
                    onClick={() => setExpanded((e) => ({ ...e, [r.id]: !isOpen }))}
                    className="flex w-full items-start gap-2 p-3 text-left hover:bg-muted/50"
                  >
                    {isOpen ? (
                      <ChevronDown className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
                    )}
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {r.status === "deduped" ? (
                          <Badge className="gap-1 border-warning/30 bg-warning/15 text-warning hover:bg-warning/15">
                            <CheckCircle2 className="h-3 w-3" /> reply_deduped
                          </Badge>
                        ) : isErr ? (
                          <Badge variant="destructive" className="gap-1">
                            <XCircle className="h-3 w-3" /> failed
                          </Badge>
                        ) : (
                          <Badge className="gap-1 border-success/30 bg-success/15 text-success hover:bg-success/15">
                            <CheckCircle2 className="h-3 w-3" /> replied
                          </Badge>
                        )}
                        <Badge variant="outline" className="text-[10px]">
                          {r.source}
                        </Badge>
                        {r.http_status != null && (
                          <span className="text-[11px] text-muted-foreground">
                            HTTP {r.http_status}
                          </span>
                        )}
                        <span className="text-[11px] text-muted-foreground">
                          {new Date(r.created_at).toLocaleString()}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
                        <span className="text-muted-foreground">→</span>
                        <code className="text-foreground">+{r.to}</code>
                        {r.message_preview && (
                          <span className="truncate text-muted-foreground">
                            "{r.message_preview}"
                          </span>
                        )}
                      </div>
                      {isErr && r.error_message && (
                        <p className="text-xs text-destructive break-all">{r.error_message}</p>
                      )}
                    </div>
                  </button>

                  {isOpen && (
                    <div className="space-y-3 border-t bg-muted/30 p-3 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Detalle completo</span>
                        <Button variant="ghost" size="sm" onClick={() => copyRaw(r)}>
                          <Copy className="mr-1 h-3 w-3" /> Copiar
                        </Button>
                      </div>

                      <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
                        <dt className="text-muted-foreground">ID log</dt>
                        <dd className="font-mono break-all">{r.id}</dd>
                        <dt className="text-muted-foreground">phone_number_id</dt>
                        <dd className="font-mono break-all">{r.phone_number_id ?? "—"}</dd>
                        <dt className="text-muted-foreground">meta_message_id</dt>
                        <dd className="font-mono break-all">{r.meta_message_id ?? "—"}</dd>
                        <dt className="text-muted-foreground">http_status</dt>
                        <dd>{r.http_status ?? "—"}</dd>
                      </dl>

                      {r.request_payload && (
                        <div>
                          <p className="mb-1 text-muted-foreground">Request enviado a Meta</p>
                          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border bg-background/60 p-2 text-[11px]">
                            {JSON.stringify(r.request_payload, null, 2)}
                          </pre>
                        </div>
                      )}
                      {r.raw_response && (
                        <div>
                          <p className="mb-1 text-muted-foreground">
                            Respuesta cruda de Meta{" "}
                            {isErr &&
                              "(revisa aquí si falta método de pago, plantilla no aprobada, número no en ventana 24h, etc.)"}
                          </p>
                          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border bg-background/60 p-2 text-[11px]">
                            {JSON.stringify(r.raw_response, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
