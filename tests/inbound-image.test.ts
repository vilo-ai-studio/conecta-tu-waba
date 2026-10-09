import assert from "node:assert/strict";
import test from "node:test";
import { getPool } from "../src/integrations/database/client.server";
import { encryptSecret } from "../src/integrations/database/secrets.server";
import { getRedis } from "../src/lib/queue.server";
import {
  downloadInboundImageEndpoint,
  fetchInboundImage,
  inboundImageId,
} from "../src/lib/inbound-image.server";

process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.DATABASE_URL = "postgresql://synthetic:synthetic@127.0.0.1:1/synthetic";
process.env.META_SYSTEM_USER_ACCESS_TOKEN = "synthetic-token";
const CLIENT = "00000000-0000-0000-0000-000000000001";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const payload = {
  entry: [
    {
      changes: [
        {
          value: {
            metadata: { phone_number_id: "phone-test" },
            messages: [
              { id: "wamid.other", type: "image", image: { id: "101" } },
              { id: "wamid.synthetic", type: "image", image: { id: "102" } },
            ],
          },
        },
      ],
    },
  ],
};

function request(secret = "synthetic-secret") {
  return new Request("https://router.test/api/public/whatsapp/download-image", {
    method: "POST",
    headers: { "x-n8n-webhook-secret": secret },
    body: JSON.stringify({ client_id: CLIENT, inbound_message_id: "wamid.synthetic" }),
  });
}

test("media ID belongs to this exact message and receiving account", () => {
  assert.equal(inboundImageId(payload, "wamid.synthetic", "phone-test"), "102");
  assert.equal(inboundImageId(payload, "wamid.other", "phone-test"), "101");
  assert.equal(inboundImageId(payload, "wamid.missing", "phone-test"), null);
  assert.equal(inboundImageId(payload, "wamid.synthetic", "other-account"), null);
});

test("missing or incorrect secret never fetches Meta", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("must not fetch");
  });
  const query = t.mock.method(getPool(), "query", async () => ({
    rows: [{ secret: encryptSecret("synthetic-secret") }],
  }));
  assert.equal((await downloadInboundImageEndpoint(request(""))).status, 401);
  assert.equal(query.mock.callCount(), 0);
  assert.equal((await downloadInboundImageEndpoint(request("wrong"))).status, 401);
  assert.equal(fetch.mock.callCount(), 0);
});

test("client-scoped image lookup rejects a foreign event before Meta", async (t) => {
  t.mock.method(getRedis(), "eval", async () => [1, 11]);
  const query = t.mock.method(getPool(), "query", async (sql: string, values: unknown[]) => {
    if (sql.includes("FROM clients"))
      return { rows: [{ secret: encryptSecret("synthetic-secret") }] };
    assert.ok(sql.includes("event.client_id = $1") && sql.includes("account.client_id = $1"));
    assert.ok(
      sql.includes("event.wa_message_id = $2") && sql.includes("event.event_kind = 'message'"),
    );
    assert.deepEqual(values, [CLIENT, "wamid.synthetic"]);
    return { rows: [] };
  });
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("must not fetch");
  });
  assert.equal((await downloadInboundImageEndpoint(request())).status, 404);
  assert.equal(query.mock.callCount(), 2);
  assert.equal(fetch.mock.callCount(), 0);
});

test("authorized image returns bounded bytes without credentials or vendor URL", async (t) => {
  t.mock.method(getRedis(), "eval", async () => [1, 11]);
  t.mock.method(getPool(), "query", async (sql: string) => ({
    rows: sql.includes("FROM clients")
      ? [{ secret: encryptSecret("synthetic-secret") }]
      : [{ raw_payload: payload, phone_number_id: "phone-test" }],
  }));
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL, options: RequestInit) => {
      assert.equal(
        (options.headers as Record<string, string>).authorization,
        "Bearer synthetic-token",
      );
      assert.equal(options.redirect, "error");
      if (String(url).includes("graph.facebook.com")) {
        assert.ok(String(url).endsWith("/102"));
        return Response.json({
          url: "https://lookaside.fbsbx.com/synthetic",
          mime_type: "image/png",
        });
      }
      return new Response(PNG);
    },
  );
  const response = await downloadInboundImageEndpoint(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), PNG);
  assert.equal(fetch.mock.callCount(), 2);
});

test("unsafe CDN URL cannot receive bearer credentials", async (t) => {
  for (const url of [
    "https://127.0.0.1/private",
    "https://fbsbx.com.attacker.test/image",
    "http://lookaside.fbsbx.com/image",
    "https://user:password@lookaside.fbsbx.com/image",
  ]) {
    const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ url }));
    await assert.rejects(() => fetchInboundImage("102"));
    assert.equal(fetch.mock.callCount(), 1);
    fetch.mock.restore();
  }
});

test("oversized and invalid image responses fail closed", async (t) => {
  for (const oversized of [true, false]) {
    let call = 0;
    const fetch = t.mock.method(globalThis, "fetch", async () => {
      if (++call === 1) return Response.json({ url: "https://lookaside.fbsbx.com/synthetic" });
      return new Response(oversized ? PNG : new TextEncoder().encode("<html>"), {
        headers: oversized ? { "content-length": String(10 * 1024 * 1024 + 1) } : {},
      });
    });
    await assert.rejects(() => fetchInboundImage("102"));
    fetch.mock.restore();
  }
});

test("streaming enforces 10 MB even without a declared size", async (t) => {
  let call = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++call === 1) return Response.json({ url: "https://lookaside.fbsbx.com/synthetic" });
    return new Response(new Uint8Array(10 * 1024 * 1024 + 1));
  });
  await assert.rejects(() => fetchInboundImage("102"), /image_too_large/);
});
