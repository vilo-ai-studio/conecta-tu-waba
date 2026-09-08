import { compare } from "bcryptjs";
import { createFileRoute } from "@tanstack/react-router";
import { getPool } from "@/integrations/database/client.server";
import { createSession, sessionCookie } from "@/integrations/database/session.server";

export const Route = createFileRoute("/api/auth/login")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => null)) as {
          email?: string;
          password?: string;
        } | null;
        const email = body?.email?.trim().toLowerCase();
        if (!email || !body?.password) {
          return Response.json({ error: "Email y contraseña son requeridos" }, { status: 400 });
        }

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

        const { token, expiresAt } = await createSession(user.id);
        return Response.json(
          { user: { id: user.id, email: user.email, name: user.name } },
          { headers: { "set-cookie": sessionCookie(token, expiresAt) } },
        );
      },
    },
  },
});
