import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  assertDavReadResponse,
  DavReadResponseError,
  davMultistatus,
  successfulDavProperty,
  CALDAV,
  requestedDavHrefs,
} from "../caldav_properties";

const identity = {
  id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  title: z.string().min(1),
  valid: z.boolean(),
};
const batchScenario = z
  .object({
    ...identity,
    batchObjects: z.number().int().min(1).max(1000),
    failBatch: z.number().int().positive().optional(),
    batchSizes: z.array(z.number().int().positive()).min(1),
  })
  .strict();
const scenario = z.union([
  z
    .object({
      ...identity,
      data: z.string(),
      prefix: z.string().optional(),
      padding: z.number().int().min(0).max(4194304).optional(),
    })
    .strict(),
  batchScenario,
]);
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
async function runBatchScenario(value: z.infer<typeof batchScenario>) {
  const { config } = await import("@musubi/config");
  const previousPrivate = config.security.federationAllowPrivateHosts,
    native = globalThis.fetch;
  config.security.federationAllowPrivateHosts = true;
  const origin = "http://127.0.0.1:1",
    batches: number[] = [];
  const document = (rows: string) =>
    `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${rows}</d:multistatus>`;
  const row = (href: string, props: string) =>
    `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  const data =
    "BEGIN:VCALENDAR\r\nDESCRIPTION:<!DOCTYPE html>\r\nEND:VCALENDAR";
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)),
      body = String(init?.body ?? "");
    assert.equal(url.origin, origin, "No native network");
    assert.ok(["GET", "PROPFIND", "REPORT"].includes(init?.method ?? "GET"));
    if (init?.method === "GET") return new Response(null, { status: 204 });
    let rows: string;
    if (body.includes("calendar-multiget")) {
      const hrefs = requestedDavHrefs(body);
      batches.push(hrefs.length);
      rows = hrefs
        .map((href) =>
          row(
            new URL(href, origin).href,
            `<d:getetag>"fixture"</d:getetag>${batches.length === value.failBatch ? "" : `<c:calendar-data><![CDATA[${data}]]></c:calendar-data>`}`,
          ),
        )
        .join("");
    } else if (body.includes("current-user-principal"))
      rows = row(
        url.href,
        "<d:current-user-principal><d:href>/principal/</d:href></d:current-user-principal>",
      );
    else
      rows = row(
        url.href,
        "<c:calendar-home-set><d:href>/home/</d:href></c:calendar-home-set>",
      );
    return new Response(document(rows), {
      status: 207,
      headers: { "content-type": "application/xml" },
    });
  };
  try {
    const { createCaldavClient } = await import("../caldav_client");
    const client = await createCaldavClient(origin, "fixture", "fixture");
    const objectUrls = Array.from(
      { length: value.batchObjects },
      (_, index) => `${origin}/calendar/${index}.ics`,
    );
    let returned = false;
    const read = async () => {
      const result = await client.fetchCalendarObjects({
        calendar: { url: `${origin}/calendar/` },
        objectUrls,
      });
      returned = true;
      return result;
    };
    if (value.valid) {
      const result = await read();
      assert.equal(result.length, objectUrls.length);
      assert.deepEqual(
        result.map((item) => item.url),
        objectUrls,
      );
      assert.ok(result.every((item) => item.data === data));
    } else {
      await assert.rejects(read, DavReadResponseError);
      assert.equal(
        returned,
        false,
        "No partial collection result after later batch failure",
      );
    }
    assert.deepEqual(batches, value.batchSizes);
    return {
      accepted: value.valid,
      productionClient: true,
      batches,
      partialResult: false,
    };
  } finally {
    globalThis.fetch = native;
    config.security.federationAllowPrivateHosts = previousPrivate;
  }
}

export async function runDavResponseScenario(value: z.infer<typeof scenario>) {
  if ("batchObjects" in value) return runBatchScenario(value);
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
