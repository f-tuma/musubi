import { createFileRoute } from "@tanstack/react-router";
import { Smartphone } from "lucide-react";
import { SessionGate } from "~/auth/SessionGate";
import { useNarrowViewport } from "~/design/use-narrow-viewport";
import { SnapshotProvider } from "~/offline/SnapshotProvider";
import { Button } from "~/components/ui/button";
import { Empty } from "~/components/ui/empty";

export const Route = createFileRoute("/app")({
  component: AppRoute,
});

const MOBILE_APP_URL =
  "https://play.google.com/store/apps/details?id=dev.frgtn.musubi";
const MOBILE_WEB_TEST_BYPASS = "musubi-mobile-web-test-bypass";

function AppRoute() {
  const narrow = useNarrowViewport();
  const testBypass =
    typeof sessionStorage !== "undefined" &&
    sessionStorage.getItem(MOBILE_WEB_TEST_BYPASS) === "true";

  // Above the gate on purpose: the restore has to be in flight while the gate
  // decides, or an offline start redirects to login before the snapshot is read.
  return (
    <SnapshotProvider>
      {narrow && !testBypass ? (
        <main className="fixed inset-0 z-dialog grid min-h-dvh place-items-center overflow-auto bg-canvas p-6 pb-safe-bottom">
          <Empty
            action={
              <Button onClick={() => window.location.assign(MOBILE_APP_URL)}>
                Get the Android app
              </Button>
            }
            aria-label="Musubi on mobile"
            aria-modal="true"
            description="The web app is not built for phones yet."
            icon={<Smartphone />}
            role="dialog"
            title="Musubi works best in the app"
          />
        </main>
      ) : (
        <SessionGate />
      )}
    </SnapshotProvider>
  );
}
