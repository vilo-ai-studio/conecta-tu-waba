import { createFileRoute } from "@tanstack/react-router";
import {
  deleteSession,
  expiredSessionCookie,
  readCookie,
  SESSION_COOKIE,
} from "@/integrations/database/session.server";

export const Route = createFileRoute("/api/auth/logout")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        await deleteSession(readCookie(request, SESSION_COOKIE));
        return Response.json({ ok: true }, { headers: { "set-cookie": expiredSessionCookie() } });
      },
    },
  },
});
