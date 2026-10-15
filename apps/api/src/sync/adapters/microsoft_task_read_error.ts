/** Task pull HTTP diagnostics contain classifications only. Neither provider
 * messages nor request addresses become part of the error or its cause. */
export type GraphTaskReadKind = "delta" | "snapshot";
export type GraphTaskReadPhase = "initial" | "saved-cursor" | "next-page" | "recovery-initial";

const GRAPH_CODES = [
  "BadRequest", "InvalidRequest", "ErrorInvalidRequest", "ErrorInvalidUrlQuery", "SyncStateNotFound", "syncStateNotFound",
  "InvalidDeltaToken", "ErrorInvalidSyncStateData", "InvalidAuthenticationToken",
  "ErrorAccessDenied", "AccessDenied", "ErrorItemNotFound", "TooManyRequests",
  "ServiceUnavailable", "MailboxNotEnabledForRESTAPI",
] as const;
type GraphCode = typeof GRAPH_CODES[number] | "missing" | "malformed" | "other";
type QueryState = "none" | "skip" | "delta" | "both" | "other" | "invalid";
type ParameterState = "absent" | "empty" | "present" | "multiple" | "unknown";

export type GraphTaskReadHttpCause = {
  code: "graph-task-read-http-failed";
  readKind: GraphTaskReadKind;
  requestPhase: GraphTaskReadPhase;
  httpStatus: number;
  graphCode: GraphCode;
  graphInnerCode: GraphCode;
  queryState: QueryState;
  skipState: ParameterState;
  deltaState: ParameterState;
};

export class GraphTaskReadHttpError extends Error {
  readonly cause: Readonly<GraphTaskReadHttpCause>;
  constructor(cause: GraphTaskReadHttpCause) {
    // Existing optional-403 and transient classifiers use the Outlook status
    // prefix. Keep it without retaining any provider-controlled message.
    super(`Outlook ${cause.httpStatus}: Task read failed.`);
    this.name = "GraphTaskReadHttpError";
    this.cause = Object.freeze({
      code: "graph-task-read-http-failed", readKind: cause.readKind, requestPhase: cause.requestPhase,
      httpStatus: cause.httpStatus, graphCode: cause.graphCode, graphInnerCode: cause.graphInnerCode,
      queryState: cause.queryState, skipState: cause.skipState, deltaState: cause.deltaState,
    });
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function graphCode(value: unknown): GraphCode {
  if (value === undefined) return "missing";
  if (typeof value !== "string" || !value || value.trim() !== value) return "malformed";
  return GRAPH_CODES.find(allowed => allowed === value) ?? "other";
}

async function graphCodes(response: Response): Promise<Pick<GraphTaskReadHttpCause, "graphCode" | "graphInnerCode">> {
  let body: unknown;
  try { body = await response.json(); }
  catch { return { graphCode: "malformed", graphInnerCode: "malformed" }; }
  if (!record(body)) return { graphCode: "malformed", graphInnerCode: "malformed" };
  if (body.error === undefined) return { graphCode: "missing", graphInnerCode: "missing" };
  if (!record(body.error)) return { graphCode: "malformed", graphInnerCode: "malformed" };
  const inner = body.error.innerError === undefined ? body.error.innererror : body.error.innerError;
  return {
    graphCode: graphCode(body.error.code),
    graphInnerCode: inner === undefined ? "missing" : record(inner) ? graphCode(inner.code) : "malformed",
  };
}

function queryShape(url: string): Pick<GraphTaskReadHttpCause, "queryState" | "skipState" | "deltaState"> {
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { return { queryState: "invalid", skipState: "unknown", deltaState: "unknown" }; }
  const skip: string[] = [], delta: string[] = [];
  for (const [key, value] of parsed.searchParams) {
    const name = key.toLowerCase();
    if (name === "$skiptoken" || name === "skiptoken") skip.push(value);
    else if (name === "$deltatoken" || name === "deltatoken") delta.push(value);
  }
  const presence = (values: string[]): ParameterState => values.length > 1 ? "multiple"
    : values.length === 0 ? "absent" : values[0] === "" ? "empty" : "present";
  return {
    queryState: skip.length && delta.length ? "both" : skip.length ? "skip" : delta.length ? "delta"
      : parsed.search ? "other" : "none",
    skipState: presence(skip), deltaState: presence(delta),
  };
}

export async function graphTaskReadHttpError(
  response: Response,
  context: { readKind: GraphTaskReadKind; requestPhase: GraphTaskReadPhase; url: string },
): Promise<GraphTaskReadHttpError> {
  return new GraphTaskReadHttpError({
    code: "graph-task-read-http-failed", readKind: context.readKind, requestPhase: context.requestPhase,
    httpStatus: response.status, ...await graphCodes(response), ...queryShape(context.url),
  });
}
