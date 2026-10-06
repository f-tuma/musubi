import { xml2js, js2xml } from "xml-js";

export const DAV = "DAV:", CALDAV = "urn:ietf:params:xml:ns:caldav";
export const davName = (namespace: string, local: string) => `{${namespace}}${local}`;
export type DavNode = { name: string; text: string; children: DavNode[]; attributes: Record<string, string> };
export type DavResponse = { href: string; status?: number; properties: Map<string, { status: number; value: DavNode }> };
export type DavReadKind = "principal" | "home" | "discovery" | "listing" | "multiget" | "sync";
type DavReadFailureReason = "invalid-structure" | "invalid-xml" | "response-href-authority" | "response-href-invalid" | "response-href-duplicate" | "projection-namespace" | "partial-property" | "discovery-response-count" | "discovery-response-status" | "discovery-response-resource" | "discovery-property-unavailable" | "discovery-property-shape" | "discovery-target-shape" | "discovery-target-invalid" | "http-status" | "http-partial" | "http-content-type";
type DavHrefRelation = "exact" | "collection-slash" | "different-origin" | "different-query" | "different-path";
type DavDiscoveryResource = "root" | "principal-alias" | "account-principal" | "account-calendar-home" | "other";
export class DavReadResponseError extends Error {
  // The logger serializes Error.cause. Keep this diagnostic to fixed enums and
  // counts/statuses: DAV XML, resource paths and credential data must stay out.
  cause: { code: "caldav-read-response-invalid"; reason: DavReadFailureReason; readKind?: DavReadKind; responseCount?: number; responseStatus?: number; propertyStatus?: number; httpStatus?: number; hrefRelation?: DavHrefRelation; providerKind?: "icloud" | "other"; requestResource?: DavDiscoveryResource; responseResource?: DavDiscoveryResource; homeTargetMatchesPrincipalID?: boolean };
  constructor(reason: DavReadFailureReason, details: Omit<DavReadResponseError["cause"], "code" | "reason"> = {}) {
    super("CalDAV property response is incomplete or ambiguous.");
    this.name = "DavReadResponseError";
    this.cause = { code: "caldav-read-response-invalid", reason, ...details };
  }
}
// tsdav strips namespaces and folds hyphen/underscore runs for every element.
// Reject aliases before handing this XML to its convenience projection.
const convenienceName = (name: string) => name.slice(name.lastIndexOf("}") + 1).replace(/[-_]+(\w?)/g, (_match, letter: string) => letter ? letter.toUpperCase() : "");
function invalid(reason: DavReadFailureReason = "invalid-structure", details?: Omit<DavReadResponseError["cause"], "code" | "reason">): never { throw new DavReadResponseError(reason, details); }
function discoveryHrefRelation(href: string, requestURL: string): DavHrefRelation {
  const target = new URL(href), request = new URL(requestURL);
  if (target.href === request.href) return "exact";
  if (target.origin !== request.origin) return "different-origin";
  if (target.search !== request.search) return "different-query";
  // RFC 4918 section 5.2 permits handling a collection request without a slash
  // as its slash form. This does not authorize another path, query or origin;
  // object reads and authoritative collection listings still use exact hrefs.
  if (!request.pathname.endsWith("/") && target.pathname === request.pathname + "/") return "collection-slash";
  return "different-path";
}
function discoveryResource(url: URL): DavDiscoveryResource {
  if (url.pathname === "/") return "root";
  if (/^\/principal\/?$/.test(url.pathname)) return "principal-alias";
  if (/^\/\d+\/principal\/?$/.test(url.pathname)) return "account-principal";
  if (/^\/\d+\/calendars\/?$/.test(url.pathname)) return "account-calendar-home";
  return "other";
}
function discoveryIdentityDiagnostic(row: DavResponse, requestURL: string) {
  const request = new URL(requestURL), response = new URL(row.href);
  const principalID = /^\/(\d+)\/principal\/?$/.exec(request.pathname)?.[1];
  const home = successfulDavProperty(row, CALDAV, "calendar-home-set");
  let homeTargetMatchesPrincipalID: boolean | undefined;
  if (principalID && home && !home.text && home.children.length === 1) {
    const href = home.children[0]!;
    if (href.name === davName(DAV, "href") && !href.children.length && href.text) {
      try {
        const target = new URL(href.text, request);
        homeTargetMatchesPrincipalID = !target.username && !target.password && !target.search && !target.hash
          && target.pathname === `/${principalID}/calendars/`;
      } catch { /* Malformed home metadata supplies no diagnostic match. */ }
    }
  }
  // Fixed resource categories and a boolean only. This is diagnostic data,
  // never identity/ACL evidence and never an exception to strict validation.
  return {
    providerKind: request.protocol === "https:" && !request.port
      && /^(?:caldav|p\d+-caldav)\.icloud\.com$/.test(request.hostname) ? "icloud" as const : "other" as const,
    requestResource: discoveryResource(request), responseResource: discoveryResource(response),
    ...(homeTargetMatchesPrincipalID === undefined ? {} : { homeTargetMatchesPrincipalID }),
  };
}
function provenCollectionAlias(row: DavResponse, url: string, contentLocation?: string): boolean {
  // A principal may also be a noncollection resource, where adding '/' is not
  // an equivalent identifier. Require the server's canonical Content-Location
  // (recommended by RFC 4918 section 5.2) or its proven collection type.
  if (contentLocation) {
    try { if (new URL(contentLocation, url).href === row.href) return true; } catch { /* Invalid metadata is not identity evidence. */ }
  }
  const resourceType = successfulDavProperty(row, DAV, "resourcetype");
  return !!resourceType && !resourceType.text
    && resourceType.children.every(marker => !marker.text && !marker.children.length)
    && resourceType.children.some(marker => marker.name === davName(DAV, "collection"));
}
const children = (node: DavNode, name: string) => node.children.filter(child => child.name === davName(DAV, name));
function status(node: DavNode): number {
  if (node.children.length) return invalid();
  const match = /^HTTP\/1\.[01] ([1-5]\d\d)(?: [^\r\n]*)?$/.exec(node.text);
  if (!match) return invalid();
  return Number(match[1]);
}
/** Strict XML identity shared by discovery and scheduling. No namespace flattening. */
export function davMultistatus(xml: string, expectedURL: string, allowSyncToken = false): DavResponse[] {
  if (xml.length > 4 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)) invalid();
  for (const match of xml.matchAll(/<(?:(?:[^"'>]|"[^"]*"|'[^']*')*)>/g)) {
    if (!/^<[A-Za-z_]/.test(match[0])) continue;
    const attributes = [...match[0].matchAll(/([^\s=]+)\s*=\s*("[^"]*"|'[^']*')/g)].map(item => item[1]);
    if (new Set(attributes).size !== attributes.length) invalid();
  }
  function parse(element: any, inherited: Record<string, string>): DavNode {
    if (element.type !== "element" || typeof element.name !== "string") return invalid();
    const namespaces = { ...inherited };
    for (const [name, value] of Object.entries(element.attributes ?? {})) {
      if (name === "xmlns" || name.startsWith("xmlns:")) {
        if (typeof value !== "string" || !value || name === "xmlns:xmlns") invalid();
        namespaces[name === "xmlns" ? "" : name.slice(6)] = value as string;
      }
    }
    const parts = element.name.split(":");
    const namespace = namespaces[parts.length === 1 ? "" : parts[0]!];
    if (parts.length > 2 || !namespace) return invalid();
    const result: DavNode = { name: davName(namespace, parts.at(-1)!), text: "", children: [], attributes: element.attributes ?? {} };
    for (const child of element.elements ?? []) {
      if (child.type === "element") result.children.push(parse(child, namespaces));
      else if (child.type === "text" || child.type === "cdata") result.text += child.text ?? child.cdata;
      else if (child.type !== "comment") invalid();
    }
    const projected = new Map<string, string>();
    for (const child of result.children) {
      const key = convenienceName(child.name), previous = projected.get(key);
      if (previous !== undefined && previous !== child.name) invalid();
      projected.set(key, child.name);
    }
    if (result.name !== davName(CALDAV, "calendar-data")) result.text = result.text.trim();
    if (result.text && result.children.length) invalid();
    if ([davName(DAV, "href"), davName(DAV, "getetag"), davName(DAV, "sync-token"), davName(CALDAV, "calendar-data")].includes(result.name)
      && /^(?:true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/i.test(result.text)) invalid();
    return result;
  }
  let document: any;
  try { document = xml2js(xml, { compact: false, alwaysChildren: true, captureSpacesBetweenElements: true }); } catch { return invalid("invalid-xml"); }
  const elements = (document.elements ?? []).filter((item: any) => item.type !== "comment" && !(item.type === "text" && !item.text?.trim()));
  if (elements.length !== 1) invalid();
  const root = parse(elements[0], { xml: "http://www.w3.org/XML/1998/namespace" });
  if (root.name !== davName(DAV, "multistatus") || root.text || root.children.some(child => child.name !== davName(DAV, "response") && !(allowSyncToken && child.name === davName(DAV, "sync-token")))) invalid();
  const tokens = children(root, "sync-token");
  if (allowSyncToken && (tokens.length !== 1 || !tokens[0]!.text || tokens[0]!.children.length)) invalid();
  const seen = new Set<string>();
  return children(root, "response").map(node => {
    const hrefs = children(node, "href"), statuses = children(node, "status"), propstats = children(node, "propstat");
    if (node.text || hrefs.length !== 1 || hrefs[0]!.children.length || !hrefs[0]!.text || statuses.length > 1 || (statuses.length && propstats.length) || (!statuses.length && !propstats.length)) invalid();
    let href: string;
    try {
      const target = new URL(hrefs[0]!.text, expectedURL);
      if (target.origin !== new URL(expectedURL).origin || target.username || target.password || target.hash) return invalid("response-href-authority");
      href = target.href;
    } catch (error) { if (error instanceof DavReadResponseError) throw error; return invalid("response-href-invalid"); }
    if (seen.has(href)) invalid("response-href-duplicate"); seen.add(href);
    const result: DavResponse = { href, ...(statuses.length ? { status: status(statuses[0]!) } : {}), properties: new Map() };
    const projectedProperties = new Set<string>();
    for (const propstat of propstats) {
      const codes = children(propstat, "status"), props = children(propstat, "prop");
      if (propstat.text || codes.length !== 1 || props.length !== 1 || props[0]!.text) invalid();
      const code = status(codes[0]!);
      for (const value of props[0]!.children) {
        const key = convenienceName(value.name);
        if (projectedProperties.has(key)) invalid();
        projectedProperties.add(key);
        result.properties.set(value.name, { status: code, value });
      }
    }
    return result;
  });
}

export function successfulDavProperty(response: DavResponse, namespace: string, name: string): DavNode | undefined {
  const property = response.properties.get(davName(namespace, name));
  return property && property.status === 200 ? property.value : undefined;
}

/** Validate authority before the convenience client filters failed responses. */
export function assertDavReadResponse(xml: string, url: string, kind: DavReadKind, requestedHrefs?: string[], contentLocation?: string) {
  try { validateDavReadResponse(xml, url, kind, requestedHrefs, contentLocation); }
  catch (error) {
    if (error instanceof DavReadResponseError) error.cause = { ...error.cause, readKind: kind };
    throw error;
  }
}
function validateDavReadResponse(xml: string, url: string, kind: DavReadKind, requestedHrefs?: string[], contentLocation?: string) {
  const responses = davMultistatus(xml, url, kind === "sync");
  const consumed = new Map([
    ...["resourcetype", "collection", "href", "getetag", "sync-token", "current-user-principal", "supported-report-set", "report"].map(name => [convenienceName(davName(DAV, name)), davName(DAV, name)] as const),
    ...["calendar", "calendar-data", "calendar-home-set", "supported-calendar-component-set", "comp"].map(name => [convenienceName(davName(CALDAV, name)), davName(CALDAV, name)] as const),
  ]);
  function validateProjection(node: DavNode) {
    const expected = consumed.get(convenienceName(node.name));
    if (expected && expected !== node.name) invalid("projection-namespace");
    for (const child of node.children) validateProjection(child);
  }
  for (const row of responses) for (const property of row.properties.values()) {
    // tsdav merges every 2xx propstat, including optional tokens/metadata. Only
    // complete 200 properties may reach that projection; failed optionals stay.
    if (property.status >= 200 && property.status < 300 && property.status !== 200) invalid("partial-property", { propertyStatus: property.status });
    validateProjection(property.value);
  }
  if (kind === "principal" || kind === "home") {
    if (responses.length !== 1) invalid("discovery-response-count", { responseCount: responses.length });
    const row = responses[0]!, hrefRelation = discoveryHrefRelation(row.href, url);
    if (hrefRelation !== "exact" && !(hrefRelation === "collection-slash" && provenCollectionAlias(row, url, contentLocation))) invalid("discovery-response-resource", { responseCount: responses.length, hrefRelation, ...discoveryIdentityDiagnostic(row, url) });
    if (row.status !== undefined) invalid("discovery-response-status", { responseCount: responses.length, responseStatus: row.status });
    const namespace = kind === "principal" ? DAV : CALDAV, name = kind === "principal" ? "current-user-principal" : "calendar-home-set";
    const value = successfulDavProperty(row, namespace, name);
    const property = row.properties.get(davName(namespace, name));
    if (!value) invalid("discovery-property-unavailable", { ...(property ? { propertyStatus: property.status } : {}) });
    const href = value?.children[0];
    if (value.text || value.children.length !== 1 || href?.name !== davName(DAV, "href") || href.children.length || !href.text) invalid("discovery-property-shape");
    // tsdav resolves home hrefs against the account root. Require an absolute
    // or root-relative target so principal-relative discovery cannot diverge.
    if (!href!.text.startsWith("/") && !/^https?:\/\//i.test(href!.text)) invalid("discovery-target-shape");
    let target: URL;
    try { target = new URL(href!.text, url); } catch { invalid("discovery-target-invalid"); }
    if (target.username || target.password || target.hash || !["http:", "https:"].includes(target.protocol)) invalid("discovery-target-invalid");
    return;
  }
  if (requestedHrefs) {
    const expected = new Set(requestedHrefs.map(href => new URL(href, url).href));
    if (expected.size !== requestedHrefs.length || responses.length !== expected.size || responses.some(row => !expected.has(row.href))) invalid();
  }
  if (kind !== "sync" && (!responses.length || (kind !== "multiget" && !responses.some(row => row.href === new URL(url).href)))) invalid();
  for (const row of responses) {
    if (kind === "sync" && row.status === 404) continue;
    if (row.status !== undefined) invalid();
    if (kind === "discovery") {
      const resourceType = successfulDavProperty(row, DAV, "resourcetype");
      if (!resourceType || resourceType.text) invalid();
      for (const marker of resourceType!.children) if (marker.text || marker.children.length) invalid();
      if (resourceType!.children.some(child => child.name === davName(CALDAV, "calendar"))) {
        const components = successfulDavProperty(row, CALDAV, "supported-calendar-component-set");
        if (!components || components.text || !components.children.length) invalid();
        for (const component of components!.children) {
          if (component.name !== davName(CALDAV, "comp") || component.text || component.children.length
            || !/^[A-Z][A-Z0-9-]*$/.test(component.attributes.name ?? "")) invalid();
        }
      }
    } else if (kind === "multiget") {
      const etag = successfulDavProperty(row, DAV, "getetag"), data = successfulDavProperty(row, CALDAV, "calendar-data");
      if (!etag || !etag.text || etag.children.length || !data || !data.text || data.children.length) invalid();
    } else if (row.href !== new URL(url).href) {
      const etag = successfulDavProperty(row, DAV, "getetag");
      if (!etag || !etag.text || etag.children.length) invalid();
    }
  }
}

/** The outgoing request is generated by tsdav; use XML decoding for escaped hrefs. */
export function requestedDavHrefs(body: string): string[] {
  const document = xml2js(body, { compact: false }) as { elements?: any[] };
  const hrefs: string[] = [];
  function visit(nodes: any[]) {
    for (const node of nodes) {
      if (node.type === "element" && node.name.split(":").at(-1) === "href") hrefs.push((node.elements ?? []).filter((item: any) => item.type === "text").map((item: any) => item.text).join(""));
      else visit(node.elements ?? []);
    }
  }
  visit(document.elements ?? []);
  if (!hrefs.length || hrefs.some(href => !href)) invalid();
  return hrefs;
}

/** Feed the convenience parser one scalar text node, never mixed text/CDATA or
 * comments that its textFn can overwrite rather than concatenate. Attributes
 * (notably component name) and qualified element names remain unchanged. */
export function canonicalDavReadXML(xml: string, url: string): string {
  const document = xml2js(xml, { compact: false, captureSpacesBetweenElements: true }) as any;
  function normalize(node: any): any {
    const elements = node.elements ?? [];
    const children = elements.filter((child: any) => child.type === "element").map(normalize);
    let text = elements.filter((child: any) => child.type === "text" || child.type === "cdata").map((child: any) => child.text ?? child.cdata).join("").trim();
    if (node.type === "element" && node.name.split(":").at(-1) === "href" && text) text = new URL(text, url).href;
    if (node.type === "element" && node.name.split(":").at(-1) === "status" && text) text = `HTTP/1.1 ${text.split(" ")[1]} Status`;
    return { ...node, elements: children.length ? children : text ? [{ type: "text", text }] : [] };
  }
  return js2xml(normalize(document), { compact: false });
}
