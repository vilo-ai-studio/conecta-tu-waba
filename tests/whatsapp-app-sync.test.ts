import assert from "node:assert/strict";
import test from "node:test";
import { jobDeduplicationKey } from "../src/lib/queue.server";

function echo(ids: string[], phone = "synthetic-account") {
  return {
    field: "smb_message_echoes",
    value: {
      metadata: { phone_number_id: phone },
      message_echoes: ids.map((id) => ({ id, to: "529990000025", timestamp: "1791896400" })),
    },
  };
}

test("app echo deduplication keeps distinct messages and accounts, ignores retry order", () => {
  const first = jobDeduplicationKey("waba", echo(["id-1"]));
  assert.notEqual(first, jobDeduplicationKey("waba", echo(["id-2"])));
  assert.notEqual(first, jobDeduplicationKey("waba", echo(["id-1"], "other-account")));
  assert.equal(
    jobDeduplicationKey("waba", echo(["id-1", "id-2"])),
    jobDeduplicationKey("waba", echo(["id-2", "id-1"])),
  );
  assert.notEqual(
    first,
    jobDeduplicationKey("waba", {
      field: "messages",
      value: { messages: [{ id: "id-1" }] },
    }),
  );
});
