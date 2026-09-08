import { createFileRoute } from "@tanstack/react-router";
import {
  persistAndEnqueueMetaWebhook,
  safeRequestHeaders,
  verifyMetaSignature,
} from "@/lib/queue.server";

function jsonError(status: number, error: string): Response {
  return Response.json({ ok: false, error }, { status });
}

async function readLimitedBody(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new RangeError("payload_too_large");
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new RangeError("payload_too_large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export const Route = createFileRoute("/api/public/whatsapp/webhook")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");
        const expected = process.env.WHATSAPP_VERIFY_TOKEN;
        if (mode === "subscribe" && expected && token === expected && challenge) {
          return new Response(challenge, {
            status: 200,
            headers: { "content-type": "text/plain" },
          });
        }
        return new Response("Forbidden", { status: 403 });
      },
      POST: async ({ request }) => {
        const maxBytes = Number(process.env.WEBHOOK_MAX_BODY_BYTES ?? 1_048_576);
        let rawBody: string;
        try {
          rawBody = await readLimitedBody(request, maxBytes);
        } catch (error) {
          if (error instanceof RangeError) return jsonError(413, "payload_too_large");
          return jsonError(400, "body_read_failed");
        }

        const signatureRequired =
          (process.env.META_WEBHOOK_SIGNATURE_REQUIRED ?? "true").toLowerCase() !== "false";
        if (signatureRequired && !process.env.META_APP_SECRET) {
          console.error("[wa-webhook] META_APP_SECRET is required but missing");
          return jsonError(503, "meta_signature_not_configured");
        }
        if (
          signatureRequired &&
          !verifyMetaSignature(rawBody, request.headers.get("x-hub-signature-256"))
        ) {
          return jsonError(401, "invalid_signature");
        }

        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          return jsonError(400, "invalid_json");
        }
        if (
          !parsedBody ||
          typeof parsedBody !== "object" ||
          !Array.isArray((parsedBody as { entry?: unknown }).entry)
        ) {
          return jsonError(400, "invalid_meta_payload");
        }

        const url = new URL(request.url);
        const queryParams: Record<string, string> = {};
        url.searchParams.forEach((value, key) => {
          queryParams[key] = value;
        });
        try {
          const result = await persistAndEnqueueMetaWebhook({
            rawBody,
            parsedBody,
            requestUrl: request.url,
            headers: safeRequestHeaders(request.headers),
            queryParams,
          });
          return Response.json({
            ok: true,
            accepted: result.accepted,
            duplicate: result.duplicate,
          });
        } catch (error) {
          console.error("[wa-webhook] durable ingest failed", error);
          return jsonError(503, "durable_ingest_failed");
        }
      },
    },
  },
});
