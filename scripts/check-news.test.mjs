import assert from "node:assert/strict";
import test from "node:test";
import { validateProjectNews } from "./check-news.mjs";

test("publishing accepts UTF-8 and rejects bytes the production reader cannot decode", () => {
  const item = { id: "2026-10-27", title: "Nová verze", body: "共通のニュース" };
  const feed = { schemaVersion: 1, items: [item] };
  assert.deepEqual(validateProjectNews(Buffer.from(JSON.stringify(feed))), feed);
  const prefix = Buffer.from('{"schemaVersion":1,"items":[{"id":"2026-10-27","title":"');
  const invalid = Buffer.concat([prefix, Buffer.from([0xff]), Buffer.from('","body":"Update"}]}')]);
  // Replacement decoding would hide malformed source bytes inside valid JSON.
  assert.doesNotThrow(() => JSON.parse(invalid.toString("utf8")));
  assert.throws(() => validateProjectNews(invalid), /encoded data was not valid/);
});
