import http from "node:http";

const attempts = new Map();
const completed = new Map();
let active = 0;
let maxActive = 0;
const activeByConversation = new Map();
const maxByConversation = new Map();
const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/metrics") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        max_active: maxActive,
        max_by_conversation: Object.fromEntries(maxByConversation),
      }),
    );
    return;
  }
  if (request.method === "POST" && request.url === "/reset") {
    active = 0;
    maxActive = 0;
    activeByConversation.clear();
    maxByConversation.clear();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const conversation = String(body.from ?? "unknown");
  active += 1;
  maxActive = Math.max(maxActive, active);
  const conversationActive = (activeByConversation.get(conversation) ?? 0) + 1;
  activeByConversation.set(conversation, conversationActive);
  maxByConversation.set(
    conversation,
    Math.max(maxByConversation.get(conversation) ?? 0, conversationActive),
  );
  const completeRequest = () => {
    active = Math.max(0, active - 1);
    activeByConversation.set(
      conversation,
      Math.max(0, (activeByConversation.get(conversation) ?? 1) - 1),
    );
  };
  const idempotencyKey = request.headers["idempotency-key"];
  if (idempotencyKey && completed.has(idempotencyKey)) {
    completeRequest();
    response.writeHead(200, { "content-type": "application/json", "x-idempotent-replay": "true" });
    response.end(JSON.stringify(completed.get(idempotencyKey)));
    return;
  }
  const messageId = String(body.message_id ?? "unknown");
  const numeric = Number(messageId.match(/(\d+)$/)?.[1] ?? 0);
  const attempt = (attempts.get(messageId) ?? 0) + 1;
  attempts.set(messageId, attempt);
  if (numeric % 97 === 0 && attempt === 1) await new Promise((resolve) => setTimeout(resolve, 500));
  if (String(body.text ?? "").startsWith("parallel-test")) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (numeric % 43 === 0 && attempt === 1) {
    completeRequest();
    response.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
    response.end(JSON.stringify({ error: "simulated_rate_limit" }));
    return;
  }
  if (numeric % 59 === 0 && attempt === 1) {
    completeRequest();
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "simulated_temporary_failure" }));
    return;
  }
  const result = { ok: true, message_id: messageId, attempt };
  if (idempotencyKey) completed.set(idempotencyKey, result);
  completeRequest();
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(result));
});

server.listen(4000, "0.0.0.0", () => console.log("[mock-integrations] listening on 4000"));
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
