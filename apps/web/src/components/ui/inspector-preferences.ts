import { useSyncExternalStore } from "react";

export type InspectorPresentation = "panel" | "floating";
const KEY = "musubi.inspector-presentation";
const CHANGE = "musubi:inspector-presentation";

function read(): InspectorPresentation {
  try { return localStorage.getItem(KEY) === "floating" ? "floating" : "panel"; }
  catch { return "panel"; }
}

function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => { if (event.key === KEY || event.key === null) listener(); };
  window.addEventListener("storage", storage);
  window.addEventListener(CHANGE, listener);
  return () => {
    window.removeEventListener("storage", storage);
    window.removeEventListener(CHANGE, listener);
  };
}

/** Window layout belongs to this browser, independently of account preferences. */
export function useInspectorPreference() {
  const presentation = useSyncExternalStore(subscribe, read, () => "panel" as const);
  return [presentation, (value: InspectorPresentation) => {
    localStorage.setItem(KEY, value);
    window.dispatchEvent(new Event(CHANGE));
  }] as const;
}
