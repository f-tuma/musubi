import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { gzipSync, deflateSync } from "node:zlib";
import express from "express";
import { createJsonBodyParser } from "../middleware/json_body";

// This process owns the listener and receives only a validated JSON fixture.
// No uncaughtException listener: a parser crash must fail the parent scenario.
async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    assert.ok(input.length <= 2048, "Child fixture exceeds its bound.");
  }
  const scenario = JSON.parse(input) as {
    encoding: "identity" | "gzip" | "deflate";
    input: "small-json" | "oversized-json" | "invalid-json";
    trailingBytes: number;
    expectedStatus: number[];
  };
  const document = { title: "Calendar 日本語", enabled: true };
  const plain = Buffer.from(scenario.input === "small-json" ? JSON.stringify(document)
    : scenario.input === "oversized-json" ? JSON.stringify({ value: "x".repeat(512 * 1024) }) : "{");
  const compressed = scenario.encoding === "gzip" ? gzipSync(plain)
    : scenario.encoding === "deflate" ? deflateSync(plain) : plain;
  const body = scenario.trailingBytes ? Buffer.concat([compressed, Buffer.from([0]), Buffer.alloc(scenario.trailingBytes, 88)]) : compressed;
  const app = express();
  let downstreamCalls = 0, parserErrors = 0;
  app.use(createJsonBodyParser());
  app.post("/parser-fixture", (req, res) => { downstreamCalls++; res.json(req.body); });
  app.get("/parser-health", (_req, res) => { res.json({ ok: true }); });
  // Observe the parser's real error port without loading DB/auth/provider modules.
  app.use((error: { statusCode?: number; type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    parserErrors++;
    res.status(error.statusCode ?? 500).json({ errorType: error.type ?? "unknown" });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  async function send(path: string, bytes?: Buffer) {
    return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: (address as { port: number }).port, path,
        method: bytes ? "POST" : "GET", agent: false,
        headers: bytes ? { "Content-Type": "application/json", "Content-Encoding": scenario.encoding, "Content-Length": bytes.length } : {},
      }, response => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", chunk => { text += chunk; if (text.length > 4096) req.destroy(new Error("Response exceeds fixture bound.")); });
        response.on("error", reject);
        response.on("end", () => {
          try { resolve({ status: response.statusCode!, body: JSON.parse(text) }); }
          catch (error) { reject(error); }
        });
      });
      req.on("error", reject);
      req.setTimeout(2000, () => req.destroy(new Error("Local parser request timed out.")));
      req.end(bytes);
    });
  }

  try {
    const response = await send("/parser-fixture", body);
    // Let pending stream callbacks run, then require another successful request.
    await new Promise(resolve => setTimeout(resolve, 100));
    const health = await send("/parser-health");
    assert.ok(scenario.expectedStatus.includes(response.status), `Unexpected HTTP status ${response.status}.`);
    assert.deepEqual(health, { status: 200, body: { ok: true } });
    if (response.status === 200) assert.deepEqual(response.body, document);
    assert.equal(downstreamCalls, response.status === 200 ? 1 : 0);
    assert.equal(parserErrors, response.status === 200 ? 0 : 1);
    process.stdout.write(`${JSON.stringify({ status: response.status, downstreamCalls, parserErrors, healthStatus: health.status })}\n`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
