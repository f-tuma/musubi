/// <reference types="vite/client" />

import type { QueryClient } from "@tanstack/react-query";
import { Agentation } from "agentation";
import { BRAND_ASSETS } from "~/brand";
import {
  ClientOnly,
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from "@tanstack/react-router";
import { type ReactNode, useSyncExternalStore } from "react";
import { AppErrorBoundary } from "~/components/AppErrorBoundary";
import { NotFound } from "~/components/NotFound";
import { useFocusMode } from "~/design/focus-mode";
import appCss from "~/design/app.css?url";
import {
  getAppliedTheme,
  subscribeToTheme,
  THEME_BOOTSTRAP_SCRIPT,
} from "~/design/theme";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  head: () => ({
    links: [
      {
        href: `${BRAND_ASSETS}/favicon.svg`,
        rel: "icon",
        type: "image/svg+xml",
      },
      { href: `${BRAND_ASSETS}/apple-touch-icon.png`, rel: "apple-touch-icon" },
      { rel: "stylesheet", href: appCss },
    ],
    meta: [
      { title: "Musubi" },
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1, viewport-fit=cover",
      },
      {
        name: "theme-color",
        content: "#f4f1e8",
      },
      {
        name: "description",
        content: "Musubi — the open, self-hostable shared calendar.",
      },
      // Login and invite URLs are public and commonly shared. Give them a
      // default preview; a route that wants its own image overrides this key.
      { content: `${BRAND_ASSETS}/og.png`, property: "og:image" },
      { content: "summary_large_image", name: "twitter:card" },
    ],
  }),
  errorComponent: (props) => (
    <RootDocument>
      <AppErrorBoundary {...props} />
    </RootDocument>
  ),
  notFoundComponent: NotFound,
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function ThemeSynchronizer() {
  useSyncExternalStore(subscribeToTheme, getAppliedTheme, () => "light");
  return null;
}

function FocusMode() {
  useFocusMode();
  return null;
}

function SkipLink() {
  return (
    <a className="skip-link" href="#main-content">
      Skip to content
    </a>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        {/* Theme is applied before the body is painted to avoid a light flash. */}
        <script>{THEME_BOOTSTRAP_SCRIPT}</script>
      </head>
      <body>
        <ThemeSynchronizer />
        <FocusMode />
        <SkipLink />
        {children}
        {import.meta.env.DEV ? (
          <ClientOnly>
            {typeof navigator !== "undefined" && !navigator.webdriver ? (
              <Agentation />
            ) : null}
          </ClientOnly>
        ) : null}
        <Scripts />
      </body>
    </html>
  );
}
