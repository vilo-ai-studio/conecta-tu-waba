import { createFileRoute } from "@tanstack/react-router";
import { getSessionUser } from "@/integrations/database/session.server";

export const Route = createFileRoute("/api/auth/session")({
  server: {
    handlers: {
      GET: async ({ request }) => Response.json({ user: await getSessionUser(request) }),
    },
  },
});
