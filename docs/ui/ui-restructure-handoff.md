# Handoff — web UI restructure (primitives, pickers, screens)

> Historical handoff, completed in July 2026. The Tailwind v4/shadcn migration
> superseded the component paths and CSS anatomy below on 2026-10-01. Current
> implementation rules are in [design-system.md](./design-system.md) and
> [the Musubi UI skill](../../.agents/skills/musubi-ui/SKILL.md); components live
> in `apps/web/src/components/ui`, and visual examples are colocated Storybook
> stories. Removed `src/ui`, CSS modules and old settings/toast names below
> describe the historical audit, not files to edit now.

- Stav: **dokončeno**, fáze 0–4 uzavřené 2026-07-29
- Pro: `apps/web`
- Čti první: tento soubor, pak `docs/ui/calendar-ui.md` (§2 pravidla R1–R12, §7
  checklist, §8 anti-patterny). Zdroj principů je `store/UI-UX/`, předloha stylu je
  `apps/client`.

## Proč to děláme

`apps/web` rostl feature-first: každá obrazovka si vymyslela vlastní markup a
všechno skončilo v jednom **3 035řádkovém** `src/calendar/components/workspace.module.css`.
V repu **nejsou žádná UI primitiva** — neexistuje Button, Dialog, Field, Row,
Select ani Switch. Uživatelův verdikt na dialogy byl „hrozný bordel a
nepoužitelné" a je věcně správný. Audit napočítal:

- **15 mechanismů pro tlačítko** — sdílená báze `.primaryButton/.secondaryButton/
  .iconButton/.textButton`, k tomu `.dangerButton`, `.deleteTextButton`,
  `.pageButton`, `.sidebarFooter button` (descendant selektor bez classy),
  `.navPair button`, `.viewButton`, `.filterBar button`, `.miniDay`, `.moreEvents`,
  `.toastAction`, `.eventChip`, `.scopeOptions button`, `.route-state button`
  v `global.css` a `.submit` v `login.module.css`. `.eventButton` je bajt po bajtu
  kopie `.primaryButton`.
- **5 vzorů form-row** (`.formRow` 38px, `.settingRow` 36px, `.transferControls`
  40px, `.caldavForm`, `.calendarChoices`) → tři výšky inputů, dva gutrery (14px
  v popoverech, 20px v dialozích) a `.formError` má dvě různá odsazení podle
  toho, v čem je zavěšený.
- **3 skořápky dialogu**: `.manageDialogHeader` (sticky `<header>`, titul 1,25rem,
  zavírací ikona), `.scopeDialog` (žádná hlavička, Cancel na celou šířku dole),
  `.popoverHeader` (`<div>`, 1,16rem, ikona zmenšená na 31px). K tomu tři různé
  recepty na „vyvýšenou kartu".
- **2 vzhledy checkboxu, 2 vzhledy selectu, 4 kódování „vybráno"**
  (`.buttonSelected`, `.viewButtonActive`, `.pageButtonActive`, `.filterChipActive`),
  2 classy pro avatar, 3 ručně psané visually-hidden techniky.
- **Tokeny existují, ale nepoužívají se**: `tokens.css` má 59 deklarací; spacing
  scale je použitá **dvakrát** proti **184 hardcoded px**, velikosti fontu jsou
  17 ad-hoc remů a `--event-dune/moss/ochre`, `--popover-width`, `--focus-ring`,
  `--motion-slow`, `--space-3/4/6/8` mají **nulové** použití.
- **Dva další stylesheety mimo modul**: `global.css` `.route-state*` (používá
  `WorkspaceDataState`, `NotFound`, `AppErrorBoundary`, `SessionGate`) a
  `login.module.css` (176 řádků, znovu implementuje brand, form-row a primary
  button). `WorkspaceDataState` se proto nedá vložit do žádného dialogu, aniž by
  vypadl ze stylu.
- **Nativní browser controls tam, kde uživatel chce vlastní**: `type="date"` ×2
  a `type="time"` ×2 v `EventEditorForm.tsx`, `type="color"` ×3
  v `CalendarTransferDialog.tsx`. `MiniCalendar.tsx` — funkční klávesnicově
  ovladatelná mřížka dat — existuje a **není napojená na nic**.

Menší, ale reálné defekty k pobrání cestou: `SaveBar` je duplikovaný inline
v `Workspace.tsx:978-1005`; filter bar duplikuje přepínače kalendářů ze sidebaru
jiným markupem; tři téměř identické `run()` helpery, z nichž ten
v `ConnectionsDialog` čistí `busy` jen při chybě; `applyTheme` je
naimplementovaný třikrát (`SettingsDialog`, `ThemeToggle`, `__root.tsx`).

## Co je předloha

`apps/client` má přesně tu vrstvu, která webu chybí:

| Co | Kde v mobilu |
| --- | --- |
| jeden modul tokenů | `constants/theme.ts` (mutable singleton + `applyTheme`) |
| primitiva | `components/ui/{Tap,Btn,Empty,Toast,Portal,ModalPortal}.tsx` |
| řádky nastavení | `components/SettingRow.tsx` — `Toggle` / `Options` / `Action` |
| dialog s jedním polem | `components/TextInputModal.tsx` |
| barvy | `components/ColorPickerModal.tsx` + paleta `constants/colors.ts` |
| skořápka sheetu | opakovaná v deseti modalech, viz `EventDetailModal.tsx` |

Tokeny už si odpovídají 1:1 a světlé hodnoty jsou identické (`#f4f1e8`,
`#e8e3d5`, `#1c1b18`, `#b3492f`); `--control-fill` / `--control-on-fill` na webu
už jsou a odpovídají mobilnímu `fill`/`onFill`. **Není to výměna palety, je to
srovnání konzistence.**

Geometrie a idiomy k převzetí: řádek `min-height: 62`, gutter `16`, control
`min-height: 48`, radiusy `999 / 20 / 15 / 14 / 10 / 8 / 4`, typová škála
`10 · 11 · 12 · 13 · 14 · 15 · 19 · 22 · 26`, uppercase micro-label
`10px / letter-spacing 1.5 / --text-faint`.

Tři pravidla chování, která mobil drží a web ne:

1. **Vybraný stav = obrácená výplň nebo silnější border, nikdy accent tint.**
   Accent zůstává destruktivnímu, odkazům, now-indikátoru a aktivní fajfce.
2. **Málo možností → segmentované pilulky, ne `<select>`** (`SettingRow.tsx:71-118`).
3. **Akce v detailu řazené podle frekvence**, Delete poslední a accentem
   (`EventDetailModal.tsx:324-325`).

Breakpointy se srovnají na ladder ze specu
(`store/UI-UX/calendar-ui-ux-agent-spec-cs.yaml`, klíč `responsive`):
**≤599 / 600–1023 / 1024–1439 / ≥1440** místo dnešního dvojího ladderu
1360 / 1040 / 820 / 520 / 600.

## Rozhodnutí (od uživatele, 2026-07-28)

- **Po fázích, primitiva první.** Každá fáze je commit se zelenými testy. Ne jeden
  velký přepis.
- **Pickery vlastní, bez nové závislosti.** Web má jen `@radix-ui/react-dialog`,
  `@radix-ui/react-popover`, `lucide-react` — žádnou UI knihovnu, žádný picker.
- **Jazyk mobilu, ne jeho layout.** Sdílené: tokeny, paleta, vzor řádku, pořadí
  sekcí, texty, model pickerů. Web si nechá klávesnici, hover a šířku; na 1440px
  se nepředstírá mobilní sheet.
- **Testy se hýbou s kódem.** Každá fáze si opraví selektory, které rozbila;
  chování pod testem zůstává.

## Fáze

### Fáze 0 — tokeny, potom rozdělit stylesheet

1. Dopsat `src/design/tokens.css`: typová škála (`--text-10..--text-26`),
   `--space-5/-7`, radiusy pod jmény, která komponenty reálně potřebují
   (`--radius-pill/-sheet/-card/-control/-chip`), `--row-min-height`,
   `--control-height`. Tři nepoužité `--event-*` pigmenty buď smazat, nebo je
   Fáze 2 napojí na paletu (jsou to tytéž pigmenty jako mobilní `constants/colors.ts`).
2. Rozdělit `workspace.module.css` na `styles/primitives.module.css` (button,
   field, row, pill, dialog shell, empty, toast) a nechat pravidla mřížky/chipů/
   toolbaru, kde jsou. Přesunout zapadlý blok `.shortcut*` (dnes ř. 132-180 uvnitř
   sidebar rodiny) a `.editorPage*` (3003-3035, přilepený na konec).
3. Ověřit **s nulovou úpravou testů** — když se něco rozbije, rozdělení nebylo
   mechanické.

### Fáze 1 — vrstva primitiv v `src/ui/`

Postavit sadu, kterou handoff `store/musubi-web-handoff/05-frontend-implementation.md`
§3 **už dávno pojmenoval** a nikdo ji nepostavil. Každé primitivo zrcadlí mobilní
a má unit test:

| Primitivo | Zrcadlí | Nahrazuje |
| --- | --- | --- |
| `Button` / `IconButton` | `ui/Btn.tsx` (`variant`, `icon`, `loading`, `disabled`) | všech 15 mechanismů |
| `Dialog` | mobilní skořápku sheetu | `.manageDialog*`, `.scopeDialog`, `.popoverHeader` — jedna hlavička (titul, popis, zavřít), scroll body, footer slot; **pod 600px se renderuje jako bottom sheet** přes CSS, které už existuje |
| `Field` | `fieldContainer` + `fieldLabel` | `.formRow`, `.settingRow`, `.transferControls`, `.caldavForm` |
| `Row` (`RowAction` / `RowToggle` / `RowOptions`) | `SettingRow.tsx` | `.settingRow`, `.calendarManageRow`, řádky v sidebaru |
| `Segmented` | inline segmented control | každý `<select>` s ≤4 možnostmi; `role="radiogroup"` + roving tabindex |
| `Switch`, `Checkbox` | RN `Switch` recept, vlastní fajfka | dva soupeřící vzhledy checkboxu |
| `Select` | — | selecty, které opravdu mají hodně možností (kalendář, timezone) |
| `Empty` | `ui/Empty.tsx` | `.dialogLoading` použitý jako empty state |
| `SectionLabel` | `sectionLabel` | ad-hoc `<h3>` / `.transferHeading` |
| `Toast` | `ui/Toast.tsx` | inline live region ve `Workspace.tsx` |

Ve stejné fázi: jeden `useAsyncAction` s `finally` místo tří kopií `run()`, a jeden
modul `applyTheme` místo tří kopií.

**Znovu použít, nevymýšlet**: `getReadableEventTextColor`
(`src/calendar/event-color.ts`), `MiniCalendar`, `Notify` (`src/calendar/notice.ts`),
`clampOffset` (`src/calendar/window-drag.ts`), `shortcutFor` (`src/calendar/shortcuts.ts`).

### Fáze 2 — tři pickery

Na desktopu popovery, pod 600px sheety, klávesnice první, každý nahrazuje nativní
input. Uložená hodnota zůstane obyčejný string, takže `EventFormValues` ani
kontrakt search-params na stránce editoru se nemění.

1. **`DatePicker`** — trigger zobrazí formátované datum (`getLongDateLabel`),
   popover hostí **`MiniCalendar`** (roving tabindex, listování měsíců, značky
   dnes/vybráno — hotové a otestované) plus zkratku Dnes. Nejlevnější reálný zisk.
2. **`TimePicker`** — listbox v krocích `geometry.snapMinutes`
   (`src/calendar/time-geometry.ts`), formát podle uživatelského `timeFormat`,
   odscrollovaný na aktuální hodnotu, psatelný (`9` → 09:00, `9:30`, `21:15`),
   a v seznamu konců i délky (`+30m`, `+1h`) jako Google. K tomu mobilní presety
   Morning/Afternoon/Evening tam, kde se nastavuje celý rozsah.
3. **`ColorPicker`** — mřížka swatchů z Musubi palety, `+` swatch otevře hex pole
   s živým náhledem, a **Microsoftem omezená paleta** ošetřená jako v mobilu
   (`MICROSOFT_CALENDAR_COLORS` + `nearestMicrosoftCalendarColor`
   v `packages/types/src/calendar.ts`) pro kalendáře v Outlooku. Pět pigmentů
   (dune `#B3A48A`, shu `#C8553D`, moss `#A8B5A0`, ochre `#D4A574`,
   indigo `#7A8BA3`) přesunout do **sdíleného modulu**, aby se web a mobil nemohly
   rozejít; tím padnou i tři hardcoded fallbacky (`#7a9e7e`
   v `CalendarTransferDialog.tsx:47`, `#7a8ba3` ve čtyřech souborech).

Každý picker: trigger s `aria-expanded`, Escape zavírá **jen nejvyšší vrstvu**,
focus se vrací na trigger, šipky se hýbou uvnitř.

### Fáze 3 — obrazovky, commit za obrazovku, nejpoužívanější první

1. **Editor eventu** (`EventEditorForm.tsx`) — sem přijdou pickery; `compact`
   i `when` sync zůstávají. Pořadí polí podle playbooku §5.8: titul → datum/čas/
   celý den/opakování → hosté → místo/odkaz → popis → kalendář/viditelnost.
2. **Náhled eventu** (`EventDetailsPopover.tsx`) — mobilní pořadí čtení (accent
   tah + serif titul, datum, čas · délka, pilulky kalendářů, řádky místo/URL, box
   poznámky, hosté) a **ikonová akční lišta** řazená podle frekvence s Delete
   poslední. Sjednotit dva delete flow do jednoho a `.deleteScope` zahodit ve
   prospěch existujícího `RecurrenceScopeDialog`.
3. **Nastavení** (`SettingsDialog.tsx`) — pořadí sekcí a texty jako mobil
   (Appearance / Notifications / Help & About / Account), `RowOptions` místo
   selectů, autosave zůstává, téma patří sem.
4. **Účet** (`AccountDialog.tsx`) — blok identity a pak řádky; zachovat gate
   „napiš své jméno" u mazání; jedna classa pro avatar.
5. **Kalendáře** (`CalendarTransferDialog.tsx`) — seskupený seznam (Musubi skupina
   první, pak po účtech), `Row` + swatch + ikona providera; `ColorPicker` z Fáze 2;
   `window.confirm` → confirm dialog podle R6.
6. **Sdílení** (`ShareCalendarDialog.tsx`) — členové s rolemi přes `Segmented`,
   sekce invitů, akce v footeru místo volných tlačítek na celou šířku.
7. **Konexe** (`ConnectionsDialog.tsx`) — řádky účtů se stavem a reconnectem,
   tlačítka providerů jako `Button variant="secondary"`, konzistentní váha submitu.
8. **Stránka full editoru** (`routes/app/p.$pageId.event.new.tsx`) — tytéž
   `Field`/`Button`, labely sekcí, hlavička srovnaná se zbytkem, label `Create`
   stejný jako v bublině.
9. **Chrome** (`Sidebar.tsx`, `Toolbar.tsx`, filter bar, `SaveBar`) — primitiva
   všude; smazat inline kopii SaveBaru; z filter baru a přepínačů kalendářů
   v sidebaru udělat tentýž `Row`.
10. **Route states a login** (`WorkspaceDataState`, `NotFound`, `AppErrorBoundary`,
    `login.tsx` + `login.module.css`) — vtáhnout druhý a třetí stylesheet do
    primitiv, aby `.route-state*` a duplicitní brand/form/button pravidla zmizela.

### Fáze 4 — úklid — **HOTOVO**

- Mrtvé classy a compatibility stylesheet jsou odstraněné; dialogové skořápky
  vlastní `src/ui/Dialog`. Breakpointy používají ladder 599 / 1023 / 1439 a
  sidebar čte CSS flag místo vlastní media query.
- Axe průchod pokrývá každý dialog (e2e helper pouští **plnou defaultní sadu pravidel
  bez filtrování** — přesně to chytilo poslední kontrast 3,22:1) plus jeden
  klávesnicový průchod na obrazovku; handoff DoD vyžaduje klávesnicový scénář, ne
  jen axe.
- `docs/ui/calendar-ui.md` popisuje aktuální tokeny, breakpointy a primitiva v
  `src/ui/`, aby příští ticket nevymyslel šestnácté tlačítko.

## Co NErozbíjet

- `/invite/:token`, `/reset-password` a `/delete-account` vypadají z webu jako
  mrtvé odkazy, ale **obsluhuje je API** přes gateway
  (`apps/api/src/index.ts:108-113`, `ops/gateway/Caddyfile:34-46`). Přidat webové
  routy by ty stránky zastínilo. 404 dávají jen pod samotným `vite dev`.
- Samotné pohledy kalendáře (geometrie Month/Week/Day/Agenda, drag, drafty) —
  fáze A–F tam už dosedly; tahle práce se jich dotkne jen tam, kde primitivum
  nahradí ad-hoc CSS.
- Year view, custom ranges a pravá utility rail — vědomě odložené
  v `docs/ui/calendar-ui.md` a odložené zůstávají.

## Ověřování

Z `apps/web`, po každé fázi:

```
pnpm typecheck && pnpm lint && pnpm test && pnpm exec playwright test
```

Dnešní stav: **104 unit / 55 e2e zelených.**

**Rozbití testů je očekávané a ohraničené**: 42 z 55 e2e testů asertuje na
strukturu nebo labely dialogů. Vzor je vždycky stejný — nativní `<select>`
nahrazený `Segmented` změní `getByRole("combobox", { name: … })` na
`getByRole("radiogroup"/"radio", …)`, a nativní date/time input nahrazený pickerem
změní `getByLabel("Start time")` + `toHaveValue("02:00")` na assert na triggeru
plus interakci s listboxem. Reprezentativní testy podle fáze:

| Fáze | Test | Selektor, který padne |
| --- | --- | --- |
| Settings | „saves revisioned settings…" | `combobox "Time format"`, `combobox "Theme"` |
| Sdílení | „manages members and invite links" | `combobox "Sam Rivers role"` |
| Chrome | „changes time grid density from the page editor" | `combobox "Row height"` |
| Kalendáře | „exports and imports iCalendar files" | `combobox "Calendar to export"`, `getByLabel("Choose .ics file")`, `getByPlaceholder("New calendar")` |
| Náhled | „handles attendance, linking, forking and recurring delete scopes" | `combobox "Recurring event delete scope"` |
| Pickery | quick-create sada, ř. ~991–2529 | `getByLabel("Date"/"Start time"/"End time"/"Ends")` |

Nejcitlivější je test **„asks for a name and a time first, the rest on request"**
(ř. ~2503): asertuje výšku bubliny `< 420`, `bubble.getByRole("combobox")`
**pozičně, bez jména** (předpokládá právě jeden combobox v bublině) a negativní
inventář (`getByPlaceholder("Add location")` count 0 atd.). Ten se bude
přepisovat celý.

**`data-*` polovina sady je vůči restrukturalizaci imunní** — `[data-day-key]`,
`[data-agenda-date]`, `[data-time-event]`, `[data-draft]`, `[data-ghost]`,
`[data-drag-preview]`, `[data-pending]`, `[data-range-selected]`,
`[data-drop-target]`. Ty musí projít **nedotčené**. Když padne jeden z nich,
regredovalo chování, ne selektor.

Nové testy: `Segmented` klávesnice (šipky, Home/End, role), varianty `Row*`,
parsování v `TimePicker`, Microsoft snapping v `ColorPicker`, jeden
`expectNoAccessibilityViolations` na každý přestavěný dialog a e2e na každý picker
(vyber datum → event tam sedí; vyber čas; vyber barvu kalendáře → swatch i zápis).

Vizuální kontrola po každé fázi: dočasný Playwright test se `page.screenshot` na
1280×720 a 390×720, pak ten test smazat. Poslední tři reálné defekty (řádky chipů
vyhozené z linky, neviditelná ikona ve zúženém searchi, prsten rozsekávající
víceденní pruhy) chytil screenshot, ne test.

## Pasti, na které jsme už narazili

Tohle stálo čas; nekopejte to znovu:

- **`animation` s `fill-mode: both` přebíjí inline `transform`.** Držel poslední
  keyframe, takže přesunuté okno stálo na místě. Řešení: `animation: none` na
  přesunutém stavu (`.popover[data-moved]`).
- **Radix pozicuje popper inline transformem na wrapperu.** Sheet pod 600px se
  dělá přepisem `:global([data-radix-popper-content-wrapper])` na
  `position: fixed` + `transform: none !important`, ne druhou komponentou.
- **`elementFromPoint` vrací jen nejvyšší prvek.** Při dragu je to popover, takže
  hit-test cíle „nenašel nic". Používat `elementsFromPoint` a projít stack
  (`dayKeyAtPoint` v `use-time-grid-drag.ts`).
- **Uchopitelná plocha nesmí být označitelný text** — tažení selekce Chromium
  gesto zruší. `user-select: none` + `touch-action: none`.
- **Gesto končí clickem.** Ten otevíral detail právě přetaženého bloku a zavíral
  popover draftu. `swallowNextClick()` po skutečném dragu, ne po každém stisku.
- **Změna date/view = nový query key = `isPending` = celý workspace se vyměnil za
  loading screen** a ztratil focus, scroll i stisknuté klávesy. Drží to
  `placeholderData: keepPreviousData` na event query.
- **Axe v e2e jede bez filtrování pravidel** na tom, co je právě otevřené. Malý
  text v `--text-muted` uvnitř dialogu spadne na kontrastu (3,22:1) — ne
  v review, ale v testu.
- **`pnpm dev` v rootu spouští i astro**; když ho zabiješ přes `timeout`, turbo
  a děti přežijí a astro nechá `packages/docs/.astro/dev.json` s mrtvým PID →
  příště `pnpm dev` padá na „Another astro dev server is already running".
  Úklid: `cd packages/docs && pnpm exec astro dev stop`. Playwright si server
  startuje sám (`apps/web`, jen vite) — na ověřování používat e2e, ne vlastní
  dev server.

## Kontext, který se nedá vyčíst z kódu

- Google Calendar je **referenční úroveň disciplíny, ne vizuální předloha**.
  Nekopírujeme paletu, ikony, typografii ani microcopy — Musubi má vlastní
  identitu (sumi tonalita, Inter Tight + Noto Serif, kanji akcenty, pigmenty) a
  vlastní doménový koncept **Pages**, který referenční produkt nemá.
- „Parita s mobilem" znamená **stejnou doménovou možnost a konzistentní výsledek,
  ne identický layout s telefonem** (`store/musubi-web-handoff/05-frontend-implementation.md` §12).
- Vizuální polish je v `docs/ui/calendar-ui.md` §1 **poslední** v prioritě. Nikdy
  neposouvat pixely, když není deterministická geometrie času nebo chybí rollback
  mutace. Tahle práce je legitimní právě proto, že A–F jsou hotové.
