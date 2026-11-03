import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  assertDavReadResponse,
  DavReadResponseError,
  davMultistatus,
  successfulDavProperty,
  CALDAV,
} from "../caldav_properties";

const scenario = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
    title: z.string().min(1),
    data: z.string(),
    prefix: z.string().optional(),
    padding: z.number().int().min(0).max(4194304).optional(),
    valid: z.boolean(),
  })
  .strict();
const schema = z
  .object({
    schemaVersion: z.literal(1),
    suite: z.literal("dav-response"),
    scenarios: z.array(scenario).min(1),
  })
  .strict();
export async function loadDavResponseSuite() {
  const suite = schema.parse(
    JSON.parse(
      await readFile(new URL("./dav-response.json", import.meta.url), "utf8"),
    ),
  );
  assert.equal(
    new Set(suite.scenarios.map((item) => item.id)).size,
    suite.scenarios.length,
  );
  return suite;
}
export function runDavResponseScenario(value: z.infer<typeof scenario>) {
  const url = "https://dav.example.test/calendar/event.ics";
  const data = value.data + " ".repeat(value.padding ?? 0);
  const xml = `${value.prefix ?? ""}<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>${url}</d:href><d:propstat><d:prop><d:getetag>"fixture"</d:getetag><c:calendar-data>${data}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
  if (value.valid) {
    assertDavReadResponse(
      xml,
      "https://dav.example.test/calendar/",
      "multiget",
      [url],
    );
    const body = successfulDavProperty(
      davMultistatus(xml, url)[0]!,
      CALDAV,
      "calendar-data",
    )?.text;
    assert.ok(
      body?.includes("BEGIN:VCALENDAR"),
      "Accepted calendar data is retained",
    );
  } else
    assert.throws(
      () =>
        assertDavReadResponse(
          xml,
          "https://dav.example.test/calendar/",
          "multiget",
          [url],
        ),
      DavReadResponseError,
    );
  return { accepted: value.valid, productionValidator: true };
}
