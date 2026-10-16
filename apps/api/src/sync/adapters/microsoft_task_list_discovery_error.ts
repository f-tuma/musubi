import { graphDiscoveryHttpCodes, type GraphCalendarDiscoveryHttpCause, type GraphCalendarDiscoveryPhase } from "./microsoft_calendar_discovery_error";

export type GraphTaskListDiscoveryPhase = GraphCalendarDiscoveryPhase;
export type GraphTaskListDiscoveryHttpCause = Omit<GraphCalendarDiscoveryHttpCause, "code"> & {
  code: "graph-task-list-discovery-http-failed";
};

/** Discovery is a distinct resource from task-item delta/snapshot reads. The
 * sibling class cannot satisfy the calendar mailbox-isolation predicate. */
export class GraphTaskListDiscoveryHttpError extends Error {
  readonly cause: Readonly<GraphTaskListDiscoveryHttpCause>;
  constructor(cause: GraphTaskListDiscoveryHttpCause) {
    // Actual HTTP status retains optional/transient classification. Provider
    // messages, status text, URLs and caught parser errors never enter logs.
    super(`Outlook ${cause.httpStatus}: Task list discovery failed.`);
    this.name = "GraphTaskListDiscoveryHttpError";
    this.cause = Object.freeze({
      code: "graph-task-list-discovery-http-failed", requestPhase: cause.requestPhase,
      httpStatus: cause.httpStatus, graphCode: cause.graphCode, graphInnerCode: cause.graphInnerCode,
    });
  }
}

export async function graphTaskListDiscoveryHttpError(
  response: Response,
  requestPhase: GraphTaskListDiscoveryPhase,
): Promise<GraphTaskListDiscoveryHttpError> {
  return new GraphTaskListDiscoveryHttpError({
    code: "graph-task-list-discovery-http-failed", requestPhase,
    httpStatus: response.status, ...await graphDiscoveryHttpCodes(response),
  });
}
