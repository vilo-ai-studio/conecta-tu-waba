# API Endpoints — Documentación de contratos

Todos los endpoints públicos viven bajo `/api/public/*` y **bypassean autenticación**
en el sitio publicado. La seguridad se implementa dentro de cada handler
(firma HMAC, secreto compartido, token de onboarding, etc.).

Base URL de producción:

- `https://<DOMAIN>` donde `DOMAIN` es el host configurado en `.env.vps`.
- Dominio de preproducción: `https://vps-connect.buho-solutions.com`.
- El cambio de tráfico productivo continúa **Por confirmar**.

---

## 1. `GET /api/public/meta-config`

Expone identificadores públicos de Meta al navegador (para Embedded Signup).

**Auth:** ninguna.
**Request:** sin body.

**Response 200 (JSON):**

```json
{
  "appId": "string | null",
  "configurationId": "string | null",
  "graphApiVersion": "v25.0"
}
```

> Nunca expone `META_APP_SECRET`.

---

## 2. Onboarding

### 2.1 `POST /api/public/onboarding/self-start`

Crea `clients` (status `onboarding_started`), un `whatsapp_accounts` pendiente,
y un `onboarding_links` con token de 30 días.

**Auth:** ninguna (endpoint público de captación).

**Request body (JSON):**

```json
{
  "name": "string (1..200, requerido)",
  "email": "string (email válido, ≤255, requerido)",
  "company_name": "string | null (opcional)",
  "phone": "string (opcional, informativo)"
}
```

**Response 200:**

```json
{ "ok": true, "token": "hex de ≥32 chars" }
```

**Errores:**

- `400 { ok:false, error:"invalid_name" | "invalid_email" }`
- `500 { ok:false, error:"db_error" | "token_gen_failed" | "server_error" }`

---

### 2.2 `POST /api/public/onboarding/validate`

Valida el token de onboarding sin exponer ids internos.

**Request body:**

```json
{ "token": "string (≥16 chars)" }
```

**Response 200 (válido):**

```json
{
  "valid": true,
  "client_id": "uuid",
  "client_name": "string | null",
  "company_name": "string | null"
}
```

**Errores:**

- `400 { valid:false, reason:"invalid_token" }`
- `404 { valid:false, reason:"not_found" }`
- `410 { valid:false, reason:"already_used" | "expired" }`
- `500 { valid:false, reason:"server_error" }`

---

### 2.3 `POST /api/public/onboarding/complete`

Llamado tras Meta Embedded Signup. Intercambia `code` → access token,
consulta datos del número, suscribe la app al WABA y guarda `whatsapp_accounts`.

**Request body:**

```json
{
  "token": "onboarding token (requerido)",
  "code": "meta oauth code (requerido)",
  "waba_id": "string (requerido)",
  "phone_number_id": "string (requerido)",
  "business_id": "string (opcional)"
}
```

**Response 200:**

```json
{ "ok": true, "webhook_subscribed": true }
```

**Errores:**

- `400 { ok:false, error:"missing_params" | "missing_meta_ids" }`
- `404 { ok:false, error:"invalid_token" }`
- `410 { ok:false, error:"already_used" | "expired" }`
- `500 { ok:false, error:"server_misconfigured" | "db_error" | "server_error" }`
- `502 { ok:false, error:"token_exchange_failed", detail:{...} }`

---

## 3. WhatsApp

### 3.1 `GET /api/public/whatsapp/webhook`

Verificación del webhook de Meta.

**Query params:**

- `hub.mode=subscribe`
- `hub.verify_token=<WHATSAPP_VERIFY_TOKEN del server>`
- `hub.challenge=<echo>`

**Response 200:** cuerpo = `hub.challenge` (`text/plain`).
**Response 403:** `Forbidden` si el token no coincide.

---

### 3.2 `POST /api/public/whatsapp/webhook`

Recibe eventos de Meta (mensajes entrantes y status updates).

**Auth:** `X-Hub-Signature-256`, validada con HMAC SHA-256 y comparación en tiempo constante.

**Comportamiento:**

1. Rechaza más de 1 MB, valida la firma y parsea el cuerpo crudo una sola vez.
2. Guarda el payload crudo y un trabajo por `change` en una sola transacción PostgreSQL.
3. Deduplica por `wa_message_id` o por una clave SHA-256 determinista.
4. Intenta publicar en Redis y responde después del commit, sin esperar a n8n ni Chatwoot.
5. El worker procesa todos los mensajes/estados contenidos en cada `change` y sincroniza Chatwoot.
6. Reenvía a n8n **solo** eventos `message` (nunca `status`) si:
   - `n8n_enabled=true`
   - `n8n_webhook_url` presente
   - `n8n_webhook_secret_encrypted` presente
   - el bot no está pausado (label o assignee en Chatwoot).
7. Si es `status`, actualiza `whatsapp_send_logs` por `meta_message_id`.

**Response:** `200` después de persistir. Devuelve `401` para firma inválida, `413` para exceso de tamaño y `503` si falta la configuración de firma o PostgreSQL no puede guardar. Un fallo de Redis no impide el `200`: el reconciliador publica después.

**Payload enviado a n8n** (`POST` al `n8n_webhook_url` del cliente):

Headers:

```
content-type: application/json
X-Client-ID: <uuid>
X-Phone-Number-ID: <phone_number_id>
X-N8N-Webhook-Secret: <secreto compartido>
Idempotency-Key: <job_id:item_key>
```

Body (mensaje):

```json
{
  "source": "meta_whatsapp",
  "client_id": "uuid",
  "whatsapp_account_id": "uuid",
  "phone_number_id": "string",
  "display_phone_number": "string | null",
  "event_kind": "message",
  "from": "wa_id normalizado (ej 5219993670065)",
  "contact_name": "string | null",
  "message_id": "wamid...",
  "message_type": "text | image | audio | ...",
  "text": "string | null",
  "timestamp": "unix seconds",
  "raw": { "object": "...", "entry": [ ... ] }
}
```

---

### 3.3 `POST /api/public/whatsapp/send-message`

Endpoint que **n8n llama** para enviar mensajes a WhatsApp. n8n nunca ve el
token de Meta.

**Auth:** header `X-N8N-Webhook-Secret` debe coincidir con
`clients.n8n_webhook_secret_encrypted`.

Acepta `Idempotency-Key` opcional. Si no existe, usa `inbound_message_id` para respuestas reales; el indicador de escritura no consume esa clave implícita.

**Body — texto:**

```json
{
  "client_id": "uuid (requerido)",
  "to": "wa_id destino (requerido)",
  "message": "texto (requerido si type=text)",
  "type": "text (opcional)",
  "inbound_message_id": "wamid del entrante para dedup (opcional)"
}
```

**Body — template:**

```json
{
  "client_id": "uuid",
  "to": "wa_id destino",
  "template_name": "nombre_plantilla",
  "template_params": ["p1", "p2"],
  "template_language": "es_MX",
  "inbound_message_id": "opcional"
}
```

**Response 200 (éxito):**

```json
{ "ok": true, "message_id": "wamid...", "meta": { ...respuesta cruda de Meta } }
```

**Response 200 (dedup):**

```json
{
  "success": true,
  "deduped": true,
  "reason": "reply_already_sent_for_inbound_message",
  "message_id": "wamid..."
}
```

**Errores:**

- `400 { ok:false, error:"missing_params" | "unsupported_type", detail }`
- `401 { ok:false, error:"invalid_secret" }`
- `403 { ok:false, error:"n8n_not_configured" }`
- `404 { ok:false, error:"client_not_found" }`
- `409 { ok:false, error:"no_connected_account" | "request_in_progress" }`
- `413 { ok:false, error:"payload_too_large" }`
- `429 { ok:false, error:"rate_limited" }`
- `500 { ok:false, error:"server_error", detail }`
- `502 { ok:false, error:"meta_error", status, detail }`

**Efectos secundarios:**

- Log en `message_send_logs` y `whatsapp_send_logs` (con payload crudo,
  código y mensaje de error de Meta si aplica).
- Mirror del outgoing a Chatwoot (`source:"n8n"`), reutilizando la
  conversación existente si hay mapping por `inbound_message_id` o `wa_id`
  normalizado.

---

## 4. `POST /api/public/chatwoot/webhook`

Webhook de Chatwoot. **Un solo endpoint con dos modos** distinguidos por
query `?kind=`:

- `?kind=agent` (default) — **API Inbox webhook**. Procesa `message_created`
  outgoing de agentes humanos y reenvía a Meta.
- `?kind=global` — **Account webhook** (Settings → Integrations → Webhooks).
  Procesa `conversation_updated` / labels / status / assignee. Ignora
  `message_created` para no duplicar envíos.

**Auth (opcional por cliente):** HMAC-SHA256 hex del body crudo con
`chatwoot_webhook_secret_encrypted` en header `X-Chatwoot-Signature`.

- Se verifica solo si `chatwoot_webhook_signature_enabled=true` y hay secreto.
- Firma inválida → `401 invalid signature`.

**Response policy:** siempre `200` para eventos aceptados o ignorados
(rate-limited, dedup, mirror, sin mapping…). Solo `401` en firma inválida.
Motivo: Chatwoot marca `Error al enviar` en cualquier respuesta no-2xx del
webhook de outgoing.

**Response 200 típica:**

```json
{ "ok": true, "forwarded": true, "meta_message_id": "wamid..." }
{ "ok": true, "ignored": "message_created_on_global_webhook" }
{ "ok": true, "ignored": "mirror_source" }
{ "ok": true, "ignored": "already_processed" }
{ "ok": true, "applied": "bot_paused_by_label" | "bot_resumed" | "conversation_state_updated" }
```

**Reglas anti-loop:** ignora eventos con
`content_attributes.source ∈ {bot, meta, meta_api, n8n}` y
`sender.type ≠ user`. Deduplica por índice único
`(client_id, chatwoot_message_id)` en `chatwoot_message_mappings`
antes de llamar a Meta.

**Eventos de estado manejados en `kind=global`:**
`conversation_updated`, `conversation_status_changed`,
`conversation_resolved`, `conversation_opened`, `conversation_reopened`.
Aplica pausa por label (`pause_label`) o asignación (`pause_on_assigned`)
y loguea `bot_paused_by_label` / `bot_resumed` / `conversation_state_updated`.

---

## Notas transversales

- **Normalización wa_id:** todos los endpoints usan `normalizeWaId()` para
  garantizar un único formato canónico (ej. `9993670065` → `5219993670065`).
- **Logs:** `message_send_logs`, `whatsapp_send_logs`,
  `chatwoot_integration_logs`, `n8n_forward_logs`, `raw_meta_webhook_events`,
  `meta_webhook_events`. Los headers `Authorization` / `Cookie` / cualquier
  clave con `token` o `secret` se filtran antes de guardar.
- **Idempotencia:**
  - Mensajes entrantes Meta → `processed_whatsapp_messages.message_id`.
  - Envíos a Meta desde n8n → `whatsapp_send_logs.inbound_message_id`.
  - Reenvíos Chatwoot → `chatwoot_message_mappings (client_id, chatwoot_message_id)`.
