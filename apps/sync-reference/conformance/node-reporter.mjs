// Node's structured reporter is a test dependency port, never a sync implementation.
export default async function* report(source) {
  const cases = [], supplemental = [], passedLogCases = [], completionMarkers = [];
  let skipped = 0, todo = 0, failures = 0;
  for await (const event of source) {
    const data = event.data ?? {};
    if (["test:pass", "test:fail"].includes(event.type)) {
      const skip = Boolean(data.skip), pending = Boolean(data.todo);
      skipped += Number(skip); todo += Number(pending); failures += Number(event.type === "test:fail");
      cases.push({ name: typeof data.name === "string" ? data.name.slice(0, 256) : "invalid-name", status: event.type === "test:pass" ? "passed" : "failed", skipped: Number(skip), todo: Number(pending) });
    }
    if (event.type === "test:stdout" && typeof data.message === "string") {
      for (const line of data.message.split("\n")) {
        if (/^SYNC_CONFORMANCE_COMPLETE:[a-z0-9/_.:-]{1,199}$/.test(line.trim())) completionMarkers.push(line.trim());
        const label = /^(?:PASS (.+)|Reference[^]*?: (.+): PASS)$/.exec(line.trim()); if (label) passedLogCases.push(label[1] ?? label[2]);
        try { const value = JSON.parse(line); if (value?.schemaVersion === 1 && value.suite === "reference-cross-account") supplemental.push(value); } catch { /* Unstructured diagnostics are not proof. */ }
      }
    }
  }
  yield `${JSON.stringify({ schemaVersion: 1, kind: "sync-conformance-node-result", cases, skipped, todo, failures, supplemental, passedLogCases, completionMarkers })}\n`;
}
