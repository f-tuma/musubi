import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { handlerStream, notifyCalendarMembers, sseStats } from "./stream";

class FakeResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  headers = new Map<string, string>();
  writes: string[] = [];

  setHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value);
  }
  flushHeaders() {}
  write(value: string) {
    this.writes.push(value);
    return true;
  }
  end() {
    if (this.writableEnded) return;
    this.writableEnded = true;
    this.emit("close");
  }
}

const req = new EventEmitter() as EventEmitter & { user: { id: string; isExternal: boolean } };
req.user = { id: "stream-user", isExternal: true };
const res = new FakeResponse();
let heartbeat: (() => void) | undefined;
let intervals = 0;
let cleared = false;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

globalThis.setInterval = ((callback: () => void, delay?: number) => {
  assert.equal(delay, 25_000);
  intervals += 1;
  heartbeat = callback;
  return 1 as unknown as NodeJS.Timeout;
}) as typeof setInterval;
globalThis.clearInterval = ((timer: NodeJS.Timeout) => {
  assert.equal(timer, 1);
  cleared = true;
}) as typeof clearInterval;

async function main() {
  try {
    await handlerStream(req as unknown as Request, res as unknown as Response);

    assert.equal(res.headers.get("content-type"), "text/event-stream");
    assert.equal(res.headers.get("cache-control"), "no-cache, no-transform");
    assert.equal(res.headers.get("connection"), "keep-alive");
    assert.equal(res.headers.get("x-accel-buffering"), "no");
    assert.deepEqual(res.writes, ["retry: 3000\n\n"]);
    assert.deepEqual(sseStats(), { connections: 1, federatedUpstream: 0, users: 1 });

    heartbeat!();
    notifyCalendarMembers([req.user.id], "event_updated", { id: "event-1" });
    assert.deepEqual(res.writes, [
      "retry: 3000\n\n",
      ": ping\n\n",
      'data: {"type":"event_updated","payload":{"id":"event-1"}}\n\n',
    ]);
    // Metadata does not widen the targeted audience, and legacy frames without
    // a known actor remain valid for clients that only invalidate their cache.
    const before = res.writes.length;
    notifyCalendarMembers(["another-user"], "event_updated", { id: "private", actorID: "actor" });
    assert.equal(res.writes.length, before);
    notifyCalendarMembers([req.user.id], "event_updated", { id: "event-1", revision: 2, actorID: "actor" });
    assert.equal(res.writes.at(-1), 'data: {"type":"event_updated","payload":{"id":"event-1","revision":2,"actorID":"actor"}}\n\n');

    req.emit("aborted");
    assert.equal(cleared, true);
    assert.equal(res.writableEnded, true);
    assert.deepEqual(sseStats(), { connections: 0, federatedUpstream: 0, users: 0 });

    const abortedReq = new EventEmitter() as EventEmitter & {
      aborted: boolean;
      user: { id: string; isExternal: boolean };
    };
    abortedReq.aborted = true;
    abortedReq.user = { id: "aborted-user", isExternal: true };
    const abortedRes = new FakeResponse();
    await handlerStream(abortedReq as unknown as Request, abortedRes as unknown as Response);
    assert.equal(intervals, 1);
    assert.equal(abortedRes.headers.size, 0);
    assert.deepEqual(sseStats(), { connections: 0, federatedUpstream: 0, users: 0 });
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }

  console.log("SSE heartbeat self-check: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
