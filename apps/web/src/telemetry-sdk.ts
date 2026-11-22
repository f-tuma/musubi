import { captureException, init, tanstackRouterBrowserTracingIntegration } from "@sentry/react";

// The only parts of @sentry/react the web app uses; importing the package
// itself lazily would keep every export (replay, feedback…) in the chunk.
// Bound in an object, not re-exported: with `strictExecutionOrder` a bare
// re-export leaves the SDK's modules uninitialized in production builds.
export const sentry = { captureException, init, tanstackRouterBrowserTracingIntegration };
