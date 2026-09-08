import { createHmac } from "node:crypto";

const baseUrl = process.env.LOAD_TEST_BASE_URL ?? "http://127.0.0.1:3101";
const secret = process.env.LOAD_TEST_META_SECRET;
const total = Number(process.env.LOAD_TEST_TOTAL ?? 1_000);
const concurrency = Number(process.env.LOAD_TEST_CONCURRENCY ?? 10);
const duplicateEvery = Number(process.env.LOAD_TEST_DUPLICATE_EVERY ?? 10);
const prefix = process.env.LOAD_TEST_PREFIX ?? "wamid.load";
const startIndex = Number(process.env.LOAD_TEST_START_INDEX ?? 0);
const retryUnavailable = process.env.LOAD_TEST_RETRY_503 === "true";
const conversations = Math.max(1, Number(process.env.LOAD_TEST_CONVERSATIONS ?? 25));
const messagePrefix = process.env.LOAD_TEST_MESSAGE_PREFIX ?? "Mensaje";
const clients = Math.max(1, Math.min(10, Number(process.env.LOAD_TEST_CLIENTS ?? 10)));
if (!secret) throw new Error("Falta LOAD_TEST_META_SECRET");

const durations = [];
let accepted = 0;
let failed = 0;
let cursor = 0;
const ids = [];
for (let index = 0; index < total; index += 1) {
  const duplicate = duplicateEvery > 0 && index > 0 && index % duplicateEvery === 0;
  ids.push(duplicate ? ids[index - 1] : `${prefix}.${startIndex + index}`);
}

async function runner() {
  while (true) {
    const index = cursor++;
    if (index >= total) return;
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: `waba-load-${index % clients}`,
          changes: [
            {
              field: "messages",
              value: {
                metadata: {
                  phone_number_id: `phone-load-${index % clients}`,
                  display_phone_number: `+52999000${index % clients}`,
                },
                contacts: [
                  {
                    wa_id: `521999000${index % conversations}`,
                    profile: { name: `Contacto ${index % conversations}` },
                  },
                ],
                messages: [
                  {
                    id: ids[index],
                    from: `521999000${index % conversations}`,
                    timestamp: String(Math.floor(Date.now() / 1_000)),
                    type: "text",
                    text: { body: `${messagePrefix} ${index}` },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const started = performance.now();
    try {
      let response;
      for (let attempt = 1; attempt <= (retryUnavailable ? 40 : 1); attempt += 1) {
        response = await fetch(`${baseUrl}/api/public/whatsapp/webhook`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-hub-signature-256": signature },
          body,
        });
        if (response.status !== 503 || !retryUnavailable) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      durations.push(performance.now() - started);
      if (response?.ok) accepted += 1;
      else {
        failed += 1;
        console.error("[load-test] rejected", response?.status, await response?.text());
      }
    } catch (error) {
      durations.push(performance.now() - started);
      failed += 1;
      console.error("[load-test] request failed", error);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => runner()));
durations.sort((left, right) => left - right);
const percentile = (p) =>
  durations[Math.min(durations.length - 1, Math.ceil(durations.length * p) - 1)] ?? 0;
const report = {
  total,
  accepted,
  failed,
  concurrency,
  p50_ms: Math.round(percentile(0.5)),
  p95_ms: Math.round(percentile(0.95)),
  max_ms: Math.round(durations.at(-1) ?? 0),
};
console.log(JSON.stringify(report, null, 2));
if (failed > 0 || report.p95_ms >= 750 || report.max_ms >= 2_000) process.exitCode = 1;
