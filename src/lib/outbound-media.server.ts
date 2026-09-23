import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

export type OutboundMediaType = "document" | "image";

export type OutboundMediaInput = {
  type: OutboundMediaType;
  url: string;
  filename?: string;
  caption?: string;
};

export class OutboundMediaError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_media_url"
      | "media_url_not_allowed"
      | "media_download_failed"
      | "media_too_large"
      | "invalid_media_type"
      | "meta_media_upload_failed",
  ) {
    super(message);
  }
}

const MAX_REDIRECTS = 3;

function isPrivateIp(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80:")
    );
  }
  return true;
}

export async function validateOutboundMediaUrl(value: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OutboundMediaError("media_url debe ser una URL HTTPS válida", "invalid_media_url");
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
    throw new OutboundMediaError(
      "media_url debe ser HTTPS y no incluir credenciales",
      "invalid_media_url",
    );
  }
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
    throw new OutboundMediaError(
      "media_url no puede apuntar a una red interna",
      "media_url_not_allowed",
    );
  }

  const directIp = isIP(url.hostname);
  if (directIp && isPrivateIp(url.hostname)) {
    throw new OutboundMediaError(
      "media_url no puede apuntar a una red interna",
      "media_url_not_allowed",
    );
  }
  if (!directIp) {
    let addresses: { address: string }[];
    try {
      addresses = await lookup(url.hostname, { all: true });
    } catch {
      throw new OutboundMediaError(
        "No se pudo resolver el dominio de media_url",
        "media_download_failed",
      );
    }
    if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
      throw new OutboundMediaError(
        "media_url no puede apuntar a una red interna",
        "media_url_not_allowed",
      );
    }
  }
  return url;
}

async function fetchPublicMedia(
  value: string,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; contentType: string; sourceUrl: URL }> {
  let url = await validateOutboundMediaUrl(value);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    let response: Response;
    try {
      response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new OutboundMediaError("No se pudo descargar media_url", "media_download_failed");
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirect === MAX_REDIRECTS) {
        throw new OutboundMediaError(
          "media_url tuvo demasiadas redirecciones",
          "media_download_failed",
        );
      }
      url = await validateOutboundMediaUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok || !response.body) {
      throw new OutboundMediaError(
        `No se pudo descargar media_url (HTTP ${response.status})`,
        "media_download_failed",
      );
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > maxBytes) {
      throw new OutboundMediaError("El archivo excede el tamaño permitido", "media_too_large");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      size += chunk.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new OutboundMediaError("El archivo excede el tamaño permitido", "media_too_large");
      }
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      bytes,
      contentType: response.headers.get("content-type")?.split(";")[0].toLowerCase() ?? "",
      sourceUrl: url,
    };
  }
  throw new OutboundMediaError("No se pudo descargar media_url", "media_download_failed");
}

function detectMediaMime(type: OutboundMediaType, bytes: Uint8Array, declaredType: string): string {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (type === "document") {
    if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return "application/pdf";
  } else {
    if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
    if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
    if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP")
      return "image/webp";
  }
  throw new OutboundMediaError(
    `El archivo no es un ${type === "document" ? "PDF" : "JPEG, PNG o WEBP"} válido${declaredType ? ` (recibido: ${declaredType})` : ""}`,
    "invalid_media_type",
  );
}

export async function uploadOutboundMedia(input: {
  phoneNumberId: string;
  systemUserToken: string;
  graphVersion: string;
  media: OutboundMediaInput;
}): Promise<{ id: string; mimeType: string; filename: string }> {
  const maxBytes = Number(process.env.OUTBOUND_MEDIA_MAX_BYTES ?? 16 * 1024 * 1024);
  const file = await fetchPublicMedia(input.media.url, maxBytes);
  const mimeType = detectMediaMime(input.media.type, file.bytes, file.contentType);
  const fallbackName =
    input.media.type === "document" ? "documento.pdf" : `imagen.${mimeType.split("/")[1]}`;
  const filename = (
    input.media.filename?.trim() ||
    file.sourceUrl.pathname.split("/").pop() ||
    fallbackName
  ).slice(0, 180);
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("file", new Blob([file.bytes], { type: mimeType }), filename);

  let response: Response;
  let payload: any = null;
  try {
    response = await fetch(
      `https://graph.facebook.com/${input.graphVersion}/${input.phoneNumberId}/media`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${input.systemUserToken}` },
        body: form,
        signal: AbortSignal.timeout(Number(process.env.META_TIMEOUT_MS ?? 15_000)),
      },
    );
    payload = await response.json().catch(() => ({}));
  } catch {
    throw new OutboundMediaError("No se pudo subir el archivo a Meta", "meta_media_upload_failed");
  }
  if (!response.ok || !payload?.id) {
    throw new OutboundMediaError(
      payload?.error?.message ?? "Meta no aceptó el archivo",
      "meta_media_upload_failed",
    );
  }
  return { id: String(payload.id), mimeType, filename };
}
