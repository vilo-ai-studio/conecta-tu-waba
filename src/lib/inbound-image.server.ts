import { getPool } from "@/integrations/database/client.server";
import { decryptSecret } from "@/integrations/database/secrets.server";
import { getMetaSystemUserToken } from "@/lib/meta-system-user.server";
import { detectMediaMime } from "@/lib/outbound-media.server";
import {
  constantTimeEqual,
  enforceTokenBucket,
  readJsonWithLimit,
} from "@/lib/request-security.server";

const MAX_BYTES = 10 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function inboundImageId(
  payload: unknown,
  messageId: string,
  phoneNumberId: string,
): string | null {
  // A batch may contain other clients/messages; only this exact inbound event is eligible.
  if (
    !payload ||
    typeof payload !== "object" ||
    !("entry" in payload) ||
    !Array.isArray(payload.entry)
  )
    return null;
  for (const entry of payload.entry) {
    for (const change of entry?.changes ?? []) {
      if (change?.value?.metadata?.phone_number_id !== phoneNumberId) continue;
      for (const message of change?.value?.messages ?? []) {
        if (
          message?.id === messageId &&
          message?.type === "image" &&
          typeof message.image?.id === "string" &&
          /^\d+$/.test(message.image.id)
        )
          return message.image.id;
      }
    }
  }
  return null;
}

export async function fetchInboundImage(
  mediaId: string,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const token = getMetaSystemUserToken();
  const headers = { authorization: `Bearer ${token}` };
  const version = process.env.META_GRAPH_API_VERSION ?? "v25.0";
  const lookup = await fetch(`https://graph.facebook.com/${version}/${mediaId}`, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!lookup.ok) throw new Error("image_unavailable");
  const metadata = await lookup.json();
  const url = new URL(metadata.url);
  const trustedHost = ["fbsbx.com", "fbcdn.net"].some(
    (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
  );
  if (
    url.protocol !== "https:" ||
    !trustedHost ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    Number(metadata.file_size) > MAX_BYTES
  )
    throw new Error("unsafe_image");
  const response = await fetch(url, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > MAX_BYTES)
    throw new Error("image_unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error("image_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, mime: detectMediaMime("image", bytes, metadata.mime_type ?? "") };
}

export async function downloadInboundImageEndpoint(request: Request): Promise<Response> {
  const fail = (status: number) =>
    Response.json(
      { ok: false, error: "image_unavailable" },
      {
        status,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  try {
    const secret = request.headers.get("x-n8n-webhook-secret") ?? "";
    if (!secret) return fail(401);
    const body = await readJsonWithLimit<{ client_id?: unknown; inbound_message_id?: unknown }>(
      request,
      2048,
    );
    if (
      !body ||
      typeof body.client_id !== "string" ||
      !UUID.test(body.client_id) ||
      typeof body.inbound_message_id !== "string" ||
      !body.inbound_message_id.startsWith("wamid.") ||
      body.inbound_message_id.length > 256
    )
      return fail(400);
    const { rows: clients } = await getPool().query<{ secret: string | null }>(
      "SELECT n8n_webhook_secret_encrypted AS secret FROM clients WHERE id = $1",
      [body.client_id],
    );
    const expected = decryptSecret(clients[0]?.secret);
    if (typeof expected !== "string" || !expected || !constantTimeEqual(secret, expected))
      return fail(401);
    const limited = await enforceTokenBucket({
      key: `inbound-image:${body.client_id}`,
      ratePerSecond: 3,
      burst: 12,
    });
    if (limited) return limited;
    const { rows } = await getPool().query<{ raw_payload: unknown; phone_number_id: string }>(
      `SELECT event.raw_payload, event.phone_number_id FROM meta_webhook_events AS event
       JOIN whatsapp_accounts AS account ON account.id = event.whatsapp_account_id
       WHERE event.client_id = $1 AND event.wa_message_id = $2
         AND event.direction = 'inbound_from_meta' AND event.event_kind = 'message'
         AND event.message_type = 'image' AND account.client_id = $1
         AND account.phone_number_id = event.phone_number_id AND account.status = 'connected'
       ORDER BY event.received_at DESC LIMIT 1`,
      [body.client_id, body.inbound_message_id],
    );
    const event = rows[0];
    if (!event) return fail(404);
    const id = inboundImageId(event.raw_payload, body.inbound_message_id, event.phone_number_id);
    if (!id) return fail(404);
    const image = await fetchInboundImage(id);
    return new Response(image.bytes as Uint8Array<ArrayBuffer>, {
      headers: {
        "Content-Type": image.mime,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    // Provider errors may include credentials or URLs; return no vendor details.
    return fail(503);
  }
}
