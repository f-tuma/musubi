import { beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const fixture = vi.hoisted(() => ({ params: {} as Record<string, string>, signedIn: true, href: undefined as unknown }));
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => fixture.params,
  Redirect: ({ href }: { href: unknown }) => { fixture.href = href; return null; },
}));
vi.mock("@/contexts/ServerContext", () => ({ useServer: () => ({ authClient: {
  useSession: () => ({ data: fixture.signedIn ? { user: { id: "owner" } } : null }),
} }) }));
const { default: Index } = await import("../app/index");
beforeEach(() => { fixture.params = {}; fixture.signedIn = true; fixture.href = undefined; });

const links: Record<string, string>[] = [
  { widgetAdd: "1" }, { widgetRefresh: "1" }, { time: "1791280800000" }, { calendarWidgetId: "12" },
  { view: "agenda", eventId: "canonical-event", occurrenceStart: "1791280800000" },
];
it.each(links)("preserves the native widget action through the root redirect: %j", params => {
  fixture.params = params;
  renderToStaticMarkup(createElement(Index));
  expect(fixture.href).toEqual({ pathname: "/(tabs)", params });
});
it("keeps a signed-out widget link behind authentication", () => {
  fixture.signedIn = false; fixture.params = { widgetAdd: "1" };
  renderToStaticMarkup(createElement(Index));
  expect(fixture.href).toBe("/(auth)/welcome");
});
