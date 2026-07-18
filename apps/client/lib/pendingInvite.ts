import * as SecureStore from "expo-secure-store";

const PENDING_INVITE_KEY = "musubi_pending_invite";

export type PendingInvite = {
  token: string;
  server?: string;
};

function validPendingInvite(value: unknown): value is PendingInvite {
  if (!value || typeof value !== "object") return false;
  const invite = value as Record<string, unknown>;
  return typeof invite.token === "string" && invite.token.length > 0
    && (invite.server === undefined || typeof invite.server === "string");
}

export async function rememberPendingInvite(invite: PendingInvite) {
  await SecureStore.setItemAsync(PENDING_INVITE_KEY, JSON.stringify(invite));
}

export async function takePendingInviteHref(): Promise<string | null> {
  try {
    const raw = await SecureStore.getItemAsync(PENDING_INVITE_KEY);
    if (!raw) return null;

    await SecureStore.deleteItemAsync(PENDING_INVITE_KEY);
    const invite: unknown = JSON.parse(raw);
    if (!validPendingInvite(invite)) return null;

    const query = new URLSearchParams({
      ...(invite.server ? { server: invite.server } : {}),
      afterAuth: "1",
    });
    return `/invite/${encodeURIComponent(invite.token)}?${query.toString()}`;
  } catch (error) {
    console.warn("Could not restore the pending invitation:", error);
    return null;
  }
}
