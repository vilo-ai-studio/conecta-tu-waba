import { useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { listChatwootLogs } from "@/lib/chatwoot-logs.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Copy,
  ArrowDownToLine,
  ArrowUpFromLine,
  Radio,
  AlertTriangle,
  CircleSlash,
  CheckCircle2,
  MessagesSquare,
  Inbox,
} from "lucide-react";
import { toast } from "sonner";

type Row = {
  id: string;
  created_at: string;
  event_type: string;
  direction: string | null;
  status: string | null;
  wa_id: string | null;
  chatwoot_contact_id: string | null;
  chatwoot_conversation_id: string | null;
  chatwoot_message_id: string | null;
  http_status: number | null;
  error_message: string | null;
  request_payload: any;
  response_payload: any;
};

const FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "Todos" },
  { key: "inbound", label: "Inbound" },
  { key: "outbound", label: "Outbound bot" },
  { key: "agent", label: "Agente humano" },
  { key: "ignored", label: "Ignorados" },
  { key: "errors", label: "Errores" },
];

function eventBadge(evt: string, status: string | null) {
  const map: Record<string, { label: string; className: string; icon?: any }> = {
    inbound_synced: {
      label: "inbound_synced",
      className: "bg-success/15 text-success border-success/30",
      icon: ArrowDownToLine,
    },
    outbound_mirrored: {
      label: "outbound_mirrored",
      className: "bg-opal/15 text-opal border-opal/30",
      icon: ArrowUpFromLine,
    },
    agent_message_sent: {
      label: "agent_message_sent",
      className: "bg-accent/15 text-accent border-accent/30",
      icon: ArrowUpFromLine,
    },
    webhook_ignored_bot_mirror: {
      label: "loop_prevented",
      className: "bg-warning/15 text-warning border-warning/30",
      icon: CircleSlash,
    },
    webhook_ignored_not_outgoing: {
      label: "ignored (not outgoing)",
      className: "bg-muted text-muted-foreground",
      icon: CircleSlash,
    },
    webhook_ignored_non_agent: {
      label: "ignored (non-agent)",
      className: "bg-muted text-muted-foreground",
      icon: CircleSlash,
    },
    webhook_duplicate: {
      label: "duplicate_ignored",
      className: "bg-warning/15 text-warning border-warning/30",
      icon: CircleSlash,
    },
    test_connection: {
      label: "test_connection",
      className: "bg-muted text-muted-foreground",
    },
  };
  const m = map[evt] ?? {
    label: evt,
    className:
      status === "error"
        ? "bg-destructive/20 text-destructive-foreground border-destructive/40"
        : "bg-muted text-muted-foreground",
    icon: status === "error" ? AlertTriangle : undefined,
  };
  const Icon = m.icon;
  return (
    <Badge className={`gap-1 ${m.className}`} variant="outline">
      {Icon ? <Icon className="h-3 w-3" /> : null}
      {m.label}
    </Badge>
  );
}

export function ChatwootLogsCard({ clientId }: { clientId: string }) {
  const load = useServerFn(listChatwootLogs);
  const [group, setGroup] = useState("all");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [live, setLive] = useState(true);
  const pulse = false;

  const query = useQuery({
    queryKey: ["chatwoot-logs", clientId, group],
    queryFn: () => load({ data: { client_id: clientId, group, limit: 200 } }),
    refetchOnWindowFocus: false,
    refetchInterval: live ? 3_000 : false,
  });

  const rows = (query.data as Row[] | undefined) ?? [];
  const stats = useMemo(() => {
    const total = rows.length;
    const ok = rows.filter((r) => r.status === "success").length;
    const err = rows.filter((r) => r.status === "error").length;
    const ign = rows.filter((r) => r.status === "ignored").length;
    return { total, ok, err, ign };
  }, [rows]);

  const copyRow = (r: Row) => {
    navigator.clipboard.writeText(JSON.stringify(r, null, 2));
    toast.success("Payload copiado (sin tokens)");
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <MessagesSquare className="h-4 w-4 text-primary" />
              Monitoreo Chatwoot
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                  live
                    ? "border-success/40 bg-success/10 text-success"
                    : "border-muted-foreground/30 bg-muted text-muted-foreground"
                }`}
              >
                <Radio className={`h-3 w-3 ${live && pulse ? "animate-ping" : ""}`} />
                {live ? "En vivo" : "Pausado"}
              </span>
            </CardTitle>
            <CardDescription>
              Eventos de la integración Chatwoot para este cliente. Los payloads se muestran sin
              tokens ni cabeceras <code>Authorization</code>.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1 rounded-md border p-0.5 text-xs">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setGroup(f.key)}
                  className={`rounded px-2 py-1 ${
                    group === f.key ? "bg-primary text-primary-foreground" : "hover:bg-muted"
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
              disabled={query.isFetching}
              onClick={() => query.refetch()}
            >
              <RefreshCw className={`mr-1 h-3 w-3 ${query.isFetching ? "animate-spin" : ""}`} />
              Recargar
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap gap-3 pt-2 text-xs text-muted-foreground">
          <span>
            Total: <span className="font-medium text-foreground">{stats.total}</span>
          </span>
          <span>
            Éxitos: <span className="font-medium text-success">{stats.ok}</span>
          </span>
          <span>
            Ignorados: <span className="font-medium text-warning">{stats.ign}</span>
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
              Aún no hay eventos de Chatwoot para este cliente
              {group !== "all" ? " con ese filtro" : ""}.
            </p>
          </div>
        ) : (
          <div className="divide-y rounded-md border">
            {rows.map((r) => {
              const isOpen = !!expanded[r.id];
              const isErr = r.status === "error";
              const isIgn = r.status === "ignored";
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
                        {eventBadge(r.event_type, r.status)}
                        {r.status && (
                          <Badge variant="outline" className="text-[10px]">
                            {isErr ? (
                              <AlertTriangle className="mr-1 h-3 w-3 text-destructive" />
                            ) : isIgn ? (
                              <CircleSlash className="mr-1 h-3 w-3" />
                            ) : (
                              <CheckCircle2 className="mr-1 h-3 w-3 text-success" />
                            )}
                            {r.status}
                          </Badge>
                        )}
                        {r.direction && (
                          <Badge variant="outline" className="text-[10px]">
                            {r.direction}
                          </Badge>
                        )}
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
                        {r.wa_id && (
                          <span>
                            <span className="text-muted-foreground">wa:</span>{" "}
                            <code>+{r.wa_id}</code>
                          </span>
                        )}
                        {r.chatwoot_conversation_id && (
                          <span>
                            <span className="text-muted-foreground">conv:</span>{" "}
                            <code>{r.chatwoot_conversation_id}</code>
                          </span>
                        )}
                        {r.chatwoot_message_id && (
                          <span>
                            <span className="text-muted-foreground">msg:</span>{" "}
                            <code>{r.chatwoot_message_id}</code>
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
                        <span className="text-muted-foreground">Detalle</span>
                        <Button variant="ghost" size="sm" onClick={() => copyRow(r)}>
                          <Copy className="mr-1 h-3 w-3" /> Copiar
                        </Button>
                      </div>

                      <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
                        <dt className="text-muted-foreground">ID</dt>
                        <dd className="font-mono break-all">{r.id}</dd>
                        <dt className="text-muted-foreground">event_type</dt>
                        <dd className="font-mono break-all">{r.event_type}</dd>
                        <dt className="text-muted-foreground">contact_id</dt>
                        <dd className="font-mono break-all">{r.chatwoot_contact_id ?? "—"}</dd>
                        <dt className="text-muted-foreground">conversation_id</dt>
                        <dd className="font-mono break-all">{r.chatwoot_conversation_id ?? "—"}</dd>
                        <dt className="text-muted-foreground">message_id</dt>
                        <dd className="font-mono break-all">{r.chatwoot_message_id ?? "—"}</dd>
                        <dt className="text-muted-foreground">http_status</dt>
                        <dd>{r.http_status ?? "—"}</dd>
                      </dl>

                      {r.request_payload != null && (
                        <div>
                          <p className="mb-1 text-muted-foreground">Request</p>
                          <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border bg-background/60 p-2 text-[11px]">
                            {JSON.stringify(r.request_payload, null, 2)}
                          </pre>
                        </div>
                      )}
                      {r.response_payload != null && (
                        <div>
                          <p className="mb-1 text-muted-foreground">Response</p>
                          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border bg-background/60 p-2 text-[11px]">
                            {JSON.stringify(r.response_payload, null, 2)}
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
