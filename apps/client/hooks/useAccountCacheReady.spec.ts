import { beforeEach, expect, it, vi } from "vitest";
import { useAccountCacheReady } from "./useAccountCacheReady";

const h = vi.hoisted(() => ({
  slots: [] as any[], cursor: 0, effects: [] as (() => void)[],
  requests: [] as { owner: string | null; resolve: () => void; reject: (error: Error) => void }[],
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useMemo: (factory: () => unknown, deps: unknown[]) => {
    const index = h.cursor++, previous = h.slots[index];
    if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) h.slots[index] = { value: factory(), deps };
    return h.slots[index].value;
  },
  useState: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.slots)) h.slots[index] = initial;
    return [h.slots[index], (value: unknown) => { h.slots[index] = value; }];
  },
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = h.cursor++, previous = h.slots[index];
    if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
      const next = { deps, cleanup: undefined as undefined | (() => void) };
      h.slots[index] = next;
      h.effects.push(() => { previous?.cleanup?.(); next.cleanup = effect() ?? undefined; });
    }
  },
}));
vi.mock("expo-secure-store", () => ({}));
vi.mock("@/lib/signOut", () => ({ resetLocalAccountState: vi.fn() }));
vi.mock("@/lib/accountCache", async original => ({
  ...await original<typeof import("@/lib/accountCache")>(),
  prepareAccountCache: (owner: string | null) => new Promise<void>((resolve, reject) => { h.requests.push({ owner, resolve, reject }); }),
}));

type Account = Parameters<typeof useAccountCacheReady>[0];
const account = { apiUrl: "https://home.example.test", userId: "account-a", isPending: false, migrated: true };
function HookHost(props: Account) { return useAccountCacheReady(props); }
function render(props: Account = account) {
  h.cursor = 0;
  const ready = HookHost(props);
  h.effects.splice(0).forEach(effect => effect());
  return ready;
}
function unmount() { h.slots.forEach(slot => slot?.cleanup?.()); }
async function settle() { for (let i = 0; i < 6; i++) await Promise.resolve(); }
beforeEach(() => { h.slots = []; h.cursor = 0; h.effects = []; h.requests = []; });

it("waits for SQL migration and a resolved session before preparing any owner", async () => {
  expect(render({ ...account, migrated: false })).toBe(false);
  expect(render({ ...account, isPending: true })).toBe(false);
  expect(h.requests).toEqual([]);
  expect(render()).toBe(false);
  h.requests[0].resolve(); await settle();
  expect(render()).toBe(true);
  // Pending session transitions close an already-ready Stack as well.
  expect(render({ ...account, isPending: true })).toBe(false);
  expect(render()).toBe(false);
  h.requests[1].resolve(); await settle();
  expect(render()).toBe(true);
  unmount();
});

it("never opens a replacement account when the retired owner's cleanup resolves", async () => {
  expect(render()).toBe(false);
  const replacement = { ...account, userId: "account-b" };
  expect(render(replacement)).toBe(false);
  h.requests[0].resolve(); await settle();
  expect(render(replacement)).toBe(false);
  h.requests[1].resolve(); await settle();
  expect(render(replacement)).toBe(true);
  unmount();
});

it("waits again for A after an A to B to A round trip instead of reusing old readiness", async () => {
  render(); h.requests[0].resolve(); await settle(); expect(render()).toBe(true);
  expect(render({ ...account, userId: "account-b" })).toBe(false);
  expect(render()).toBe(false);
  h.requests[1].resolve(); await settle(); expect(render()).toBe(false);
  h.requests[2].resolve(); await settle(); expect(render()).toBe(true);
  unmount();
});

it("prepares signed-out storage before welcome and then prepares B before tabs", async () => {
  render(); h.requests[0].resolve(); await settle(); expect(render()).toBe(true);
  const expired = { ...account, userId: undefined };
  expect(render(expired)).toBe(false); expect(h.requests[1].owner).toBeNull();
  h.requests[1].resolve(); await settle(); expect(render(expired)).toBe(true);
  const replacement = { ...account, userId: "account-b" };
  expect(render(replacement)).toBe(false);
  h.requests[2].resolve(); await settle(); expect(render(replacement)).toBe(true);
  unmount();
});

it("keeps the current scope closed after cleanup failure and ignores unmounted callbacks", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  render(); h.requests[0].reject(new Error("cleanup failed")); await settle();
  expect(render()).toBe(false); expect(log).toHaveBeenCalledOnce();
  render({ ...account, userId: "account-b" }); unmount();
  h.requests[1].resolve(); await settle();
  expect(h.slots[1]).toBeNull();
  log.mockRestore();
});
