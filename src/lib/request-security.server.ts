import { timingSafeEqual } from "node:crypto";
import { getRedis, rateLimit, tokenBucketRateLimit } from "@/lib/queue.server";

export class BodyTooLargeError extends Error {}

export async function readJsonWithLimit<T>(request: Request, maxBytes: number): Promise<T | null> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new BodyTooLargeError("payload_too_large");
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new BodyTooLargeError("payload_too_large");
    }
    chunks.push(value);
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(buffer)) as T;
  } catch {
    return null;
  }
}

export function requestIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function enforceRateLimit(input: {
  key: string;
  limit: number;
  windowSeconds: number;
}): Promise<Response | null> {
  try {
    const result = await rateLimit(input);
    if (result.allowed) return null;
    return Response.json(
      { ok: false, error: "rate_limited", retry_after_seconds: result.retryAfterSeconds },
      { status: 429, headers: { "retry-after": String(result.retryAfterSeconds) } },
    );
  } catch (error) {
    console.error("[rate-limit] Redis unavailable", error);
    return Response.json({ ok: false, error: "rate_limiter_unavailable" }, { status: 503 });
  }
}

export async function clearRateLimit(key: string): Promise<void> {
  await getRedis().del(`conecta:rate:${key}`);
}

export async function enforceTokenBucket(input: {
  key: string;
  ratePerSecond: number;
  burst: number;
}): Promise<Response | null> {
  try {
    const result = await tokenBucketRateLimit(input);
    if (result.allowed) return null;
    return Response.json(
      { ok: false, error: "rate_limited", retry_after_seconds: result.retryAfterSeconds },
      { status: 429, headers: { "retry-after": String(result.retryAfterSeconds) } },
    );
  } catch (error) {
    console.error("[rate-limit] Redis unavailable", error);
    return Response.json({ ok: false, error: "rate_limiter_unavailable" }, { status: 503 });
  }
}
