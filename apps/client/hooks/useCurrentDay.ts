import { useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";

const dayStart = () => {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.getTime();
};

// A calendar left open across midnight must move its "today" marker without
// waiting for an unrelated store update. The timeout follows local midnights
// (including DST), and foregrounding catches timers suspended in background.
export function useCurrentDay() {
  const [start, setStart] = useState(dayStart);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => setStart(previous => {
      const next = dayStart();
      return previous === next ? previous : next;
    });
    const schedule = () => {
      if (timer) clearTimeout(timer);
      const nextMidnight = new Date();
      nextMidnight.setHours(24, 0, 0, 50);
      timer = setTimeout(() => {
        refresh();
        schedule();
      }, Math.max(nextMidnight.getTime() - Date.now(), 1000));
    };

    schedule();
    const appState = AppState.addEventListener("change", state => {
      if (state !== "active") return;
      refresh();
      schedule();
    });
    return () => {
      if (timer) clearTimeout(timer);
      appState.remove();
    };
  }, []);

  return useMemo(() => new Date(start), [start]);
}
