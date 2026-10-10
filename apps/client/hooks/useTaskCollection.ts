import { useCallback, useEffect, useRef } from "react";
import { useServer } from "@/contexts/ServerContext";
import { useApi } from "@/services/api";
import { refreshTasks, startTaskCollectionSync, taskCollectionScope } from "@/services/taskCollection";
import { emptyTaskCollection, useTasksStore } from "@/store/useTasksStore";

export function useTaskCollection() {
  const { apiUrl, authClient } = useServer();
  const scope = taskCollectionScope(apiUrl, authClient.useSession().data?.user.id);
  const api = useApi();
  const apiRef = useRef(api);
  useEffect(() => { apiRef.current = api; }, [api]);
  const state = useTasksStore();
  // Scope mismatch hides private rows in this render, before effects can reset.
  const collection = state.scope === scope ? state : emptyTaskCollection;
  useEffect(() => startTaskCollectionSync(scope, apiRef.current), [scope]);
  const refresh = useCallback((providerSync = false) => refreshTasks(scope, apiRef.current, { providerSync }), [scope]);
  return { ...collection, scope, apiRef, refresh };
}
