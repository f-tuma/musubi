// Runnable authorization regression check (no test framework):
// `pnpm --filter @musubi/api exec tsx src/handlers/calendars.test.ts`
import assert from "node:assert";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.ENVIRONMENT ??= "dev";
process.env.BETTER_AUTH_URL ??= "http://localhost:7531";

async function main() {
  const { getCalendarDetailsForUser } = await import("./calendars");

  let calendarReads = 0;
  let memberReads = 0;

  const nonMemberDependencies = {
    getUserRoleForCalendar: async () => null,
    getCalendar: async () => {
      calendarReads += 1;
      return { id: "private-calendar" };
    },
    getCalendarMembers: async () => {
      memberReads += 1;
      return [];
    },
  };

  await assert.rejects(
    () => getCalendarDetailsForUser(
      "unrelated-user",
      "private-calendar",
      nonMemberDependencies as any,
    ),
    (error: any) =>
      error?.kind === "Forbidden"
      && error?.message === "You're not a member of this calendar.",
  );
  assert.equal(calendarReads, 0, "non-members must not read calendar details");
  assert.equal(memberReads, 0, "non-members must not read calendar members");

  let missingCalendarMemberReads = 0;
  await assert.rejects(
    () => getCalendarDetailsForUser(
      "member",
      "missing-calendar",
      {
        getUserRoleForCalendar: async () => "viewer",
        getCalendar: async () => undefined,
        getCalendarMembers: async () => {
          missingCalendarMemberReads += 1;
          return [];
        },
      } as any,
    ),
    (error: any) => error?.kind === "NotFound",
  );
  assert.equal(
    missingCalendarMemberReads,
    0,
    "a missing calendar must not trigger a member-list read",
  );

  const details = await getCalendarDetailsForUser(
    "member",
    "shared-calendar",
    {
      getUserRoleForCalendar: async () => "viewer",
      getCalendar: async () => ({
        id: "shared-calendar",
        name: "Shared",
        color: "#c8553d",
      }),
      getCalendarMembers: async () => [{
        user: {
          id: "member",
          name: "Member",
          email: "member@example.com",
        },
      }],
    } as any,
  );
  assert.deepEqual(details, {
    id: "shared-calendar",
    name: "Shared",
    color: "#c8553d",
    members: [{
      id: "member",
      name: "Member",
      email: "member@example.com",
    }],
  });

  console.log("calendar detail authorization self-check: OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
