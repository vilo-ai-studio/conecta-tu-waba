import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getClient,
  createOnboardingLink,
  revokeOnboardingLink,
  updateClientN8n,
  sendN8nTestEvent,
} from "@/lib/admin.functions";
import {
  sendTestMessage,
  resubscribeWabaWebhook,
  redirectWabaWebhookToRouter,
  verifyWhatsAppAccountMetaAccess,
} from "@/lib/whatsapp.functions";
import {
  listTestContacts,
  createTestContact,
  deleteTestContact,
} from "@/lib/test-contacts.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ArrowLeft,
  Copy,
  LinkIcon,
  RefreshCw,
  Send,
  AlertTriangle,
  Star,
  Trash2,
  Plus,
  Settings,
  ScrollText,
  MessageSquare,
  Webhook,
  ShieldCheck,
  Bug,
} from "lucide-react";
import { toast } from "sonner";
import { useEffect, useState } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { MessageLogsCard } from "@/components/MessageLogsCard";
import { RawWebhookEventsCard } from "@/components/RawWebhookEventsCard";
import { DebugPanel } from "@/components/DebugPanel";
import { ChatwootIntegrationCard } from "@/components/ChatwootIntegrationCard";
import { ChatwootLogsCard } from "@/components/ChatwootLogsCard";

export const Route = createFileRoute("/_authenticated/clients/$id")({
  component: ClientDetail,
});

function ClientDetail() {
  const { id } = Route.useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const get = useServerFn(getClient);
  const makeLink = useServerFn(createOnboardingLink);
  const revokeLink = useServerFn(revokeOnboardingLink);
  const saveN8n = useServerFn(updateClientN8n);
  const sendTest = useServerFn(sendN8nTestEvent);
  const sendWa = useServerFn(sendTestMessage);
  const resubscribe = useServerFn(resubscribeWabaWebhook);
  const redirectWebhook = useServerFn(redirectWabaWebhookToRouter);
  const verifyMetaAccess = useServerFn(verifyWhatsAppAccountMetaAccess);
  const listContacts = useServerFn(listTestContacts);
  const addContact = useServerFn(createTestContact);
  const removeContact = useServerFn(deleteTestContact);
  const { data, isLoading, error } = useQuery({
    queryKey: ["client", id],
    queryFn: () => get({ data: { id } }),
  });
  const contactsQuery = useQuery({
    queryKey: ["test-contacts", id],
    queryFn: () => listContacts({ data: { client_id: id } }),
  });
  const [generating, setGenerating] = useState(false);
  const [revokingLinkId, setRevokingLinkId] = useState<string | null>(null);
  const [showLinkHistory, setShowLinkHistory] = useState(false);
  const [n8nEnabled, setN8nEnabled] = useState(false);
  const [n8nUrl, setN8nUrl] = useState("");
  const [n8nSecret, setN8nSecret] = useState("");
  const [n8nSaving, setN8nSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [waDialogOpen, setWaDialogOpen] = useState(false);
  const [waTo, setWaTo] = useState("");
  const [waMessage, setWaMessage] = useState("Mensaje de prueba desde el panel");
  const [waSending, setWaSending] = useState(false);
  const [waResult, setWaResult] = useState<
    | { ok: true; message_id: string | null }
    | {
        ok: false;
        error: {
          message: string;
          type?: string | null;
          code?: number | null;
          error_subcode?: number | null;
          fbtrace_id?: string | null;
          http_status?: number | null;
        };
      }
    | null
  >(null);
  const [contactLabel, setContactLabel] = useState("");
  const [savingContact, setSavingContact] = useState(false);
  const [resubscribing, setResubscribing] = useState(false);
  const [redirectingWebhook, setRedirectingWebhook] = useState(false);
  const [redirectWebhookDialogOpen, setRedirectWebhookDialogOpen] = useState(false);
  const [verifyingMetaAccess, setVerifyingMetaAccess] = useState(false);

  const saveCurrentAsContact = async () => {
    const phone = waTo.replace(/[^\d]/g, "");
    if (phone.length < 6) {
      toast.error("Número inválido");
      return;
    }
    if (!contactLabel.trim()) {
      toast.error("Ponle un nombre al contacto");
      return;
    }
    setSavingContact(true);
    try {
      await addContact({ data: { client_id: id, label: contactLabel.trim(), phone: waTo } });
      toast.success("Contacto guardado");
      setContactLabel("");
      queryClient.invalidateQueries({ queryKey: ["test-contacts", id] });
    } catch (err: any) {
      toast.error("Error", { description: err.message });
    } finally {
      setSavingContact(false);
    }
  };

  const removeSavedContact = async (contactId: string) => {
    try {
      await removeContact({ data: { id: contactId } });
      queryClient.invalidateQueries({ queryKey: ["test-contacts", id] });
    } catch (err: any) {
      toast.error("Error", { description: err.message });
    }
  };

  const runSendTest = async () => {
    setWaSending(true);
    setWaResult(null);
    try {
      const res: any = await sendWa({
        data: { client_id: id, to: waTo, message: waMessage, type: "text" },
      });
      setWaResult(res);
      if (res?.ok) toast.success("Mensaje enviado correctamente");
      else toast.error("No se pudo enviar el mensaje", { description: res?.error?.message });
    } catch (err: any) {
      setWaResult({ ok: false, error: { message: err?.message ?? "Error desconocido" } });
      toast.error("Error", { description: err?.message });
    } finally {
      setWaSending(false);
    }
  };

  // Solo inicializamos el estado local UNA vez cuando llegan los datos.
  // Un useEffect con dep [data] machacaba el toggle recién activado en cuanto
  // React Query refrescaba la query (ej. tras invalidateQueries), volviendo la UI a false.
  const [n8nInitialized, setN8nInitialized] = useState(false);
  useEffect(() => {
    if (!data || n8nInitialized) return;
    setN8nEnabled(!!(data as any).n8n_enabled);
    setN8nUrl((data as any).n8n_webhook_url ?? "");
    setN8nSecret("");
    setN8nInitialized(true);
  }, [data, n8nInitialized]);

  const generate = async () => {
    setGenerating(true);
    try {
      await makeLink({ data: { client_id: id } });
      toast.success("Enlace generado", {
        description: "Los enlaces anteriores sin usar se revocaron automáticamente.",
      });
      router.invalidate();
    } catch (err: any) {
      toast.error("Error", { description: err.message });
    } finally {
      setGenerating(false);
    }
  };

  const saveN8nConfig = async () => {
    setN8nSaving(true);
    const payload = {
      id,
      n8n_enabled: n8nEnabled,
      n8n_webhook_url: n8nUrl.trim() || null,
      ...(n8nSecret.trim() ? { n8n_webhook_secret: n8nSecret.trim() } : {}),
    };
    console.log("[saveN8nConfig] enviando", payload);
    try {
      const res: any = await saveN8n({ data: payload });
      console.log("[saveN8nConfig] respuesta del servidor", res);
      if (res) {
        setN8nEnabled(!!res.n8n_enabled);
        setN8nUrl(res.n8n_webhook_url ?? "");
      }
      setN8nSecret("");
      toast.success("Configuración guardada correctamente", {
        description: `n8n_enabled = ${res?.n8n_enabled ? "true" : "false"}`,
      });
      await queryClient.invalidateQueries({ queryKey: ["client", id] });
    } catch (err: any) {
      console.error("[saveN8nConfig] error", err);
      toast.error("No se pudo guardar configuración", { description: err?.message });
    } finally {
      setN8nSaving(false);
    }
  };

  const reloadFromDb = async () => {
    try {
      const fresh: any = await get({ data: { id } });
      queryClient.setQueryData(["client", id], fresh);
      setN8nEnabled(!!fresh.n8n_enabled);
      setN8nUrl(fresh.n8n_webhook_url ?? "");
      setN8nSecret("");
      toast.success("Estado recargado desde BD", {
        description: `n8n_enabled = ${fresh.n8n_enabled ? "true" : "false"}`,
      });
    } catch (err: any) {
      toast.error("Error al recargar", { description: err?.message });
    }
  };

  const runTest = async () => {
    setTesting(true);
    try {
      const res: any = await sendTest({ data: { id } });
      if (res?.ok) toast.success("Evento de prueba enviado", { description: `HTTP ${res.status}` });
      else toast.error("Error en n8n", { description: res?.error ?? "Fallo" });
      await queryClient.invalidateQueries({ queryKey: ["client", id] });
      await queryClient.invalidateQueries({ queryKey: ["debug-fwd", id] });
    } catch (err: any) {
      toast.error("Error", { description: err.message });
    } finally {
      setTesting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-4 w-24" />
        <div className="space-y-2">
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-4 w-48" />
        </div>
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (error || !data)
    return (
      <p className="text-sm text-destructive">{(error as Error)?.message ?? "No encontrado"}</p>
    );

  const wa = (data.whatsapp_accounts as any[])?.[0];
  const activeLinks = ((data.onboarding_links as any[]) ?? [])
    .filter(
      (l) =>
        !l.used_at &&
        !l.revoked_at &&
        (!l.expires_at || new Date(l.expires_at) > new Date()),
    )
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const onboardingLinks = ((data.onboarding_links as any[]) ?? []).sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const formatDate = (value: string | null | undefined) =>
    value
      ? new Intl.DateTimeFormat("es-MX", {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(value))
      : "—";

  return (
    <div className="space-y-6">
      <Link
        to="/dashboard"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Volver
      </Link>

      <PageHeader
        title={data.name}
        description={`${data.company_name ?? "Sin empresa"} · ${data.email ?? "Sin email"}`}
        badge={<StatusBadge status={data.status} />}
      />

      <Tabs defaultValue="config" className="space-y-4">
        <TabsList className="grid w-full grid-cols-2 bg-card/60 backdrop-blur-sm sm:w-auto sm:inline-flex">
          <TabsTrigger value="config" className="gap-1.5">
            <Settings className="h-3.5 w-3.5" /> Configuración
          </TabsTrigger>
          <TabsTrigger value="logs" className="gap-1.5">
            <ScrollText className="h-3.5 w-3.5" /> Logs
          </TabsTrigger>
        </TabsList>

        <TabsContent value="config" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <LinkIcon className="h-4 w-4 text-primary" />
                Enlace de conexión
              </CardTitle>
              <CardDescription>
                Cada cliente conserva un solo enlace utilizable. Al generar uno nuevo, los
                anteriores sin usar se revocan automáticamente.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Button onClick={generate} disabled={generating}>
                  <RefreshCw className={`mr-2 h-4 w-4 ${generating ? "animate-spin" : ""}`} />
                  Generar nuevo enlace
                </Button>
                <Button variant="outline" asChild>
                  <a href="/onboarding" target="_blank" rel="noreferrer">
                    Abrir onboarding público
                  </a>
                </Button>
              </div>

              {activeLinks.length > 0 ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">Enlace vigente</p>
                      <p className="text-xs text-muted-foreground">
                        Creado {formatDate(activeLinks[0].created_at)} · vence{" "}
                        {formatDate(activeLinks[0].expires_at)}
                      </p>
                    </div>
                    <Badge variant="secondary">Más reciente</Badge>
                  </div>
                  {activeLinks.slice(0, 1).map((l) => {
                    const url = `${origin}/connect/${l.token}`;
                    return (
                      <div
                        key={l.id}
                        className="flex items-center gap-2 rounded-md border bg-muted/50 p-3"
                      >
                        <LinkIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                        <code className="flex-1 truncate text-xs">{url}</code>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            navigator.clipboard.writeText(url);
                            toast.success("Copiado");
                          }}
                        >
                          <Copy className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          disabled={revokingLinkId === l.id}
                          onClick={async () => {
                            if (!window.confirm("¿Revocar este enlace? Dejará de funcionar de inmediato.")) {
                              return;
                            }
                            setRevokingLinkId(l.id);
                            try {
                              await revokeLink({ data: { id: l.id } });
                              toast.success("Enlace revocado");
                              await queryClient.invalidateQueries({ queryKey: ["client", id] });
                            } catch (err: any) {
                              toast.error("No se pudo revocar el enlace", {
                                description: err?.message ?? "Error desconocido",
                              });
                            } finally {
                              setRevokingLinkId(null);
                            }
                          }}
                          title="Revocar enlace"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No hay un enlace vigente. Genera uno cuando el cliente vaya a iniciar la conexión.
                </p>
              )}

              {onboardingLinks.length > 0 && (
                <div className="border-t pt-4">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="px-0 text-muted-foreground"
                    onClick={() => setShowLinkHistory((visible) => !visible)}
                  >
                    {showLinkHistory ? "Ocultar" : "Ver"} historial de enlaces ({onboardingLinks.length})
                  </Button>
                  {showLinkHistory && (
                    <div className="mt-3 space-y-2 text-xs">
                      {onboardingLinks.map((link) => {
                        const state = link.used_at
                          ? "Usado"
                          : link.revoked_at
                            ? "Revocado"
                            : link.expires_at && new Date(link.expires_at) <= new Date()
                              ? "Vencido"
                              : "Vigente";
                        return (
                          <div
                            key={link.id}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2"
                          >
                            <span>
                              {state} · creado {formatDate(link.created_at)}
                            </span>
                            <span className="text-muted-foreground">
                              {state === "Usado"
                                ? `usado ${formatDate(link.used_at)}`
                                : state === "Revocado"
                                  ? `revocado ${formatDate(link.revoked_at)}`
                                  : `vence ${formatDate(link.expires_at)}`}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-primary" />
                Cuenta de WhatsApp
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {wa ? (
                <>
                  <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-muted-foreground">Número</dt>
                      <dd className="font-medium">{wa.display_phone_number ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Nombre verificado</dt>
                      <dd className="font-medium">{wa.verified_name ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">WABA ID</dt>
                      <dd className="font-mono text-xs">{wa.waba_id ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Phone Number ID</dt>
                      <dd className="font-mono text-xs">{wa.phone_number_id ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Estado</dt>
                      <dd className="font-medium">{wa.status}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Webhook suscrito</dt>
                      <dd className="font-medium">{wa.webhook_subscribed ? "Sí" : "No"}</dd>
                    </div>
                  </dl>
                  <div className="pt-2 flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      disabled={verifyingMetaAccess || !wa.phone_number_id}
                      onClick={async () => {
                        setVerifyingMetaAccess(true);
                        try {
                          const res: any = await verifyMetaAccess({
                            data: { whatsapp_account_id: wa.id },
                          });
                          if (res.ok) {
                            toast.success("Acceso de Meta verificado", {
                              description: "El System User puede administrar este número.",
                            });
                          } else {
                            toast.error("No se pudo verificar el acceso de Meta", {
                              description: res.error?.message ?? "Error desconocido",
                            });
                          }
                        } catch (err: any) {
                          toast.error("No se pudo verificar el acceso de Meta", {
                            description: err?.message ?? "Error desconocido",
                          });
                        } finally {
                          setVerifyingMetaAccess(false);
                        }
                      }}
                    >
                      <ShieldCheck
                        className={`mr-2 h-4 w-4 ${verifyingMetaAccess ? "animate-pulse" : ""}`}
                      />
                      Verificar acceso Meta
                    </Button>
                    <Button
                      onClick={() => {
                        setWaResult(null);
                        setWaDialogOpen(true);
                      }}
                      disabled={wa.status !== "connected" || !wa.phone_number_id}
                    >
                      <Send className="mr-2 h-4 w-4" />
                      Enviar mensaje de prueba
                    </Button>
                    <Button
                      variant="outline"
                      disabled={resubscribing || !wa.waba_id}
                      onClick={async () => {
                        setResubscribing(true);
                        try {
                          const res = await resubscribe({ data: { whatsapp_account_id: wa.id } });
                          if (res.ok) {
                            toast.success("Webhook re-suscrito correctamente");
                          } else {
                            const e = res.error;
                            toast.error(
                              `Meta: ${e.message}${e.code ? ` (code ${e.code})` : ""}${e.http_status ? ` [HTTP ${e.http_status}]` : ""}`,
                            );
                          }
                          await queryClient.invalidateQueries({ queryKey: ["client", id] });
                        } catch (err: any) {
                          toast.error(err?.message ?? "Error al re-suscribir");
                        } finally {
                          setResubscribing(false);
                        }
                      }}
                    >
                      <RefreshCw
                        className={`mr-2 h-4 w-4 ${resubscribing ? "animate-spin" : ""}`}
                      />
                      Re-suscribir webhook del WABA
                    </Button>
                    <Button
                      variant="outline"
                      disabled={redirectingWebhook || !wa.waba_id}
                      onClick={() => setRedirectWebhookDialogOpen(true)}
                    >
                      <Webhook className="mr-2 h-4 w-4" />
                      Redirigir callback al router
                    </Button>
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Aún no se ha conectado ninguna cuenta.
                </p>
              )}
            </CardContent>
          </Card>

          <Dialog open={waDialogOpen} onOpenChange={setWaDialogOpen}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Enviar mensaje de prueba</DialogTitle>
                <DialogDescription>
                  Envía un mensaje real vía Meta Cloud API usando la credencial protegida del
                  System User de Búho.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <p>
                    El destinatario debe haber escrito primero al WhatsApp Business para estar
                    dentro de la ventana de 24 horas, salvo que uses plantilla.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="wa-to">Número destino (formato internacional)</Label>
                  <Input
                    id="wa-to"
                    placeholder="+5219991234567"
                    value={waTo}
                    onChange={(e) => setWaTo(e.target.value)}
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">
                    Puedes escribir con o sin <code>+</code>. Se enviará a Meta solo con dígitos:{" "}
                    <code>{waTo.replace(/[^\d]/g, "") || "—"}</code>
                  </p>
                </div>

                <div className="space-y-2 rounded-md border bg-muted/40 p-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium flex items-center gap-1.5">
                      <Star className="h-3.5 w-3.5" /> Contactos guardados
                    </Label>
                    <span className="text-[10px] text-muted-foreground">
                      {(contactsQuery.data ?? []).length} guardado
                      {(contactsQuery.data ?? []).length === 1 ? "" : "s"}
                    </span>
                  </div>

                  {(contactsQuery.data ?? []).length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {(contactsQuery.data ?? []).map((c: any) => (
                        <div
                          key={c.id}
                          className="group flex items-center gap-1 rounded-full border bg-background px-2 py-1 text-xs"
                        >
                          <button
                            type="button"
                            className="hover:text-primary"
                            onClick={() => setWaTo(c.phone)}
                            title={`+${c.phone}`}
                          >
                            <span className="font-medium">{c.label}</span>
                            <span className="ml-1 text-muted-foreground">+{c.phone}</span>
                          </button>
                          <button
                            type="button"
                            className="opacity-40 hover:opacity-100 hover:text-destructive"
                            onClick={() => removeSavedContact(c.id)}
                            title="Eliminar"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Aún no hay contactos guardados para este cliente.
                    </p>
                  )}

                  <div className="flex gap-2 pt-1">
                    <Input
                      className="h-8 text-xs"
                      placeholder="Nombre (p. ej. Juan)"
                      value={contactLabel}
                      onChange={(e) => setContactLabel(e.target.value)}
                      maxLength={80}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={saveCurrentAsContact}
                      disabled={savingContact || !waTo.trim() || !contactLabel.trim()}
                    >
                      <Plus className="mr-1 h-3 w-3" />
                      Guardar
                    </Button>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Guarda el número actual del campo de arriba con un nombre para reusarlo después.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="wa-message">Mensaje</Label>
                  <Textarea
                    id="wa-message"
                    rows={4}
                    value={waMessage}
                    onChange={(e) => setWaMessage(e.target.value)}
                  />
                </div>

                {waResult && waResult.ok && (
                  <div className="rounded-md border border-success/40 bg-success/10 p-3 text-sm">
                    <p className="font-medium text-success">Mensaje enviado correctamente</p>
                    {waResult.message_id && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        message_id: <code className="break-all">{waResult.message_id}</code>
                      </p>
                    )}
                  </div>
                )}
                {waResult && !waResult.ok && (
                  <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm space-y-1">
                    <p className="font-medium text-destructive">No se pudo enviar el mensaje</p>
                    <p className="text-xs break-all">{waResult.error.message}</p>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                      {waResult.error.type && (
                        <>
                          <dt>type</dt>
                          <dd className="text-foreground">{waResult.error.type}</dd>
                        </>
                      )}
                      {waResult.error.code != null && (
                        <>
                          <dt>code</dt>
                          <dd className="text-foreground">{waResult.error.code}</dd>
                        </>
                      )}
                      {waResult.error.error_subcode != null && (
                        <>
                          <dt>error_subcode</dt>
                          <dd className="text-foreground">{waResult.error.error_subcode}</dd>
                        </>
                      )}
                      {waResult.error.fbtrace_id && (
                        <>
                          <dt>fbtrace_id</dt>
                          <dd className="text-foreground break-all">{waResult.error.fbtrace_id}</dd>
                        </>
                      )}
                      {waResult.error.http_status && (
                        <>
                          <dt>http_status</dt>
                          <dd className="text-foreground">{waResult.error.http_status}</dd>
                        </>
                      )}
                    </dl>
                  </div>
                )}
              </div>

              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setWaDialogOpen(false)}
                  disabled={waSending}
                >
                  Cerrar
                </Button>
                <Button
                  onClick={runSendTest}
                  disabled={waSending || waTo.replace(/[^\d]/g, "").length < 6 || !waMessage.trim()}
                >
                  <Send className={`mr-2 h-4 w-4 ${waSending ? "animate-pulse" : ""}`} />
                  {waSending ? "Enviando…" : "Enviar"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={redirectWebhookDialogOpen} onOpenChange={setRedirectWebhookDialogOpen}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Redirigir callback de WhatsApp al router</DialogTitle>
                <DialogDescription>
                  Este cambio reemplaza el callback alterno configurado para el WABA de este
                  número, por ejemplo un túnel temporal de ngrok. Meta enviará los eventos de
                  mensajes a este router.
                </DialogDescription>
              </DialogHeader>
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
                Se configurará la URL pública definida para este router. No modifica n8n,
                Chatwoot ni desconecta el número.
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={redirectingWebhook}
                  onClick={() => setRedirectWebhookDialogOpen(false)}
                >
                  Cancelar
                </Button>
                <Button
                  type="button"
                  disabled={redirectingWebhook || !wa?.waba_id}
                  onClick={async () => {
                    if (!wa) return;
                    setRedirectingWebhook(true);
                    try {
                      const result = await redirectWebhook({
                        data: { whatsapp_account_id: wa.id },
                      });
                      if (result.ok) {
                        toast.success("Callback redirigido al router", {
                          description: result.callback_url,
                        });
                        setRedirectWebhookDialogOpen(false);
                      } else {
                        const issue = result.error;
                        toast.error(
                          `Meta: ${issue.message}${issue.code ? ` (code ${issue.code})` : ""}${issue.http_status ? ` [HTTP ${issue.http_status}]` : ""}`,
                        );
                      }
                      await queryClient.invalidateQueries({ queryKey: ["client", id] });
                    } catch (err: any) {
                      toast.error(err?.message ?? "No se pudo redirigir el callback");
                    } finally {
                      setRedirectingWebhook(false);
                    }
                  }}
                >
                  <Webhook className={`mr-2 h-4 w-4 ${redirectingWebhook ? "animate-pulse" : ""}`} />
                  {redirectingWebhook ? "Redirigiendo…" : "Confirmar redirección"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Webhook className="h-4 w-4 text-primary" />
                Instancia de n8n
              </CardTitle>
              <CardDescription>
                Configura la URL y el secreto de n8n para este cliente. Si está desactivado o falta
                la URL, el webhook de Meta seguirá funcionando pero no se reenviará nada a n8n. Cada
                cliente puede tener su propia instancia.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="n8n-enabled">Reenvío a n8n habilitado</Label>
                  <p className="text-xs text-muted-foreground">
                    Solo se reenvían eventos si está activado y hay URL configurada.
                  </p>
                </div>
                <Switch id="n8n-enabled" checked={n8nEnabled} onCheckedChange={setN8nEnabled} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="n8n-url">URL del webhook n8n</Label>
                <Input
                  id="n8n-url"
                  type="url"
                  placeholder="https://n8n.cliente.com/webhook/whatsapp"
                  value={n8nUrl}
                  onChange={(e) => setN8nUrl(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="n8n-secret">Secreto (X-N8N-Webhook-Secret)</Label>
                <Input
                  id="n8n-secret"
                  type="password"
                  placeholder={
                    (data as any).n8n_webhook_secret_encrypted
                      ? "•••••••• (dejar vacío para no cambiar)"
                      : "Sin configurar"
                  }
                  value={n8nSecret}
                  onChange={(e) => setN8nSecret(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Se enviará como header <code>X-N8N-Webhook-Secret</code> en cada reenvío.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={saveN8nConfig} disabled={n8nSaving}>
                  {n8nSaving ? "Guardando…" : "Guardar configuración de n8n"}
                </Button>
                <Button
                  variant="outline"
                  onClick={runTest}
                  disabled={testing || !(data as any).n8n_webhook_url}
                >
                  {testing ? "Enviando…" : "Enviar evento de prueba"}
                </Button>
                <Button variant="ghost" onClick={reloadFromDb}>
                  <RefreshCw className="mr-1 h-3 w-3" /> Recargar estado real desde BD
                </Button>
              </div>

              <div className="rounded-lg border border-primary/20 bg-muted/30 p-3 text-xs space-y-1">
                <p className="flex items-center gap-1.5 font-medium text-sm">
                  <Bug className="h-3.5 w-3.5 text-primary" />
                  Estado real (BD)
                </p>
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                  <span className="text-muted-foreground">n8n_enabled</span>
                  <span className="font-mono">{String(!!(data as any).n8n_enabled)}</span>
                  <span className="text-muted-foreground">URL</span>
                  <span className="font-mono break-all">
                    {(data as any).n8n_webhook_url ?? "—"}
                  </span>
                  <span className="text-muted-foreground">Secreto</span>
                  <span className="font-mono">
                    {(data as any).n8n_webhook_secret_encrypted ? "Sí" : "No"}
                  </span>
                  <span className="text-muted-foreground">Último intento</span>
                  <span className="font-mono">
                    {(data as any).n8n_last_delivery_at
                      ? new Date((data as any).n8n_last_delivery_at).toLocaleString()
                      : "—"}
                  </span>
                  <span className="text-muted-foreground">Último status</span>
                  <span className="font-mono">{(data as any).n8n_last_delivery_status ?? "—"}</span>
                </div>
                {(data as any).n8n_last_delivery_error && (
                  <p className="text-destructive break-all">
                    {(data as any).n8n_last_delivery_error}
                  </p>
                )}
              </div>

              {((data as any).n8n_last_delivery_at || (data as any).n8n_last_delivery_status) && (
                <div className="rounded-md border bg-muted/40 p-3 text-sm space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">Última entrega:</span>
                    <Badge
                      variant={
                        (data as any).n8n_last_delivery_status === "success"
                          ? "default"
                          : "destructive"
                      }
                    >
                      {(data as any).n8n_last_delivery_status ?? "—"}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {(data as any).n8n_last_delivery_at
                        ? new Date((data as any).n8n_last_delivery_at).toLocaleString()
                        : ""}
                    </span>
                  </div>
                  {(data as any).n8n_last_delivery_error && (
                    <p className="text-xs text-destructive break-all">
                      {(data as any).n8n_last_delivery_error}
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings className="h-4 w-4 text-primary" />
                Datos para n8n
              </CardTitle>
              <CardDescription>
                Configura estos valores en tu instancia de n8n para responder mensajes. n8n nunca
                recibe el access token de Meta ni el App Secret.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {(() => {
                const sendUrl = `${origin}/api/public/whatsapp/send-message`;
                const configBlob = {
                  client_id: id,
                  send_message_url: sendUrl,
                  required_header: "X-N8N-Webhook-Secret",
                };
                const bodyExample = {
                  client_id: id,
                  to: "5219991234567",
                  message: "Hola desde n8n",
                  type: "text",
                };
                return (
                  <>
                    <div className="grid gap-3 text-sm">
                      <div>
                        <p className="text-muted-foreground text-xs">Endpoint</p>
                        <code className="block break-all rounded-lg border bg-muted/40 p-2 text-xs overflow-x-auto">
                          {sendUrl}
                        </code>
                      </div>
                      <div>
                        <p className="text-muted-foreground text-xs">client_id</p>
                        <code className="block break-all rounded-lg border bg-muted/40 p-2 text-xs overflow-x-auto">
                          {id}
                        </code>
                      </div>
                      <div>
                        <p className="text-muted-foreground text-xs">Header requerido</p>
                        <code className="block rounded-lg border bg-muted/40 p-2 text-xs overflow-x-auto">
                          X-N8N-Webhook-Secret: &lt;tu secreto&gt;
                        </code>
                      </div>
                      <div>
                        <p className="text-muted-foreground text-xs">Body de ejemplo</p>
                        <pre className="whitespace-pre-wrap rounded-lg border bg-muted/40 p-2 text-xs overflow-x-auto">
                          {JSON.stringify(bodyExample, null, 2)}
                        </pre>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      onClick={() => {
                        navigator.clipboard.writeText(JSON.stringify(configBlob, null, 2));
                        toast.success("Configuración copiada");
                      }}
                    >
                      <Copy className="mr-2 h-4 w-4" />
                      Copiar configuración para n8n
                    </Button>
                  </>
                );
              })()}
            </CardContent>
          </Card>

          <ChatwootIntegrationCard clientId={id} />
          <ChatwootLogsCard clientId={id} />
        </TabsContent>

        <TabsContent value="logs" className="space-y-4">
          <Tabs defaultValue="debug" className="space-y-4">
            <TabsList className="grid w-full grid-cols-3 bg-card/60 backdrop-blur-sm sm:w-auto sm:inline-flex">
              <TabsTrigger value="debug" className="gap-1.5">
                <Bug className="h-3.5 w-3.5" /> Debug
              </TabsTrigger>
              <TabsTrigger value="messages" className="gap-1.5">
                <MessageSquare className="h-3.5 w-3.5" /> Mensajes
              </TabsTrigger>
              <TabsTrigger value="raw" className="gap-1.5">
                <Webhook className="h-3.5 w-3.5" /> Eventos Meta
              </TabsTrigger>
            </TabsList>

            <TabsContent value="debug" className="space-y-4">
              <DebugPanel clientId={id} />
            </TabsContent>
            <TabsContent value="messages" className="space-y-4">
              <MessageLogsCard clientId={id} />
            </TabsContent>
            <TabsContent value="raw" className="space-y-4">
              <RawWebhookEventsCard />
            </TabsContent>
          </Tabs>
        </TabsContent>
      </Tabs>
    </div>
  );
}
