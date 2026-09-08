import { compare } from "bcryptjs";
import { createFileRoute } from "@tanstack/react-router";
import { getPool } from "@/integrations/database/client.server";
import { createSession, sessionCookie } from "@/integrations/database/session.server";
import {
  BodyTooLargeError,
  clearRateLimit,
  enforceRateLimit,
  readJsonWithLimit,
  requestIp,
} from "@/lib/request-security.server";

export const Route = createFileRoute("/api/auth/login")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: {
          email?: string;
          password?: string;
        } | null;
        try {
          body = await readJsonWithLimit(request, 32_768);
        } catch (error) {
          if (error instanceof BodyTooLargeError) {
            return Response.json({ error: "Solicitud demasiado grande" }, { status: 413 });
          }
          return Response.json({ error: "Solicitud inválida" }, { status: 400 });
        }
        const email = body?.email?.trim().toLowerCase();
        if (!email || !body?.password) {
          return Response.json({ error: "Email y contraseña son requeridos" }, { status: 400 });
        }
        const limitKeys = [`login:ip:${requestIp(request)}`, `login:email:${email}`];
        const limits = await Promise.all(
          limitKeys.map((key) => enforceRateLimit({ key, limit: 5, windowSeconds: 900 })),
        );
        const limited = limits.find((response) => response !== null);
        if (limited) return limited;

        const result = await getPool().query<{
          id: string;
          email: string;
          name: string | null;
          password_hash: string;
        }>(
          "SELECT id, email, name, password_hash FROM users WHERE lower(email) = $1 AND active = true LIMIT 1",
          [email],
        );
        const user = result.rows[0];
        if (!user || !(await compare(body.password, user.password_hash))) {
          return Response.json({ error: "Credenciales incorrectas" }, { status: 401 });
        }

        await Promise.all(limitKeys.map((key) => clearRateLimit(key).catch(() => undefined)));
        const { token, expiresAt } = await createSession(user.id);
        return Response.json(
          { user: { id: user.id, email: user.email, name: user.name } },
          { headers: { "set-cookie": sessionCookie(token, expiresAt) } },
        );
      },
    },
  },
});
