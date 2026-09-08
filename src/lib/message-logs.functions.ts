import { createServerFn } from "@tanstack/react-start";
import { requireDatabaseAuth } from "@/integrations/database/auth-middleware";
import { z } from "zod";

async function assertAdmin(database: any, userId: string) {
  const { data } = await database
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!data) throw new Error("No autorizado");
}

// Lista los logs de envío de mensajes de WhatsApp para un cliente, más
// reciente primero. Incluye source (panel/n8n), status, error y payload crudo.
export const listMessageLogs = createServerFn({ method: "GET" })
  .middleware([requireDatabaseAuth])
  .inputValidator((input: { client_id: string; limit?: number; status?: string | null }) =>
    z.object({
      client_id: z.string().uuid(),
      limit: z.number().int().min(1).max(500).optional(),
      status: z.string().nullable().optional(),
    }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.database, context.userId);
    const { databaseAdmin } = await import("@/integrations/database/client.server");
    let q = databaseAdmin
      .from("message_send_logs")
      .select("*")
      .eq("client_id", data.client_id)
      .order("created_at", { ascending: false })
      .limit(data.limit ?? 100);
    if (data.status && data.status !== "all") q = q.eq("status", data.status);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });
