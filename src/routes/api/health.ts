import { createFileRoute } from "@tanstack/react-router";
import { checkDatabase } from "@/integrations/database/client.server";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        try {
          await checkDatabase();
          return Response.json({ status: "ok", database: "ok" });
        } catch (error) {
          console.error("[health] database unavailable", error);
          return Response.json({ status: "error", database: "unavailable" }, { status: 503 });
        }
      },
    },
  },
});
