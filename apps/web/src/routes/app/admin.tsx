import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { AdminSettings } from "~/calendar/components/AdminSettings";
import { Button } from "~/components/ui/button";

export const Route = createFileRoute("/app/admin")({
  component: AdminRoute,
});

function AdminRoute() {
  return (
    <main className="mx-auto flex w-full max-w-default flex-col gap-8 px-4 py-6 outline-none" id="main-content" tabIndex={-1}>
      <header className="grid justify-items-start gap-4">
        <Button asChild size="compact" variant="ghost">
          <Link to="/app">
            <ArrowLeft aria-hidden="true" />
            Back to calendar
          </Link>
        </Button>
        <h1 className="font-serif text-26 font-normal text-foreground">Announcements</h1>
      </header>
      <AdminSettings headingLevel={2} />
    </main>
  );
}
