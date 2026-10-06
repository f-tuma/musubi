import assert from "node:assert/strict";
import { DAV, CALDAV, davMultistatus, successfulDavProperty, assertDavReadResponse, DavReadResponseError } from "./caldav_properties";
import { StructuredLogger } from "../../../../packages/config/src/logger";
const url = "https://dav.example.test/home/calendar/";
const response = (properties: string, code = "HTTP/1.1 200 OK", href = url) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${properties}</d:prop><d:status>${code}</d:status></d:propstat></d:response>`;
const document = (value: string) => `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:x="urn:wrong">${value}</d:multistatus>`;
// RFC 4918 section 5.2: a server may treat a collection URL without its
// trailing slash as the slash form, then use the slash form in DAV:href.
const principalURL = "https://dav.example.test/principal/member";
const canonicalPrincipal = response('<c:calendar-home-set><d:href>/home/</d:href></c:calendar-home-set>', "HTTP/1.1 200 OK", principalURL + "/");
assert.doesNotThrow(() => assertDavReadResponse(document(canonicalPrincipal), principalURL, "home", undefined, principalURL + "/"));
assert.doesNotThrow(() => assertDavReadResponse(document(response('<d:current-user-principal><d:href>/principal/member/</d:href></d:current-user-principal>', "HTTP/1.1 200 OK", principalURL + "/")), principalURL, "principal", undefined, "/principal/member/"));
assert.doesNotThrow(() => assertDavReadResponse(document(response('<c:calendar-home-set><d:href>/home/</d:href></c:calendar-home-set>', "HTTP/1.1 200 OK", principalURL + "/?scope=mine")), principalURL + "?scope=mine", "home", undefined, "/principal/member/?scope=mine"));
assert.doesNotThrow(() => assertDavReadResponse(document(canonicalPrincipal.replace("<c:calendar-home-set>", "<d:resourcetype><d:collection/></d:resourcetype><c:calendar-home-set>")), principalURL, "home"), "A successful collection type also proves the RFC 4918 slash convention applies");
for (const metadata of [undefined, "/private-user/", principalURL + "/?scope=other", "https://other.example.test/principal/member/", "https://secret@dav.example.test/principal/member/"]) {
  assert.throws(() => assertDavReadResponse(document(canonicalPrincipal), principalURL, "home", undefined, metadata), "Noncollection resources have no slash alias without matching canonical location evidence");
}
for (const href of [principalURL + "/other/", principalURL + "/?scope=other", principalURL + "%2F", "https://other.example.test/principal/member/", principalURL + "/#secret", "https://secret@dav.example.test/principal/member/"]) {
  assert.throws(() => assertDavReadResponse(document(response('<c:calendar-home-set><d:href>/home/</d:href></c:calendar-home-set>', "HTTP/1.1 200 OK", href)), principalURL, "home"), "A slash alias cannot authorize another path, query, origin, fragment or credential-bearing href");
}
assert.throws(() => assertDavReadResponse(document(canonicalPrincipal + response('<c:calendar-home-set><d:href>/other-home/</d:href></c:calendar-home-set>', "HTTP/1.1 200 OK", principalURL)), principalURL, "home"), "Both slash forms in one response remain ambiguous");
assert.throws(() => assertDavReadResponse(document(canonicalPrincipal.replace("200 OK", "403 Forbidden")), principalURL, "home", undefined, principalURL + "/"), "Slash normalization never grants failed properties");
assert.throws(() => assertDavReadResponse(document(response('<d:getetag>"fresh"</d:getetag><c:calendar-data>BEGIN:VCALENDAR</c:calendar-data>', "HTTP/1.1 200 OK", principalURL + "/")), principalURL, "multiget", [principalURL]), "Resource reads still require the exact requested object");

function validationError(xml: string): DavReadResponseError {
  try { assertDavReadResponse(xml, principalURL, "home"); }
  catch (error) { assert.ok(error instanceof DavReadResponseError); return error; }
  throw new Error("Expected validation failure");
}
const mismatch = validationError(document(response('<c:calendar-home-set><d:href>/private-home/</d:href></c:calendar-home-set>', "HTTP/1.1 200 OK", "https://dav.example.test/private-user/")));
assert.deepEqual(mismatch.cause, { code: "caldav-read-response-invalid", reason: "discovery-response-resource", responseCount: 1, hrefRelation: "different-path", providerKind: "other", requestResource: "other", responseResource: "other", readKind: "home" });
assert.equal(validationError(document("")).cause.reason, "discovery-response-count");
assert.equal(validationError(document("")).cause.responseCount, 0);
assert.deepEqual(validationError(document(`<d:response><d:href>${principalURL}</d:href><d:status>HTTP/1.1 403 Forbidden</d:status></d:response>`)).cause, { code: "caldav-read-response-invalid", reason: "discovery-response-status", responseCount: 1, responseStatus: 403, readKind: "home" });
assert.equal(validationError(document(canonicalPrincipal.replace(principalURL + "/", principalURL).replace("200 OK", "403 Forbidden"))).cause.propertyStatus, 403);
assert.equal(validationError(document(canonicalPrincipal.replace("c:calendar-home-set", "x:calendar-home-set").replace("/c:calendar-home-set", "/x:calendar-home-set"))).cause.reason, "projection-namespace");
let logged = "";
const originalWrite = process.stderr.write;
try {
  process.stderr.write = ((line: string) => { logged += line; return true; }) as typeof process.stderr.write;
  new StructuredLogger("error").error("sync.account.failed", { error: mismatch });
} finally { process.stderr.write = originalWrite; }
assert.deepEqual(JSON.parse(logged).error.cause, mismatch.cause, "Grafana receives structured diagnostic fields through the existing logger");
for (const privateValue of ["https://dav.example.test", "private-user", "private-home", "calendar-home-set", "<d:"]) assert.ok(!logged.includes(privateValue), "Validation diagnostics contain no server XML or private resource identity");
const icloudPrincipal = "https://p42-caldav.icloud.com/123456789/principal/";
const icloudMismatch = document(response('<c:calendar-home-set><d:href>/123456789/calendars/</d:href></c:calendar-home-set>', "HTTP/1.1 200 OK", "https://p42-caldav.icloud.com/principal/"));
let icloudError: DavReadResponseError | undefined;
try { assertDavReadResponse(icloudMismatch, icloudPrincipal, "home"); }
catch (error) { assert.ok(error instanceof DavReadResponseError); icloudError = error; }
assert.ok(icloudError, "Known iCloud address shapes are not a shortcut around principal identity proof");
assert.deepEqual(icloudError.cause, { code: "caldav-read-response-invalid", reason: "discovery-response-resource", responseCount: 1, hrefRelation: "different-path", providerKind: "icloud", requestResource: "account-principal", responseResource: "principal-alias", homeTargetMatchesPrincipalID: true, readKind: "home" });
for (const privateValue of ["123456789", "p42", "https:", "<d:"]) assert.ok(!JSON.stringify(icloudError.cause).includes(privateValue));
for (const [homeHref, match] of [["/987654321/calendars/", false], ["/123456789/calendars/?private=yes", false], ["https://secret@p42-caldav.icloud.com/123456789/calendars/", false]] as const) {
  assert.throws(() => assertDavReadResponse(icloudMismatch.replace("/123456789/calendars/", homeHref), icloudPrincipal, "home"), error => error instanceof DavReadResponseError && error.cause.homeTargetMatchesPrincipalID === match);
}
for (const origin of ["https://p42-caldav.icloud.com.evil.test", "http://p42-caldav.icloud.com", "https://p42-caldav.icloud.com:8443"]) {
  assert.throws(() => assertDavReadResponse(icloudMismatch.split("https://p42-caldav.icloud.com").join(origin), origin + "/123456789/principal/", "home"), error => error instanceof DavReadResponseError && error.cause.providerKind === "other");
}
const privilege = '<d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><c:read-free-busy/></d:privilege></d:current-user-privilege-set>';
const [valid] = davMultistatus(document(response(privilege)), url);
assert.equal(successfulDavProperty(valid!, DAV, "current-user-privilege-set")!.children[1]!.children[0]!.name, `{${CALDAV}}read-free-busy`);
assert.equal(successfulDavProperty(davMultistatus(document(response(privilege, "HTTP/1.1 403 Forbidden")), url)[0]!, DAV, "current-user-privilege-set"), undefined);
assert.equal(successfulDavProperty(davMultistatus(document(response('<x:current-user-privilege-set/>')), url)[0]!, DAV, "current-user-privilege-set"), undefined);
for (const xml of [
  document(response(privilege)).replace('<d:status>HTTP/1.1 200 OK</d:status>', ''),
  document(response(privilege, "successful")),
  document(response(privilege) + response(privilege)),
  document(response(privilege)).replace('xmlns:d="DAV:"', 'xmlns:d="DAV:" xmlns:d="urn:wrong"'),
  document(response(privilege, "HTTP/1.1 200 OK", "https://other.test/calendar/")),
  '<!DOCTYPE x [<!ENTITY y "read">]>' + document(response(privilege)),
]) assert.throws(() => davMultistatus(xml, url));
const failed = davMultistatus(document(`<d:response><d:href>${url}</d:href><d:status>HTTP/1.1 403 Forbidden</d:status></d:response>`), url)[0]!;
assert.equal(failed.status, 403); assert.equal(failed.properties.size, 0);
console.log("Strict CalDAV multistatus: exact namespaced property/status/href identity and ambiguity refusal OK");

const collection = response('<d:resourcetype><d:collection/></d:resourcetype>');
const child = response('<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>', "HTTP/1.1 200 OK", url + "child/");
assert.doesNotThrow(() => assertDavReadResponse(document(collection + child), url, "discovery"));
assert.doesNotThrow(() => assertDavReadResponse(document(collection), url, "discovery"));
for (const payload of [document(""), document(child), document(collection + response('<d:resourcetype/>', "HTTP/1.1 403 Forbidden", url + "hidden/")), document(collection + response('<x:resourcetype/>', "HTTP/1.1 200 OK", url + "hidden/"))]) {
  assert.throws(() => assertDavReadResponse(payload, url, "discovery"), "Filtered or incomplete discovery cannot prove removal");
}
const fullResource = response('<d:getetag>"fresh"</d:getetag><c:calendar-data>BEGIN:VCALENDAR</c:calendar-data>', "HTTP/1.1 200 OK", url + "event.ics");
assert.doesNotThrow(() => assertDavReadResponse(document(fullResource), url, "multiget"));
assert.throws(() => assertDavReadResponse(document(fullResource.replace('c:calendar-data', 'x:calendar-data').replace('/c:calendar-data', '/x:calendar-data')), url, "multiget"));
assert.throws(() => assertDavReadResponse(document(response('<d:getetag>"fresh"</d:getetag>', "HTTP/1.1 200 OK", url + "event.ics")), url, "multiget"));
const token = '<d:sync-token>new-token</d:sync-token>';
assert.doesNotThrow(() => assertDavReadResponse(document(token), url, "sync"));
assert.throws(() => assertDavReadResponse(document(""), url, "sync"));
const deletion = `<d:response><d:href>${url}gone.ics</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`;
assert.doesNotThrow(() => assertDavReadResponse(document(token + deletion), url, "sync"));
assert.throws(() => assertDavReadResponse(document(token + deletion.replace("404 Not Found", "403 Forbidden")), url, "sync"));
console.log("Discovery absence and resource/sync completeness proofs OK");

assert.throws(() => assertDavReadResponse(document(fullResource), url, "multiget", [url + "missing.ics"]), "A different href cannot satisfy a requested read");
assert.throws(() => assertDavReadResponse(document(fullResource), url, "multiget", [url + "event.ics", url + "missing.ics"]), "Missing requested resource is incomplete, not empty");
assert.doesNotThrow(() => assertDavReadResponse(document(fullResource), url, "multiget", [url + "event.ics"]));

// The downstream convenience parser merges propstats after namespace stripping
// and camel-casing. Reject both cross-propstat and nested/sibling aliases.
for (const alias of ["x:calendar-data", "c:calendar_data", "c:calendarData", "c:calendar--data"]) {
  assert.throws(() => davMultistatus(document(response(`<c:calendar-data>proven</c:calendar-data><${alias}>other</${alias}>`)), url));
}
assert.throws(() => davMultistatus(document(response('<d:resourcetype><c:calendar/><x:calendar/></d:resourcetype>')), url));
assert.throws(() => davMultistatus(document(response('<c:calendar-data>proven</c:calendar-data>').replace('</d:response>', '<d:propstat><d:prop><x:calendar-data>other</x:calendar-data></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>')), url));
console.log("Convenience namespace/camel-case aliases rejected before projection: OK");

for (const properties of [
  '<d:getetag><d:href>version</d:href></d:getetag><c:calendar-data>BEGIN:VCALENDAR</c:calendar-data>',
  '<d:getetag/> <c:calendar-data>BEGIN:VCALENDAR</c:calendar-data>',
  '<d:getetag>"version"</d:getetag><c:calendar-data><c:comp/></c:calendar-data>',
  '<d:getetag>"version"</d:getetag><c:calendar-data/>',
]) assert.throws(() => assertDavReadResponse(document(response(properties)), url, "multiget"), "Resource validators and bodies must be nonempty scalars");
for (const formatted of [document(collection), `\n${document(collection)}\n`, `<?xml version="1.0"?>\n<!-- comment -->\n${document(collection)}\n  `]) {
  assert.doesNotThrow(() => assertDavReadResponse(formatted, url, "discovery"));
}

assert.equal(successfulDavProperty(davMultistatus(document(response(privilege, "HTTP/1.1 206 Partial Content")), url)[0]!, DAV, "current-user-privilege-set"), undefined, "Partial privilege proof is unknown");
assert.throws(() => assertDavReadResponse(document(response('<d:resourcetype/>', "HTTP/1.1 206 Partial Content")), url, "discovery"));
assert.throws(() => assertDavReadResponse(document(response('<d:getetag>"partial"</d:getetag><c:calendar-data>BEGIN:VCALENDAR</c:calendar-data>', "HTTP/1.1 206 Partial Content")), url, "multiget"));
