import { createHash, randomBytes } from "node:crypto";
import { getPool } from "./client.server";

export const SESSION_COOKIE = "conecta_session";
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS ?? 60 * 60 * 12);

export type AuthUser = { id: string; email: string; name: string | null };

export function readCookie(request: Request, name: string): string | null {
  const cookies = request.headers.get("cookie") ?? "";
  for (const entry of cookies.split(";")) {
    const [key, ...value] = entry.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function sessionCookie(token: string, expiresAt: Date): string {
  const secure =
    process.env.NODE_ENV === "production" || process.env.APP_URL?.startsWith("https://");
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    `Expires=${expiresAt.toUTCString()}`,
  ]
    .filter(Boolean)
    .join("; ");
}

export function expiredSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await getPool().query(
    "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
    [userId, hashSessionToken(token), expiresAt],
  );
  return { token, expiresAt };
}

export async function deleteSession(token: string | null): Promise<void> {
  if (!token) return;
  await getPool().query("DELETE FROM sessions WHERE token_hash = $1", [hashSessionToken(token)]);
}

export async function getSessionUser(request: Request): Promise<AuthUser | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const result = await getPool().query<AuthUser>(
    `SELECT u.id, u.email, u.name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.expires_at > now()
        AND u.active = true
      LIMIT 1`,
    [hashSessionToken(token)],
  );
  return result.rows[0] ?? null;
}
