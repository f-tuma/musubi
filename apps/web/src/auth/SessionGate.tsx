import {
  Outlet,
  useLocation,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { AnnouncementGate } from "~/calendar/components/AnnouncementDialog";
import { signOutAndReset } from "~/offline/sign-out";
import { RouteState } from "~/components/route-state";
import { AUTH_EXPIRED_EVENT, authClient } from "./auth-client";
import { useSessionUser } from "./use-session-user";

export function SessionGate() {
  const session = authClient.useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const redirecting = useRef(false);
  // The session cannot be confirmed with no network, and treating that as "not
  // signed in" would send someone with a perfectly good cookie to the login
  // page — where there is nothing to log in against either. The last known
  // account stands in; the server decides again the moment it can be reached.
  const { fromSnapshot } = useSessionUser();
  const offlineSession = !session.data && fromSnapshot;

  useEffect(() => {
    function refreshSession() {
      // A 401 can mean a cookie that only needed re-reading, or a session that is
      // genuinely over. Ask the server which, because only the second is a
      // departure — and then the cache and the snapshot belong to nobody, so
      // they go the same way as on a deliberate sign-out. A request that fails
      // outright answers neither question and is left to the offline path.
      void authClient
        .getSession()
        .then((result) => {
          // Better Auth resolves HTTP failures with { data: null, error }.
          // Only an explicit 401 or a successful empty response confirms that
          // the session is gone; a failed check must not erase local state.
          if (result.error && result.error.status !== 401) return;
          return result.data
            ? session.refetch()
            : signOutAndReset({ queryClient });
        })
        .catch(() => undefined)
        .finally(() => router.invalidate());
    }

    window.addEventListener(AUTH_EXPIRED_EVENT, refreshSession);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, refreshSession);
  }, [queryClient, router, session]);

  useEffect(() => {
    if (
      session.isPending ||
      session.data ||
      offlineSession ||
      redirecting.current
    ) {
      return;
    }

    redirecting.current = true;
    void navigate({
      replace: true,
      search: { redirect: `${location.pathname}${location.searchStr}` },
      to: "/login",
    });
  }, [
    location.pathname,
    location.searchStr,
    navigate,
    offlineSession,
    session.data,
    session.isPending,
  ]);

  if (session.isPending) {
    return (
      <RouteState busy title="Opening your calendar…" />
    );
  }

  // Offline with a known account: the calendar renders from its snapshot rather
  // than a dead end.
  if (offlineSession) {
    return <Outlet />;
  }

  if (!session.data) {
    return (
      <RouteState busy title="Taking you to sign in…" />
    );
  }

  return (
    <>
      <AnnouncementGate />
      <Outlet />
    </>
  );
}
