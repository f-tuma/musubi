import { z } from "zod";
import { compareVersions } from "./version";

/**
 * `YYYY-MM-DD`, s číselnou příponou pro další zprávy téhož dne.
 * Přípona je klíč pro lexikografické pořadí, ne počet zpráv.
 *
 * Datum v id není ozdoba: je to zároveň řazení, takže "novější než poslední
 * viděná" je porovnání řetězců a tabulka nepotřebuje druhý sloupec na pořadí.
 * Formát se lexikograficky řadí správně jen díky nulám (`08`, ne `8`).
 */
export const ANNOUNCEMENT_ID_PATTERN = /^\d{4}-\d{2}-\d{2}(-\d+)?$/;

export const AnnouncementSchema = z.object({
  id: z.string().regex(ANNOUNCEMENT_ID_PATTERN),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
  /**
   * Nejstarší verze klienta, které se zpráva týká. `null`/chybějící = všem.
   * Filtruje se podle ní na KLIENTOVI: server neví, komu odpovídá.
   */
  minVersion: z.string().max(32).nullish(),
});

export type Announcement = z.infer<typeof AnnouncementSchema>;

/** Co posílá admin panel při vytvoření nebo opravě. `id` přiděluje server. */
export const AnnouncementInputSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
  minVersion: z.string().max(32).nullish(),
});

export type AnnouncementInput = z.infer<typeof AnnouncementInputSchema>;

export const AnnouncementsResponseSchema = z.object({
  announcements: z.array(AnnouncementSchema),
  /**
   * Jede s odpovědí, protože tenhle dokument si stahuje každý přihlášený klient
   * při startu tak jako tak — web podle něj ukáže odkaz na panel bez dalšího
   * requestu. Autoritou zůstávají admin endpointy samy.
   */
  isAdmin: z.boolean(),
  /**
   * Posílá se JEN při prvním pohledu — účtu, který ještě nic neviděl. Znamená
   * "nic neukazuj, jen si posuň značku sem". Bez toho by nový účet (a v den
   * nasazení každý stávající) dostal modal se všemi novinkami za celou
   * historii produktu.
   *
   * Volitelné, takže starší klient, který o něm neví, ho prostě ignoruje.
   */
  markTo: z.string().max(64).optional(),
});

export type AnnouncementsResponse = z.infer<typeof AnnouncementsResponseSchema>;

/**
 * Volné id pro dnešní datum.
 *
 * Přiděluje ho server, ne autor: klient by musel znát existující id, aby uhodl
 * volné, a dva otevřené panely by si vybraly totéž.
 */
export function mintAnnouncementId(
  dateKey: string,
  taken: readonly string[],
): string {
  const sameDay = taken.filter(
    (id) => ANNOUNCEMENT_ID_PATTERN.test(id) &&
      (id === dateKey || id.startsWith(`${dateKey}-`)),
  );
  const newest = sameDay.sort()[sameDay.length - 1];
  if (!newest) return dateKey;
  if (newest === dateKey) return `${dateKey}-2`;

  const suffix = newest.slice(dateKey.length + 1);
  const incremented = (BigInt(suffix) + 1n).toString();
  // Read markers compare strings. At digit boundaries, 10 sorts before 9;
  // extending the highest suffix keeps the new ID strictly after every old ID.
  return `${dateKey}-${incremented > suffix ? incremented : `${suffix}0`}`;
}

export type AnnouncementSegment =
  | { type: "text"; value: string }
  | { type: "link"; url: string; value: string };

/**
 * Jen http(s). Obsah píše majitel serveru, ale `javascript:` nebo `data:` URL
 * v modalu je spouštěč skriptu, ne odkaz — takže se nikdy nestanou klikatelnými
 * a zůstanou obyčejným textem.
 */
const LINK_PATTERN = /https?:\/\/[^\s<>"']+/g;

/** Tečka na konci věty ani uzavírací závorka nepatří do URL. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

/** Rozseká jeden odstavec na úseky textu a odkazů. */
export function splitAnnouncementText(text: string): AnnouncementSegment[] {
  const segments: AnnouncementSegment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(LINK_PATTERN)) {
    const start = match.index ?? 0;
    const url = match[0].replace(TRAILING_PUNCTUATION, "");
    // Celý match byl interpunkce po `https://`? Pak to není odkaz.
    if (!url || url === "http://" || url === "https://") continue;

    if (start > cursor) {
      segments.push({ type: "text", value: text.slice(cursor, start) });
    }
    segments.push({ type: "link", url, value: url });
    cursor = start + url.length;
  }

  if (cursor < text.length) {
    segments.push({ type: "text", value: text.slice(cursor) });
  }

  return segments;
}

/** Prázdný řádek dělí odstavce; jeden zlom řádku ne. */
export function announcementParagraphs(body: string): AnnouncementSegment[][] {
  return body
    .split(/\n[ \t]*\n\s*/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map(splitAnnouncementText);
}

/**
 * Co tomuhle klientovi zbývá ukázat, od nejnovější.
 *
 * Server už odfiltroval, co uživatel viděl. Zbývá `minVersion`, a to umí jen
 * klient: server neví, jaká verze se ho ptá. Co tady vypadne, zůstane
 * nevyřízené a vyskočí po aktualizaci — to je celý mechanismus "novinky se
 * propagují při aktualizování verze".
 */
export function pendingAnnouncements(
  announcements: readonly Announcement[],
  clientVersion: string,
): Announcement[] {
  return announcements
    .filter(
      (announcement) =>
        !announcement.minVersion ||
        compareVersions(clientVersion, announcement.minVersion) >= 0,
    )
    .sort((left, right) => (left.id < right.id ? 1 : left.id > right.id ? -1 : 0));
}

/** Nejvyšší id ze seznamu — kam se posune značka po zavření modalu. */
export function newestAnnouncementId(
  announcements: readonly Announcement[],
): string | undefined {
  let newest: string | undefined;
  for (const announcement of announcements) {
    if (newest === undefined || announcement.id > newest) newest = announcement.id;
  }
  return newest;
}
