/** Structural native transport contract. Providers declare this shape locally to avoid a dependency cycle. */
export interface HttpDispatchRequest { readonly url: string; readonly method: string; readonly signal?: AbortSignal }
export type BeforeRawDispatch = () => undefined;
export type SendRawOnce = (beforeRaw?: BeforeRawDispatch) => Promise<Response>;
export interface HttpDispatchPort {
  dispatch?(request: HttpDispatchRequest, sendRawOnce: SendRawOnce): Promise<Response>;
  isDispatchDeferred?(error: unknown): boolean;
}
/** Preserve the optional decorator at every already-claimed runtime reconstruction. */
export function guardHttpDispatch<T extends HttpDispatchPort>(http: T, guard: () => void): T {
  return { ...http, dispatch(request: HttpDispatchRequest, send: SendRawOnce) {
    guard(); request.signal?.throwIfAborted();
    const guarded: SendRawOnce = before => send(() => { guard(); request.signal?.throwIfAborted(); before?.(); return undefined; });
    return http.dispatch ? http.dispatch(request, guarded) : guarded();
  } };
}
