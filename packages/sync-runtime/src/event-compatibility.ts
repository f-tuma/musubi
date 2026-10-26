import { EventWriteError } from "@musubi/types";
import { createRuntimeAttempt } from "./attempt";
import { copyTaskCompatibilityData as own } from "./task-compatibility-data";
import type { AcceptedEventUpdateContext, ExternalEventRef } from "./event-compatibility-types";
import type { EventCompatibilityAttemptOptions, EventCompatibilityCompletion, EventCompatibilityFacts, EventCompatibilityHostPorts,
  EventCompatibilityNativePorts, EventCompatibilityObservation, EventCompatibilityPreparation, EventCompatibilitySnapshot } from "./event-compatibility-ports";

/** Shared host compatibility only. These native ports keep their existing
 * provider-specific scope, conditionality and notification/recovery policies. */
export async function runClaimedEventCompatibility(claim: { readonly reconciling: boolean; readonly caldavDispatchPossible: boolean },
  host: EventCompatibilityHostPorts, native: EventCompatibilityNativePorts, options: EventCompatibilityAttemptOptions = {}) {
  const initial = own(claim);
  const attempt = createRuntimeAttempt(signal => host.renew(signal), options), signal = attempt.signal;
  let mutationStarted = false, writerFulfilled = false, caldavDispatchPossible = initial.caldavDispatchPossible, settled = false;
  let expectedRef: ExternalEventRef | null = null, resultRef: ExternalEventRef | null = null, remoteSnapshot: EventCompatibilitySnapshot | null = null;
  let acceptedData: Omit<AcceptedEventUpdateContext, "beforeMutation"> | undefined, beforeMutation: AcceptedEventUpdateContext["beforeMutation"] | undefined;
  let prepared: EventCompatibilityPreparation | undefined;
  const acceptedNative = (): AcceptedEventUpdateContext | undefined => acceptedData ? { ...own(acceptedData, false), beforeMutation: beforeMutation! } : undefined;
  const captureRef = (ref: ExternalEventRef) => { attempt.guard(); expectedRef = own(ref); };
  function failure(code: string, outcome: "not-written" | "unconfirmed" = "not-written"): never { attempt.guard(); throw host.failure(code, outcome); }
  const facts = (): EventCompatibilityFacts => own({ mutationStarted, writerFulfilled, caldavDispatchPossible, expectedRef, resultRef, remoteSnapshot });
  const destination = async () => { attempt.guard(); const allowed = await host.checkDestination(initial.reconciling || mutationStarted, signal); attempt.guard(); return allowed; };
  const confirm = async (kind: Parameters<typeof host.confirm>[0]) => { attempt.guard(); const allowed = await host.confirm(kind, signal); attempt.guard(); return allowed; };
  const finish = async (input: Parameters<typeof host.finish>[0]) => { attempt.guard(); await host.finish(input); };
  const matches = (...args: Parameters<typeof host.matches>) => { attempt.guard(); return host.matches(...args); };
  const expected = async () => { attempt.guard(); const ref = own(await host.expectedRef(signal)); attempt.guard(); return ref; };
  const complete = async (input: EventCompatibilityCompletion) => {
    attempt.guard(); const result = await host.complete(own(input), signal); if (result) settled = true; return result;
  };
  const stamp = (ref: ExternalEventRef, observation: EventCompatibilityObservation | null): EventCompatibilitySnapshot => {
    attempt.guard(); return {
    externalEventId: ref.externalEventId, etag: observation?.ref.etag ?? null, icalUid: observation?.ref.icalUid ?? ref.icalUid,
    deleted: !observation, observedAt: new Date(host.now()).toISOString(), ...(observation?.event ? { values: JSON.parse(JSON.stringify(observation.event)) } : {}),
  }; };
  const echo = (observation: EventCompatibilityObservation): EventCompatibilitySnapshot => {
    attempt.guard(); return { isEcho: true, externalEventId: observation.ref.externalEventId,
      etag: observation.ref.etag ?? null, deleted: false, providerState: observation.state, observedAt: new Date(host.now()).toISOString() };
  };
  const scopedStamp = (ref: ExternalEventRef, observation: EventCompatibilityObservation | null) => {
    const { icalUid: _uid, ...snapshot } = stamp(ref, observation); return snapshot;
  };
  const read = async (input: Parameters<typeof native.read>[0]) => {
    attempt.guard();
    const request = input.family === "generic" ? { ...input, ref: own(input.ref, false), acceptedUpdate: acceptedNative() } :
      input.family === "find-created" ? { ...input, identity: { ...input.identity } } : { ...input, ref: own(input.ref, false) };
    return own(await native.read(request, signal));
  };
  const deliver = async (input: Parameters<typeof native.deliver>[0]) => {
    attempt.guard(); const result = await native.deliver(input, signal); writerFulfilled = true; return own(result);
  };
  const mark = async (kind: Parameters<typeof host.mark>[0], accepted = false) => {
    attempt.guard(); const granted = await host.mark(kind, accepted, signal); attempt.guard(); return granted;
  };
  const prep = async (family: EventCompatibilityPreparation["family"]) => { attempt.guard(); await host.prepareNative(family, captureRef, signal); attempt.guard(); };
  const activeRef = () => { if (!expectedRef) failure("provider-version-unavailable"); return expectedRef!; };
  try {
    const run = async () => {
      prepared = own(await host.prepare(signal)); attempt.guard();
      const p = prepared, family = p.family;
      if (family === "graphOccurrenceContent" || family === "graphMeetingCancellation") {
        const check = async () => { try { await confirm(family); } catch { failure("provider-conflict", p.priorDispatch || mutationStarted ? "unconfirmed" : "not-written"); } };
        await check();
        const outcome = await deliver({ family, mark: async () => { await check(); await mark(family); mutationStarted = true; }, accepted: async () => { await mark(family, true); } });
        if (family === "graphOccurrenceContent" && outcome.kind === "rejected") {
          attempt.guard(); if (!await host.stop(family, true)) failure("provider-conflict", "unconfirmed"); else settled = true;
        } else await complete({ family });
        return;
      }
      if (family === "organizer") {
        await confirm("organizer");
        const outcome = await deliver({ family, mark: async () => { await mark(family); mutationStarted = true; }, accepted: async () => { await mark(family, true); } });
        if (outcome.kind === "observed" || outcome.kind === "deleted") await complete({ family });
        else if (p.provider === "microsoft" && outcome.kind === "rejected") {
          attempt.guard(); if (!await host.stop(family, true)) failure("provider-conflict", "unconfirmed"); else settled = true;
        } else await finish({ status: "unconfirmed", code: p.provider !== "microsoft" && outcome.kind === "absent" ? "organizer-copy-absent" : "organizer-outcome-unknown", uncertain: p.priorDispatch || mutationStarted, retry: "organizer" });
        return;
      }
      if (family === "reminderInstance") {
        const check = async () => { if (!await destination() || !await confirm(family)) failure("provider-conflict", mutationStarted ? "unconfirmed" : "not-written"); };
        await check(); await prep(family);
        const outcome = await deliver({ family, mark: async () => { await check(); mutationStarted = true; } });
        mutationStarted = true;
        if (outcome.kind !== "observed" || !outcome.observation) failure("provider-write-failed", "unconfirmed");
        const observed = outcome.observation!; resultRef = own(observed.ref); attempt.guard();
        if (!matches("reminder-instance", observed)) failure("provider-conflict", "unconfirmed");
        await complete({ family, resultRef, expectedRef, snapshot: echo(observed) }); return;
      }
      if (family === "graphSeriesDeletion" || family === "graphSeriesCreate") {
        const check = async () => { if (!await destination() || !await confirm(family)) failure("provider-conflict"); };
        await check();
        try { await deliver({ family, mark: async () => { await check(); mutationStarted = true; } }); }
        catch (error) { if (!signal.aborted && family === "graphSeriesCreate" && host.errorInfo(error)?.outcome === "unconfirmed") mutationStarted = true; throw error; }
        mutationStarted = true;
        if (family === "graphSeriesCreate") { attempt.guard(); host.prepareGraphFamilyObservation(signal); if (!await destination()) return; }
        if (!await complete({ family })) failure("provider-conflict", "unconfirmed"); return;
      }
      if (family === "caldavAlarm" || family === "caldavSplit" || family === "caldavSeriesDeletion" || family === "caldavSeries") {
        const check = async () => { if (!await destination() || !await confirm(family)) failure("provider-conflict", family === "caldavAlarm" && mutationStarted ? "unconfirmed" : "not-written"); };
        if (family === "caldavSeries") { if (!await destination()) return; if (!await confirm(family)) failure("provider-conflict"); }
        else await check();
        expectedRef = p.expectedRef ? own(p.expectedRef) : null;
        if (family !== "caldavAlarm") mutationStarted = true;
        const outcome = await deliver({ family, mark: async () => { await check(); if (family === "caldavAlarm") mutationStarted = true; } });
        if (family === "caldavAlarm") mutationStarted = true;
        if (outcome.kind !== "observed" || !outcome.observation) failure("provider-write-failed", "unconfirmed");
        const observed = outcome.observation!; resultRef = own(observed.ref); attempt.guard(); if (!await destination()) return;
        if (!await complete(family === "caldavAlarm" ? { family, observation: observed } : { family, ref: resultRef })) failure("provider-conflict", "unconfirmed");
        return;
      }
      if (family === "googleOccurrence") {
        if (!await destination()) return; if (!await confirm("revision")) failure("provider-conflict");
        await prep(family); expectedRef = await expected(); activeRef();
        let observed = await read({ family, ref: activeRef(), recover: p.reconciling });
        if (!observed?.event) failure("provider-conflict");
        remoteSnapshot = { ...scopedStamp(observed!.ref, observed), providerState: observed!.state };
        if (!matches("occurrence-desired", observed!)) {
          if (observed!.ref.etag !== expectedRef?.etag || !matches("occurrence-baseline", observed!)) failure("provider-conflict");
          if (!await destination()) return; remoteSnapshot = null; mutationStarted = true;
          const outcome = await deliver({ family, ref: own(activeRef(), false), event: own(p.event, false) });
          if (outcome.kind !== "observed" || !outcome.observation) failure("provider-write-failed", "unconfirmed"); observed = outcome.observation!;
        }
        resultRef = own(observed!.ref); attempt.guard(); await complete({ family, resultRef, expectedRef, snapshot: echo(observed!) }); remoteSnapshot = null; return;
      }
      if (family === "microsoftRsvp" || family === "caldavRsvp" || family === "googleRsvp") {
        if (!await destination()) return;
        const source = async () => { if (!await confirm("rsvp")) failure("provider-conflict", family === "microsoftRsvp" ? "not-written" : mutationStarted ? "unconfirmed" : "not-written"); };
        if (family === "googleRsvp") await source();
        await prep(family);
        if (family !== "googleRsvp") await source();
        if (family === "caldavRsvp") captureRef(host.nativeRef(family));
        const outcome = await deliver({ family, mark: async () => {
          attempt.guard();
          if (family === "microsoftRsvp") { if (!await mark(family)) failure("provider-conflict"); }
          else {
            await source();
            if (family === "googleRsvp" && !await mark(family)) failure("provider-conflict", "not-written");
            if (family === "caldavRsvp") {
              if (p.caldavDispatchPossible) failure("provider-conflict");
              let granted: boolean;
              try { granted = await mark(family); } catch (error) { caldavDispatchPossible = true; throw error; }
              if (!granted) failure("provider-conflict"); caldavDispatchPossible = true;
            }
          }
          mutationStarted = true;
        }, ...(family === "microsoftRsvp" ? { accepted: async () => { if (!await mark(family, true)) failure("provider-write-failed", "unconfirmed"); } } : {}) });
        if (family === "microsoftRsvp" && outcome.kind !== "observed") {
          await finish({ status: "unconfirmed", code: outcome.kind === "absent" ? "graph-rsvp-copy-absent" : "graph-rsvp-response-unconfirmed", uncertain: p.priorDispatch || mutationStarted, retry: "none" }); return;
        }
        if (outcome.kind !== "observed" || !outcome.observation) failure("provider-write-failed", "unconfirmed");
        const observed = outcome.observation!; resultRef = own(observed.ref); if (family !== "microsoftRsvp") attempt.guard();
        await complete({ family, resultRef, expectedRef, snapshot: echo(observed) }); return;
      }
      if (family === "reminderEdit") {
        if (!await destination()) return;
        const source = async () => { if (!await confirm("reminderEdit")) failure("provider-conflict", mutationStarted ? "unconfirmed" : "not-written"); };
        await source(); expectedRef = await expected(); activeRef();
        let observed = await read({ family, ref: activeRef() }); remoteSnapshot = { ...scopedStamp(activeRef(), observed), ...(observed ? { providerState: observed.state } : {}) };
        if (!observed || !matches("reminder-event", observed)) failure("provider-conflict");
        if (!matches("reminder-intent", observed!)) {
          if (observed!.ref.etag !== expectedRef?.etag) failure("provider-conflict");
          if (!await destination()) return; attempt.guard(); remoteSnapshot = null;
          const outcome = await deliver({ family, ref: own(activeRef(), false), mark: async () => { await source(); mutationStarted = true; } });
          if (outcome.kind !== "observed" || !outcome.observation) failure("provider-write-failed", "unconfirmed"); observed = outcome.observation!;
          if (!matches("reminder-intent", observed)) failure("provider-write-failed", "unconfirmed");
        }
        if (!matches("reminder-event", observed!)) { remoteSnapshot = { ...scopedStamp(observed!.ref, observed), providerState: observed!.state }; failure("provider-conflict", mutationStarted ? "unconfirmed" : "not-written"); }
        resultRef = own(observed!.ref); attempt.guard(); await complete({ family, resultRef, expectedRef, snapshot: echo(observed!) }); remoteSnapshot = null; return;
      }
      const generic = p.generic!;
      if (generic.saveProjection) { attempt.guard(); const saved = await host.saveProjection(signal); attempt.guard(); if (!saved) return; }
      if (!await destination()) return;
      if (p.action !== "delete" && !await confirm("revision")) failure("provider-write-failed", p.reconciling ? "unconfirmed" : "not-written");
      expectedRef = await expected();
      attempt.guard(); const accepted = own(await host.acceptedUpdate(signal)); attempt.guard();
      if (accepted) { acceptedData = accepted; beforeMutation = async () => {
        attempt.guard(); if (!await host.renew(signal)) failure("provider-write-failed");
        if (!await destination()) throw new EventWriteError("event-write", "unknown"); attempt.guard(); mutationStarted = true;
      }; }
      const identity = generic.identity ? { operationID: p.operationId, signal } : undefined;
      if (identity && p.action === "create") {
        attempt.guard(); const known = host.knownCreateId(signal);
        if (known) attempt.guard();
        if (known && await host.deletedCreate(known, signal)) { remoteSnapshot = stamp({ externalEventId: known }, null); failure("provider-conflict"); }
      }
      let recovered = false;
      if (p.reconciling || p.action === "delete") {
        if (p.action === "create") {
          if (!identity || !generic.findCreated) { await finish({ status: "blocked", code: "create-recovery-unavailable", uncertain: true, retry: "none" }); return; }
          const observed = await read({ family: "find-created", identity });
          if (observed) {
            remoteSnapshot = stamp(observed.ref, observed); if (!matches("delivered", observed, generic.expected)) failure("provider-conflict"); resultRef = own(observed.ref); remoteSnapshot = null; recovered = true;
          } else if (p.provider !== "google" && p.provider !== "caldav") { await finish({ status: "blocked", code: "create-outcome-unknown", uncertain: true, retry: "none" }); return; }
        } else if (expectedRef) {
          const observed = await read({ family: "generic", ref: expectedRef, acceptedUpdate: acceptedNative() }); remoteSnapshot = stamp(expectedRef, observed);
          const firstExplicit = p.attempts === 1 && generic.firstExplicitResolution?.expectedRemoteExists === true && generic.firstExplicitResolution.expectedRemoteEtag === expectedRef.etag;
          if (observed && p.provider === "microsoft" && p.action === "delete" && p.reconciling && !firstExplicit) {
            await finish({ status: "unconfirmed", code: "provider-write-failed", uncertain: true, retry: "hour", remoteSnapshot }); return;
          }
          if (!observed && p.action === "delete") recovered = true;
          else if (observed && p.action === "update" && matches("delivered", observed, generic.expected)) { resultRef = own(observed.ref); recovered = true; }
          else if (observed && (attempt.guard(), host.sameAcceptedVersion(expectedRef, observed.ref))) { /* Original accepted baseline permits native preflight. */ }
          else failure("provider-conflict"); remoteSnapshot = null;
        } else if (generic.predecessor) failure("provider-version-unavailable");
      }
      if (!recovered) {
        if (p.action !== "create" && !expectedRef) { if (generic.predecessor) failure("provider-version-unavailable"); await complete({ family: "generic", resultRef: null, expectedRef: null }); return; }
        attempt.guard(); await native.preflight(own(p.event, false), expectedRef && own(expectedRef, false), generic.patch && own(generic.patch, false), acceptedNative(), signal);
        if (!await destination()) return; attempt.guard(); if (!acceptedData) mutationStarted = true;
        const outcome = await deliver({ family: "generic", action: p.action, event: own(p.event, false), ref: expectedRef && own(expectedRef, false),
          patch: generic.patch && own(generic.patch, false), identity, acceptedUpdate: acceptedNative() });
        if (p.action !== "delete" && outcome.kind === "observed" && outcome.observation) resultRef = own(outcome.observation.ref);
      }
      attempt.guard(); await complete({ family: "generic", resultRef, expectedRef });
    };
    await attempt.run(() => run().catch(async error => {
      if (!signal.aborted && host.errorInfo(error)?.code === "provider-conflict" && !prepared?.skipConflictRead && !remoteSnapshot && expectedRef && prepared?.canReadEvent && !signal.aborted) {
        try { remoteSnapshot = stamp(expectedRef, await read({ family: "generic", ref: expectedRef, acceptedUpdate: acceptedNative() })); } catch { /* Existing conflict remains authoritative. */ }
      }
      throw error;
    }));
  } catch (error) { if (!settled) await host.fail(error, facts()); }
  finally { attempt.close(); }
  return { facts: facts(), settled };
}
