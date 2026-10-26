import { readIcloudOrganizerCreation } from "./icloud_organizer_creation";
import { isDeepStrictEqual } from "node:util";
import { config } from "@musubi/config";
import {
  CaldavOrganizerRequestSchema,
  OrganizerDispatchSchema,
  EventWriteError,
  type ProviderOrganizerIntent,
} from "@musubi/types";
import { createGuardedCaldavFetch } from "../caldav_client";
import { readCaldavSchedulingProof } from "../caldav_scheduling";
import { reserveProviderMutation } from "../provider_budget";
import {
  assertEventWriteResponse,
  assertProviderEventMutationResponse,
  requireEventEtag,
  ProviderEventWriteError,
} from "../event_write";
import { caldavSeriesResourceURL } from "./caldav_series";
import {
  caldavOrganizerNative,
  caldavOrganizerDesired,
  matchesCaldavOrganizer,
  type CaldavOrganizerNative,
  type CaldavOrganizerDesired,
} from "./caldav_organizer";
const fetch = createGuardedCaldavFetch();
function enabled() {
  if (!config.api.caldavOrganizerEditsEnabled)
    throw new EventWriteError("organizer", "unsupported");
}
export function caldavOrganizerTransport(
  getAuthorization: (userID: string, accountID: string) => Promise<string>,
  icloudCreateEligibility?: (userID: string, accountID: string, collection: string, resource: string) => Promise<boolean>,
) {
  return async (
    userID: string,
    accountID: string,
    collection: string,
    action: "create" | "update" | "delete",
    resourceID?: string,
    signal?: AbortSignal,
  ) => {
    enabled();
    const id =
      resourceID ??
      new URL(
        "musubi-organizer-proof.ics",
        collection.endsWith("/") ? collection : `${collection}/`,
      ).href;
    caldavSeriesResourceURL(collection, id);
    const authorization = await getAuthorization(userID, accountID);
    const proof = await readCaldavSchedulingProof(
      collection,
      id,
      authorization,
      signal,
      action,
    );
    async function read(target: string): Promise<CaldavOrganizerNative | null> {
      enabled();
      caldavSeriesResourceURL(collection, target);
      const response = await fetch(target, {
        redirect: "error",
        signal,
        headers: {
          authorization,
          accept: "text/calendar",
          "cache-control": "no-cache",
        },
      });
      if ([404, 410].includes(response.status)) return null;
      assertEventWriteResponse(response);
      if (response.status !== 200 || response.headers.has("content-range"))
        throw new ProviderEventWriteError("provider-write-failed");
      const data = new TextDecoder("utf-8", { fatal: true }).decode(
        await response.arrayBuffer(),
      );
      // Native parsing establishes UID, not a URL-derived guess.
      const { default: ICAL } = await import("ical.js");
      const uid = new ICAL.Component(ICAL.parse(data))
        .getFirstSubcomponent("vevent")
        ?.getFirstPropertyValue("uid");
      if (typeof uid !== "string")
        throw new ProviderEventWriteError("provider-conflict");
      const native = {
        id: target,
        data,
        iCalUID: uid,
        etag: requireEventEtag(response.headers.get("etag")),
        scheduleTag: requireEventEtag(response.headers.get("schedule-tag")),
        proof,
      };
      caldavOrganizerNative(native);
      return native;
    }
    return {
      proof,
      read,
      async deliver(
        saved: ProviderOrganizerIntent,
        beforeDispatch: () => Promise<void>,
        accepted: () => Promise<void>,
      ) {
        enabled();
        const request = CaldavOrganizerRequestSchema.parse(saved.request);
        if (request.action !== action)
          throw new ProviderEventWriteError("provider-conflict");
        const baseline = saved.baseline as CaldavOrganizerNative | null;
        if (baseline) {
          caldavOrganizerNative(baseline);
          if (!isDeepStrictEqual(baseline.proof, proof))
            throw new ProviderEventWriteError("provider-conflict");
        }
        const desired = saved.desired as CaldavOrganizerDesired | null;
        const rebuilt = caldavOrganizerDesired(
          collection,
          request,
          baseline,
          proof,
          desired?.stamp ?? "20000101T000000Z",
        );
        if (!isDeepStrictEqual(rebuilt, desired))
          throw new ProviderEventWriteError("provider-conflict");
        const dispatch = saved.dispatch
          ? OrganizerDispatchSchema.parse(saved.dispatch)
          : undefined;
        if (dispatch && dispatch.kind !== "caldav-organizer-dispatch")
          throw new ProviderEventWriteError("provider-conflict");
        const target = desired?.id ?? baseline!.id;
        const readCreated = async () => {
          try { return { current: await read(target) }; }
          catch (error) {
            if (request.action !== "create" || !desired || !icloudCreateEligibility || !(error instanceof ProviderEventWriteError) || error.code !== "provider-version-unavailable") throw error;
            const result = await readIcloudOrganizerCreation(target, desired, proof, authorization,
              async () => (await getAuthorization(userID, accountID)) === authorization && await icloudCreateEligibility(userID, accountID, collection, target), signal);
            return { observed: { kind: "observed" as const, ...result } };
          }
        };
        const initial = await readCreated();
        if (initial.observed) return initial.observed;
        const current = initial.current;
        if (
          current &&
          desired &&
          matchesCaldavOrganizer(current, desired, baseline)
        )
          return {
            kind: "observed" as const,
            native: current,
            state: caldavOrganizerNative(current).state,
          };
        if (dispatch?.acceptedAt && request.action === "delete" && !current)
          return { kind: "deleted" as const };
        if (dispatch)
          return {
            kind: current ? ("unconfirmed" as const) : ("absent" as const),
          };
        if (
          request.action === "create"
            ? current !== null
            : !current || !isDeepStrictEqual(current, baseline)
        )
          throw new ProviderEventWriteError("provider-conflict");
        if ((await getAuthorization(userID, accountID)) !== authorization)
          throw new ProviderEventWriteError("provider-conflict");
        enabled();
        signal?.throwIfAborted();
        await reserveProviderMutation({ url: new URL(target).href, method: request.action === "delete" ? "DELETE" : "PUT" }, beforeDispatch);
        enabled();
        signal?.throwIfAborted();
        const response = await fetch(target, {
          method: request.action === "delete" ? "DELETE" : "PUT",
          redirect: "error",
          signal,
          headers: {
            authorization,
            ...(request.action === "create"
              ? { "if-none-match": "*" }
              : { "if-match": baseline!.etag }),
            ...(desired
              ? { "content-type": "text/calendar; charset=utf-8" }
              : {}),
          },
          ...(desired ? { body: desired.data } : {}),
        });
        assertProviderEventMutationResponse(response);
        await accepted();
        const final = await readCreated();
        if (final.observed) return final.observed;
        const observed = final.current;
        if (request.action === "delete" && !observed)
          return { kind: "deleted" as const };
        if (
          observed &&
          desired &&
          matchesCaldavOrganizer(observed, desired, baseline)
        )
          return {
            kind: "observed" as const,
            native: observed,
            state: caldavOrganizerNative(observed).state,
          };
        return {
          kind: observed ? ("unconfirmed" as const) : ("absent" as const),
        };
      },
    };
  };
}
