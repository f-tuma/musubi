import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Kbd } from "~/components/ui/kbd";
import { SectionLabel } from "~/components/ui/section-label";
import { SHORTCUT_GROUPS } from "../shortcuts";

/** The `?` overlay. Lists the same map `shortcutFor` dispatches. */
export function ShortcutsDialog({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="default" aria-describedby={undefined} closeLabel="Close shortcuts">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
            {SHORTCUT_GROUPS.map((group) => (
              <section key={group.title} className="grid content-start gap-3">
                <SectionLabel level={3}>{group.title}</SectionLabel>
                <dl className="grid gap-2 text-13">
                  {group.items.map((item) => (
                    <div key={item.action} className="flex items-center justify-between gap-3">
                      <dt className="text-foreground-secondary">{item.action}</dt>
                      <dd>
                        <Kbd>{item.keys}</Kbd>
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
