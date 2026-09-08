import { createFileRoute } from "@tanstack/react-router";
import { checkDatabase } from "@/integrations/database/client.server";
import { getRedis } from "@/lib/queue.server";

export const Route = createFileRoute("/api/health/ready")({
  server: {
    handlers: {
      GET: async () => {
        const [database, redis] = await Promise.allSettled([checkDatabase(), getRedis().ping()]);
        const components = {
          database: database.status === "fulfilled" ? "ok" : "error",
          redis: redis.status === "fulfilled" ? "ok" : "error",
        };
        const ready = database.status === "fulfilled" && redis.status === "fulfilled";
        if (!ready) console.error("[readiness] dependency unavailable", components);
        return Response.json(
          { status: ready ? "ok" : "error", ...components },
          { status: ready ? 200 : 503 },
        );
      },
    },
  },
});
