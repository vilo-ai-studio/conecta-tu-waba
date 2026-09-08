import { createFileRoute } from "@tanstack/react-router";

// Validates a public onboarding token WITHOUT revealing internal ids to the browser.
// Returns only what the public UI needs to render.
export const Route = createFileRoute("/api/public/onboarding/validate")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const { token } = (await request.json()) as { token?: string };
          if (!token || typeof token !== "string" || token.length < 16) {
            return Response.json({ valid: false, reason: "invalid_token" }, { status: 400 });
          }

    const { databaseAdmin } = await import("@/integrations/database/client.server");

          const { data: link, error } = await databaseAdmin
            .from("onboarding_links")
            .select("id,client_id,expires_at,used_at,clients(name,company_name)")
            .eq("token", token)
            .maybeSingle();

          if (error) {
            console.error("[onboarding.validate] db error", error);
            return Response.json({ valid: false, reason: "server_error" }, { status: 500 });
          }
          if (!link) return Response.json({ valid: false, reason: "not_found" }, { status: 404 });
          if (link.used_at) return Response.json({ valid: false, reason: "already_used" }, { status: 410 });
          if (link.expires_at && new Date(link.expires_at) < new Date()) {
            return Response.json({ valid: false, reason: "expired" }, { status: 410 });
          }

          const client = link.clients as any;
          return Response.json({
            valid: true,
            client_id: link.client_id,
            client_name: client?.name ?? null,
            company_name: client?.company_name ?? null,
          });
        } catch (err) {
          console.error("[onboarding.validate] unexpected", err);
          return Response.json({ valid: false, reason: "server_error" }, { status: 500 });
        }
      },
    },
  },
});
