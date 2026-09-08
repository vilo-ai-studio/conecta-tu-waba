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

// Lista los últimos eventos entrantes desde Meta para un cliente.
export const listMetaEvents = createServerFn({ method: "GET" })
  .middleware([requireDatabaseAuth])
  .inputValidator((input: { client_id: string; limit?: number }) =>
    z.object({
      client_id: z.string().uuid(),
      limit: z.number().int().min(1).max(500).optional(),
    }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.database, context.userId);
    const { databaseAdmin } = await import("@/integrations/database/client.server");
    const { data: rows, error } = await databaseAdmin
      .from("meta_webhook_events")
      .select("*")
      .eq("client_id", data.client_id)
      .order("received_at", { ascending: false })
      .limit(data.limit ?? 100);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

// Lista los últimos reenvíos a n8n para un cliente.
export const listN8nForwards = createServerFn({ method: "GET" })
  .middleware([requireDatabaseAuth])
  .inputValidator((input: { client_id: string; limit?: number }) =>
    z.object({
      client_id: z.string().uuid(),
      limit: z.number().int().min(1).max(500).optional(),
    }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.database, context.userId);
    const { databaseAdmin } = await import("@/integrations/database/client.server");
    const { data: rows, error } = await databaseAdmin
      .from("n8n_forward_logs")
      .select("*")
      .eq("client_id", data.client_id)
      .order("attempted_at", { ascending: false })
      .limit(data.limit ?? 100);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

// Lista los últimos envíos a Meta para un cliente.
export const listWhatsAppSends = createServerFn({ method: "GET" })
  .middleware([requireDatabaseAuth])
  .inputValidator((input: { client_id: string; limit?: number }) =>
    z.object({
      client_id: z.string().uuid(),
      limit: z.number().int().min(1).max(500).optional(),
    }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.database, context.userId);
    const { databaseAdmin } = await import("@/integrations/database/client.server");
    const { data: rows, error } = await databaseAdmin
      .from("whatsapp_send_logs")
      .select("*")
      .eq("client_id", data.client_id)
      .order("created_at", { ascending: false })
      .limit(data.limit ?? 100);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });
