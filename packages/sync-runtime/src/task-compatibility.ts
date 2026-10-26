import { createRuntimeAttempt } from "./attempt";
import { copyNativeTaskEvidence } from "./task-native-data";
import { copyTaskCompatibilityData } from "./task-compatibility-data";
import { diffTaskProjection, jsonTaskProjection, sameTaskProjection } from "./task-projection";
import {
  TaskCompatibilityError, type ClaimedTaskCompatibility, type TaskCompatibilityAttemptOptions,
  type TaskCompatibilityFacts, type TaskCompatibilityHostPorts, type TaskCompatibilityNativePorts,
  type TaskCompatibilityProjection, type TaskCompatibilityRead, type TaskCompatibilityRef, type TaskCompatibilityResult,
} from "./task-compatibility-ports";

const achieved = (current: TaskCompatibilityProjection, patch: TaskCompatibilityProjection) =>
  Object.entries(patch).every(([key, value]) => JSON.stringify(current[key]) === JSON.stringify(value));
const fail = (code: string, outcome: "not-written" | "unconfirmed" = "not-written"): never => {
  throw new TaskCompatibilityError({ code, outcome });
};

/** One storage-free lifecycle for the retained native task writers. Hosts own
 * decoding, claims, source/privacy locks, lineage and atomic mapping ACKs. The
 * portable Google kernels are selected before entering this compatibility path. */
export async function runClaimedTaskCompatibility(claim: ClaimedTaskCompatibility, host: TaskCompatibilityHostPorts,
  native: TaskCompatibilityNativePorts, options: TaskCompatibilityAttemptOptions = {}): Promise<TaskCompatibilityResult> {
  const { action, reconciling } = claim;
  const attempt = createRuntimeAttempt(signal => host.renew(signal), options);
  let acknowledged = false;
  let facts: TaskCompatibilityFacts = { possibleDispatch: false, writerFulfilled: false };
  const record = (value: Partial<TaskCompatibilityFacts>) => {
    // Refs are host writer results, whose optional fields can be undefined.
    // Do not introduce a new native JSON parser at that durability boundary.
    facts = Object.freeze({ ...facts, ...value,
      ...(value.resultRef ? { resultRef: Object.freeze({ ...value.resultRef }) } : {}),
      ...(value.acknowledgementProjection === undefined ? {} : {
        acknowledgementProjection: copyNativeTaskEvidence(jsonTaskProjection(value.acknowledgementProjection)),
      }),
    });
  };
  const mark = async () => {
    attempt.guard();
    if (!await host.beforeMutation(attempt.signal)) fail("task-source-read-only");
    attempt.guard(); record({ possibleDispatch: true });
  };
  try {
    return await attempt.run(async () => {
      // Capture every authority/history field before the first native await.
      // Descriptor copying refuses getters/callbacks without running them and
      // preserves rich canonical Dates instead of round-tripping through JSON.
      const prepared = copyTaskCompatibilityData(await host.prepare(attempt.signal));
      attempt.guard();
      if (prepared.kind !== "ready") {
        await host.finish({ ...prepared, facts });
        return { status: "finished", facts };
      }
      // Snapshot native JSON without v1 admission limits. Neither old saved
      // masks nor large/unproven-UID/recurring v0 tasks are re-encoded here.
      const target = copyNativeTaskEvidence(prepared.target);
      let saved = prepared.saved && copyNativeTaskEvidence(prepared.saved);
      const expected = copyNativeTaskEvidence(prepared.paired.ref);
      let ref: TaskCompatibilityRef | undefined = expected.externalTaskId ? Object.freeze({
        ...expected, externalTaskId: expected.externalTaskId,
      }) : undefined;
      const acknowledge = async (evidence: TaskCompatibilityRead | null, deletionRef?: TaskCompatibilityRef) => {
        attempt.guard();
        if (evidence) record({ resultRef: { ...evidence.ref }, acknowledgementProjection: evidence.projection });
        else if (deletionRef) record({ resultRef: { ...deletionRef } });
        if (!await host.ack(evidence, deletionRef, expected, attempt.signal))
          fail("task-write-failed", reconciling || facts.possibleDispatch || facts.writerFulfilled ? "unconfirmed" : "not-written");
        // A committed host ACK remains authoritative if its signal then expires.
        acknowledged = true;
      };
      if (action === "create" && reconciling) {
        ref = prepared.recovery.ref;
        if (!ref) fail("task-create-unconfirmed", "unconfirmed");
        const observed = await native.read(ref!, attempt.signal);
        if (!observed || !sameTaskProjection(observed.projection, target)) fail("task-create-unconfirmed", "unconfirmed");
        await acknowledge(observed);
        return { status: "acknowledged", facts };
      }
      const current = ref ? await native.read(ref, attempt.signal) : null;
      if (action === "delete" && !current) {
        await acknowledge(null, ref);
        return { status: "acknowledged", facts };
      }
      if (action !== "create" && !ref) fail("task-version-unavailable");
      if (action === "update" && !current) fail("task-provider-conflict");
      if (!saved) {
        let baseline = prepared.projectionBaseline ?? current?.projection ?? null;
        if (prepared.paired.hasPredecessor) baseline = prepared.paired.projectionBaseline ?? baseline;
        saved = copyNativeTaskEvidence({ version: 1 as const, projection: target, baseline,
          patch: baseline ? diffTaskProjection(baseline, target) : target });
        attempt.guard();
        if (!await host.saveProjection(saved, attempt.signal)) fail("task-projection-unavailable");
      }
      // Preserve the legacy order: read, save mask, recovery achieved, current
      // dispatch permission, original pair, native preflight, empty-mask ACK.
      if (action === "update" && reconciling && current && achieved(current.projection, saved.patch)) {
        await acknowledge(current);
        return { status: "acknowledged", facts };
      }
      if (!prepared.dispatchAllowed) {
        attempt.guard(); await host.finish({ kind: "not-needed", current, facts });
        return { status: "finished", facts };
      }
      if (current && (current.ref.etag !== ref?.etag || saved.baseline && !sameTaskProjection(current.projection, saved.baseline))) fail("task-provider-conflict");
      attempt.guard();
      await native.preflight({ action, task: copyTaskCompatibilityData(prepared.task, false), external: ref, projection: target,
        secondary: prepared.authority === "secondary" }, attempt.signal);
      attempt.guard();
      if (action === "update" && !Object.keys(saved.patch).length && current) {
        await acknowledge(current);
        return { status: "acknowledged", facts };
      }
      if (action === "create") {
        const written = await native.create(copyTaskCompatibilityData(prepared.task, false), mark, attempt.signal);
        record({ resultRef: written, writerFulfilled: true });
      } else if (action === "delete") {
        await native.delete(ref!, mark, attempt.signal);
        record({ writerFulfilled: true });
        await acknowledge(null, ref);
        return { status: "acknowledged", facts };
      } else {
        const written = await native.update(copyTaskCompatibilityData(prepared.task, false), ref!, saved.patch, mark, attempt.signal);
        record({ resultRef: { ...ref!, ...written }, writerFulfilled: true });
      }
      // The complete writer return is captured before discovering cancellation,
      // preserving the API's historical durable response-address boundary.
      attempt.guard();
      const observed = await native.read(facts.resultRef!, attempt.signal);
      if (!observed || !achieved(observed.projection, saved.patch)) fail("task-write-failed", "unconfirmed");
      await acknowledge(observed);
      return { status: "acknowledged", facts };
    });
  } catch (cause) {
    if (acknowledged) return { status: "acknowledged", facts };
    const error = cause instanceof TaskCompatibilityError ? cause.info : host.classifyError(cause);
    await host.finish({ kind: "failed", error, cause, facts });
    return { status: "finished", facts };
  } finally { attempt.close(); }
}
