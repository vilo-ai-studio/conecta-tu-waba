import { createFileRoute } from "@tanstack/react-router";
import { getSessionUser } from "@/integrations/database/session.server";
import { assertOperationsAdmin, buildOperationsHealth } from "@/lib/operations.server";

export const Route = createFileRoute("/api/health/details")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const user = await getSessionUser(request);
        if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
        try {
          await assertOperationsAdmin(user.id);
        } catch {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        try {
          return Response.json(await buildOperationsHealth());
        } catch (error) {
          console.error("[health.details] check failed", error);
          return Response.json({ status: "error" }, { status: 503 });
        }
      },
    },
  },
});
