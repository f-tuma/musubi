/** Calendar discovery diagnostics retain classifications only. Neither provider
 * messages, status text, request identities nor caught parse errors are kept. */
export type GraphCalendarDiscoveryPhase = "initial" | "next-page";

const GRAPH_CODES = [
  "MailboxNotEnabledForRESTAPI", "MailboxNotSupportedForRESTAPI",
  "ErrorItemNotFound", "ResourceNotFound", "BadRequest", "InvalidRequest",
  "ErrorInvalidRequest", "InvalidAuthenticationToken", "ErrorAccessDenied",
  "AccessDenied", "TooManyRequests", "ServiceUnavailable",
] as const;
type GraphCode = typeof GRAPH_CODES[number] | "missing" | "unparseable" | "other";

export type GraphCalendarDiscoveryHttpCause = {
  code: "graph-calendar-discovery-http-failed";
  requestPhase: GraphCalendarDiscoveryPhase;
  httpStatus: number;
  graphCode: GraphCode;
  graphInnerCode: GraphCode;
};

export class GraphCalendarDiscoveryHttpError extends Error {
  readonly cause: Readonly<GraphCalendarDiscoveryHttpCause>;
  constructor(cause: GraphCalendarDiscoveryHttpCause) {
    // Preserve the status prefix used by optional/transient classifiers without
    // letting provider-controlled message text alter classification or logs.
    super(`Outlook ${cause.httpStatus}: Calendar discovery failed.`);
    this.name = "GraphCalendarDiscoveryHttpError";
    this.cause = Object.freeze({
      code: "graph-calendar-discovery-http-failed", requestPhase: cause.requestPhase,
      httpStatus: cause.httpStatus, graphCode: cause.graphCode, graphInnerCode: cause.graphInnerCode,
    });
  }
}

/** A mailbox code is resource eligibility evidence only on the initial GET.
 * Message text, a generic 404, or a failed continuation never qualify. */
export function isMicrosoftEventMailboxUnavailable(error: unknown): error is GraphCalendarDiscoveryHttpError {
  return error instanceof GraphCalendarDiscoveryHttpError && error.cause.httpStatus === 404 && error.cause.requestPhase === "initial" &&
    [error.cause.graphCode, error.cause.graphInnerCode].some(code => code === "MailboxNotEnabledForRESTAPI" || code === "MailboxNotSupportedForRESTAPI");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function graphCode(value: unknown): GraphCode {
  if (value === undefined) return "missing";
  if (typeof value !== "string" || !value || value.trim() !== value) return "unparseable";
  return GRAPH_CODES.find(allowed => allowed === value) ?? "other";
}

async function graphCodes(response: Response): Promise<Pick<GraphCalendarDiscoveryHttpCause, "graphCode" | "graphInnerCode">> {
  let body: unknown;
  try { body = await response.json(); }
  catch { return { graphCode: "unparseable", graphInnerCode: "unparseable" }; }
  if (!record(body)) return { graphCode: "unparseable", graphInnerCode: "unparseable" };
  if (body.error === undefined) return { graphCode: "missing", graphInnerCode: "missing" };
  if (!record(body.error)) return { graphCode: "unparseable", graphInnerCode: "unparseable" };
  // As with task HTTP diagnostics, inspect the first innerError/innererror only.
  // An absent first-level code is not proof that no deeper service code exists.
  const inner = body.error.innerError === undefined ? body.error.innererror : body.error.innerError;
  return {
    graphCode: graphCode(body.error.code),
    graphInnerCode: inner === undefined ? "missing" : record(inner) ? graphCode(inner.code) : "unparseable",
  };
}

export async function graphCalendarDiscoveryHttpError(
  response: Response,
  requestPhase: GraphCalendarDiscoveryPhase,
): Promise<GraphCalendarDiscoveryHttpError> {
  return new GraphCalendarDiscoveryHttpError({
    code: "graph-calendar-discovery-http-failed", requestPhase,
    httpStatus: response.status, ...await graphCodes(response),
  });
}
