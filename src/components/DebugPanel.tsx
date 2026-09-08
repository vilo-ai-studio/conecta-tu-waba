import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { listMetaEvents, listN8nForwards, listWhatsAppSends } from "@/lib/debug-logs.functions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RefreshCw, ChevronDown, ChevronRight, Bug } from "lucide-react";

function fmtTime(iso: string) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function StatusBadge({ ok, label }: { ok: boolean | null | undefined; label: string }) {
  return (
    <Badge variant={ok ? "default" : ok === false ? "destructive" : "secondary"}>{label}</Badge>
  );
}

function CollapsibleJSON({ data, label = "Ver detalle" }: { data: any; label?: string }) {
  const [open, setOpen] = useState(false);
  if (data == null) return null;
  return (
    <div className="mt-2">
      <button
        type="button"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {label}
      </button>
      {open && (
        <pre className="mt-1 max-h-72 overflow-auto rounded-md bg-muted/50 p-2 text-[10px] leading-tight">
          {typeof data === "string" ? data : JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function DebugPanel({ clientId }: { clientId: string }) {
  const listMeta = useServerFn(listMetaEvents);
  const listFwd = useServerFn(listN8nForwards);
  const listSends = useServerFn(listWhatsAppSends);

  const metaQ = useQuery({
    queryKey: ["debug-meta", clientId],
    queryFn: () => listMeta({ data: { client_id: clientId, limit: 100 } }),
    refetchInterval: 5_000,
  });
  const fwdQ = useQuery({
    queryKey: ["debug-fwd", clientId],
    queryFn: () => listFwd({ data: { client_id: clientId, limit: 100 } }),
    refetchInterval: 5_000,
  });
  const sendQ = useQuery({
    queryKey: ["debug-send", clientId],
    queryFn: () => listSends({ data: { client_id: clientId, limit: 100 } }),
    refetchInterval: 5_000,
  });

  const refreshAll = () => {
    metaQ.refetch();
    fwdQ.refetch();
    sendQ.refetch();
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Bug className="h-4 w-4 text-primary" />
              Debug operativo
            </CardTitle>
            <CardDescription>
              Todo lo que entra desde Meta, todo lo que sale a n8n y todo lo que sale a Meta. En
              vivo.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={refreshAll}>
            <RefreshCw className="mr-1 h-3 w-3" /> Refrescar
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="meta">
          <TabsList>
            <TabsTrigger value="meta">
              Entradas desde Meta {metaQ.data ? `(${metaQ.data.length})` : ""}
            </TabsTrigger>
            <TabsTrigger value="fwd">
              Reenvíos a n8n {fwdQ.data ? `(${fwdQ.data.length})` : ""}
            </TabsTrigger>
            <TabsTrigger value="send">
              Envíos a Meta {sendQ.data ? `(${sendQ.data.length})` : ""}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="meta" className="mt-4 space-y-2">
            {metaQ.isLoading && (
              <div className="space-y-2">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            )}
            {!metaQ.isLoading && (metaQ.data ?? []).length === 0 && (
              <p className="text-sm text-muted-foreground">
                Aún no hay eventos entrantes desde Meta.
              </p>
            )}
            {(metaQ.data ?? []).map((e: any) => (
              <div key={e.id} className="rounded-md border bg-muted/30 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{e.event_kind ?? "—"}</Badge>
                  {e.status && (
                    <Badge variant={e.status === "failed" ? "destructive" : "secondary"}>
                      {e.status}
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground">{fmtTime(e.received_at)}</span>
                  {e.processing_error && <Badge variant="destructive">error</Badge>}
                </div>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                  <dt>phone_number_id</dt>
                  <dd className="font-mono text-foreground break-all">
                    {e.phone_number_id ?? "—"}
                  </dd>
                  <dt>from</dt>
                  <dd className="font-mono text-foreground">{e.from_wa_id ?? "—"}</dd>
                  <dt>message_id</dt>
                  <dd className="font-mono text-foreground break-all">{e.wa_message_id ?? "—"}</dd>
                  <dt>tipo</dt>
                  <dd className="text-foreground">{e.message_type ?? "—"}</dd>
                </dl>
                {e.text_body && <p className="mt-1 text-xs italic">"{e.text_body}"</p>}
                {(e.error_message || e.error_code) && (
                  <p className="mt-1 text-xs text-destructive">
                    {e.error_code ? `[${e.error_code}] ` : ""}
                    {e.error_message}
                  </p>
                )}
                {e.processing_error && (
                  <p className="mt-1 text-xs text-destructive">{e.processing_error}</p>
                )}
                <CollapsibleJSON data={e.raw_payload} label="Ver payload raw" />
              </div>
            ))}
          </TabsContent>

          <TabsContent value="fwd" className="mt-4 space-y-2">
            {fwdQ.isLoading && (
              <div className="space-y-2">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            )}
            {!fwdQ.isLoading && (fwdQ.data ?? []).length === 0 && (
              <p className="text-sm text-muted-foreground">Aún no hay reenvíos a n8n.</p>
            )}
            {(fwdQ.data ?? []).map((f: any) => (
              <div key={f.id} className="rounded-md border bg-muted/30 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge ok={f.success} label={f.success ? "success" : "error"} />
                  {f.response_status != null && (
                    <Badge variant="outline">HTTP {f.response_status}</Badge>
                  )}
                  <span className="text-xs text-muted-foreground">{fmtTime(f.attempted_at)}</span>
                </div>
                <p className="mt-1 truncate text-xs font-mono">{f.n8n_webhook_url}</p>
                {f.error_message && (
                  <p className="mt-1 text-xs text-destructive break-all">{f.error_message}</p>
                )}
                <CollapsibleJSON data={f.request_payload} label="Ver request" />
                <CollapsibleJSON data={f.response_body} label="Ver response" />
              </div>
            ))}
          </TabsContent>

          <TabsContent value="send" className="mt-4 space-y-2">
            {sendQ.isLoading && (
              <div className="space-y-2">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            )}
            {!sendQ.isLoading && (sendQ.data ?? []).length === 0 && (
              <p className="text-sm text-muted-foreground">Aún no hay envíos hacia Meta.</p>
            )}
            {(sendQ.data ?? []).map((s: any) => (
              <div key={s.id} className="rounded-md border bg-muted/30 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge
                    ok={s.success}
                    label={s.meta_message_status ?? (s.success ? "ok" : "error")}
                  />
                  {s.response_status != null && (
                    <Badge variant="outline">HTTP {s.response_status}</Badge>
                  )}
                  <Badge variant="outline" className="text-[10px]">
                    {s.source}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{fmtTime(s.created_at)}</span>
                </div>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                  <dt>to</dt>
                  <dd className="font-mono text-foreground">{s.to_wa_id ?? "—"}</dd>
                  <dt>meta_message_id</dt>
                  <dd className="font-mono text-foreground break-all">
                    {s.meta_message_id ?? "—"}
                  </dd>
                  <dt>fbtrace_id</dt>
                  <dd className="font-mono text-foreground break-all">{s.fbtrace_id ?? "—"}</dd>
                  <dt>error_code</dt>
                  <dd className="text-foreground">{s.error_code ?? "—"}</dd>
                </dl>
                {s.message_preview && <p className="mt-1 text-xs italic">"{s.message_preview}"</p>}
                {s.error_message && (
                  <p className="mt-1 text-xs text-destructive break-all">
                    {s.error_type ? `[${s.error_type}] ` : ""}
                    {s.error_message}
                  </p>
                )}
                <CollapsibleJSON data={s.request_payload} label="Ver request" />
                <CollapsibleJSON data={s.response_body} label="Ver respuesta Meta" />
              </div>
            ))}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
