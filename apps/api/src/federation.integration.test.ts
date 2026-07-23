import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { Request, Response } from "express";
import {
  calendarInvites,
  calendarMembers,
  calendars,
  db,
  deleteExpiredMemberTokens,
  getUserRoleForCalendar,
  getUserByTokenHash,
  memberTokens,
  removeCalendarMember,
  replaceMemberToken,
  rotateMemberToken,
  user,
} from "@musubi/db";
import { MEMBER_TOKEN_TTL_MS } from "@musubi/types";
import { hashMemberToken } from "./federation_tokens";
import { handlerFederationAccept } from "./handlers/federation";

async function acceptInvite(
  token: string,
  authorization?: string,
) {
  let statusCode = 0;
  let payload: any;
  const req = {
    body: {
      token,
      profile: {
        name: "Claimed federation profile",
        email: "",
        homeServer: "https://home.example.test",
      },
    },
    headers: authorization ? { authorization } : {},
  } as Request;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      payload = body;
      return this;
    },
  } as unknown as Response;
  return {
    run: async (email: string) => {
      req.body.profile.email = email;
      await handlerFederationAccept(req, res);
      return { statusCode, payload };
    },
  };
}

async function main() {
  if (process.env.ENVIRONMENT !== "test") {
    throw new Error("Refusing to run federation DB integration test unless ENVIRONMENT=test");
  }

  const suffix = randomUUID();
  const ownerID = `federation-owner-${suffix}`;
  const externalID = `federation-shadow-${suffix}`;
  const calendarA = randomUUID();
  const calendarB = randomUUID();
  const oldHash = hashMemberToken(`expired-${suffix}`);
  const currentHash = hashMemberToken(`current-${suffix}`);
  const rotatedHash = hashMemberToken(`rotated-${suffix}`);
  let isolatedShadowID: string | undefined;

  await db.insert(user).values([
    {
      id: ownerID,
      name: "Federation test owner",
      email: `${ownerID}@example.test`,
    },
    {
      id: externalID,
      name: "Federation test shadow",
      email: `${externalID}@example.test`,
      isExternal: true,
      homeServer: "https://home.example.test",
    },
  ]);

  try {
    await db.insert(calendars).values([
      { id: calendarA, creatorID: ownerID, name: "Federation A", color: "#111111" },
      { id: calendarB, creatorID: ownerID, name: "Federation B", color: "#222222" },
    ]);
    await db.insert(calendarMembers).values([
      { userID: externalID, calendarID: calendarA, role: "viewer" },
    ]);
    const inviteID = randomUUID();
    await db.insert(calendarInvites).values({
      id: inviteID,
      calendarID: calendarB,
      expiresAt: new Date(Date.now() + 60_000),
      maxUses: 5,
    });

    await db.insert(memberTokens).values({
      userID: externalID,
      tokenHash: oldHash,
      createdAt: new Date(Date.now() - MEMBER_TOKEN_TTL_MS - 60_000),
    });
    assert.equal(await getUserByTokenHash(oldHash), null);
    await deleteExpiredMemberTokens();
    assert.equal(
      (await db.select().from(memberTokens).where(eq(memberTokens.tokenHash, oldHash))).length,
      0,
    );

    await replaceMemberToken(externalID, currentHash);
    assert.equal((await getUserByTokenHash(currentHash))?.id, externalID);

    assert.ok(await rotateMemberToken(externalID, currentHash, rotatedHash));
    assert.equal(await getUserByTokenHash(currentHash), null);
    assert.equal((await getUserByTokenHash(rotatedHash))?.id, externalID);
    assert.equal(
      await rotateMemberToken(externalID, currentHash, hashMemberToken(`race-${suffix}`)),
      null,
    );

    // Claiming the existing shadow's unverified profile without its member
    // token creates an isolated identity; it cannot inherit calendar A.
    const unproved = await (await acceptInvite(inviteID))
      .run(`${externalID}@example.test`);
    isolatedShadowID = unproved.payload.userID;
    assert.equal(unproved.statusCode, 200);
    assert.notEqual(isolatedShadowID, externalID);
    assert.equal(await getUserRoleForCalendar(isolatedShadowID!, calendarA), null);
    assert.equal(await getUserRoleForCalendar(isolatedShadowID!, calendarB), "viewer");
    assert.equal((await getUserByTokenHash(rotatedHash))?.id, externalID);

    // Presenting the current credential proves control and safely reuses the
    // existing shadow. Accept also replaces the old credential.
    const proved = await (await acceptInvite(
      inviteID,
      `Bearer rotated-${suffix}`,
    )).run(`${externalID}@example.test`);
    assert.equal(proved.statusCode, 200);
    assert.equal(proved.payload.userID, externalID);
    assert.equal(await getUserRoleForCalendar(externalID, calendarB), "viewer");
    assert.equal(await getUserByTokenHash(rotatedHash), null);
    const acceptedHash = hashMemberToken(proved.payload.memberToken);
    assert.equal((await getUserByTokenHash(acceptedHash))?.id, externalID);

    await removeCalendarMember(externalID, calendarA);
    assert.equal((await getUserByTokenHash(acceptedHash))?.id, externalID);
    await removeCalendarMember(externalID, calendarB);
    assert.equal(await getUserByTokenHash(acceptedHash), null);
  } finally {
    await db.delete(user).where(inArray(
      user.id,
      [ownerID, externalID, ...(isolatedShadowID ? [isolatedShadowID] : [])],
    ));
  }

  const leftovers = await db.select({ id: memberTokens.id })
    .from(memberTokens)
    .where(eq(memberTokens.userID, externalID));
  assert.deepEqual(leftovers, []);
  console.log("federation token lifecycle integration self-check: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
