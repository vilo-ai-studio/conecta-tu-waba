import pg from "pg";

if (process.env.LOAD_TEST_ALLOWED !== "true") {
  throw new Error("Define LOAD_TEST_ALLOWED=true únicamente en una base aislada.");
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const mode = process.argv[2] ?? "seed";
try {
  if (mode === "cleanup") {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM webhook_events
          WHERE whatsapp_account_id IN (
            SELECT wa.id FROM whatsapp_accounts wa
            JOIN clients c ON c.id = wa.client_id
            WHERE c.email LIKE 'load-test-%@example.invalid'
          )`,
      );
      await client.query(
        `DELETE FROM meta_webhook_events
          WHERE client_id IN (
            SELECT id FROM clients WHERE email LIKE 'load-test-%@example.invalid'
          )`,
      );
      await client.query(
        `DELETE FROM webhook_jobs
          WHERE client_id IN (
            SELECT id FROM clients WHERE email LIKE 'load-test-%@example.invalid'
          )`,
      );
      await client.query("DELETE FROM raw_meta_webhook_events WHERE body_raw LIKE '%phone-load-%'");
      const removed = await client.query(
        "DELETE FROM clients WHERE email LIKE 'load-test-%@example.invalid' RETURNING id",
      );
      await client.query("COMMIT");
      console.log(`[load-test] fixtures removed: ${removed.rowCount} clients`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } else {
    for (let index = 0; index < 10; index += 1) {
      const clientId = `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      const accountId = `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      await pool.query(
        `INSERT INTO clients (id, name, email, company_name, status, n8n_enabled, n8n_webhook_url, n8n_webhook_secret_encrypted)
         VALUES ($1, $2, $3, $4, 'connected', true, 'http://mock-integrations:4000/webhook', 'load-test-secret')
         ON CONFLICT (id) DO UPDATE SET n8n_enabled = true, n8n_webhook_url = excluded.n8n_webhook_url,
           n8n_webhook_secret_encrypted = excluded.n8n_webhook_secret_encrypted`,
        [
          clientId,
          `Cliente prueba ${index + 1}`,
          `load-test-${index}@example.invalid`,
          `Carga ${index + 1}`,
        ],
      );
      await pool.query(
        `INSERT INTO whatsapp_accounts (id, client_id, waba_id, phone_number_id, status, connected_at)
         VALUES ($1, $2, $3, $4, 'connected', now())
         ON CONFLICT (id) DO UPDATE SET phone_number_id = excluded.phone_number_id, status = 'connected'`,
        [accountId, clientId, `waba-load-${index}`, `phone-load-${index}`],
      );
    }
    console.log("[load-test] 10 clients ready");
  }
} finally {
  await pool.end();
}
