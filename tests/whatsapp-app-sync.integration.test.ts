import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { getPool } from "../src/integrations/database/client.server";
import { processMetaChangeJob, PermanentJobError } from "../src/lib/meta-webhook-processor.server";
import {
  closeQueueConnections,
  persistAndEnqueueMetaWebhook,
  type MetaChangeJobV1,
} from "../src/lib/queue.server";

const dbUrl = process.env.APP_SYNC_TEST_DATABASE_URL;
const apiUrl = process.env.C24_APP_SYNC_TEST_URL;

test(
  "Connect → HTTP C24 → real inbox: echoes, retries, account boundaries and authentication",
  {
    skip: !dbUrl || !apiUrl,
  },
  async () => {
    const db = new URL(dbUrl!);
    const api = new URL(apiUrl!);
    assert.equal(db.hostname, "127.0.0.1");
    assert.equal(db.pathname, "/connect_app_sync_validation");
    assert.equal(api.hostname, "127.0.0.1");
    assert.equal(api.protocol, "http:");
    process.env.DATABASE_URL = dbUrl;
    process.env.REDIS_URL = "redis://127.0.0.1:56379/14";
    process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 24).toString("base64");
    const pool = getPool();
    const c24 = new pg.Pool({
      connectionString: dbUrl!.replace(
        "connect_app_sync_validation",
        "c24_closeout_validation_20261013",
      ),
    });
    const client = "00000000-0000-4000-8000-000000000024";
    const account = randomUUID();
    const phoneId = `synthetic-${randomUUID()}`;
    const recipient = `52998${randomInt(1000000, 9999999)}`;
    const messageId = `synthetic-app-${randomUUID()}`;
    const sent = Math.floor(Date.now() / 1000) - 60;
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "synthetic-waba",
          changes: [
            {
              field: "smb_message_echoes",
              value: {
                metadata: { phone_number_id: phoneId, display_phone_number: "+52 999 000 0024" },
                message_echoes: [
                  {
                    id: messageId,
                    from: "529990000024",
                    to: recipient,
                    type: "text",
                    timestamp: String(sent),
                    text: { body: "Respuesta ficticia enviada desde el celular" },
                  },
                  {
                    id: `${messageId}-image`,
                    from: "529990000024",
                    to: recipient,
                    type: "image",
                    timestamp: String(sent - 30),
                    image: { id: "synthetic-media", caption: "Foto ficticia desde el celular" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    async function enqueue(body: unknown) {
      const result = await persistAndEnqueueMetaWebhook({
        rawBody: JSON.stringify(body),
        parsedBody: body,
        headers: {},
        requestUrl: "http://local.test/meta",
        queryParams: {},
      });
      const rows = await pool.query<{ payload: MetaChangeJobV1 }>(
        "SELECT payload FROM webhook_jobs WHERE raw_event_id=$1",
        [result.rawEventId],
      );
      return { result, jobs: rows.rows.map((row) => row.payload) };
    }
    const outboxBefore = (await c24.query("SELECT count(*) FROM outbox_messages")).rows[0].count;
    try {
      await pool.query(
        "INSERT INTO clients(id,name,n8n_enabled,n8n_webhook_url,n8n_webhook_secret_encrypted) VALUES($1,'C24 ficticio',true,$2,'synthetic-app-sync-secret')",
        [client, `${apiUrl}/webhooks/connect-router`],
      );
      await pool.query(
        "INSERT INTO whatsapp_accounts(id,client_id,waba_id,phone_number_id,display_phone_number) VALUES($1,$2,'synthetic-waba',$3,'529990000024')",
        [account, client, phoneId],
      );
      process.env.WHATSAPP_APP_ECHO_CLIENT_IDS = "";
      const disabledPayload = structuredClone(payload);
      for (const message of disabledPayload.entry[0].changes[0].value.message_echoes) {
        message.id = `disabled-${message.id}`;
      }
      const disabled = await enqueue(disabledPayload);
      await processMetaChangeJob(disabled.jobs[0]);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM n8n_forward_logs WHERE client_id=$1 AND forward_attempted=true",
            [client],
          )
        ).rows[0].count,
        "0",
      );
      process.env.WHATSAPP_APP_ECHO_CLIENT_IDS = client;
      const { result, jobs } = await enqueue(payload);
      assert.equal(result.accepted, 1);
      assert.equal(jobs.length, 1);
      await processMetaChangeJob(jobs[0]);
      await processMetaChangeJob(jobs[0]);
      assert.equal((await enqueue(payload)).result.duplicate, 1);
      const messages = await c24.query(
        "SELECT m.*,c.telefono_whatsapp,c.status,c.last_inbound_at FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.meta_message_id LIKE $1 ORDER BY m.created_at",
        [`${messageId}%`],
      );
      assert.equal(messages.rowCount, 2);
      assert.deepEqual(
        messages.rows.map((row) => [
          row.direction,
          row.sender_type,
          row.telefono_whatsapp,
          row.status,
          row.last_inbound_at,
        ]),
        [
          ["outbound", "human", `+${recipient}`, "open", null],
          ["outbound", "human", `+${recipient}`, "open", null],
        ],
      );
      assert.equal(messages.rows[1].created_at.getTime(), sent * 1000);
      const forwarded = await pool.query(
        "SELECT request_payload FROM n8n_forward_logs WHERE client_id=$1 AND forward_attempted=true ORDER BY attempted_at",
        [client],
      );
      assert.equal(forwarded.rowCount, 2);
      assert.ok(
        forwarded.rows.every(
          (row) =>
            row.request_payload.event_kind === "message_echo" &&
            row.request_payload.direction === "outbound" &&
            row.request_payload.to === `521${recipient.slice(2)}`,
        ),
      );
      const badSecret = await fetch(`${apiUrl}/webhooks/connect-router`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-N8N-Webhook-Secret": "wrong" },
        body: JSON.stringify({ client_id: client, raw: payload }),
      });
      assert.equal(badSecret.status, 401);
      const foreign = await fetch(`${apiUrl}/webhooks/connect-router`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-N8N-Webhook-Secret": "synthetic-app-sync-secret",
        },
        body: JSON.stringify({ client_id: randomUUID(), raw: payload }),
      });
      assert.equal(foreign.status, 403);
      const malformed = structuredClone(payload);
      malformed.entry[0].changes[0].value.message_echoes[0].to = "";
      const rejected = await enqueue(malformed);
      // Same message identifiers are a retry; use a new identifier for the invalid event.
      assert.equal(rejected.result.duplicate, 1);
      malformed.entry[0].changes[0].value.message_echoes[0].id = `invalid-${randomUUID()}`;
      const invalid = await enqueue(malformed);
      await assert.rejects(() => processMetaChangeJob(invalid.jobs[0]), PermanentJobError);
      assert.equal((await fetch(`${apiUrl}/api/v1/operacion/conversaciones`)).status, 401);
      assert.equal(
        (await c24.query("SELECT count(*) FROM outbox_messages")).rows[0].count,
        outboxBefore,
      );
      console.log("Synthetic app echoes persisted through Connect and C24; no external send.");
    } finally {
      await c24.query("DELETE FROM messages WHERE meta_message_id LIKE $1", [`${messageId}%`]);
      await c24.query("DELETE FROM meta_webhook_events WHERE meta_message_id LIKE $1", [
        `${messageId}%`,
      ]);
      await c24.query(
        "DELETE FROM conversations WHERE telefono_whatsapp=$1 AND NOT EXISTS(SELECT 1 FROM messages WHERE conversation_id=conversations.id)",
        [`+${recipient}`],
      );
      await pool.query("DELETE FROM clients WHERE id=$1", [client]);
      await closeQueueConnections();
      await c24.end();
      await pool.end();
    }
  },
);
