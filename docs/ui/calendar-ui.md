# Kalendářové UI/UX — pravidla a plán polishe

- Stav: living document
- Datum: 2026-07-29
- Zdroj principů: `store/UI-UX/` (playbook, spec, studie Google Calendar)
- Platí pro: `apps/web` primárně, `apps/client` kde to má smysl
- Navazuje: [`ui-restructure-handoff.md`](./ui-restructure-handoff.md) —
  sjednocení dialogů, primitiva v `src/ui/` a vlastní date/time/color pickery
  (dokončeno 2026-07-29)

Studie Google Calendar je **referenční úroveň disciplíny, ne vizuální předloha**.
Kopírujeme způsob skládání vrstev a míru závaznosti akcí. Nekopírujeme paletu,
ikony, typografii ani microcopy — Musubi má vlastní identitu (sumi tonalita,
Inter Tight + Noto Serif, kanji akcenty, pigmenty dune/moss/ochre/indigo) a
vlastní doménový koncept **Pages**, který referenční produkt nemá.

## 1. Jak rozhodovat, když si pravidla odporují

V tomto pořadí, vždy:

1. časová a datová korektnost,
2. přístupnost a vratnost akcí,
3. kontinuita kontextu,
4. srozumitelnost interakce,
5. výkon,
6. vizuální polish.

Vizuální polish je **poslední**. Nikdy neposouvej pixely, když ještě není
deterministická geometrie času nebo chybí rollback mutace.

## 2. Domácí pravidla

**R1 — Kalendář je prostorový editor času, ne tabulka.** Datum = poloha, čas =
vertikální poloha, délka = velikost, souběh = uspořádání. Když se s časem nedá
manipulovat přímo, je to prohlížeč s formuláři.

**R2 — Stálá orientace.** Uživatel vždy vidí aktivní rozsah, pohled, cestu na
dnešek, prev/next a Create. Běžná akce nesmí bezdůvodně změnit datum, pohled,
scroll ani aktivní objekt.

**R3 — Vrstva odpovídá závaznosti.** Lehká akce nesmí otevřít těžkou vrstvu:

| Vrstva | Otázka | Závaznost | V Musubi |
| --- | --- | --- | --- |
| Slot / buňka | Kdy? | velmi nízká | selection v gridu |
| Nový event | Co, kdy a kam? | nízká–střední | `QuickCreate` v pravém `Inspector` panelu |
| Preview | Co to je, co teď můžu? | nízká–střední | `EventDetailsPopover` v pravém `Inspector` panelu |
| Full editor | Jak se to má přesně chovat? | vysoká | `EventEditorForm` |
| Dialog dopadu | Koho/co to ovlivní? | velmi vysoká | recurrence scope, nevratné |

**R4 — Lokální akce má lokální reakci.** Klik na slot zachová výběr v gridu a
otevře pravý panel s jeho datem a časem. Panel na desktopu překryje pravý okraj kalendáře bez změny jeho šířky.
Nezakrytá část zůstává interaktivní. Validace je u pole, které ji způsobilo. Drag ukazuje čas u taženého objektu.

**R5 — Dvě rychlosti, bez ztráty draftu.** Quick create ↔ full editor si předají
všechno rozpracované. Editor nikdy nezakládá nový prázdný draft.

**R6 — Vratné akce mají Undo, ne dialog.** Dialog jen pro: nevratné, externí
dopad, rozsah série, konflikt oprávnění. `window.confirm` není cílový stav —
je to placeholder.

**R7 — Jedna geometrie času.** Grid, event layout, selection, hit-testing a drag
musí číst stejné hodnoty (`pxPerMinute`, `snapMinutes`, `minEventHeight`,
`visibleDayStart/End`). Dvě různé matematiky = kurzor „ujíždí" oproti času.

**R8a — Držet, dokud zápis nedosedne.** Pointer mašina nesmí uklidit svůj
vizuální stav dřív, než se změna projeví v datech. React Query notifikuje
odběratele **v pozdějším ticku**, takže „uklidit hned" znamená jeden frame se
starým stavem — blok skočí zpátky na původní čas a pak na nový, řádek problikne
starým pořadím. Proto `release()` (odpojí pointer, blok nechá na místě) a
`finish()` až v `.finally()` commitu; u seznamu Pages totéž řeší lokálně držené
`committedOrder`.

**R8 — Optimisticky, s rollbackem.** Mutace se projeví okamžitě, chyba vrátí
stav a **řekne to lidsky**: co selhalo, proč, co dělat, že byl stav obnoven.

**R9 — Barva nikdy nenese význam sama.** Vždy doplněná textem, ikonou nebo
borderem. Platí pro kalendáře, stavy i typy.

**R10 — Přístupnost je architektura, ne dodatek.** Focus-visible, návrat focusu
na spouštěč, klávesnicová cesta k core workflow, screen-reader názvy. Drag musí
mít klávesnicovou alternativu.

**R11 — Stav je vidět.** Každý interaktivní prvek: default, hover, focus-visible,
pressed, selected, dragging, resizing, pending, disabled, error.

**R11a — Stavy se kombinují, nepřepisují.** `:hover` na vybraném prvku **posune
jeho vlastní barvu**, nikdy ji nenahradí neutrální hover plochou. Pozor na
specificitu: `.x:hover:not(:disabled)` (0,3,0) přebíjí `.x[data-selected]`
(0,2,0), takže vybraný prvek pod kurzorem zbělá, pokud pár `[selected]:hover`
neexistuje. Nudge dělej `color-mix(in srgb, var(--control-fill) 88%,
var(--control-on-fill))` — míchá k vlastní barvě textu, takže jedno pravidlo
platí v light i dark. Barevný objekt (event) se na hover nepřebarvuje vůbec, jen
`filter: saturate()`.

**R11d — Shell není dokument.** Kalendářová plocha má `user-select: none` a
`cursor: default`: tažení po ní vyrábí eventy a Chromium **ruší pointer gesto** ve
chvíli, kdy se z něj stane označování textu — takže nechtěná selekce není kosmetika,
ale rozbité gesto. Vstupní pole jsou výjimka (`user-select: text`), a protože Radix
portáluje vrstvy do `body`, dialogy, popovery i detail eventu zůstávají čitelné a
kopírovatelné. Kdo chce zkopírovat název eventu, otevře jeho preview.

**R11b — Focus ring patří klávesnici.** `:focus-visible` sám nestačí: při
*programatickém* focusu (dialog otevře první pole, focus se vrací na spouštěč)
prohlížeč hádá a Chrome hádá „ukázat". Myšímu uživateli tak ring bliká po každém
zavření dialogu, což čte jako glitch. Modalitu proto držíme sami
(`src/design/focus-mode.ts`): jakákoli klávesa, která není psaní, ring **nabije**,
další pointer stisk ho **odpojí**; do té doby je `outline-color: transparent`.
Klávesová cesta tím nepřijde o nic, což je ta nediskutovatelná část.

**R11c — Vyplněná plocha je vlastní kontext, ne výjimka.** Když control sedí na
`--control-fill` (vybraný řádek, filled chip), nepřepisuj mu jednu vlastnost po
druhé — **přemapuj tokeny pro ten podstrom** (`--text-secondary`, `--text-muted`,
`--surface-raised`, `--border-strong` odvozené z `--control-on-fill`). Sdílená
hover pravidla si pak vezmou správnou paletu sama, funguje to v obou tématech a
další control přidaný do toho řádku už žádný override nepotřebuje. Viz
`.pageRow:has([data-selected])`.

**R4b — Vrstva nesmí prosáknout do plochy pod sebou.** React portály bublají
eventy do **React** rodiče, ne DOM rodiče: popover vyrenderovaný z buňky Month
posílá svůj `pointerdown` do handleru té buňky, takže stisk v preview startoval
drag-to-create pod ním (a označit text v preview tím bylo nemožné). Content každé
vrstvy proto zastavuje `pointerdown` i `click`. Platí pro každou novou vrstvu
rendered z interaktivní plochy.

**R4c — Focus mimo vrstvu není rozhodnutí ji zavřít.** Radix zavírá vrstvu, když
z ní odejde focus, což míchá dvě různé věci: modál, který přebírá řízení (ta
vrstva opravdu má jít), a focus, který jen opustil text — což dělá začátek
označování i vrstva, kterou nahrazujeme (při odchodu vrací focus na svůj původ,
takže zabila náhradu v okamžiku vzniku). Zavírá se jen ta první varianta,
predikát je `focusMovedToAnotherLayer()`.

**R4a — Anchor se nesmí hýbat, když je jeho vrstva otevřená.** Karta eventu se na
hover zvedá o 1 px; dokud u ní visí popover, zvedla by ho s sebou (a při hover-out
zase spustila). Radix značí spouštěč `data-state="open"` — geometrie se v tom
stavu zmrazí, barevný posun zůstává.

**R12 — Mobil/narrow se adaptuje, nezmenšuje.** Pod 600 px popover → sheet,
permanentní zóny → vrstvy. Zachovej v tomto pořadí: rozsah → Today/navigace →
event content → Create → přepnutí pohledu.

## 3. Tokeny a geometrie

Zdroj pravdy je [`apps/web/src/design/tokens.css`](../../apps/web/src/design/tokens.css).
Nové komponenty nesmí zakládat paralelní paletu ani vlastní škálu controlů.

Aktuální systém obsahuje:

| Rodina | Tokeny / kontrakt |
| --- | --- |
| plochy a text | `--surface-*`, `--border-*`, `--text-*`, světlé i tmavé téma |
| typografie | `--font-*` a škála `--text-10..--text-26` |
| spacing | `--space-1..--space-8` (`4 / 8 / 12 / 16 / 20 / 24 / 28 / 32`) |
| radiusy | `--radius-sm/-md/-lg/-pill/-sheet/-card/-control/-chip`, `--event-radius` |
| ovládání | `--control-height`, `--row-min-height`, `--focus-ring` |
| kalendář | `--sidebar-width`, `--toolbar-height`, `--date-header-height`, `--hour-height`, `--popover-width` |
| motion | `--motion-fast/-standard/-slow`; globální reduced-motion pojistka |

Layer and form spacing, responsive density, and ownership of shared alignment
axes are defined in [`design-system.md` section 4](./design-system.md#4-geometry-and-rhythm).
Those rules apply to every calendar layer; feature CSS must not establish a
competing inset or rhythm.

Web portal ordering uses `--layer-*-z` tokens. An elevated shared Dialog passes
its layer context to descendant Popover and Menu surfaces, including their
Radix positioning wrappers. Child pickers must remain clickable above the
dialog in both anchored and narrow sheet layouts; features do not set z-index.

Event creation uses the same right Inspector and complete EventEditorForm as
editing. Desktop panels overlay the right edge of the workspace without reserving width.
Calendar columns and toolbar typography retain their geometry while the panel is open.
Event and task inspectors share a 540 px desktop width. Their header can detach the
inspector into a floating window and dock it again without replacing the form or
its draft. Drag the floating header, or focus its move handle and use arrow keys
(Shift moves farther). Placement stays within the viewport and is retained when
switching a task between detail and edit. The Appearance setting “Open details as”
stores the default in this browser only; a header toggle affects the current
window. Below 1024 px, either preference uses the existing modal panel.
Task forms align their grid rows at the top of the body; spare height belongs to
the scroller, not the spaces between fields.
Closing reveals the covered controls and days. Calendar gesture handlers ignore
portaled dialog content; inspectors allow native clicks to bubble so nested
pickers can dismiss on an outside press within the inspector.
Narrow screens retain a modal panel. Toolbar, search, keyboard, month cells and time-grid gestures preserve
their date/time defaults and return focus. The header and actions stay fixed;
fields share one scroller. The displayed all-day end date is exclusive; the
form adapts it to Musubi’s inclusive last date for drafts and writes. During creation,
the header’s expand icon widens the same mounted form over the current calendar:
no navigation, URL changes or draft handoff. Collapse restores the previous panel
or floating placement. Draft identity, exact DST-fold instants and failed-save
feedback survive either direction. Existing-event editing can still open its full
editor route. The panel footer only contains Cancel and Save/Create.

Only one object inspector is active. Clicking outside event details keeps them
open; the close button or Escape dismisses them, and another event trigger
switches the selected object. Imperative creation entry points use
`requestInspectorTransition` so an edited event or new draft can guard a
replacement. A new range gesture retains the old draft until the user accepts
the replacement; moving the existing draft changes the same form. Unsaved
changes require an explicit discard, and pending saves prevent closing or
moving the draft. Persistent desktop editors do not consume grid presses as layer dismissals;
read-only details, modal inspectors and nested pickers still do.

Meeting creation has one workspace dialog with a calendar picker. The toolbar
Create menu opens it without a preset; a calendar row's meeting icon presets
that calendar. Only verified provider capabilities appear in the picker. A
missing preset requires an explicit alternative, switching preserves draft
content and intended instants, and submitted retries retain their original
calendar and request. Closing returns focus to the entry point. Background
invitation information lives behind the header’s Info button; the primary action
still explicitly says it sends invitations. Cancellation confirmations retain
their consequences in the visible description.

`--hour-height` nastavuje renderer z téhož `TimeGeometry`, který používá
hit-testing, event layout i drag. Není dovoleno zavést druhou pixelovou
konstantu pro tutéž časovou osu.

### 3.1 Sdílená UI vrstva

Znovupoužitelné ovládací prvky žijí v
[`apps/web/src/ui/`](../../apps/web/src/ui/). Feature komponenta může vlastnit
obsah a jeho doménové uspořádání, ne novou skořápku dialogu nebo šestnáctý
vzhled tlačítka.

| Potřeba | Použít |
| --- | --- |
| akce a ikonová akce | `Button` / `IconButton`; navigace zůstává odkazem s `buttonClassName` |
| zrušení akce | vždy `variant="secondary"` — stejná role musí mít stejnou váhu; `variant="text"` je pro terciární věci v toku („More options", „Back to calendar") |
| modal / confirm | `Dialog` / `DialogClose` — jedna hlavička, focus trap, návrat focusu, mobilní sheet |
| lightweight anchored layer | `PopoverContent` + Radix-backed `Popover*` exports — shared portal, surface, collision gutter and mobile sheet; the feature owns semantics and focus policy |
| short command list | `MenuContent` / `MenuItem` — Radix-backed roving focus, typeahead, Escape and focus return; never wrap one direct action in a menu |
| popsané pole | `Field` — label, description a error vazby generuje komponenta |
| řádek nastavení či seznamu | `RowAction` / `RowToggle` / `RowOptions` |
| malá volba | `Segmented`; boolean `Switch` / `Checkbox`; delší seznam `Select` |
| datum, čas a barva | `DatePicker` / `TimePicker` / `ColorPicker`, ne nativní browser picker |
| prázdno, sekce, feedback | `Empty` / `SectionLabel` / `Toast` |
| route a auth plocha | `RouteState` / `AuthShell` |

Varianty patří do API primitiva (`variant`, `size`, `layout`), ne do
descendant selektoru obrazovky. Moduly v `calendar/components/styles/` smějí
popisovat jen doménový obsah uvnitř sdílené skořápky. `PopoverContent`
deliberately does not define a role, keyboard model, or focus policy: a
select-only combobox, editable time combobox, and event preview share a physical
layer, not one interaction model.

Responzivní ladder je jediný:

- `≤599`: overlay drawer, FAB, popover → sheet;
- `600–1023`: overlay/compact drawer;
- `1024–1439`: permanentní sidebar, kompaktní desktop chrome;
- `≥1440`: plný desktop shell.

Vizuální hierarchie: mřížka nízký kontrast → **eventy dominantní**; dnešek
zvýrazněný bez zabarvení celého sloupce; now indicator jediný svého typu;
destruktivní barva jen kontextově.

## 4. Interakční stavový automat (cíl)

```text
idle
├── pointerDown na eventu -> pressCandidate
│   ├── release < threshold -> openPreview
│   ├── move > threshold    -> dragging
│   └── pointerCancel       -> idle
├── pointerDown v gridu -> selecting (drag-to-create)
├── Enter na eventu     -> openPreview
├── Enter v gridu       -> quickCreate
└── resizeHandleDown    -> resizing

dragging / resizing
├── pointerMove -> updateGhost + autoScroll   (žádná síť!)
├── pointerUp   -> optimisticCommit -> idle
└── Escape      -> rollback -> idle
```

Bez explicitního automatu se click, drag, resize, long-press a scroll začnou
míchat — to je zdroj náhodných popoverů a ztraceného focusu.

## 5. Kde `apps/web` stojí (audit 2026-07-27)

**Hotové (a dobré):**

- Shell: toolbar s rozsahem, Today, prev/next, view switcher, Create; sidebar
  Pages + Calendars.
- Views: Month (+N overflow), Day/Week time grid (all-day řádek, now marker,
  overlap layout), Agenda.
- **Sdílená a testovaná časová geometrie** v `@musubi/calendar/layout`
  (`overlaps`, `all-day-spans`, `month-grid`, `ranges`, `layout.test.ts`) →
  playbook „Gate 1" je v podstatě splněná, jsme legitimně ve fázi 2.
- Vrstvy závaznosti: slot → QuickCreate → EventDetailsPopover → EventEditorForm.
- Permission gating přes sdílené `can()`; Pages s explicit save a 409 conflict UI.
- SSE realtime, offline/error stavy, light/dark, `prefers-reduced-motion`.
- Klávesnice: `c` create, arrows/Home/End/PageUp/Down scroll v gridu, navigace
  buněk v Month, Escape zavírá, `Ctrl/Cmd+S` v Page editoru.

**Mezery proti referenci (ověřené greppem, ne dojmem):**

| # | Mezera | Dopad |
| --- | --- | --- |
| G1 | **Žádná přímá manipulace** — chybí drag-to-move, resize, drag-to-create | největší; produkt působí jako prohlížeč s formuláři (porušuje R1) |
| G2 | **Žádné Undo** — mazání jde přes `window.confirm` | R6; každá vratná akce platí cenu dialogu |
| G3 | `HOUR_HEIGHT = 64` hardcoded v komponentě → **žádná density/zoom** | R7; a Page config `density` **nikdo nečte** |
| G4 | Page config deklaruje `density`, `weekend`, `groupBy`, `showAdjacentDays` — **renderer je ignoruje** | mrtvý kontrakt, hotový hook nevyužit |
| G5 | Chybí mini calendar | skok na vzdálené datum jen přes prev/next |
| G6 | Neúplná klávesová mapa (chybí `T/D/W/M/A`, `E`, `Delete`, `/`, `?`), arrows scrollují místo pohybu focus buňky (žádný roving tabindex) | R10 |
| G7 | Toast bez akce — není snackbar s Undo | R6/R8 |
| G8 | Event blok neadaptuje obsah podle **vlastního** rozměru (žádné container queries) | krátké eventy nečitelné |
| G9 | Není viditelná selection layer po kliknutí do slotu | R4 |
| G10 | Chybí tokeny z §3 | R7 |

## 6. Plán polishe

Pořadí je dané prioritou z §1 a tím, co odemyká „pocit". **Fáze A je předpoklad
pro B** (snap potřebuje px/min jako data, ne magickou konstantu).

**Stav: A–F hotové** (2026-07-28). Zbytky jsou vypsané u jednotlivých fází —
žádný z nich neblokuje další práci. Dál platí §7 checklist na každý nový ticket.

### Fáze A — Geometrie a tokeny — **HOTOVO** (2026-07-27)

- Tokeny z §3 doplněné (`--space-*`, `--hour-height`, `--date-header-height`,
  `--event-radius`, `--focus-ring`, `--popover-width`, `--motion-slow`).
- `HOUR_HEIGHT = 64` → `time-geometry.ts`: `TimeGeometry` + čisté funkce
  (`minutesToY`, `yToMinutes`, `durationToHeight`, `gridHeight`). Čte to grid,
  event layout, hodinové linky, now marker, klávesnicový scroll **i
  pointer→čas** (dřív měl vlastní snap na 30 min, teď sdílených 15).
  CSS bere výšku z `--hour-height`, které nastavuje komponenta ze stejné
  geometrie → jedno číslo pro JS i CSS.
- **`density` z Page configu zapojená**, rozšířená na 3 stupně
  (`compact 44 / comfortable 64 / spacious 88`); přepínač v edit módu, ukládá se
  s Page. Draft ukazuje náhled živě.
- Scroll: jeden effect vlastní pozici. Změna rozsahu → ukotví u pracovní hodiny;
  změna density → **přepočítá scrollTop**, aby zůstal vidět stejný čas (jinak
  by stejný pixel ukazoval jinou hodinu).
- Testy: 11 unit testů geometrie (round-trip ve všech hustotách, snap, clamp,
  min height) + e2e, že density mění výšku mřížky a uloží se.

- `weekend` a `showAdjacentDays` zapojené: weekend filtruje **podle dne v týdnu**
  (platí pro oba week starty), den nikdy nezmizí; skrytý cizí měsíc si nechá
  buňku (výška měsíce se nemění), jen nemá obsah, klik ani počet eventů v SR
  názvu. Oba přepínače v edit módu.

Tím je fáze A uzavřená — mrtvý kontrakt `PageConfigV1.view` je celý živý.

### Fáze B — Přímá manipulace

**B1 — drag-to-move + resize: HOTOVO** (2026-07-27)

- Pointer automat v `use-time-grid-drag.ts` podle §4: press → threshold (4 px) →
  drag/resize → commit/rollback. Listenery se navěšují **při stisku**, ne
  z effectu (jinak by se re-registrovaly při každém pohybu ghostu).
- Čistá matematika v `time-grid-drag.ts` (+16 testů): absolutní snap na 15 min
  (event mimo mřížku se srovná), zachování délky u move, **nikdy neinvertuje**
  event při resize (jeden interval vždy zůstane), clamp na hranice dne,
  auto-scroll s rampou u okraje, day index z pointeru.
- Živý čas přímo v bloku (ukazuje čas dropu, ne původní), elevace + `grab`
  kurzor, **highlight cílového dne** při přesunu mezi dny, `ns-resize` úchyty
  8 px nahoře/dole (zvýrazní se až při hoveru).
- Escape ruší drag (`stopPropagation`, aby nezavřel celou obrazovku), pointer
  cancel taky; nulová síťová mutace během pohybu — commit až po dropu, chyba
  vrátí blok na serverovou pravdu a řekne to.
- Gating: `canEditEvent` + žádný drag u **opakovaných** eventů, protože update
  dnes mění celou sérii — tichý přesun série je přesně ten skrytý dopad, který
  pravidla zakazují. Scope dialog patří do C, kde se dialogy staví.

**B2 — drag-to-create + klávesnice: HOTOVO** (2026-07-27)

- `useDragToCreate`: tažení přes prázdnou mřížku vybere interval (funguje i
  nahoru), **selection layer je vidět dřív, než se popover otevře** (§R4, G9),
  s časovým rozsahem. Po uvolnění se délka přenese do QuickCreate — `endTime`
  prošlo až do `defaultEventFormValues`, takže se místo výchozí hodiny použije
  vytažený interval.
- Klik zůstal klikem: po dragu se trailing click **spolkne** (`consumeClick`),
  jinak by uvolnění vytvořilo druhý event.
- **Klávesnicová alternativa** (§R10): `Alt+↑/↓` posune o snap interval,
  `Alt+Shift+↑/↓` mění délku. Používá **stejnou** `nextDragTimes` matematiku
  jako myš, a výsledek se **oznámí** do notice live regionu — bez toho by
  screen-reader uživatel neměl potvrzení.

**B3 — Month + persistence selection: HOTOVO** (2026-07-27, po zpětné vazbě)

- **Month drag-to-move** (`useMonthDrag`): tažení chipu na jinou buňku změní
  **jen datum**, čas a délka zůstanou; cílová buňka se zvýrazní (`data-drop-target`
  jako v time gridu), Escape ruší, chyba vrátí. Stejné gating (role + žádné
  opakované). Resize v Month nemá smysl (buňka není časová osa).
- **Selection zůstává vidět, dokud je quick create otevřený.** Odvozuje se
  z `pendingCreate` (otevřený intent), ne z drag stavu — takže platí i pro
  **klik**, ne jen tažení. Dřív zmizela v okamžiku, kdy se popover otevřel, což
  bylo proti §8.2.

**B3a — Month drag kreslí ghost, ne obarvené buňky: HOTOVO** (2026-07-30)

Tažení přes buňky Month dřív obarvovalo dotčené buňky (`data-range-selected`) a
pill „New event" se objevil až po puštění. Teď se **od prvního pixelu za
thresholdem kreslí tentýž pill**, takže gesto odpovídá tím, co vyrobí — stejně
jako time grid maluje blok, který vzniká. Cell tint je smazaný: dvě značky pro
jednu věc jsou šum a obarvená mřížka nesedí do stylu. Živý pill má
`pointer-events: none` (gesto vlastní buňka pod ním) a po puštění se z něj beze
změny vzhledu stane grabbable draft — žádný přeskok mezi „taženo" a „vytvořeno".

**B3b — Druhý draft nahradí první, ne oba: HOTOVO** (2026-07-30)

Když byl otevřený draft a začalo se tahat jiný, po puštění zmizely **oba**.
Příčina nebyla v gestu: odcházející popover při unmountu vrací focus na svůj
původ (`onCloseAutoFocus`), nově namountovaný to přes Radix vyhodnotí jako
interakci mimo sebe a zavře se — viz R4c. Navíc první draft teď padá **hned při
stisku** nového gesta (`onCancelDraft` v Month i time gridu), takže na obrazovce
nikdy nejsou dva rozpracované eventy.

**B3c — Překryv: karty přes sebe, ne slivery: HOTOVO** (2026-07-30)

Week kaskádovala pevných 8 px na úroveň (mobil dělá totéž s 10 px), takže
z eventu pod ním zbyl proužek, ve kterém nebylo nic — ani název, ani čas. Day
zase dělil na přesné rovné sloupce. Teď je **jedno pravidlo pro oba**
(`overlapPlacement()` v `time-grid-math.ts`): lane = rovný podíl sloupce, ale blok
se rozlévá `LANE_SPREAD = 1.7` lane doprava a kreslí se nad tu vedlejší. Dva
překryvy tedy vyjdou na `0–85 %` a `50–100 %` — čte se to jako široká karta
s druhou položenou přes její rok, což je referenční chování Google Calendaru.
Klastry hlubší než `MAX_OVERLAP_LANES = 4` se skládají na poslední lane (z-order
pořád drží pozdější nahoře); tam by se teprve vyplatilo „+N more".

Blok, který leží nad jiným, má **prstenec v barvě plochy** (`data-overlapping`):
dva eventy z jednoho kalendáře mají stejnou barvu a bez mezery splynou v jeden
tvar, ve kterém je odlišuje jen text. `apps/client` má zatím pořád pevných 10 px —
sdílená není matematika, jen ta čísla, takže při další úpravě mobilu je vzít odsud.

**B9 — Ghost na místě, event tam, kam se táhne: HOTOVO** (2026-07-28)

Předtím zůstával tažený blok ve svém sloupci a jen měnil čas; cílový den se
zvýrazňoval zvlášť. To bylo dokumentované jako záměr, ale je to špatně: u tažení
napříč dny odpověď „kam to spadne" nesla jen výplň sloupce, a v Month nebyl
tažený chip vidět vůbec.

- **Move**: na původním místě zůstane **ghost** (obtah + slabá výplň), a event se
  vykreslí jako **preview v tom sloupci/buňce, nad kterou je kurzor**, s časem,
  který by dostal. Takže tažení do strany je vidět.
- **Resize** zůstává v místě — tam ghost nemá co říct, blok sám roste.
- Month preview je chip **za** existujícími segmenty v buňce: vložený dopředu
  posunul víceденní pruhy o řádek a rozbil jejich návaznost.
- Karty eventů dostaly **jemný drop shadow**, aby dvě stejně barevné karty na
  sobě čtly jako dvě. Prsten z barvy plátna jsme zkusili a zahodili — u pruhů,
  které pokračují do další buňky, rozsekal jeden event na několik, a shadow sám
  to oddělení unese.

**B8 — Okno tvorby se dá odtáhnout: HOTOVO** (2026-07-28)

- Bublina se táhne za svou hlavičku (`data-drag-handle`) a **clampuje se na
  plochu kalendáře** — `clampOffset` posouvá offset, ne kurzor, takže se okno
  nedá zaparkovat tak, aby jeho vlastní tlačítka byla mimo. Čistá funkce s testem
  (`window-drag.ts`), gesto zvlášť (`use-window-drag.ts`) — stejné dělení jako u
  time gridu.
- Zůstává ukotvené a hýbe se transformem, takže se nic nemusí přepočítávat a
  žádná collision logika ho uprostřed tažení nepřehodí na druhou stranu.
- Pod 600 px se gesto **vůbec nenabízí**: tam je z bubliny sheet, který má jedno
  místo, kde být.
- Po přesunu zmizí šipka (ukazovala na anchor, který okno opustilo) a **vypne se
  otevírací animace** — animace s `fill-mode: both` drží svůj poslední keyframe
  a přebíjí inline transform, takže by okno zůstalo stát na místě.

**B7 — More options je vrstva nad kalendářem: HOTOVO** (2026-07-28, přepsáno
2026-08-27)

- Full editor byl nejprve **stránka** na `/app/p/$pageId/event/new`. Teď je to
  **modal** ve velikosti `workspace` (stejná vrstva jako share dialog) na
  `/app/p/$pageId/$view/event/new`, protože „odejít z editoru" nikdy nebyla
  navigace jinam — byl to návrat k tomu, co je za ním.
- Kvůli tomu je editor **dítě view routy**: rodič zůstane namountovaný, takže
  kalendář za modalem nezmizí a nepřekresluje se. Dřív se odmountoval celý.
- Staré URL bez view segmentu **redirectují** — tvar draftu v search se nemění,
  takže i link napsaný před tou změnou editor otevře.
- Dokud je editor otevřený, **kanonizace Page id v rodiči se vypíná**
  (`useChildMatches`). Jinak by stará Page id v odkazu editor rovnou zavřela:
  redirect na `/$view` by tu vrstvu shodil s sebou.
- **Draft cestuje v URL**, ne v paměti: stránka jde reloadnout i nalinkovat a
  rozdělaný event se neztratí (`title`, `date`, `startTime`, `endTime`,
  `endDate`, `allDay`, `location`, `description`, `url`, `recurrence`,
  `attendees`, `calendarId`).
- `returnDate` je **oddělený** od data draftu: odchod ze stránky nesmí uživatele
  potichu přesunout na jiný týden (R2). Uloží se → vrátí se tam, odkud přišel.
- `EventEditorForm.onExpand` rozhoduje, kam „More options" vede. Když ho nikdo
  nepředá (unit testy, embedding bez routeru), formulář se rozbalí na místě —
  jedna komponenta, dvě umístění, ne dva formuláře.
- **Editace má vlastní vrstvu** na `/app/p/$pageId/$view/event/$eventId`; rychlá
  editace zůstává v popoveru a „More options" ji předá modalu.

**B6 — Quick create je konečně quick: HOTOVO** (2026-07-28)

Bublina pro tvorbu byla celý editor v popoveru (~700 px, deset bloků) — což je
proti R3: lehká akce nesmí otevřít těžkou vrstvu.

- `EventEditorForm` má `compact`: viditelné zůstane **jen to, bez čeho event
  nemůže existovat** — název, kdy, do kterého kalendáře. Místo, poznámky, odkaz,
  opakování, hosté a „Also show in" jsou za jedním **More options**.
- Není to druhý formulář. Stejná komponenta, stejná validace, stejný submit —
  odhalení mění jen kolik je na obrazovce, takže rozepsaný draft přechodem
  nemůže zmizet (R5). Full editor (edit eventu) zůstává celý, bez disclosure:
  tam je vysoká závaznost na místě.
- Výška bubliny ~700 → ~360 px, primární akce je vidět bez scrollu.

**B5 — Draft jako položený, uchopitelný blok: HOTOVO** (2026-07-28)

Předtím byl výsledek drag-to-create jen zvýrazněný pruh: co jsi vytáhl, to jsi
měl. Teď je z něj **draft** — blok/pilule, která na kalendáři leží a dá se hýbat,
dokud se neuloží.

- Time grid: draft se dá **táhnout i resizovat** (`useTimeGridDrag`, druhá
  instance téhož automatu — commituje do otevřeného formuláře, ne na server).
  Hook je teď generický v tom, *co* se táhne (`useTimeGridDrag<T>`), aby draft
  nemusel předstírat, že je `Event`.
- Month: draft je **jedna pilule přes celý rozsah** (plochá tam, kde pokračuje do
  další buňky), uchopením se posune celý rozsah. Tint pod ní zmizel — dvě značky
  pro jednu věc jsou šum; tint teď označuje jen rozsah, který se právě vytahuje
  (tam pilule ještě není).
- Draft je pojmenovaný („New event") a nese svůj čas — čte se jako event, ne jako
  výběr. Název se objeví, až když má blok výšku (stejné container query jako
  reálný blok).
- Formulář převezme nový čas přes `when` (`EventEditorForm`), který přepíše
  **jen** „kdy" — rozepsaný název přežije přetažení. Intent si drží `id`, takže
  se popover neremountuje.
- Popover se otevírá **vedle** slotu (`side="right"`, anchor na pravé hraně
  sloupce / poslední buňky rozsahu), ne přes něj. Jinak by „draft se dá chytit"
  byla lež — bublina ho zakrývala.
- Tři chyby, které to odhalilo a které platily i pro reálné eventy:
  1. Gesto končí **clickem**, který otevíral detail právě přetaženého bloku a
     zavíral popover draftu (`swallowNextClick`, jen po skutečném dragu).
  2. Hit-test cílového dne bral jen nejvyšší element, což byl při dragu popover
     → „žádný cíl" (`dayKeyAtPoint` prochází celý stack).
  3. Uchopitelná plocha nesmí být zároveň označitelný text: tažení selekce
     Chromium gesto zruší (`user-select: none`).

**B4 — Month drag-to-create: HOTOVO** (2026-07-27)

- `useDayRangeCreate`: pointerdown na prázdné místo buňky → sleduje
  `[data-day-key]` pod kurzorem → normalizovaný rozsah (tažení dozadu je stejně
  platné). Buňka nemá časovou osu, takže výsledek je **all-day rozsah**, ne
  interval — quick create se otevře s `isAllDay: true`, `date` = začátek,
  `endDate` = konec.
- Rozsah je zvýrazněný během tažení i po dobu, co je popover otevřený
  (`data-range-selected`, stejný zdroj `pendingCreate` jako v B3).
- Prostý klik si drží svou cestu (jednodenní timed event); trailing click po
  tažení se spolkne přes `consumeClick`.
- `defaultEventFormValues` 4. parametr je teď objekt `{ endDate, endTime,
  isAllDay }` — gesto předá to, co odvodilo, zbytek má default.

Tím je fáze B hotová. Zbývá jen scope pro opakované eventy (patří do C).

### Fáze C — Vratnost

**C1 — Undo v toastu: HOTOVO** (2026-07-28)

- `Notify = (message, undo?) => void` (`src/calendar/notice.ts`). Undo se
  nepřidával jako abstraktní command model — reverzní akce je closure u místa,
  které mutaci provedlo, protože jen ono ví, co byl původní stav.
- Toast sedí **dole na střed** kalendářové plochy — tam ho lidi hledají, a je to
  z cesty toolbaru, ze kterého změna obvykle přišla. Na úzkém viewportu se zvedne
  nad create button, který vlastní pravý dolní rok. Toast s Undo žije 9 s
  (bez Undo 3,5 s): nabídka platí jen tehdy, když tam je
  ještě v okamžiku, kdy si chybu všimneš. Klik Undo nabídku hned sundá, aby se
  reverzace nedala přehrát dvakrát.
- Undo má: přesun a resize (time grid i month, včetně Alt+šipek), mazání eventu,
  odebrání jednoho výskytu / následujících.
- **Mazání běžného eventu je na jeden klik**, bez potvrzovacího kroku. Confirm
  zůstal jen tam, kde ho Undo nezastoupí: série (potřebuje rozsah) a kalendář
  s providerem (změna už odešla jinam, restore by tam vznikl jako nový event).
- Follow-up (2026-08-01): toast bez akce má symetrický horizontální padding,
  aby krátká zpráva nebyla uvnitř plochy natlačená doprava. Varianta s `Undo`
  si nechává původní těsnější pravý okraj pro tlačítko; její layout byl správně
  a nesmí se kvůli prostému toastu vyvažovat prázdným protějškem vlevo.

**C2 — Rozsah série + drag opakovaných: HOTOVO** (2026-07-28)

- `seriesEditWrites` (`src/calendar/recurrence-edit.ts`) vrací **data, ne
  volání** — `{ creates, updates }` — takže se každý rozsah dá zkontrolovat bez
  serveru a volající si řídí pořadí i undo.
- Tři rozsahy: `series` (posune master o stejný delta; resize hýbe jen taženou
  hranou), `occurrence` (EXDATE + odpojená kopie), `following`
  (`endSeriesBefore` + nová série). `remainderRule` v `@musubi/calendar` sníží
  `COUNT`, aby rozdělením série nevznikly occurrences dvakrát; `UNTIL` je
  absolutní, takže se nechává.
- Tím padlo gating v TimeGridView i MonthCalendar — **opakované eventy se dají
  táhnout**.
- Dialog se ptá **před** zápisem a v textu **říká nový čas**, protože kalendář za
  ním pořád ukazuje starý (nic se nezapsalo). Zavření dialogu nezapíše nic.

**C3 — Rozsah i pro editaci formulářem: HOTOVO** (2026-08-02)

- Editace jednoho výskytu přes formulář se ptá na rozsah stejně jako tah a
  mazání. Předtím tiše přepsala celou sérii: přetáhneš výskyt → zeptá se,
  přepíšeš mu název → změní všechny.
- `seriesEditWrites` bere `edited` (událost, jak ji uživatel opustil) místo
  `start`/`end`, takže jedna funkce unese změnu času i obsahu. `series` vezme
  nový obsah, ale posune se jen o **delta** — nastavit masteru datum výskytu by
  celou sérii přetáhlo na jedno datum.
- Rozepsaná změna čeká ve stavu, dokud otázka nedostane odpověď; zavření otázky
  nezapíše nic a formulář zůstane, jak byl.
- Dialog říká nový čas **jen když se čas opravdu změnil**; jinak se ptá na
  „změny“, ne na přesun.
- Vrstvy: popovery jsou nad dialogy (většina dialogů nějaký popover obsahuje),
  ale dialog vyvolaný **z** popoveru se musí povýšit — jinak se otázka schová za
  vrstvu, která ji položila. `Dialog` má na to `elevated`.

**C4 — Error copy podle čtyř otázek: HOTOVO** (2026-08-02)

Spec žádá po chybě čtyři odpovědi: *co selhalo · proč, když to víme · co s tím ·
jestli se stav vrátil*. Poslední chyběla skoro všude — hláška končila u „could
not be saved" a uživatel nevěděl, jestli jeho změna platí, nebo ne.

- Každá hláška teď říká, co zbylo: „…and is still applied", „The pages went back
  to the order they were in", „Nothing was added", „It went back to its previous
  value". Text se ověřoval **proti kódu** — u reorderu a settings se stav
  opravdu vrací, u mazání stránky opravdu ne.
- Settings ukazovaly **strojový kód ze serveru** („server") místo věty; raw
  `error.message` už uživatele nepotká, předává se jen `Request <id>`.
- `window.confirm` v discardu draftu už dávno není (nahrazeno
  `ConfirmationDialog`) — ta poznámka tu zůstala zastaralá.

**C5 — Parita mobilu: HOTOVO** (2026-08-02)

- `seriesEditWrites` se přesunul do `@musubi/calendar`, aby web i mobil sdílely
  jednu logiku a jeden test. Je **generický** přes `SeriesEditable` (start, end,
  id, recurrence), takže balíček nezískal závislost na `@musubi/types` ani na
  žádném rendereru, a každý klient si protáhne vlastní typ události.
- Id pro rozdělenou sérii se předává (`newId`): React Native nemá
  `crypto.randomUUID`, mobil dává svoje `uuidv7`.
- Mobil se teď ptá stejnou otázkou (`chooseOption`, jeho vlastní idiom) při
  uložení editace. Předtím `onEdit(master ?? event)` tiše přepsal celou sérii.
- `chooseOption` dostal `onCancel`: bez něj by čekající promise nikdy nedoběhla.
  Zrušení otázky **nezavře** composer — rozepsaná změna se neztratí, stejně jako
  na webu.
- Rozdělením vznikne nové id, takže připomínka za ním sama nepřejde. Odpojenému
  výskytu se kopíruje offset ze série; jinak by o ni tiše přišel.
- `apps/client` dostal **vitest** (`pnpm --filter @musubi/client test`, součást
  root `pnpm test`) — react-native a expo se mockují na švu, takže logika běží
  v nodu. Soubory jsou `*.spec.ts`: assert-based `*.test.ts` vedle nich si
  nechávají svůj běžec (tsx z root skriptu), jeden suffix na běžce.

Tím je fáze C uzavřená.

### Fáze D — Orientace a kontinuita — **HOTOVO** (2026-07-28)

- **Mini calendar** (`MiniCalendar.tsx`) v sidebaru: klik změní jen anchor date,
  view/filtry zůstanou. Jeden tab stop (den, na kterém view stojí), šipky hýbou
  focusem, šipka za hranu přelistuje měsíc — 42 tab stopů v sidebaru by pohřbilo
  všechno pod ním. Měsíc jde listovat samostatně a znovu se naváže na anchor,
  když se změní pod ním. Hlavička je „Aug 2026“, ne „August 2026“ — toolbar to
  už píše celé.
- **Klávesová mapa** (`shortcuts.ts`) jako **čistá funkce** `shortcutFor`, ne
  rozstřílená po handlerech: `d/w/m/a` view, `n/j` a `p/k` období, `t` dnes,
  `c` nový event, `/` hledání, `?` overlay, `Ctrl/⌘+S` uložení. Overlay
  (`ShortcutsDialog`) čte **tentýž** `SHORTCUT_GROUPS`, takže nemůže popisovat
  něco jiného, než co se posílá dál.
- Listener je na `window`, ne na elementu workspace: zkratka aplikace musí
  fungovat, i když není nic konkrétního zafokusované. Handler se čte přes ref,
  takže vidí aktuální stav bez re-registrace. Otevřená vrstva (`[role="dialog"]`,
  tedy i Radix popover) klávesy vlastní — písmeno za dialogem nesmí přepnout
  view pod ním.
- **Kontinuita při změně rozsahu**: `placeholderData: keepPreviousData` na event
  query. Předtím každá změna data/view udělala nový query key → `isPending` →
  celý workspace se vyměnil za loading screen a ztratil focus, scroll i
  stisknuté klávesy. Teď zůstane grid i toolbar, jen se ukáže „Refreshing“.
  (Chycené jako flake v e2e — byla to skutečná chyba, ne test.)
- **Focus po zavření**: Radix vrací focus na trigger sám; výjimky jsou vrstvy
  bez triggeru — quick create (`anchor.returnFocus`) a scope dialog, který si
  bere `document.activeElement` z okamžiku gesta, aby Alt+šipky vrátily focus na
  blok eventu.
- Roving tabindex v Month gridu byl už z fáze A/B; mini calendar ho má stejný.
- Kontrast: `.manageDialogHeader p` a nadpisy skupin v overlayi měly na 10 px
  `--text-muted` (3.22:1). Axe to zachytil v e2e; obojí je teď
  `--text-secondary`.

*Zbývá:* samostatná viditelná selection layer (dnes ji nese `pendingCreate` +
`data-range-selected`, což na R1 stačí).

### Fáze E — Craft eventu — **HOTOVO** (2026-07-28)

- **Container queries na bloku** (`container: timelineEvent / size`): blok se ptá
  své vlastní výšky, ne délky eventu. `title` vždy → `+ čas` od 30 px →
  dvouřádkový title od 44 px → `+ místo` od 58 px. Předtím o čase rozhodoval
  `duration >= 30` v JS, což přestane platit v okamžiku, kdy density nebo zoom
  změní výšku boxu při stejné délce.
- **`EventMarks`** (R9): opakování `Repeat`, hosté `Users`, read-only `Lock`.
  `aria-hidden`, protože label tlačítka to už říká — je to redundance pro oči,
  ne druhé oznámení. Barva zůstává jen identita kalendáře.
- **`pending`**: `data-pending` + `aria-busy` na bloku i chipu, dokud je zápis
  času v letu (`busyEventId` ve Workspace — jedno gesto, jedno id). Puls, který
  respektuje `prefers-reduced-motion`.
- **`read_only`**: `data-readonly` + zámek na bloku, ne až v popoveru.
- **`error` záměrně nemá stav bloku.** Chyba zápisu se vrátí (rollback) a řekne
  toastem; zaseknutý červený blok by tvrdil, že data jsou v nějakém rozbitém
  stavu, což nejsou — server o změně neví.

### Fáze F — Responzivita — **HOTOVO** (2026-07-28)

- **Popover → sheet pod 600 px v CSS, ne druhou komponentou.** Radix drží focus,
  dismiss i Escape; přepisuje se jen jedna věc — inline `transform` na
  `[data-radix-popper-content-wrapper]` (přes `:global`), plus `position: fixed`
  na spodní hranu. Druhá implementace „mobilního sheetu“ by byla druhá věc, co se
  musí držet v kroku. Platí pro quick create i detail eventu.
- **FAB je tentýž `.eventButton`,** jen přesunutý do dosahu palce
  (`position: fixed`, kruh, `env(safe-area-inset-bottom)`). Žádné druhé tlačítko
  → žádný druhý handler a druhý label. Toast se nad něj posune.
- **Pořadí zmenšování podle R12**: `Today` se pod 820 px už neschovává (jen mu
  ubere padding) — rozsah a navigace jsou v pořadí nad vším ostatním. Labely
  ustupují u view switcheru, který je v pořadí poslední.
- Chip v Month má teď explicitní mřížku `čas | title | marks` — implicitní tok
  by značky z fáze E zalomil na druhý řádek. Ikona v collapsed searchi dostala
  `flex: none`, jinak ji input vytlačil na nulovou šířku (pole vypadalo prázdné).
- Sheet záměrně **nemá scrim**: popover se zavírá klikem mimo, takže pozadí musí
  zůstat dosažitelné. Dialogy (settings, scope, shortcuts) scrim mají — ty jsou
  modální.

### Fáze G — Page settings jako dialog — **HOTOVO** (2026-07-30)

Editace Page se přesunula z inline edit mode do vlastního dialogu. Pencil sedí
na řádku Page v sidebaru (quiet, objeví se na `:hover`/`:focus-within`, na
`hover: none` je vidět vždy — hover nesmí být jediná cesta k funkci).

**Co zmizelo:** `SaveBar.tsx`, edit strip v toolbaru (`toolbarTop`,
`pageNameInput`, `pageEditOptions`), pencil v toolbaru a všechen draft state ve
`Workspace.tsx` (~150 řádků). Dialog je jediné místo, kde Page vzniká i mění se.

**Odchylky od dosavadních pravidel, s důvodem:**

- **Přišli jsme o live náhled** viditelnosti a density při editaci. Byla to cena
  za jedno místo editace místo dvou (§1: srozumitelnost nad efektem). Density se
  tedy projeví až po Uložit, ne při přetahování selectu.
- **Checkboxy kalendářů v sidebaru jsou teď *jen* dočasný filtr**, nikdy nic
  neukládají — jako v Google Calendaru. Uložená viditelnost Page se edituje
  výhradně v jejím dialogu. Po úspěšném uložení se dočasné přepnutí zahodí,
  jinak by invertovalo právě uloženou volbu.
- **Ikona Page je nové pole v `PageConfigV1`** (`icon`, `z.enum` s `.default`,
  ne volný string): klient jméno mapuje na komponentu, takže cizí hodnota by
  nebyla obrázek, ale chyba. Nová ikona = změna kontraktu, což je záměr.
- **Delete Page má confirm, ne Undo** — soft delete na serveru nemá restore
  endpoint, takže Undo by byl slib, který nesplníme (§2 výjimka pro nevratné).
  Skryté, dokud je Page poslední: server by ji hned backfillnul.
- `Ctrl/Cmd+S`, guard na neuložené změny a `beforeunload` se přestěhovaly do
  dialogu, který jako jediný drží draft a trapuje focus.
- **Tvorba Page má vlastní dialog** (`NewPageDialog`), ne `window.prompt` —
  ptá se na jméno a ikonu, zbytek Page zdědí ze stavu, ve kterém vznikla.
  Mřížka ikon je společná komponenta obou dialogů; radio pokrývá celou dlaždici
  (`inset: 0; opacity: 0`), ne 1 px schované, aby klik trefil samotný control.
- Ikona je v configu **optional**, ne defaultovaná: „ještě nevybráno" je reálný
  stav Pages uložených před ikonami a klient je kreslí jako dřív (domeček pro
  default Page, kalendář pro ostatní) — `resolvePageIcon()`.
- V `EventDetailsPopover` zmizela sekce „Add to calendar" se dvěma velkými
  řádky; Link a Fork jsou kompaktní tlačítka ve footeru, druhý krok (do kterého
  kalendáře) zůstal beze změny. Footer se smí zalomit — čtyři akce se do šířky
  popoveru nevejdou a horizontální scroll v popoveru je chyba.
- Footer preview eventu je **grid rovných buněk** (`grid-auto-flow: column`),
  jedna až čtyři akce podle práv. Čtyři ikona+label tlačítka se do 390 px vejdou
  jen s polovičním `padding-inline`, takže labely musí být krátké — „Edit series"
  se nevejde a stačí „Edit", protože hlavička už sérii bádžuje a scope dialog se
  na rozsah stejně zeptá. Delete drží stejný tvar jako sousedi, destruktivnost
  nese barva.
- Řádek Page je **dvě tlačítka v jednom vizuálním řádku**, takže hover vlastní
  wrapper (`.pageRow:hover .pageRowMain`) — tečky leží nad řádkem, takže mířit na
  ně jinak vezme pointer z řádku a jeho hover by uprostřed gesta zhasl. Tečky
  samy se na hover nezvedají (musí zůstat na středu řádku) a mají rádius
  koncentrický s řádkem (`radius - inset`); vnitřní kulatější než vnější je
  vždycky vidět.
- `IconButton` centruje flexem, ne gridem: grid řádek je vysoký jako line box,
  takže se ikona zarovnala na účaří a sedla o 1,5 px nad střed tlačítka.
- Sloupce editoru eventu se v page layoutu roztahují na výšku řádku, takže
  poslední pole (notes) bere zbytek místa a seznam kalendářů drží
  `align-content: start` u hlavičky. Nevyplněné místo mezi hlavičkou a obsahem
  je vada, ne vzduch.

### Fáze H — Mobilní průchod — **HOTOVO** (2026-07-30)

Review webu na 390×844 proti nativnímu klientovi. Nativní model je: horizontální
pager mezi obdobími, pull-to-refresh, tap → draft, hold+pan → create/move, pinch
→ vertikální zoom, month→day drill zoom.

**Opraveno:**

- **Week na telefonu ukazoval 3,5 dne ze 7.** `.timeGridView` držela
  `min-width: 700px`, takže mřížka scrollovala vodorovně — a horizontální scroll
  v kalendáři nikdo nehledá. Pod 600 px se teď vejde celý týden (~48px sloupce);
  nad tím zůstává minimální sloupec a scroll, kde je čitelnější. Hlavička dne je
  ve dvou řádcích (`MON` / `20`) — vedle sebe se v 48px oba klipovaly.
- **Flick doleva/doprava mění období** (`use-swipe-period.ts`), jen na dotyku:
  myš má šipky a horizontální scroll trackpadu není gesto. V agendě se nepaguje,
  je to jeden souvislý seznam.
- **Drag-to-create na dotyku čeká na držení.** Flick i tažení rozsahu žijí na
  stejných buňkách, takže o tom, co gesto je, rozhoduje **jedna** konstanta
  `TOUCH_HOLD_MS = 280` (stejná hodnota jako `HOLD_CREATE_MS` v nativním
  klientovi) — pod ní je to stránkování, nad ní tažení. Sdílená konstanta je to,
  co brání okně, ve kterém by vystřelilo obojí; první verze měla flick 400 ms a
  v pásmu 280–400 ms dělala obojí zároveň.
- **FAB přestal zakrývat poslední řádek Month** (`padding-bottom` plochy).
- **Grid se otevírá hodinu před „teď"**, ne na fixní 7:00. V 15:00 jsi předtím
  přistál osm hodin nad svým dnem (`openScrollMinutes()`).

**Druhé kolo (po zpětné vazbě):**

- **Horní bar je jedna řádka, 64 px.** Šipky ‹ › na telefonu zmizely (flick je
  nahradil), přepínač pohledů se z pásu čtyř chipů stal `Select` — na úzkém
  displeji ho sdílené primitivum otevře jako spodní sheet, takže „schovat" nestálo
  žádnou novou komponentu. Titulek se přestal ořezávat, protože na úzkém displeji
  ztrácí rok (`Jul 27 – Aug 2`, `Mon, Jul 27`, `From Jul 27`) — rok je to první,
  co label může ztratit a pořád odpovědět „na co se dívám"; ořezaný titulek
  neodpoví na nic. Týden přes Silvestr si oba roky nechává, tam by to bylo
  dvojznačné.
- **Presety Morning/Afternoon/Evening jsou pryč.** Byly jen na úzkém displeji,
  zabíraly řádek v už tak nabité quick create a časy se dají nastavit vedle.
- O tom, co je „úzké", rozhoduje `useNarrowViewport()` — **stejný breakpoint jako
  CSS**, protože dva by se rozešly. Renderovat obojí a jedno skrýt CSS by nechalo
  dva controly na jednu práci v accessibility stromu.

**Vědomě neuděláno** (a proč): pull-to-refresh — to gesto vlastní prohlížeč,
vlastní implementace by s ním zápasila; pinch zoom timeline — density je vlastnost
Page, takže by vznikly dva zdroje pravdy na tutéž věc; month→day drill zoom —
kosmetika nativní navigace.

### Fáze I — Draft, ghost a domovský kalendář — **HOTOVO** (2026-07-30)

- **Přepínač All day se přestal hýbat.** Byl mezi časovým řádkem a řádkem „Ends",
  takže při každém překlopení jeden nad ním zmizel a jeden pod ním vznikl a
  checkbox skočil o řádek. Teď je **jeden slot pro dva obsahy** (čas nebo datum
  konce) a přepínač je vždycky pod ním; oba řádky jsou vysoké jeden control, takže
  se nemá kam pohnout.
- **Draft a ghost už nejsou dashed ani průhledné.** Plná linka a **opaque
  overlay** z nového tokenu `--draft-fill`, odvozeného z `--text-primary` — na
  světlém tématu je tmavý, na tmavém světlý, jedna definice. Průhledný draft se
  přes obsah pod sebou čte jako šmouha, ne jako blok.
- **Ghost sleduje formulář.** Doteď tekla data jen grid → formulář (`when`); teď
  i zpět (`onDraftChange` → `moveCreateDraft`), takže změna času, délky nebo
  kalendáře v okně New event blok na mřížce **přesune a přebarví**
  (`--draft-accent`). Signatura se porovnává, takže se ty dva směry nezacyklí.
- **Barva eventu se bere z domovského kalendáře**, ne z prvního členství. Byla to
  věcná chyba na sedmi místech (Month, Week/Day, all-day pásy, agenda, ghost při
  tažení, accent v detailu). Pravidlo je teď jedno — `eventHomeCalendarId()` —
  protože barva, hvězdička na pilulce i routování zápisu musí ukazovat na totéž.
- **Domovský kalendář má v detailu hvězdičku** v pilulce.
- **Hlavička sloupce Event calendars nescrolluje** s kalendáři pod sebou
  (`position: sticky`).

### Fáze J — Filtry, překryv a ghost jako objekt — **HOTOVO** (2026-07-30)

- **Viditelnost kalendářů se nastavuje v Page settings** pomocí pilulek
  (`CalendarVisibilityPill`): stav nese sama pilulka (`aria-pressed`), ne
  přepínač vedle labelu. Samostatný filter shelf i přepínání ze sidebaru zmizely;
  filtr je uloženou vlastností Page a patří k jejím ostatním pokročilým volbám.
- **Eventy drží odstup od pravé hrany sloupce** (`COLUMN_RIGHT_INSET_PX = 10`).
  Blok nalepený na mřížku se čte jako její součást, a ten pruh je zároveň místo,
  kde se dá stisknout nový event vedle plného. Odstup platí jen pro poslední lane
  — u ostatních je pravá hrana pod blokem, který je překrývá.
- **Tažený blok se rozšíří na celý sloupec** a po položení se vrátí do své lane,
  jako u Googlu: co držíš, to potřebuješ číst, a lane se stejně mění.
- **Slovník:** „ghost event" = **návrh nového** eventu z drag-to-create
  (`.timeGridSelection`, `.dayDraft`) — průhledný závoj s plným okrajem. Stopa po
  **přesouvaném** eventu je něco jiného: tentýž blok, jen **vybledlý**
  (`opacity: .45`), protože je to skutečný event se svou barvou. Nemíchat.
- **Závoj návrhu je z barvy plochy** (`--draft-fill` = `--surface-canvas` na
  72 %), takže na světlém tématu světlý a na tmavém tmavý; overlay odvozený
  z barvy textu by dělal opak a na tmavém svítil.
- Návrh v time gridu leží v **z-index pásmu eventů** (5), ne nad sticky hlavičkou
  (8) — při scrollování musí zajet pod all-day řádek a datum jako event.
- **Ghost v Month krájela dělící linka buněk.** Nebyl to z-index: `.dayCell` má
  `overflow: hidden`, takže 8px bleed, kterým chip sahá přes hranici, se ostříhne
  na hranici buňky a ten 1px border zůstane odkrytý. U neprůhledného chipu to
  není vidět, u průhledného ghostu ano. Klip proto pouští jen buňka, která ghost
  drží (`.dayCell:has(.eventChip[data-ghost])`), a jen po dobu tažení.
- **Draft má vždycky viditelné úchyty** na horní a dolní hraně. Hover-only nápověda
  řekne jen tomu, kdo už ví, že tam jsou — a draft je celý o tom, že se jeho konce
  posouvají.
- **Hvězdička domovského kalendáře stojí místo barevného kolečka** a nese jeho
  barvu (jako na mobilu): je to stejný signál plus jeden, ne dva vedle sebe.
- Opraven kontrast `--text-muted` na 11px textu (3,2:1, pod AA) u pilulek i
  u `recurrenceBadge` — axe to na nové pilulce zachytil hned.

### Fáze K — Pořadí Pages přetažením — **HOTOVO** (2026-07-30)

`PUT /pages/reorder` konečně má UI. Řádek Page se chytne a přetáhne, seznam
během tažení **ukazuje cílové pořadí** (ne čáru mezi řádky) a po puštění se pošle
celé nové pořadí ids.

- **Gesto:** myš se stane tažením po `DRAG_THRESHOLD_PX`, prst musí nejdřív
  `TOUCH_HOLD_MS` držet — jinak by scrollování sidebaru přerovnávalo Pages. Escape
  ruší, trailing click se spolkne (`consumeClick`), aby puštění nad jiným řádkem
  tu Page zároveň neotevřelo. Žádný samostatný grip: řádek je celý úchyt, stejně
  jako event v gridu.
- **Klávesová alternativa (R10):** `Alt+↑/↓` na řádku, tvarem stejné jako
  `Alt+šipky` u eventu. Výsledek hlásí live region — ne `role="status"`, ten už
  patří toastu, a dva by ho udělaly dvojznačným.
- **Optimisticky s rollbackem (R8):** pořadí se překreslí hned, chyba vrátí
  původní seznam a řekne to toastem; seznam, který se na dobu round tripu vrátí
  zpátky, se čte jako selhané tažení.
- **DOM pořadí se během tažení nemění.** Řádky se posouvají do svého preview
  slotu transformem (`--row-shift` + `transition: translate`), takže se plynule
  prohodí, a držený řádek sleduje kurzor 1:1 bez re-renderu pod rukou. Kdo drží,
  ten má `transition: none` a leží nad ostatními.
- **Frame, ve kterém přijde nové pořadí, se nesmí animovat.** Držený řádek už na
  svém místě *je*; kdyby v tu chvíli měl transition, odjel by o řádek zpátky a
  zase dopředu — to je to probliknutí po puštění. Proto `data-settling`, a to
  přes **dva** `requestAnimationFrame`: jeden běží ještě před nejbližším paintem,
  takže by se vypnutí i zapnutí animace vešlo do stejného paintu a přechod by
  stejně vystřelil. Zrušené tažení (Escape, drop na stejný slot) se naopak
  animovat má — řádek doklouže domů.
- Rozměry řádků se **měří jednou na začátku** tažení. Průběžné měření by řádek
  nechalo honit kurzor, protože transformy s ním samy hýbou.
- Default Page selection was completed in Phase N. The reorder endpoint remains
  the single atomic write for both order and default ownership.

### Fáze L — Agenda a filtry na telefonu — **HOTOVO** (2026-07-31)

Agenda byla „strohá": čas, název, kalendář. Teď nese to, co event skutečně má, a
seznam sám říká, kde v čase jsme.

- **Relativní jméno dne** („Today", „Tomorrow") stojí nad datem, ne místo něj —
  jméno hledá oko, datum ho potvrzuje. Dál už žádné „In 3 days": čtvrtý den
  dopředu si nikdo takové jméno nepřeloží rychleji než datum.
- **Prázdné dny jsou vidět jako mezera.** Agenda kreslí jen dny, které něco mají,
  takže skok z 27. na 3. se čte jako „3. je další v řadě". Tichý separátor
  „6 free days" mezi skupinami je jediné místo, kde volný čas může být vůbec
  vidět. Počítá se přes `startOfDay` obou konců, ne dělením milisekund — 23hodinový
  den při přechodu času by jinak vyšel o jeden nižší.
- **Měsíc je pásmo, ne řádek svého druhu**: tišší než rok, hlasitější než den.
  Datum dne je `sticky` ve své vlastní grid area, takže drží, dokud jeho události
  neprojdou, a pak ho vystrčí ten další.
- **Řádek ukazuje jen to, co event má** — místo (s `MapPin`) a `EventMarks`
  (opakování / hosté / zámek), sdílené s gridem. Prázdné sloty by se čtenáři
  čtou jako chybějící data, ne jako „nic tam není".
- **Detail se otevírá doprava** (`side="bottom" align="start"`), ne doleva. Řádek
  je široký přes celý sloupec, takže `side="right"` neměl kam a Radix kartu
  překlopil doleva. Bottom placement se ale **neposouvá po hlavní ose**: karta
  vysoká 476px pod řádkem v y=349 přesahovala pod okno a na footer se nedalo
  dosáhnout. Strop je proto `--radix-popover-content-available-height` — kolik
  místa ta strana reálně má; karta uvnitř scrolluje, což už umí.
- **Filtry kalendářů na telefonu jsou jeden vodorovný pás.** Titulek „Visible
  calendars" zmizí z layoutu, ale zůstane jako přístupné jméno regionu
  (`clip` místo `display: none`) — a pilulky se nezalamují, scrollují do strany
  (`overscroll-behavior-x: contain`, skrytý scrollbar) jako v nativním klientovi.
  Zalomený blok pilulek na 390px ukrojil třetinu obrazovky kalendáři.
**Vizuální check ukázal tři věci, které z popisu nebyly vidět** (2026-07-31):

- **Two sticky layers must be intentional.** This iteration originally folded
  the year into the month band and left only the day date sticky. Phase P later
  restored the standalone year band after production use showed that its broader
  orientation was more valuable; its stacking and opaque surface are now an
  explicit part of the Agenda contract.
- **„N free days" mezi každými dvěma řádky není informace, ale šum.** Týdenní
  event nechává šest prázdných dnů za každým výskytem, takže se pásmo objevovalo
  mezi vším. Hranice je `AGENDA_FREE_DAYS_MIN = 7` — celý týden, kdy čtenář
  přestává poznat „příští týden" od „příštího měsíce". Pásmo se navíc lícuje se
  **sloupcem eventů**, ne s datem: patří skoku mezi dny, ne jednomu z nich.
- **Filtry na telefonu nešly vůbec otevřít.** Pod 1024px toolbar schovává hledání
  i tlačítko Filters — pás pilulek je tam proto **vždy vidět** (`useCompactViewport`),
  ne za přepínačem, který na té šířce neexistuje.
- Rytmus agendy drží dvě proměnné na `.agendaList` (`--agenda-date-column`,
  `--agenda-inline`); media queries přepisují jen je, ne jednotlivá pásma.
- `--text-muted` na 9,76px je 3,2:1 — axe to na datu dne odhalil až ve chvíli, kdy
  dostalo vlastní pozadí (u průhledného sticky prvku hlásí „incomplete", ne chybu).
  Datum, mezera i místo jedou na `--text-secondary`.
- `PLAYWRIGHT_ORIGIN` v `playwright.config.ts` — dev server nabídnutý jen na `::1`
  se testuje beze druhé konfigurace.

### Phase M — Shared layers and production catalog — **COMPLETE** (2026-08-01)

- Quick Create, event details, and Month overflow now compose the shared
  `PopoverContent` contract. Their domain-specific focus, drag, dismissal, and
  portal event guards remain feature-owned; the portal, surface, collision
  gutter, arrow, motion, and narrow sheet no longer have a second calendar-only
  implementation.
- The old global narrow-viewport Radix wrapper override was removed from
  `workspace.module.css`. Only the shared anchored surface may move its own
  popper wrapper into sheet geometry, so an unrelated future Radix control
  cannot be moved by calendar feature CSS.
- Page settings no longer calls `window.confirm`. Discarding a dirty draft and
  deleting a Page use `ConfirmationDialog`, keep the safe action focused first,
  return focus on cancellation, and keep delete failures inside the decision
  layer. Delete still has no Undo because the server exposes no restore path.
- Storybook renders the real Page settings dialog in regular and narrow modes,
  including both confirmation branches. Authentication, `RouteState`, and
  `Avatar` also have production-backed catalog coverage rather than copied
  showcase markup.
- The remaining authentication and route-state background gradients were
  removed. Their readable 10–12 px metadata now uses `--text-secondary` rather
  than the sub-AA muted token.

No package extraction is part of this phase. The APIs are stable enough to
catalog and reuse in place; moving files before the native catalog exists would
create churn without reducing another implementation.

### Phase N — Complete Page default behavior — **COMPLETE** (2026-08-01)

- Page settings exposes `Set as default` as an immediate secondary action in a
  standard settings row. A successful write changes the row to a persistent
  `Default` status and announces the result through the shared toast. The dialog
  stays open so an unrelated name, icon, presentation, or visibility draft is
  never discarded by changing the default.
- The action is optimistic and rolls the Page cache back on failure (R8). It
  sends the full current Page order plus `defaultPageId`; order and default move
  remain one server transaction rather than two writes that could diverge.
- An order-only write now preserves the current default. The previous query
  compared every Page id with an absent `defaultPageId`, which cleared every
  `isDefault` flag during a normal drag reorder.
- Replacement orders must contain every active owned Page exactly once. A stale,
  partial, duplicated, or foreign list is rejected before the transaction
  changes positions or the default.
- Position and default changes increment Page revisions and update timestamps.
  Realtime receivers can therefore accept the `page_updated` frames, then sort
  their cache by the received positions; equal-revision echoes remain no-ops.
- Listing Pages repairs legacy accounts that have Pages but no default by
  promoting the first ordered Page. This is deterministic and guarded by the
  existing one-active-default database index.
- Storybook covers the real set-default interaction. Unit coverage owns the
  optimistic state transformation, dialog draft preservation, realtime order,
  and request validation; the Postgres integration scenario covers order-only
  preservation, default movement, invalid-order rollback, and legacy repair.

### Phase O — Disconnect one provider calendar — **COMPLETE** (2026-08-01)

- Calendar management exposes `Stop syncing` only on provider-backed mirrors.
  The wording distinguishes this operation from disconnecting the account and
  from deleting the source calendar at Google, Microsoft, or CalDAV.
- The shared `ConfirmationDialog` names the affected calendar and explains the
  boundary: the provider account, source calendar, and sibling mirrors remain
  connected. There is no Undo because the server has no direct mirror restore
  operation.
- The calendar disappears optimistically and the previous cache is restored if
  the request fails (R8). Calendar and event queries refresh after settlement.
- The API returns the removed mirror id and broadcasts `calendar_removed`, so
  other open sessions do not retain a calendar that this session disconnected.
- Storybook catalogs both calendar management and its confirmation state. Unit
  coverage owns the action wording, confirmation boundary, callback, toast, and
  optimistic success path.

### Phase P — Restore standalone Agenda years — **COMPLETE** (2026-08-01)

- Production use favored the original standalone year band over folding the
  year into a month label. The year therefore returns at the first visible group
  and at every year boundary; the first month of that year is not duplicated as
  a separate band, matching the earlier behavior.
- The year is sticky with an opaque canvas surface and explicit stacking. Month
  bands still scroll with their events, while each day date remains the local
  sticky heading for its event group.
- Later Agenda improvements remain intact: month rhythm uses
  `--agenda-inline`, mobile spacing is variable-driven, short recurring gaps are
  suppressed by `AGENDA_FREE_DAYS_MIN`, and event metadata and filter behavior
  are unchanged.

### Phase Q — Import into connected accounts — **COMPLETE** (2026-08-09)

- Calendar import uses the same Musubi / connected-account choices, provider
  marks, account labels, and provider-aware colour picker as calendar creation.
- The API verifies that the selected account belongs to the current user,
  creates the destination calendar at the provider first, imports its local
  mirror, and pushes every accepted VEVENT into that provider calendar.
- A native Musubi import remains the default. Missing or mismatched
  `provider` / `accountId` pairs are rejected rather than silently importing to
  the wrong destination.

### Vědomě odloženo

Year view, 3-day/custom range, right utility rail, focus time / OOO /
appointment schedules. Žádné z toho nemá cenu, dokud neběží B a C.

## 7. Checklist na každý UI ticket

```yaml
ticket:
  user_goal: ""
  entry_points: []          # slot, event, toolbar, klávesnice, mobil
  ui_layer: ""              # slot | quick_create | preview | editor | dialog
  preserved_context: []     # datum, view, scroll, focus, vybraný objekt
  state_machine: ""         # nebo "netřeba" + proč
  keyboard_path: ""
  narrow_path: ""
  shared_geometry: true
  optimistic_error_undo: ""
  a11y: ""                  # focus, název pro SR, kontrast, redukovaný motion
  tests: []
  own_identity: true        # nekopíruje cizí značku
```

Po dokončení dolož: co je hotové, jaké invarianty zůstaly zachované, jak funguje
klávesnice a screen reader, jak se řeší loading/pending/error/undo, jaké testy, a
**každou odchylku od těchto pravidel i s důvodem**.

## Multi-week (M8.1)

První post-parity view a zároveň test, jestli view registry drží. Co z toho
vzešlo a nedá se vyčíst z kódu:

- `ViewDefinition` vznikla **před** multi-weekem, ne s ním. Views předtím
  odpovídaly na „jaký rozsah", „o kolik posune šipka", „co říká toolbar" v
  `if (view === …)` větvích ve `Workspace.tsx` a `workspace-queries.ts` — pátý
  view by znamenal editovat kód těch čtyř, což PRD §16.2 zakazuje. Renderovací
  `switch` v JSX zůstal schválně: komponenty v registry by natáhly celý strom
  views i do `shortcuts.ts`.
- Multi-week je **matice samostatných týdenních bloků** (`MultiWeekCalendar`),
  ne jeden dlouhý měsíc — reference je [MultiWeek](https://www.multiweek.app/),
  kde jde o srovnání týdnů vedle sebe. Počet sloupců se počítá z šířky
  (`MIN_BLOCK_WIDTH_PX`), zbytek se zalomí do řádků; na telefonu vyjde 1 sloupec.
- Blok je **čtecí mini time grid**, ne `TimeGridView`. Dvacet živých gridů by
  neslo drag, resize, hit-testing a now-marker dvacetkrát. Sdílí se **matematika**
  (`getDaySegments`, `assignOverlapColumns`, `overlapPlacement`), takže nabitý
  čtvrtek vypadá nabitě i tady, a klik otevře tentýž popover jako všude jinde.
  Hodinové linky jsou CSS gradient, ne elementy — jinak by to bylo 280 divů,
  které nic nedělají.
- Okno hodin je konstanta 7–21 (`VISIBLE_START_HOUR`). Celý den v bloku vysokém
  190 px je šmouha; události mimo okno se **ořezávají na hranu, ne zahazují**,
  jinak by blok lhal o tom, jak je den plný. Nastavitelné okno je v PRD §16.1.
- Počet týdnů je v **Page configu**, ne v settings: plánovací stránka chce osm
  týdnů, „tenhle týden" jeden. To je vlastnost stránky, ne člověka.
- Titulek v toolbaru je „Jul 20 – Oct 11" — krátké měsíce a rok jen když span
  přechází přes rok. Dlouhá varianta se ořízne o ellipsis, což stojí datum.
- **Schované** (`hidden: true` v registry, 2026-08-02): view funguje a testy běží,
  ale nenabízí se v přepínači ani v seznamu zkratek — zůstává jako koncept,
  dostupný přes URL a přes Page config, dokud se nedoladí vzhled. Přesně na tohle
  sloužilo pole `enabled`, které jsem při refaktoru vyhodil jako YAGNI; vrátilo se
  o dvě hodiny později pod jiným jménem.
- Zatím **není**: drag mezi týdny, kopírování modifikátorem, ruční nastavení
  řádků × sloupců (dnes jen auto), skrytí víkendů, barevná pravidla, search
  highlight a zakládání eventu klikem do bloku. Všechno jde přidat nad stejnou
  definicí a stejným blokem.

## 8. Anti-patterny (červené vlajky v review)

- Klik na event otevře plný formulář.
- Každé smazání má modal, i když je Undo spolehlivé.
- Popover uprostřed obrazovky bez vztahu k anchoru.
- Po zavření editoru skok na dnešek nebo nahoru.
- Barva je jediný rozdíl mezi stavem nebo typem.
- `:hover` přepíše vybraný/checked stav místo aby ho posunul (viz R11a).
- Změna filtru resetuje datum nebo scroll.
- Grid, event layout a hit-testing počítají každý po svém.
- Drag zapisuje na server při každém pointer move.
- All-day jako půlnoční timestamp místo date range.
- Refetch zavře otevřený popover.

### September feedback: quiet calendar chrome

Standing provider coverage limits live behind the toolbar’s “Calendar sync
coverage” info action. Offline, update, and live availability warnings retain
their visible banners. App scrollbars are visually hidden at the global web
layer; overflow, wheel, touch, and keyboard scrolling stay intact in calendars,
forms, lists, and portaled surfaces.

Event calendar pickers identify each account once, with a provider mark and
account label in a single-line group heading. Local Musubi uses its mark and the
signed-in account name. The default calendar does not repeat a “Personal calendar”
subtitle. Each heading and its calendar rows share one rounded
surface, using the notes surface tokens, with consistent space between accounts.
Individual rows show calendar colour and name without repeating the provider
logo or subtitle. Event-detail calendar pills use a calendar-coloured provider
mark instead of a second colour dot, and a stronger outline identifies the home
calendar on web and native.


### Connection choices and availability setup

Web Connections and onboarding always request Google/Microsoft Tasks access
alongside calendar access. There is no Include Tasks checkbox or separate
consent toggle (approved 2026-09-30). Existing calendar-only credentials remain
usable; the backend continues to decide task eligibility from the actual grant.

Google availability uses the standard grouped rows. An empty list offers **How to
set up** instead of an unusable check action. The setup dialog explains sharing
busy times without details, accepting the Google sharing link in the connected
account, refreshing connected calendars, and selecting the discovered calendar.
Calendars with readable event details remain in normal event sync. Instructions
link to the [Google sharing guide](https://support.google.com/calendar/answer/37082?hl=en).
Refresh failures stay in the setup dialog; successful discovery returns to the
source list. Checking intervals remains explicit, with range fields in the body
and the read action in the footer.


Inset section groups at the end of a flush dialog keep a shared body-sized closing
gap before the footer or shell edge, including delivery records and saved-change
lists. Safe-area padding remains a separate shell/footer responsibility. Dialog
and nested settings, calendar and inspector scrollers reserve scroll padding so
keyboard focus does not land against the clipping edge. Scroll padding supplements
physical content padding; it does not replace the final visible gap.


### Task layouts, account search and motion (2026-09-13)

Tasks offers List and Kanban beside the toolbar title. Both group tasks by Needs
action, In progress, Completed and Cancelled, retain the RFC priority mapping,
and identify the source with a calendar-coloured provider mark. List controls
precede the title. Kanban cards have their own compact hierarchy; mouse dragging
starts on the card background, touch dragging uses the handle so the rest of the
card can scroll. Status selectors remain the keyboard alternative. Moves appear
optimistically and roll back with an error if the write fails. The selected layout
survives calendar navigation and the full event editor round trip.

Search reads all accessible stored events and tasks, with visible events/tasks
first and separate groups for other dates and hidden calendars. Arrow Up/Down
stays within a column; Left/Right changes columns; Enter opens the selected item.
The input retains focus while its active result is announced. Quick actions omit
the current view and include eligible meeting creation. Account results follow
realtime invalidation and stay out of offline snapshots; selected details resolve
by ID against current data so redaction or removal also retires displayed content.
Offline search can use the currently cached event window.

Desktop retains the view pills when an inspector is open, wrapping actions where
needed. The mini-calendar owns Today and month arrows; toolbar paging is retained
on narrow screens. Month wheel navigation advances once per gesture burst. Shared
pills slide their selection, calendar views and periods crossfade, and inspectors
slide over the workspace in 120 ms without resizing the calendar or its title. Reduced-motion settings disable these
transitions. User-menu actions include sign out, leaving the full profile width
for name and email.

## Datované tasky v kalendáři (web a Android)

- Začátek tasku patří do příslušného dne, s časem do časové mřížky. Termín
  dokončení má vlastní položku v celodenním řádku.
- Datum bez času zachovává uložený kalendářní den. Termín s časem se vztahuje
  k časovému pásmu zařízení. Shodný celodenní začátek a termín tvoří jednu položku.
- Task bez dat zůstává jen v Tasks. Zrušené tasky se nezobrazují; dokončené
  mají označení dokončení. Platí filtr viditelných kalendářů.
- Kliknutí otevírá detail tasku se změnou stavu. Položky jsou pouze projekce;
  neukládají se přes event API a nevstupují do eventových připomínek ani dostupnosti.
- Task zatím nemá samostatnou délku. Krátká geometrie časové položky slouží
  pouze pro čitelnost; nezobrazuje se jako uložený konec a nepřetéká přes půlnoc.
  Termín dokončení není konec rezervovaného časového bloku.
- Zobrazují se konkrétní tasky vrácené API. Projekce sama negeneruje budoucí
  opakované tasky z pravidla recurrence.


Kanban columns scroll independently below a fixed header containing the status,
count and Add task action. Each scroll region is keyboard-focusable; drag edge
scrolling follows the column under the pointer while horizontal board scrolling
remains available on narrow screens.

Page settings Filters includes independent Events, Tasks and Meetings switches.
An omitted item-types filter means all types; an empty array means none. The
selection is saved per Page and applies to calendar grids, Agenda and the task
list/board. Meetings include local attendance-enabled events and invitations
identified by the connected provider's readable attendee metadata.
