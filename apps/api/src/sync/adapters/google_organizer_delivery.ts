import { observedProviderFetch as fetch } from "../provider_http_metrics";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { config } from "@musubi/config";
import {
  EventWriteError,
  GoogleOrganizerRequestSchema,
  OrganizerDispatchSchema,
  type ProviderOrganizerIntent,
  type ProviderRsvpInstance,
} from "@musubi/types";
import {
  googleEventCreateID,
  assertCompleteEventReadResponse,
} from "../event_create_identity";
import {
  assertProviderEventMutationResponse,
  ProviderEventWriteError,
} from "../event_write";
import {
  assertGoogleOrganizerInstanceIdentity,
  googleOrganizerNative,
  googleOrganizerBody,
  matchesGoogleOrganizer,
} from "./google_organizer";
const root = "https://www.googleapis.com/calendar/v3";
export function googleOrganizerTransport(
  token: (user: string, account: string) => Promise<string>,
) {
  return async (
    user: string,
    account: string,
    calendar: string,
    signal?: AbortSignal,
  ) => {
    if (!config.api.providerOrganizerEditsEnabled)
      throw new EventWriteError("organizer", "unsupported");
    const headers = {
      Authorization: `Bearer ${await token(user, account)}`,
      "Cache-Control": "no-cache",
    };
    const response = await fetch(`${root}/users/me/calendarList/primary`, {
      headers,
      redirect: "error",
      signal,
    });
    assertCompleteEventReadResponse(response);
    const primary = z
      .object({
        id: z.email(),
        primary: z.literal(true),
        accessRole: z.literal("owner"),
      })
      .parse(await response.json());
    if (primary.id.toLowerCase() !== calendar.toLowerCase())
      throw new EventWriteError("organizer", "denied");
    const url = `${root}/calendars/${encodeURIComponent(calendar)}/events`;
    async function read(id: string, instance?: ProviderRsvpInstance) {
      const result = await fetch(`${url}/${encodeURIComponent(id)}`, {
        headers,
        redirect: "error",
        signal,
      });
      if ([404, 410].includes(result.status)) return null;
      assertCompleteEventReadResponse(result);
      const raw = await result.json();
      if (raw?.id !== id)
        throw new ProviderEventWriteError("provider-conflict");
      if (raw.status === "cancelled") { if (instance) assertGoogleOrganizerInstanceIdentity(raw, instance); return null; }
      return googleOrganizerNative(raw, primary.id, instance);
    }
    return {
      email: primary.id,
      read,
      async deliver(
        saved: ProviderOrganizerIntent,
        beforeDispatch: () => Promise<void>,
        accepted: () => Promise<void>,
      ) {
        const request = GoogleOrganizerRequestSchema.parse(saved.request);
        if ((request.action !== "create" && request.scope === "occurrence") !== !!saved.instance) throw new ProviderEventWriteError("provider-conflict");
        const baseline = saved.baseline
          ? googleOrganizerNative(saved.baseline, primary.id, saved.instance)
          : null;
        const body = googleOrganizerBody(request, baseline, primary.id);
        if (!isDeepStrictEqual(body, saved.desired))
          throw new ProviderEventWriteError("provider-conflict");
        if (saved.dispatch && saved.dispatch.kind !== "google-organizer-dispatch") throw new ProviderEventWriteError("provider-conflict");
        const dispatched =
          saved.dispatch === undefined
            ? false
            : !!OrganizerDispatchSchema.parse(saved.dispatch);
        const id =
          request.action === "create"
            ? googleEventCreateID({ operationID: request.operationID })
            : baseline!.id;
        const current = await read(id, saved.instance);
        if (
          current &&
          matchesGoogleOrganizer(current, request, baseline, primary.id, saved.instance)
        )
          return { kind: "observed" as const, native: current };
        if (
          dispatched &&
          request.action === "delete" &&
          saved.dispatch?.acceptedAt &&
          !current
        )
          return { kind: "deleted" as const };
        if (dispatched)
          return {
            kind: current ? ("unconfirmed" as const) : ("absent" as const),
          };
        if (
          request.action === "create"
            ? current !== null
            : !current || !isDeepStrictEqual(current, baseline)
        )
          throw new ProviderEventWriteError("provider-conflict");
        // Refresh current OAuth grant before the caller atomically marks dispatch.
        // This marker is permanent; no later attempt can send another mutation.
        headers.Authorization = `Bearer ${await token(user, account)}`;
        if (!config.api.providerOrganizerEditsEnabled)
          throw new EventWriteError("organizer", "unsupported");
        await beforeDispatch();
        signal?.throwIfAborted();
        let result: Response;
        try {
          result = await fetch(
            `${url}${request.action === "create" ? "" : `/${encodeURIComponent(id)}`}?sendUpdates=all&conferenceDataVersion=1`,
            {
              method:
                request.action === "create"
                  ? "POST"
                  : request.action === "update"
                    ? "PATCH"
                    : "DELETE",
              headers: {
                ...headers,
                "Content-Type": "application/json",
                ...(baseline ? { "If-Match": baseline.etag } : {}),
              },
              ...(body ? { body: JSON.stringify(body) } : {}),
              redirect: "error",
              signal,
            },
          );
        } catch {
          throw new ProviderEventWriteError(
            "provider-write-failed",
            "unconfirmed",
          );
        }
        assertProviderEventMutationResponse(result);
        try {
          await result.body?.cancel();
        } catch {
          /* Authoritative read follows. */
        }
        await accepted();
        const observed = await read(id, saved.instance);
        if (request.action === "delete" && !observed)
          return { kind: "deleted" as const };
        if (
          observed &&
          matchesGoogleOrganizer(observed, request, baseline, primary.id, saved.instance)
        )
          return { kind: "observed" as const, native: observed };
        return {
          kind: observed ? ("unconfirmed" as const) : ("absent" as const),
        };
      },
    };
  };
}
