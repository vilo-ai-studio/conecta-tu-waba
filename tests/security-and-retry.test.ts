import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { verifyMetaSignature } from "../src/lib/queue.server";
import {
  BodyTooLargeError,
  constantTimeEqual,
  readJsonWithLimit,
} from "../src/lib/request-security.server";
import {
  isRetryableHttpStatus,
  retryAfterMilliseconds,
  retryDelayMs,
} from "../src/lib/retry-policy";
import { isMetaSubscriptionConfirmed } from "../src/lib/meta-subscription";

test("firma Meta válida, inválida, ausente y malformada", () => {
  process.env.META_APP_SECRET = "test-secret";
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
  const signature = `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;
  assert.equal(verifyMetaSignature(body, signature), true);
  assert.equal(verifyMetaSignature(`${body}x`, signature), false);
  assert.equal(verifyMetaSignature(body, null), false);
  assert.equal(verifyMetaSignature(body, "sha256=no-es-hex"), false);
});

test("lector JSON acepta el límite y rechaza cuerpos mayores", async () => {
  const request = new Request("http://local.test", {
    method: "POST",
    body: JSON.stringify({ ok: true }),
  });
  assert.deepEqual(await readJsonWithLimit(request, 32), { ok: true });
  const oversized = new Request("http://local.test", { method: "POST", body: "x".repeat(33) });
  await assert.rejects(() => readJsonWithLimit(oversized, 32), BodyTooLargeError);
});

test("comparación de secretos conserva igualdad exacta", () => {
  assert.equal(constantTimeEqual("secreto", "secreto"), true);
  assert.equal(constantTimeEqual("secreto", "secreta"), false);
  assert.equal(constantTimeEqual("corto", "mucho-mas-largo"), false);
});

test("secuencia exacta de reintentos sin jitter y jitter máximo de 20%", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7].map((attempt) => retryDelayMs(attempt, () => 0)),
    [5_000, 30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000],
  );
  assert.equal(
    retryDelayMs(1, () => 1),
    6_000,
  );
});

test("clasifica errores HTTP y respeta Retry-After", () => {
  for (const status of [408, 429, 500, 503, 599]) assert.equal(isRetryableHttpStatus(status), true);
  for (const status of [400, 401, 403, 404]) assert.equal(isRetryableHttpStatus(status), false);
  assert.equal(retryAfterMilliseconds("12"), 12_000);
  const now = Date.parse("2026-09-07T12:00:00Z");
  assert.equal(retryAfterMilliseconds("Sun, 07 Sep 2026 12:00:30 GMT", now), 30_000);
});

test("la suscripción de Meta requiere confirmación explícita", () => {
  assert.equal(isMetaSubscriptionConfirmed({ success: true }), true);
  assert.equal(isMetaSubscriptionConfirmed({ success: false }), false);
  assert.equal(isMetaSubscriptionConfirmed({ data: [] }), false);
  assert.equal(isMetaSubscriptionConfirmed({ data: [{ id: "app" }] }), false);
  assert.equal(isMetaSubscriptionConfirmed(null), false);
});
