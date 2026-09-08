import process from "node:process";
import { createCipheriv, randomBytes } from "node:crypto";
import pg from "pg";

const { Client } = pg;
const sourceUrl = process.env.LEGACY_DATABASE_URL;
const targetUrl = process.env.DATABASE_URL;
const encryptedColumns = new Set([
  "token_encrypted",
  "n8n_webhook_secret_encrypted",
  "chatwoot_api_access_token_encrypted",
  "chatwoot_webhook_secret_encrypted",
]);

if (!sourceUrl) throw new Error("Falta LEGACY_DATABASE_URL (base actual de Lovable)");
if (!targetUrl) throw new Error("Falta DATABASE_URL (PostgreSQL nuevo)");
if (sourceUrl === targetUrl) throw new Error("Origen y destino no pueden ser la misma base");

function encryptionKey() {
  const encoded = process.env.DATA_ENCRYPTION_KEY;
  if (!encoded) throw new Error("Falta DATA_ENCRYPTION_KEY");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32)
    throw new Error("DATA_ENCRYPTION_KEY debe contener exactamente 32 bytes en base64");
  return key;
}

function encryptSecret(value) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("enc:v1:")) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ciphertext.toString("base64url")}`;
}

const tables = [
  "clients",
  "onboarding_links",
  "whatsapp_accounts",
  "webhook_events",
  "raw_meta_webhook_events",
  "meta_webhook_events",
  "n8n_forward_logs",
  "processed_whatsapp_messages",
  "message_send_logs",
  "whatsapp_send_logs",
  "test_contacts",
  "client_integrations",
  "chatwoot_contact_mappings",
  "chatwoot_conversation_mappings",
  "chatwoot_message_mappings",
  "chatwoot_integration_logs",
];

function sslConfig(prefix) {
  const mode = process.env[`${prefix}_SSL`] ?? "require";
  if (mode === "disable") return false;
  return { rejectUnauthorized: mode !== "no-verify" };
}

function identifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`Identificador inválido: ${value}`);
  return `"${value}"`;
}

async function columns(client, table) {
  const result = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table],
  );
  return result.rows.map((row) => row.column_name);
}

const source = new Client({ connectionString: sourceUrl, ssl: sslConfig("LEGACY_DATABASE") });
const target = new Client({ connectionString: targetUrl, ssl: sslConfig("DATABASE") });

await source.connect();
await target.connect();

const report = [];
try {
  await target.query("BEGIN");

  for (const table of tables) {
    const [sourceColumns, targetColumns] = await Promise.all([
      columns(source, table),
      columns(target, table),
    ]);

    if (sourceColumns.length === 0) {
      report.push({ table, source: 0, target: null, status: "source_missing" });
      continue;
    }
    if (targetColumns.length === 0) throw new Error(`La tabla destino public.${table} no existe`);

    const common = sourceColumns.filter((column) => targetColumns.includes(column));
    if (!common.includes("id")) throw new Error(`${table}: no existe una columna id común`);

    const select = common.map(identifier).join(", ");
    const sourceRows = await source.query(`SELECT ${select} FROM ${identifier(table)} ORDER BY id`);
    const targetBefore = await target.query(
      `SELECT count(*)::integer AS count FROM ${identifier(table)}`,
    );

    for (const row of sourceRows.rows) {
      const values = common.map((column) =>
        encryptedColumns.has(column) ? encryptSecret(row[column]) : row[column],
      );
      const placeholders = common.map((_, index) => `$${index + 1}`).join(", ");
      const updates = common
        .filter((column) => column !== "id")
        .map((column) => `${identifier(column)} = EXCLUDED.${identifier(column)}`)
        .join(", ");
      await target.query(
        `INSERT INTO ${identifier(table)} (${select}) VALUES (${placeholders})
         ON CONFLICT (id) DO UPDATE SET ${updates}`,
        values,
      );
    }

    const targetAfter = await target.query(
      `SELECT count(*)::integer AS count FROM ${identifier(table)}`,
    );
    report.push({
      table,
      source: sourceRows.rowCount,
      target_before: targetBefore.rows[0].count,
      target_after: targetAfter.rows[0].count,
      status: "ok",
    });
  }

  await target.query("COMMIT");
  console.table(report);
  console.log(
    "Importación terminada. Los usuarios de acceso no se migran; crea el administrador con npm run admin:create.",
  );
} catch (error) {
  await target.query("ROLLBACK");
  throw error;
} finally {
  await Promise.allSettled([source.end(), target.end()]);
}
