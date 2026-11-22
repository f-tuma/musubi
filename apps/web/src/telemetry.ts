import { scrubTelemetry, TELEMETRY_DATA_COLLECTION } from "@musubi/types";
import type { sentry as TelemetrySdk } from "./telemetry-sdk";
import type { AnyRouter } from "@tanstack/react-router";
import { version } from "../../../package.json";
import { getServerCapabilities } from "~/api/resources";

let sdk: typeof TelemetrySdk | undefined;
let started = false;

/**
 * Starts browser error, performance and release-health reporting when this
 * server advertises a DSN (`SENTRY_WEB_DSN`), so the same build serves every
 * install. The SDK is downloaded only then: an install without one ships none
 * of it to its browsers.
 */
export function startTelemetry(router: AnyRouter) {
  if (started || typeof window === "undefined") return;
  started = true;
  getServerCapabilities()
    .then(async ({ sentry: options }) => {
      if (!options) return;
      // Lazy on purpose: a separate chunk only installs with a DSN download.
      const { sentry } = await import("./telemetry-sdk");
      sentry.init({
        dsn: options.dsn,
        environment: options.environment,
        release: `musubi@${version}`,
        tracesSampleRate: options.tracesSampleRate,
        integrations: [sentry.tanstackRouterBrowserTracingIntegration(router)],
        dataCollection: TELEMETRY_DATA_COLLECTION,
        beforeSend: scrubTelemetry,
        beforeSendSpan: scrubTelemetry,
        beforeBreadcrumb: scrubTelemetry,
      });
      sdk = sentry;
    })
    // An unreachable API leaves this tab unreported, never broken.
    .catch(() => {});
}

/** Route error boundaries catch render errors before the global handler can. */
export function reportError(error: unknown) {
  sdk?.captureException(error);
}
