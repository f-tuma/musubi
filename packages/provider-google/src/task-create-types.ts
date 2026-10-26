import type { GoogleNativeTaskAcceptedResponse, GoogleTaskProjection, GoogleTaskProviderPorts, GoogleTaskRequestMetric } from "./task-types";

/** CREATE has a captured collection, but no native task address before POST. */
export interface GoogleTaskCreateTarget {
  readonly connectionId: string;
  readonly connectionGeneration: string;
  readonly taskListId: string;
}
export interface GoogleTaskCreate {
  readonly target: GoogleTaskCreateTarget;
  readonly body: GoogleTaskProjection;
  readonly operationId: string;
  readonly attemptId: string;
  readonly serializer: { readonly id: "google-task"; readonly version: 1 };
}
export type GoogleNativeTaskCreatePreflight = { readonly kind: "allowed" };
/** A valid response address is useful evidence even without a usable tag. It
 * does not prove that a subsequent scoped GET achieves the admitted target. */
export interface GoogleNativeTaskResponseAddress {
  readonly taskId: string;
  readonly validator: string | null;
}
/** Preserve the existing writer-return boundary: both ID and strong body ETag. */
export interface GoogleNativeTaskCreateEvidence {
  readonly kind: "created";
  readonly taskId: string;
  readonly etag: string;
}
export type GoogleTaskCreateRequestMetric = Omit<GoogleTaskRequestMetric, "method"> & { readonly method: "GET" | "POST" };
export interface GoogleTaskCreateProviderPorts extends Omit<GoogleTaskProviderPorts, "beforeMutation" | "onAcceptedResponse" | "telemetry"> {
  readonly telemetry: { record(metric: GoogleTaskCreateRequestMetric): void };
  readonly beforeMutation: (request: GoogleTaskCreate, signal?: AbortSignal) => Promise<void>;
  readonly onAcceptedResponse: (response: GoogleNativeTaskAcceptedResponse, signal?: AbortSignal) => Promise<void>;
  readonly onResponseAddress: (address: GoogleNativeTaskResponseAddress, signal?: AbortSignal) => Promise<void>;
}
