import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

const enabled = process.env.RADICALE_E2E === "true";
const radicaleUrl = process.env.RADICALE_URL ?? "http://127.0.0.1:5232/";
const radicaleUsername = process.env.RADICALE_USERNAME ?? "musubi";
const radicalePassword =
  process.env.RADICALE_PASSWORD ?? "musubi-radicale-test";
const collectionID = crypto.randomUUID();
const collectionName = `Musubi E2E Tasks ${collectionID.slice(0, 8)}`;
const collectionUrl = new URL(
  `${radicaleUsername}/musubi-ui-${collectionID}/`,
  radicaleUrl,
).href;
const authorization = `Basic ${Buffer.from(
  `${radicaleUsername}:${radicalePassword}`,
).toString("base64")}`;

async function davRequest(
  request: APIRequestContext,
  method: string,
  body?: string,
) {
  return request.fetch(collectionUrl, {
    data: body,
    headers: {
      authorization,
      ...(body ? { "content-type": "application/xml; charset=utf-8" } : {}),
    },
    method,
  });
}

async function readTasks(request: APIRequestContext) {
  const response = await davRequest(
    request,
    "REPORT",
    `<?xml version="1.0" encoding="utf-8" ?>
<c:calendar-query xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:d="DAV:">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter>
</c:calendar-query>`,
  );
  expect(response.status()).toBe(207);
  return response.text();
}

async function chooseOption(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { exact: true, name: option }).click();
}

test.skip(!enabled, "Set RADICALE_E2E=true and run through the local harness.");

test("round-trips a Task Page edit through API, Postgres and Radicale", async ({
  page,
  request,
}) => {
  const createCollection = await davRequest(
    request,
    "MKCALENDAR",
    `<?xml version="1.0" encoding="utf-8" ?>
<c:mkcalendar xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:d="DAV:">
  <d:set><d:prop>
    <d:displayname>${collectionName}</d:displayname>
    <c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>
  </d:prop></d:set>
</c:mkcalendar>`,
  );
  expect(createCollection.status()).toBe(201);

  try {
    const email = `task-e2e-${crypto.randomUUID()}@example.test`;
    await page.goto("/login");
    // SSR exposes the controls before React owns them; an early click would
    // trigger a native navigation and leave the sign-up state unchanged.
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Create one" }).click();
    await page.getByLabel("Name").fill("Task E2E");
    await page.getByLabel("Email").fill(email);
    await page
      .getByLabel("Passphrase", { exact: true })
      .fill("task-e2e-password");
    await page.getByLabel("Confirm passphrase").fill("task-e2e-password");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(
      page.getByRole("heading", { level: 1, name: "Welcome to Musubi" }),
    ).toBeVisible();
    await page.getByLabel("Your name").fill("Task E2E");
    await page.getByRole("button", { exact: true, name: "Continue" }).click();
    await page.getByLabel("Calendar name").fill("Personal");
    await page.getByRole("button", { exact: true, name: "Continue" }).click();
    await page.getByRole("button", { name: "Skip for now" }).click();

    await page.getByRole("button", { name: "Connections" }).click();
    const connections = page.getByRole("dialog", { name: "Settings" });
    await connections
      .getByRole("button", { name: "CalDAV", exact: true })
      .click();
    const caldav = page.getByRole("dialog", { name: "Connect CalDAV" });
    await caldav.getByLabel("Server address").fill(radicaleUrl);
    await caldav.getByLabel("Username").fill(radicaleUsername);
    await caldav.getByLabel("Password").fill(radicalePassword);
    await caldav
      .getByRole("button", { name: "Connect", exact: true })
      .click();
    await expect(page.getByText("Calendar connected.")).toBeVisible();
    await connections
      .getByRole("button", { name: "Close settings" })
      .click();

    await page.getByRole("radio", { name: "Tasks" }).click();
    await expect(page.getByRole("region", { name: "Tasks" })).toBeVisible();
    await page.getByRole("button", { name: "Create event, meeting or task" }).click();
    await page.getByRole("menuitem", { name: "Task" }).click();

    const createDialog = page.getByRole("dialog", { name: "New task" });
    await createDialog.getByLabel("Title").fill("E2E CalDAV task");
    await chooseOption(page, "Calendar", collectionName);
    await createDialog
      .getByLabel("Notes")
      .fill("Created through the Task Page and stored as VTODO.");
    await createDialog.getByRole("button", { name: "Save task" }).click();
    const taskButton = (title: string) =>
      page.getByRole("button", {
        exact: true,
        name: `${title} ${collectionName}`,
      });
    await expect(taskButton("E2E CalDAV task")).toBeVisible();

    await expect
      .poll(async () => readTasks(request))
      .toContain("SUMMARY:E2E CalDAV task");

    await taskButton("E2E CalDAV task").click();
    const editDialog = page.getByRole("dialog", { name: "Edit task" });
    await editDialog.getByLabel("Title").fill("E2E CalDAV task updated");
    await chooseOption(page, "Status", "In progress");
    await chooseOption(page, "Priority", "3");
    await editDialog.getByRole("button", { name: "Save task" }).click();
    await expect(taskButton("E2E CalDAV task updated")).toBeVisible();

    await expect
      .poll(async () => readTasks(request))
      .toContain("SUMMARY:E2E CalDAV task updated");
    await expect.poll(async () => readTasks(request)).toContain("PRIORITY:3");

    const taskRow = page
      .getByRole("listitem")
      .filter({ has: taskButton("E2E CalDAV task updated") });
    const completion = taskRow.getByRole("checkbox", {
      name: "Mark E2E CalDAV task updated completed",
    });
    await completion.focus();
    await page.keyboard.press("Space");
    await expect(
      page.getByRole("checkbox", {
        name: "Mark E2E CalDAV task updated open",
      }),
    ).toBeChecked();
    await expect
      .poll(async () => readTasks(request))
      .toContain("STATUS:COMPLETED");

    await taskButton("E2E CalDAV task updated").click();
    await page
      .getByRole("dialog", { name: "Edit task" })
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(taskButton("E2E CalDAV task updated")).toHaveCount(0);
    await expect
      .poll(async () => readTasks(request))
      .not.toContain("E2E CalDAV task updated");
  } finally {
    const cleanup = await davRequest(request, "DELETE");
    expect([200, 404]).toContain(cleanup.status());
  }
});
