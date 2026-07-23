import assert from "node:assert/strict";
import { z } from "zod";
import { BadRequestError } from "@musubi/types";
import { httpErrorFor } from "./middleware/http_error";
import { optionalDateQuery, requireUUID } from "./request_validation";

const uuid = "018f3f7e-2b4a-7cc1-9a2e-8e8c44ad9130";

assert.equal(requireUUID(uuid, "eventId"), uuid);
assert.throws(
  () => requireUUID("not-a-uuid", "eventId"),
  (error: unknown) => error instanceof BadRequestError && error.message === "eventId must be a valid UUID.",
);

assert.equal(optionalDateQuery(undefined, "since"), undefined);
assert.equal(
  optionalDateQuery("2026-07-23T12:00:00.000Z", "since")?.toISOString(),
  "2026-07-23T12:00:00.000Z",
);
for (const malformed of ["not-a-date", "", ["2026-07-23T12:00:00.000Z"]]) {
  assert.throws(
    () => optionalDateQuery(malformed, "since"),
    (error: unknown) => error instanceof BadRequestError && error.message === "since must be a valid timestamp.",
  );
}

const malformedBody = z.object({ id: z.string().uuid() }).safeParse({ id: "nope" });
assert.equal(malformedBody.success, false);
if (!malformedBody.success) {
  assert.deepEqual(httpErrorFor(malformedBody.error), {
    statusCode: 400,
    errorMessage: "Request contains invalid data.",
  });
}
assert.deepEqual(httpErrorFor(new BadRequestError("Invalid request.")), {
  statusCode: 400,
  errorMessage: "Invalid request.",
});
assert.deepEqual(httpErrorFor(new Error("boom")), {
  statusCode: 500,
  errorMessage: "500 - Internal Server Error",
});

console.log("request validation self-check: OK");
