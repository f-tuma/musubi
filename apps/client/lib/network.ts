type ErrorLike = {
  message?: string;
  status?: number | string;
  statusCode?: number | string;
};

const messageOf = (error: unknown) => {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as ErrorLike).message ?? "");
  }
  return "";
};

const statusOf = (error: unknown) => {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as ErrorLike).status ?? (error as ErrorLike).statusCode;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export function isNetworkError(error: unknown) {
  const message = messageOf(error).toLowerCase();
  const status = statusOf(error);
  return status === 0
    || message.includes("network request failed")
    || message.includes("failed to fetch")
    || message.includes("fetch failed")
    || message.includes("network error")
    || message.includes("internet connection")
    || message.includes("offline")
    || message.includes("unknownhostexception")
    || message.includes("unable to resolve host")
    || message.includes("could not resolve host")
    || message.includes("no address associated with hostname")
    || message.includes("socket hang up")
    || message.includes("connection refused");
}

/** Fetch with a finite wait so weak connections end in actionable UI. */
export async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit, timeoutMs = 18_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Friendly copy for user-triggered requests; preserves useful server errors. */
export function userFacingError(error: unknown, fallback = "Something went wrong. Please try again.") {
  const message = messageOf(error).replace(/^\d+:\s*/, "").trim();
  const lower = message.toLowerCase();
  const status = statusOf(error) ?? Number(messageOf(error).match(/^\d+/)?.[0]);

  if (isNetworkError(error)) return "No internet connection. Check your connection and try again.";
  if (status === 408 || lower.includes("timeout") || lower.includes("timed out") || lower.includes("abort")) {
    return "The connection is taking too long. Try again on a stronger network.";
  }
  if ([502, 503, 504].includes(status)) {
    return "Musubi could not reach the server. Try again in a moment.";
  }
  return message || fallback;
}
