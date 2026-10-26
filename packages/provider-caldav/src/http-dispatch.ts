/** Structural host decoration; no storage, credentials or runtime dependency. */
export interface NativeHttpDispatch {
  dispatch?(request: Readonly<{ url: string; method: string; signal?: AbortSignal }>,
    sendRawOnce: (beforeRaw?: () => undefined) => Promise<Response>): Promise<Response>;
  isDispatchDeferred?(error: unknown): boolean;
}
/** The decorator's persistence/admission stays outside the actual raw HTTP span. */
export async function dispatchNativeHttp(http: NativeHttpDispatch, url: string, init: RequestInit,
  raw: (init: RequestInit) => Promise<Response>, clock: { nowMonotonicMs(): number },
  record: (status: number | "network-error" | "aborted", durationMs: number) => void): Promise<Response> {
  let open = true, used = false, rawResponse: Response | undefined;
  const send = async (before?: () => undefined): Promise<Response> => {
    if (!open || used) throw new Error("Native HTTP capability is closed or already used.");
    used = true; init.signal?.throwIfAborted();
    if (before && before() !== undefined) throw new TypeError("Native HTTP admission must be synchronous.");
    const started = clock.nowMonotonicMs();
    let status: number | "network-error" | "aborted" = "network-error";
    try { const response = await raw(init); rawResponse = response; status = response.status; return response; }
    catch (error) { if (init.signal?.aborted || error instanceof Error && error.name === "AbortError") status = "aborted"; throw error; }
    finally { try { record(status, Math.max(0, clock.nowMonotonicMs() - started)); } catch { /* Diagnostics never authorize or change native evidence. */ } }
  };
  try {
    const response = await (http.dispatch ? http.dispatch({ url, method: (init.method ?? "GET").toUpperCase(), signal: init.signal ?? undefined }, send) : send());
    if (!used || response !== rawResponse) throw new Error("Native HTTP decoration must return its actual raw response.");
    return response;
  }
  finally { open = false; }
}
