import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useRef,
  useState,
} from "react";

export type AsyncActionState = {
  busy: boolean;
  error: string;
  run: <Result>(
    action: () => Promise<Result>,
    fallbackMessage: string,
  ) => Promise<Result | undefined>;
  setError: Dispatch<SetStateAction<string>>;
};

/**
 * Runs one user action at a time and owns its shared busy/error lifecycle.
 * Errors are intentionally converted to UI state: callers describe the
 * fallback in their own domain language instead of handling rejected promises.
 */
export function useAsyncAction(): AsyncActionState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const runningRef = useRef(false);

  const run = useCallback(
    async <Result,>(
      action: () => Promise<Result>,
      fallbackMessage: string,
    ): Promise<Result | undefined> => {
      if (runningRef.current) return undefined;

      runningRef.current = true;
      setBusy(true);
      setError("");

      try {
        return await action();
      } catch (actionError) {
        setError(
          actionError instanceof Error
            ? actionError.message
            : fallbackMessage,
        );
        return undefined;
      } finally {
        runningRef.current = false;
        setBusy(false);
      }
    },
    [],
  );

  return { busy, error, run, setError };
}
