import { useEffect, useMemo, useState } from "react";
import { accountCacheOwner, prepareAccountCache } from "@/lib/accountCache";

type Account = { apiUrl: string; userId?: string; isPending: boolean; migrated: boolean };

export function useAccountCacheReady({ apiUrl, userId, isPending, migrated }: Account) {
  const owner = !isPending && migrated ? accountCacheOwner(apiUrl, userId) : undefined;
  const request = useMemo(() => ({ owner }), [owner]);
  const [prepared, setPrepared] = useState<typeof request | null>(null);
  useEffect(() => {
    if (request.owner === undefined) return;
    let cancelled = false;
    void prepareAccountCache(request.owner).then(() => {
      if (!cancelled) setPrepared(request);
    }).catch(error => {
      if (!cancelled) console.error("Could not prepare account cache:", error);
    });
    return () => { cancelled = true; };
  }, [request]);
  // Comparing the requested owner also closes the UI during the render in which
  // an account changes, before the previous effect's cleanup has had a turn.
  return request.owner !== undefined && prepared === request;
}
