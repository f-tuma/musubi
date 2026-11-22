import { scrubBreadcrumb, scrubTelemetry, TELEMETRY_DATA_COLLECTION } from "@musubi/types";
import type { sentry as TelemetrySdk } from "./telemetry-sdk";
import type { AnyRouter } from "@tanstack/react-router";
import { version } from "../../../package.json";
import { getServerCapabilities } from "~/api/resources";

// Settles with the SDK once it is running, or undefined when reporting is off.
let ready: Promise<typeof TelemetrySdk | undefined> | undefined;

/**
 * Starts browser error, performance and release-health reporting when this
 * server advertises a DSN (`SENTRY_WEB_DSN`), so the same build serves every
 * install. The SDK is downloaded only then: an install without one ships none
 * of it to its browsers.
 */
export function startTelemetry(router: AnyRouter) {
  if (ready || typeof window === "undefined") return;
  ready = getServerCapabilities()
    .then(async ({ sentry: options }) => {
      if (!options) return undefined;
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
        beforeBreadcrumb: scrubBreadcrumb,
      });
      return sentry;
    })
    // An unreachable API leaves this tab unreported, never broken.
    .catch(() => undefined);
}

/**
 * Route error boundaries catch render errors before the global handler can.
 * An error on the first paint waits for the SDK instead of being lost.
 */
export function reportError(error: unknown) {
  void ready?.then((sentry) => sentry?.captureException(error));
}
