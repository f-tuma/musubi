import assert from "node:assert/strict";
import { config } from "@musubi/config";

async function main() {
  const origin = "http://127.0.0.1:1", home = origin + "/home/", collection = home + "calendar/";
  const originalFetch = globalThis.fetch, allowPrivate = config.security.federationAllowPrivateHosts;
  config.security.federationAllowPrivateHosts = true;
  // Construct module-scoped guarded transports only after the local fixture policy.
  const { classifyCaldavCalendars } = await import("./adapters/caldav");
  const { createCaldavClient } = await import("./caldav_client");
  const { DavReadResponseError } = await import("./caldav_properties");
  const { caldavEventPrivileges, caldavReadAccess, caldavAllows } = await import("./caldav_privileges");
  let chain = "ok", listings = 0;
  let mode = "ok", read = true, write = true;
  const row = (href: string, props: string, status = "HTTP/1.1 200 OK") => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop>${mode === "missing-status" ? "" : `<d:status>${status}</d:status>`}</d:propstat></d:response>`;
  const collision = (data: string, property: string, value: string) => data.replace("</d:response>", `<d:propstat><d:prop><${property}>${value}</${property}></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`);
  const document = (value: string) => `${mode === "formatted" ? '<?xml version="1.0"?>\n  <!-- ordinary document -->\n' : ""}<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:x="urn:wrong">${value}</d:multistatus>${mode === "formatted" ? "\n  " : ""}`;
  globalThis.fetch = async (input, init) => {
    const target = new URL(String(input)); assert.equal(target.origin, origin, "No live network");
    const body = String(init?.body ?? "");
    assert.ok(init?.method === "PROPFIND" || init?.method === "REPORT");
    let data: string;
    if (body.includes("calendar-multiget")) {
      if (mode === "redirect-resource") return new Response(null, { status: 302, headers: { location: "http://127.0.0.2:1/foreign/" } });
      data = row(collection + "event.ics", '<d:getetag>"fresh"</d:getetag><c:calendar-data>BEGIN:VCALENDAR&#13;&#10;END:VCALENDAR</c:calendar-data>');
      if (mode.startsWith("resource:")) data = collision(data, mode.slice(9), "UNVALIDATED PRIVATE CONTENT");
    }
    else if (body.includes("resourcetype") && (target.pathname === "/" || target.pathname === "/.well-known/caldav")) data = row(target.href, "<d:resourcetype><d:collection/></d:resourcetype>");
    else if (body.includes("current-user-principal")) data = row(chain === "principal-href" ? home : target.href, `<${chain === "principal-ns" ? "x" : "d"}:current-user-principal><d:href>${chain === "home-canonical-slash" ? "/principal" : "/principal/"}</d:href></${chain === "principal-ns" ? "x" : "d"}:current-user-principal>`, chain === "principal-denied" ? "HTTP/1.1 403 Forbidden" : "HTTP/1.1 200 OK");
    else if (body.includes("calendar-home-set")) data = row(chain === "home-href" ? home : chain === "home-canonical-slash" ? target.href + "/" : target.href, `<${chain === "home-ns" ? "x" : "c"}:calendar-home-set><d:href>${chain === "home-relative" ? "home/" : "/home/"}</d:href></${chain === "home-ns" ? "x" : "c"}:calendar-home-set>`, chain === "home-denied" ? "HTTP/1.1 403 Forbidden" : "HTTP/1.1 200 OK");
    else if (body.includes("current-user-privilege-set")) {
      const privileges = mode === "privilege-ns" ? "<d:privilege><x:read/></d:privilege>" : `${read ? "<d:privilege><d:read/></d:privilege>" : "<d:privilege><c:read-free-busy/></d:privilege>"}${write ? "<d:privilege><d:write/></d:privilege>" : ""}`;
      data = row(mode === "wrong-href" ? home : target.href, `<${mode === "wrong-namespace" ? "x" : "d"}:current-user-privilege-set>${privileges}</${mode === "wrong-namespace" ? "x" : "d"}:current-user-privilege-set>`, mode === "denied" ? "HTTP/1.1 403 Forbidden" : "HTTP/1.1 200 OK");
    } else if (body.includes("supported-report-set")) data = row(target.href, "<d:supported-report-set/>");
    else {
      assert.ok(body.includes("resourcetype")); listings++;
      data = row(home, "<d:resourcetype><d:collection/></d:resourcetype>") + row(collection, '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Fixture</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/><c:comp name="VTODO"/></c:supported-calendar-component-set>', mode === "denied" ? "HTTP/1.1 403 Forbidden" : "HTTP/1.1 200 OK");
      if (mode === "empty-body") data = "";
    }
    if (body.includes("calendar-home-set") && chain.startsWith("home:")) data = collision(data, chain.slice(5), "<d:href>/empty/</d:href>");
    if (mode === "wrong-component-property") data = data.split("c:supported-calendar-component-set").join("x:supported-calendar-component-set").split('name="VEVENT"').join('name="OTHER"').split('name="VTODO"').join('name="OTHER"');
    if (mode === "wrong-calendar-type") data = data.replace("<c:calendar/>", "<x:calendar/>");
    if (mode === "missing-components") data = data.replace(/<c:supported-calendar-component-set>.*?<\/c:supported-calendar-component-set>/g, "");
    if (mode === "failed-components") data = data.replace("<c:supported-calendar-component-set>", '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><c:supported-calendar-component-set>').replace('</c:supported-calendar-component-set></d:prop><d:status>HTTP/1.1 200 OK', '</c:supported-calendar-component-set></d:prop><d:status>HTTP/1.1 403 Forbidden');
    if (mode === "nameless-components") data = data.replace(/name="V(?:EVENT|TODO)"/g, "");
    if (mode === "qualified-component-name") data = data.replace(/name="V(?:EVENT|TODO)"/g, 'x:name="VEVENT"');
    if (mode === "todo-only") data = data.replace('<c:comp name="VEVENT"/>', "");
    if (mode === "unsupported-components") data = data.replace(/name="V(?:EVENT|TODO)"/g, 'name="VJOURNAL"');
    if (mode === "outer-whitespace-resource") data = data.replace("BEGIN:VCALENDAR&#13;&#10;END:VCALENDAR", "&#13;&#10; BEGIN:VCALENDAR&#13;&#10;END:VCALENDAR&#13;&#10; ");
    if (mode === "whitespace-resource") data = data.replace("BEGIN:VCALENDAR&#13;&#10;END:VCALENDAR", "<![CDATA[BEGIN:VCALENDAR\r\nSUMMARY:A]]> <![CDATA[B]]>\r\n<![CDATA[END:VCALENDAR]]>");
    if (mode === "scalar-resourcetype") data = data.replace(/<d:resourcetype>.*?<\/d:resourcetype>/g, "<d:resourcetype>junk</d:resourcetype>");
    if (mode === "scalar-marker") data = data.replace("<c:calendar/>", "<c:calendar>junk</c:calendar>");
    if (mode === "nested-marker") data = data.replace("<c:calendar/>", "<c:calendar><c:comp/></c:calendar>");
    if (mode === "mixed-content") data = data.replace("</d:resourcetype>", "junk</d:resourcetype>");
    if (mode === "split-resource") data = data.replace("BEGIN:VCALENDAR&#13;&#10;END:VCALENDAR", "BEGIN:VCAL<!-- split -->ENDAR<![CDATA[\r\nEND:VCALENDAR]]>");
    if (mode.startsWith("optional-")) {
      const code = mode === "optional-missing" ? "404 Not Found" : "206 Partial Content";
      const property = mode === "optional-display" ? "d:displayname" : "d:sync-token";
      data = data.replace("</d:response>", `<d:propstat><d:prop><${property}>optional-value</${property}></d:prop><d:status>HTTP/1.1 ${code}</d:status></d:propstat></d:response>`);
    }
    if (mode === "partial-propstat") data = data.split("HTTP/1.1 200 OK").join("HTTP/1.1 206 Partial Content");
    return new Response(document(data), { status: 207, headers: { ...(mode === "missing-type" ? {} : { "content-type": mode === "plain-type" ? "text/plain" : "application/xml" }), ...(mode === "partial" ? { "content-range": "items 0-0/2" } : {}), ...(chain === "home-canonical-slash" && body.includes("calendar-home-set") ? { "content-location": "/principal/" } : {}) } });
  };
  try {
    for (const bad of ["principal-href", "principal-ns", "principal-denied", "home-href", "home-ns", "home-denied", "home-relative", "home:x:calendar-home-set", "home:c:calendar_home_set", "home:c:calendarHomeSet", "home:c:calendar--home-set"]) {
      chain = bad;
      await assert.rejects(async () => { const client = await createCaldavClient(origin, "fixture", "fixture"); await client.fetchCalendars(); }, error => {
        if (bad === "home-href") {
          assert.ok(error instanceof DavReadResponseError);
          assert.deepEqual(error.cause, { code: "caldav-read-response-invalid", reason: "discovery-response-resource", responseCount: 1, hrefRelation: "different-path", providerKind: "other", requestResource: "principal-alias", responseResource: "other", readKind: "home" });
        }
        return true;
      });
      assert.equal(listings, 0, "Unproven discovery must never reach an authoritative collection listing");
    }
    chain = "home-canonical-slash";
    const canonicalClient = await createCaldavClient(origin, "fixture", "fixture");
    assert.equal((await canonicalClient.fetchCalendars()).length, 1, "tsdav home discovery accepts the RFC 4918 collection slash form without falling back to an unproven root");
    chain = "ok";
    const client = await createCaldavClient(origin, "fixture", "fixture");
    assert.equal((await client.fetchCalendars()).length, 1);
    for (const bad of ["denied", "missing-status", "empty-body", "partial", "mixed-content", "missing-type", "plain-type", "wrong-component-property", "wrong-calendar-type", "missing-components", "failed-components", "nameless-components", "qualified-component-name", "scalar-resourcetype", "scalar-marker", "nested-marker", "partial-propstat", "optional-token", "optional-display"]) {
      mode = bad; await assert.rejects(async () => classifyCaldavCalendars(await client.fetchCalendars()), error => {
        if (bad === "partial" || bad === "missing-type" || bad === "plain-type") {
          assert.ok(error instanceof DavReadResponseError);
          assert.deepEqual(error.cause, { code: "caldav-read-response-invalid", reason: bad === "partial" ? "http-partial" : "http-content-type", readKind: "discovery", httpStatus: 207 });
        }
        return true;
      }, "Incomplete discovery must not become authoritative empty calendars");
    }
    mode = "formatted";
    const formattedClient = await createCaldavClient(origin, "fixture", "fixture");
    assert.equal(classifyCaldavCalendars(await formattedClient.fetchCalendars()).length, 1, "Declaration/comments and document-level whitespace are ordinary XML");
    mode = "optional-missing";
    assert.equal(classifyCaldavCalendars(await client.fetchCalendars()).length, 1, "Failed optional properties cannot erase proven classification");
    mode = "unsupported-components";
    assert.deepEqual(classifyCaldavCalendars(await client.fetchCalendars()), [], "Explicit VJOURNAL-only classification is proven unsupported");
    mode = "ok";
    const both = classifyCaldavCalendars(await client.fetchCalendars());
    assert.equal(both.length, 1); assert.equal(both[0]!.supportsEvents, true); assert.equal(both[0]!.supportsTasks, true);
    mode = "todo-only";
    const todo = classifyCaldavCalendars(await client.fetchCalendars());
    assert.equal(todo.length, 1); assert.equal(todo[0]!.supportsEvents, false); assert.equal(todo[0]!.supportsTasks, true);
    mode = "ok";
    const calendar = (await client.fetchCalendars())[0]!;
    const readObjects = () => client.fetchCalendarObjects({ calendar, objectUrls: [collection + "event.ics"] });
    assert.equal((await readObjects())[0]!.data, "BEGIN:VCALENDAR\r\nEND:VCALENDAR");
    mode = "split-resource";
    assert.equal((await readObjects())[0]!.data, "BEGIN:VCALENDAR\r\nEND:VCALENDAR", "Validated scalar text survives comments and CDATA without replacement");
    mode = "whitespace-resource";
    assert.equal((await readObjects())[0]!.data, "BEGIN:VCALENDAR\r\nSUMMARY:A B\r\nEND:VCALENDAR", "Whitespace-only separators between CDATA segments remain exact");
    mode = "outer-whitespace-resource";
    assert.equal((await readObjects())[0]!.data, "\r\n BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n ", "Return the exact validated resource, including leading/trailing CRLF and spaces");
    for (const failure of ["redirect-resource", "partial-propstat"]) {
      mode = failure;
      await assert.rejects(readObjects(), "Redirected or partial resource proof cannot authorize original resource mutation");
    }
    for (const property of ["x:calendar-data", "c:calendar_data", "c:calendarData", "c:calendar--data", "c:calendar-data"]) {
      mode = `resource:${property}`;
      await assert.rejects(readObjects(), "Unvalidated aliases must never replace proven calendar data");
    }
    mode = "ok";
    let privileges = await caldavEventPrivileges(collection, "Basic fixture");
    assert.deepEqual(caldavReadAccess(privileges), { read: true, readFreeBusy: true });
    write = false; privileges = await caldavEventPrivileges(collection, "Basic fixture");
    assert.equal(caldavAllows(privileges, "update"), false); assert.equal(caldavReadAccess(privileges).read, true);
    read = false; privileges = await caldavEventPrivileges(collection, "Basic fixture");
    assert.deepEqual(caldavReadAccess(privileges), { read: false, readFreeBusy: true });
    for (const bad of ["denied", "missing-status", "wrong-href", "wrong-namespace", "privilege-ns", "partial", "partial-propstat"]) {
      mode = bad; assert.deepEqual(caldavReadAccess(await caldavEventPrivileges(collection, "Basic fixture")), { read: null, readFreeBusy: null });
    }
    console.log("CalDAV convenience client preserves strict discovery authority; exact privilege HTTP proof keeps read independent from write/free-busy: OK");
  } finally { globalThis.fetch = originalFetch; config.security.federationAllowPrivateHosts = allowPrivate; }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
