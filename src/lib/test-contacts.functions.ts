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

export const listTestContacts = createServerFn({ method: "GET" })
  .middleware([requireDatabaseAuth])
  .inputValidator((input: { client_id: string }) =>
    z.object({ client_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.database, context.userId);
    const { data: rows, error } = await context.database
      .from("test_contacts")
      .select("id, label, phone, created_at")
      .eq("client_id", data.client_id)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const createTestContact = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .inputValidator((input: { client_id: string; label: string; phone: string }) =>
    z.object({
      client_id: z.string().uuid(),
      label: z.string().trim().min(1).max(80),
      phone: z.string().trim().min(4).max(30),
    }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.database, context.userId);
    const phone = data.phone.replace(/[^\d]/g, "");
    if (phone.length < 6) throw new Error("Número inválido");
    const { data: row, error } = await context.database
      .from("test_contacts")
      .insert({ client_id: data.client_id, label: data.label, phone })
      .select("id, label, phone, created_at")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const deleteTestContact = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .inputValidator((input: { id: string }) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    await assertAdmin(context.database, context.userId);
    const { error } = await context.database.from("test_contacts").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
