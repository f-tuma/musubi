import type { Settings, SettingsDocument, SettingsPatch } from "@musubi/types";
import { useEffect, useState } from "react";
import { ApiError } from "~/api/http";
import { applyTheme } from "~/design/theme";

export type SettingsDocumentSource = {
  onAdopt: (document: SettingsDocument) => void;
  onLoad: (signal?: AbortSignal) => Promise<SettingsDocument>;
  onNotice: (message: string) => void;
  onPatch: (request: { baseRevision: number; patch: SettingsPatch }) => Promise<SettingsDocument>;
};

export type SettingsDocumentState = {
  error: string;
  /** Why the document itself could not be read, as opposed to a failed save. */
  loadFailed: boolean;
  retry: () => void;
  save: (patch: SettingsPatch) => Promise<void>;
  saving: boolean;
  settings?: SettingsDocument;
};

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Our sentence, not the server's word for it. A failed write returns a machine
 * code ("server", "conflict"); showing that answers none of the four questions
 * an error has to. The request id is the part worth passing on.
 */
function withRequestId(message: string, error: unknown) {
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  return requestId ? `${message} (Request ${requestId})` : message;
}

/**
 * The revisioned settings document behind General, read each time the
 * settings window opens and dropped when it is closed.
 *
 * It lives with the window rather than the panel, so moving between sections
 * does not read the document again or flash a loading state.
 */
export function useSettingsDocument(
  open: boolean,
  { onAdopt, onLoad, onNotice, onPatch }: SettingsDocumentSource,
): SettingsDocumentState & { reset: () => void } {
  const [settings, setSettings] = useState<SettingsDocument>();
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let active = true;
    onLoad(controller.signal)
      .then((document) => {
        if (!active) return;
        setError("");
        setLoadFailed(false);
        setSettings(document);
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setLoadFailed(true);
        setError(withRequestId("Settings could not be loaded.", loadError));
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [loadAttempt, onLoad, open]);

  function reset() {
    setError("");
    setLoadFailed(false);
    setSettings(undefined);
  }

  function retry() {
    setError("");
    setLoadFailed(false);
    setSettings(undefined);
    setLoadAttempt((attempt) => attempt + 1);
  }

  async function save(patch: SettingsPatch) {
    if (!settings || saving) return;
    const base = settings;
    setSettings({ ...base, value: { ...base.value, ...patch } });
    if (patch.theme) applyTheme(patch.theme);
    setSaving(true);
    setError("");

    try {
      const updated = await onPatch({ baseRevision: base.revision, patch });
      setSettings(updated);
      onNotice("Settings saved.");
    } catch (saveError) {
      if (saveError instanceof ApiError && saveError.status === 409) {
        try {
          const current = await onLoad();
          const sameFieldChanged = Object.keys(patch).some((key) => {
            const field = key as keyof Settings;
            return !sameValue(base.value[field], current.value[field]);
          });

          if (!sameFieldChanged) {
            const retried = await onPatch({ baseRevision: current.revision, patch });
            setSettings(retried);
            onNotice("Settings merged and saved.");
            return;
          }

          setSettings(current);
          onAdopt(current);
          if (patch.theme) applyTheme(current.value.theme);
          setError("This setting changed on another device. The newer server value is shown.");
          return;
        } catch (refreshError) {
          setSettings(base);
          if (patch.theme) applyTheme(base.value.theme);
          setError(
            withRequestId(
              "The newer settings could not be fetched. Your change went back to its previous value — try again.",
              refreshError,
            ),
          );
          return;
        }
      }

      setSettings(base);
      if (patch.theme) applyTheme(base.value.theme);
      setError(
        withRequestId("This setting could not be saved. It went back to its previous value — try again.", saveError),
      );
    } finally {
      setSaving(false);
    }
  }

  return { error, loadFailed, reset, retry, save, saving, settings };
}
