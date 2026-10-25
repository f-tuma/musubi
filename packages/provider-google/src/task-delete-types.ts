import type { GoogleNativeTaskReadEvidence, GoogleTaskProviderPorts, GoogleTaskRequestMetric, GoogleTaskTarget } from "./task-types";

/** Native DELETE keeps its original any-2xx success floor. This type does not
 * widen UPDATE's separate 200|201|204 accepted-response contract. */
export type GoogleTaskDeleteAcceptedStatus =
  | 200 | 201 | 202 | 203 | 204 | 205 | 206 | 207 | 208 | 209
  | 210 | 211 | 212 | 213 | 214 | 215 | 216 | 217 | 218 | 219
  | 220 | 221 | 222 | 223 | 224 | 225 | 226 | 227 | 228 | 229
  | 230 | 231 | 232 | 233 | 234 | 235 | 236 | 237 | 238 | 239
  | 240 | 241 | 242 | 243 | 244 | 245 | 246 | 247 | 248 | 249
  | 250 | 251 | 252 | 253 | 254 | 255 | 256 | 257 | 258 | 259
  | 260 | 261 | 262 | 263 | 264 | 265 | 266 | 267 | 268 | 269
  | 270 | 271 | 272 | 273 | 274 | 275 | 276 | 277 | 278 | 279
  | 280 | 281 | 282 | 283 | 284 | 285 | 286 | 287 | 288 | 289
  | 290 | 291 | 292 | 293 | 294 | 295 | 296 | 297 | 298 | 299;
export function isGoogleTaskDeleteAcceptedStatus(value: unknown): value is GoogleTaskDeleteAcceptedStatus {
  return typeof value === "number" && Number.isInteger(value) && value >= 200 && value <= 299;
}
export interface GoogleTaskDelete {
  readonly target: GoogleTaskTarget;
  readonly acceptedEtag: string;
  readonly operationId: string;
  readonly attemptId: string;
  readonly serializer: { readonly id: "google-task"; readonly version: 1 };
}
export type GoogleNativeTaskDeleteReadEvidence = GoogleNativeTaskReadEvidence;
export type GoogleNativeTaskDeleteAbsence = Extract<GoogleNativeTaskReadEvidence, { kind: "absent" }>;
export type GoogleNativeTaskDeletePreflight =
  | { readonly kind: "allowed"; readonly read: Extract<GoogleNativeTaskReadEvidence, { kind: "present" }> }
  | GoogleNativeTaskDeleteAbsence;
/** Only a dispatched DELETE can produce this raw HTTP receipt. A 404/410
 * response fulfils the DELETE request but never asserts accepted HTTP or a write. */
export type GoogleNativeTaskDeleteResponse =
  | { readonly kind: "accepted"; readonly status: GoogleTaskDeleteAcceptedStatus; readonly validator: null }
  | { readonly kind: "absent"; readonly status: 404 | 410 };
export type GoogleNativeTaskDeleteEvidence =
  | { readonly kind: "deleted"; readonly status: GoogleTaskDeleteAcceptedStatus }
  | { readonly kind: "absent"; readonly status: 404 | 410; readonly source: "writer-read" | "delete-response" };
export type GoogleTaskDeleteRequestMetric = Omit<GoogleTaskRequestMetric, "method"> & { readonly method: "GET" | "DELETE" };
export interface GoogleTaskDeleteProviderPorts extends Omit<GoogleTaskProviderPorts, "beforeMutation" | "onAcceptedResponse" | "telemetry"> {
  readonly telemetry: { record(metric: GoogleTaskDeleteRequestMetric): void };
  readonly beforeMutation: (request: GoogleTaskDelete, signal?: AbortSignal) => Promise<void>;
  readonly onDeleteResponse: (response: GoogleNativeTaskDeleteResponse, signal?: AbortSignal) => Promise<void>;
}
