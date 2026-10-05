import { describe, expect, it, vi } from "vitest";
import { expoClient } from "@better-auth/expo/client";
import { authCookiePrefixes } from "./authCookiePrefixes";
import { serverStoragePrefix } from "./serverUrl";
vi.mock("react-native", () => ({ Platform: { OS: "android" }, AppState: { addEventListener: vi.fn(() => ({remove: vi.fn()})) } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { scheme: "musubi" } } }));
vi.mock("expo-linking", () => ({ createURL: (path: string) => `musubi://${path}` }));
vi.mock("expo-network", () => ({ addNetworkStateListener: vi.fn(() => ({remove: vi.fn()})) }));

describe("Expo QA session persistence", () => {
  it("persists a custom-prefix sign-in cookie and sends it on protected API requests", async () => {
    const values = new Map<string, string>();
    const plugin = expoClient({ scheme: "musubi", cookiePrefix: authCookiePrefixes(true, "musubi-ui-qa"), storagePrefix: "qa",
      storage: {getItem: key => values.get(key) ?? null, setItem: (key, value) => {values.set(key, value);} } });
    const fetchPlugin = plugin.fetchPlugins![0];
    await fetchPlugin.hooks!.onSuccess!({ response: new Response("{}", {headers: {"set-cookie": "musubi-ui-qa.session_token=synthetic-test-token; Path=/; Max-Age=3600; HttpOnly"}}), request: {url: "http://localhost:7531/api/auth/sign-in/email"}, data: {} } as never);
    const request = await fetchPlugin.init!("http://localhost:7531/api/v1/events", {});
    expect(request!.options!.headers).toMatchObject({cookie: "musubi-ui-qa.session_token=synthetic-test-token"});
  });
});


describe("production auth session origin boundary", () => {
  const origin = "https://api.example.com";
  function client(storage: Map<string, string>, url = origin, prefix = serverStoragePrefix(url)) {
    return expoClient({ scheme: "musubi", cookiePrefix: authCookiePrefixes(false), storagePrefix: prefix,
      storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); } } }).fetchPlugins![0];
  }
  async function signIn(plugin: ReturnType<typeof client>) {
    await plugin.hooks!.onSuccess!({
      response: new Response("{}", { headers: { "set-cookie": "better-auth.session_token=synthetic-origin-cookie; Path=/; Max-Age=3600; HttpOnly" } }),
      request: { url: `${origin}/api/auth/sign-in/email` }, data: {},
    } as never);
  }
  function requestCookie(headers: unknown) {
    if (headers instanceof Headers) return headers.get("cookie");
    return headers && typeof headers === "object" && "cookie" in headers && typeof headers.cookie === "string" ? headers.cookie : null;
  }
  async function cookie(plugin: ReturnType<typeof client>, url: string) {
    return requestCookie((await plugin.init!(url, {}))!.options!.headers);
  }

  it("restores the same-origin cookie after restart and never sends it to a formerly colliding origin", async () => {
    const storage = new Map<string, string>();
    await signIn(client(storage));
    expect(await cookie(client(storage), `${origin}/api/v1/events`)).toBe("better-auth.session_token=synthetic-origin-cookie");
    for (const otherOrigin of ["https://api-example.com", "http://api.example.com", "https://api.example.com:7531"])
      expect(await cookie(client(storage, otherOrigin), `${otherOrigin}/api/v1/events`)).toBeNull();
    expect(await cookie(client(storage), `${origin}/api/v1/events`)).toBe("better-auth.session_token=synthetic-origin-cookie");
  });

  it("clears the persisted cookie during logout, including a subsequent restart", async () => {
    const storage = new Map<string, string>();
    const plugin = client(storage);
    await signIn(plugin);
    const logout = await plugin.init!(`${origin}/api/auth/sign-out`, { method: "POST" });
    expect(requestCookie(logout!.options!.headers)).toBe("better-auth.session_token=synthetic-origin-cookie");
    expect(await cookie(client(storage), `${origin}/api/v1/events`)).toBeNull();
  });

  it("never imports an ambiguous legacy credential into the new namespace", async () => {
    const storage = new Map<string, string>();
    await signIn(client(storage, origin, "musubi_api_example_com"));
    expect(await cookie(client(storage), `${origin}/api/v1/events`)).toBeNull();
    expect(await cookie(client(storage, "https://api-example.com"), "https://api-example.com/api/v1/events")).toBeNull();
  });
});
