import {
  announcementParagraphs,
  newestAnnouncementId,
  pendingAnnouncements,
  type Announcement,
} from "@musubi/types";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import musubiPackage from "../../../../../package.json";
import { getAnnouncements } from "~/api/resources";
import { getServerOrigin, queryKeys } from "~/api/query-keys";
import { useSessionUser } from "~/auth/use-session-user";
import { useSettingsMutations } from "~/calendar/settings-mutations";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "~/components/ui/dialog";

/** Co tenhle build je. Vite ho vloží; žádný fetch. Stejný zdroj jako use-newer-server. */
const BUILD_VERSION = musubiPackage.version;

/** Project news is fetched at startup, without interrupting work on focus. */
export function useAnnouncementsQuery() {
  const { user } = useSessionUser();
  const userId = user?.id;

  return useQuery({
    enabled: Boolean(userId),
    queryFn: ({ signal }) => getAnnouncements(signal),
    queryKey: queryKeys.announcements(getServerOrigin(), userId ?? ""),
    // Jednou za načtení aplikace. Novinka, která dorazí uprostřed práce, počká
    // na příští spuštění — vyskočit lidem pod rukama je horší než počkat.
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
}

/**
 * Text zprávy: odstavce, a odkazy jako odkazy.
 *
 * Exportované zvlášť, protože to je jediná část s pravidly, která stojí za test
 * — zbytek je zapojení dat.
 */
export function AnnouncementBody({ body }: { body: string }) {
  return (
    <>
      {announcementParagraphs(body).map((segments, index) => (
        // Prostý text: zlom řádku uvnitř odstavce autor napsal schválně.
        <p className="text-14 leading-relaxed whitespace-pre-wrap text-foreground-secondary [&+&]:mt-3" key={index}>
          {segments.map((segment, segmentIndex) =>
            segment.type === "link" ? (
              <a
                className="text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-current"
                href={segment.url}
                key={segmentIndex}
                // Odkaz ven nesmí dostat window.opener na Musubi.
                rel="noreferrer noopener"
                target="_blank"
              >
                {segment.value}
              </a>
            ) : (
              <span key={segmentIndex}>{segment.value}</span>
            ),
          )}
        </p>
      ))}
    </>
  );
}

/**
 * Prezentace samotného modalu: nejnovější zprávy a zavírací akce.
 *
 * Vyexportováno zvlášť od `AnnouncementGate`, aby si ho Storybook mohl
 * vykreslit se vzorovými daty bez query klienta nebo session.
 */
export function AnnouncementDialogView({
  announcements,
  onClose,
}: {
  announcements: Announcement[];
  onClose: () => void;
}) {
  return (
    // Radix uvnitř Dialogu drží focus trap, Escape i vrácení focusu — obojí
    // směřuje sem, takže zavření jakoukoli cestou posune značku.
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
    >
      <DialogContent size="form" aria-describedby={undefined} closeLabel="Close">
        <DialogHeader>
          <DialogTitle>News and updates</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {announcements.map((announcement) => (
            <section className="flex flex-col gap-2" key={announcement.id}>
              <h3 className="font-serif text-16 font-normal text-foreground">{announcement.title}</h3>
              <AnnouncementBody body={announcement.body} />
            </section>
          ))}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Ukáže, co je nového — jednou.
 *
 * Server už odfiltroval, co uživatel viděl; `minVersion` dořeší tenhle build,
 * protože server neví, jaká verze se ho ptá. Zavření posune značku v nastavení,
 * takže se totéž neukáže na telefonu.
 */
export function AnnouncementGate() {
  const { user } = useSessionUser();
  const userId = user?.id;
  const [dismissed, setDismissed] = useState(false);

  const { data } = useAnnouncementsQuery();

  const { getSettingsDocument, patchSettings } = useSettingsMutations(
    userId ?? "",
  );

  async function mark(lastSeenProjectNews: string) {
    try {
      const document = await getSettingsDocument();
      await patchSettings({
        baseRevision: document.revision,
        // The legacy marker keeps this client compatible with older servers.
        patch: { lastSeenProjectNews, lastSeenAnnouncement: lastSeenProjectNews },
      });
    } catch {
      // Značka se neuložila — zpráva se příště ukáže znovu. Otravné, ale
      // neškodné; ztratit ji úplně by bylo horší.
    }
  }

  // První pohled: nic se neukazuje, jen se posune značka. Bez toho by nový účet
  // (a v den nasazení každý stávající) dostal celou historii produktu naráz.
  //
  // V efektu, ne při renderu: patch je vedlejší efekt, a při renderu by ho
  // StrictMode vyvolal dvakrát a opakoval při každém dalším renderu.
  const markTo = data?.markTo;
  useEffect(() => {
    if (markTo) void mark(markTo);
    // `mark` se mění s každým renderem (uzavírá mutace), a značka se má poslat
    // právě jednou na hodnotu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markTo]);

  const pending =
    data && !markTo
      ? pendingAnnouncements(data.announcements, BUILD_VERSION)
      : [];
  if (dismissed || pending.length === 0) return null;

  function close() {
    setDismissed(true);
    const newest = newestAnnouncementId(pending);
    // Značka se posouvá jen na to, co se OPRAVDU ukázalo. Co odfiltroval
    // minVersion, zůstává nevyřízené a vyskočí po aktualizaci.
    if (newest) void mark(newest);
  }

  return <AnnouncementDialogView announcements={pending} onClose={close} />;
}
