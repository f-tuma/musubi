# Nylas: normalizace kalendářů a důsledky pro Musubi

Ověřeno **12. října 2026**. Předmětem je veřejně dokumentované chování Nylas v3, nikoli rekonstruovaný zdrojový kód jeho současného backendu. Nebyly použity přihlašovací údaje, soukromá rozhraní ani skutečné zápisy do kalendářů. Posouzení ukázek je statické; tvrzení o skutečném chování našich adaptérů vychází z kontraktů a lokálního kódu, nikoli z nového živého testu.

**Hlavní závěr:** Nylas nabízí jednotný způsob volání a obsluhy odpovědí, ale neodstraňuje rozdílné identity, význam rušení, hranice opakování ani vedlejší účinky schůzek. Musubi má v několika důležitých oblastech bohatší a přísnější model. Největší příležitost není zahodit tyto záruky, ale zpřístupnit je jako menší, srozumitelné veřejné kontrakty a odstranit opakování mezi implementacemi jednotlivých operací.

V textu znamená **doloženo** výslovný údaj primárního zdroje, **pozorování** statické porovnání dokumentů nebo kódu a **návrh** naše architektonické rozhodnutí. Chybějící veřejný kontrakt není důkazem chybějící interní implementace.

## 1. Co je skutečně sjednocené

Nylas rozlišuje autentizované spojení účtu `grant`, kalendář jako kontejner a událost. Nad poskytovateli vystavuje stejné Events endpointy. Kalenderový přehled popisuje osobní, skupinové a zdrojové kalendáře i přístup pouze k dostupnosti. Změny provádí u poskytovatele. Výchozí oznámení jsou jen pro primární kalendář; oznámení pro všechny kalendáře vyžadují nastavení aplikace. To je produktová konfigurace, ne vlastnost samotného modelu události. [Calendar API](https://developer.nylas.com/docs/v3/calendar/)

Pro Musubi z toho vyplývá jednoduchá transportní fasáda: účet, zdroj, objekt a operace. Neměla by vynucovat, aby každé spojení současně podporovalo poštu, kalendáře a úkoly. Připojení je kontext autentizace a limitů; zdroj je kontext práv, pokrytí a životního cyklu; objekt je obsah a jeho vztahy. Tyto hranice máme z velké části již zavedené. Veřejný protokol by je měl pojmenovat dříve než konkrétní OAuth nebo DAV podrobnosti.

**Doloženo:** Nylas doporučuje složenou identitu `(grant_id, event_id)`: podle jeho popisu mohou Google kopie stejné schůzky sdílet ID, zatímco Microsoft a iCloud mají ID podle uživatele. `ical_uid` slouží ke korelaci; může chybět a opakování jej může sdílet. Normalizovaný tvar proto pořád vyžaduje větvení podle poskytovatele. [Cross-provider sync](https://developer.nylas.com/docs/cookbook/calendar/cross-provider-calendar-sync/)

**Návrh:** Musubi musí ponechat oddělené lokální UUID, identitu provider kopie, identitu zdroje, UID schůzky a původní identitu výskytu. Korelace není autorita. Dvě pozvánky se stejným UID nesmějí samy od sebe sloučit soukromé informace ani získat společná práva. Pro CalDAV je navíc nutné oddělit URL prostředku od komponenty uvnitř něj. Náš [časový kontrakt](../../sync/event-time-model.md) tuto hranici výslovně zachovává. To je podstatná vlastnost budoucího otevřeného protokolu, nikoli nadbytečný detail databáze.

## 2. Matice rozdílů, které projdou jednotným API

Tato tabulka popisuje Nylas API. Nejde o vyčerpávající seznam možností nativních Google, Graph nebo CalDAV rozhraní.

| Oblast | Google | Microsoft Graph | iCloud přes Nylas | Exchange EWS | Důsledek pro Musubi |
| --- | --- | --- | --- | --- | --- |
| Identita kopie | Nylas popisuje sdílené ID schůzky | ID podle uživatele | ID podle uživatele | Bez obecné záruky zde | Vždy zdrojový kontext |
| `primary` při Events dotazu | Ano | Ano | Ne | Ano | Skutečné ID kalendáře je základ |
| `updated_after/before` | Ano | Ano | Ne | Ano | Časový filtr není univerzální delta |
| `master_event_id` filtr | Ano | Ano | Ne | Ano | Přenos série potřebuje vlastní kontrakt |
| `ical_uid` filtr | Ano | Ano | Ne | Ano | UID index nelze zaměnit za identitu |
| `busy` filtr | Ano | Ano | Ne | Ano | Vyjednat podporu filtrů |
| `show_cancelled` | Ano | Ano, jiný význam | Ne | Ne | Tombstone a zrušený výskyt rozlišovat |
| `event_type` filtr | Google typy | Ne | Ne | Ne | Zachovat provider hodnotu |
| `notify_participants=false` | Podporováno | HTTP 400 | Ignorováno, oznámení vždy | Podporováno | Operace deklaruje vedlejší účinky |
| Send RSVP | Ano | Ano, caveat ke stavu | Nepodporováno | Ano | Schůzky nejsou prostý event PATCH |
| Počet reminders | Provider specifický | Nejvýše jeden | Nejvýše jeden | Nejvýše jeden | Připomínky jsou projekce |

Filtry a limity: [Events listing](https://developer.nylas.com/docs/reference/api/events/get-all-events/). Oznámení: [Using Events](https://developer.nylas.com/docs/v3/calendar/using-the-events-api/). RSVP: [Send RSVP](https://developer.nylas.com/docs/reference/api/events/send-rsvp/). Připomínky: [Return event](https://developer.nylas.com/docs/reference/api/events/get-events-id/).

**Pozorování:** `start` a `end` mají výchozí hodnoty, takže první list není automaticky kompletní historie účtu. Specifikace současně vysvětluje překryv intervalu na příkladech událostí, které začnou před dolní hranicí nebo skončí po horní. Nestačí mechanicky implementovat doslovný název filtru. Musubi potřebuje normativní definici průniku a úplnosti výsledku; test musí obsahovat událost překlenující celé okno. [Events listing](https://developer.nylas.com/docs/reference/api/events/get-all-events/)

## 3. Čas: kde je Musubi přesnější a kde potřebuje rozšíření

Nylas popisuje `when` jako `timespan`, `date` nebo `datespan`. Timed hodnoty jsou Unix sekundy, časová pásma IANA jsou volitelná. Pro výskyt může vrátit původní začátek `original_start_time`. Veřejný event objekt připouští odlišné počáteční a koncové pásmo. Python SDK dokumentuje navíc typ `time`, tedy samostatný okamžik. [Return event](https://developer.nylas.com/docs/reference/api/events/get-events-id/), [Python events](https://developer.nylas.com/docs/v3/sdks/python/manage-events/)

Musubi používá explicitní tagged union `zoned`, `floating`, `all-day`, `legacy-unknown` a pro výskyt `instant`, `floating` nebo `date`. Tím umí vyjádřit rozdíl mezi přesným okamžikem a civilním časem závislým na uživateli. Zachovává i civilní kotvu při neexistující hodině v přechodu DST. To nelze bezpečně nahradit jedním timestampem s volitelným timezone. Implementace: [event_time.ts](../../../packages/types/src/event_time.ts); návrhový a akceptační kontext: [Event time model](../../sync/event-time-model.md).

Příklad důvodu: „každé úterý v 9:00 v Praze“ neznamená opakovaně přičíst 604 800 sekund. „Každé úterý v 9:00 tam, kde právě jsem“ není stejná událost s jinou prezentací. A narozeniny nejsou UTC půlnoc, kterou telefon při cestě zobrazí předchozí večer. Protokol musí rozlišovat tyto významy před převodem do poskytovatele, jinak bude řadu skutečných konfliktů pokládat za pouhý formátovací rozdíl.

**Doloženo:** iCloud cookbook používá pro all-day exclusive `end_date`. [Create iCloud events](https://developer.nylas.com/docs/cookbook/calendar/events/create-events-icloud/) Musubi zachovává stávající inclusive poslední den. Doporučení není provést plošnou migraci jen kvůli podobnosti s Nylas. Vybrat a verzovat jeden veřejný intervalový kontrakt; převod provádět přesně jednou na hranici adaptéru. Nový veřejný transport by mohl používat standardní exclusive konec, ale lokální databázi změnit až samostatnou ověřenou migrací.

Naopak naše současné jediné pásmo pro oba endpointy má doloženou hranici: Google událost s jiným end timezone je odmítnuta před importem a posunem cursoru. [Provider time import](../../sync/provider-time-import.md) To je konkrétní kandidát rozšíření modelu. Nejprve určit význam koncového pásma při opakování a duration; teprve potom přidat další pole. Zachovávat původní provider hodnoty i v případě, že veřejný model umí zobrazit jen instants. Zobrazitelnost nesmí automaticky znamenat zapisovatelnost.

Nylas reminder recipe doporučuje při chybějícím pásmu zobrazovací fallback UTC. [Schedule reminders](https://developer.nylas.com/docs/cookbook/use-cases/act/schedule-event-reminders/) To lze přijmout jako explicitní prezentaci okamžiku. Nelze z toho odvodit pásmo původní série, rozhodnutí o floating času nebo povolení přepisu provider objektu. Naše `legacy-unknown` je pro synchronizační protokol správnější než tiché „doplnění“ UTC.

## 4. Opakování: společné pole nezaručuje společnou matematiku

**Doloženo:** Nylas pracuje s masterem a výskyty; `recurrence` je na masteru. Podporuje RRULE a EXDATE, nikoli RDATE/EXRULE. Standardní listing expanduje výskyty; `expand_recurring` je deprecated ve prospěch importu. Změna RRULE podle srovnávací tabulky ponechá relevantní Google overrides, ale Microsoft overrides odstraní. U Microsoftu měsíční opakování nepodporuje různé ordinal indexy více dnů. Úprava EXDATE po vytvoření může vrátit 200 bez odstranění výskytu; je nutné samostatné delete. [Recurring reference](https://developer.nylas.com/docs/v3/calendar/recurring-events/)

Cookbook zároveň tvrdí, že předává RRULE poskytovateli beze změny a pravidlo se chová stejně u čtyř providerů. Tuto větu nelze přijmout jako obecnou garanci: stejná stránka připomíná limity Microsoftu. [Create recurring events](https://developer.nylas.com/docs/cookbook/calendar/create-recurring-events/) Graph samotný má strukturované `pattern` a `range`, nikoli univerzální RFC5545 řetězec na wire. [Graph patternedRecurrence](https://learn.microsoft.com/en-us/graph/api/resources/patternedrecurrence?view=graph-rest-1.0) Bez znalosti backendu Nylas nevíme, kde přesně provádí jednotlivé převody.

Import Events vrací master definitions, výjimky a samostatné události v okně. Přiznává duplicity mezi stránkami, nechronologické pořadí, neúplnou stránku i při dalších výsledcích, nepodporované metadata a Graph support v beta. [Import Events](https://developer.nylas.com/docs/reference/api/events/import-events/) Pro Musubi to je silná inspirace: mít samostatný kontrakt pro synchronizaci definic a samostatný kontrakt pro pohled na expandované výskyty. Uživatel kalendáře potřebuje výskyty; offline sync a následné write scopes potřebují definitions a přesné vztahy.

Naše K11 již odděluje Google definitions, CalDAV komponenty a Graph provider-expanded okno. Tento rozdíl je vědomé omezení, které mají klienti ukazovat prostřednictvím coverage. [Provider time import](../../sync/provider-time-import.md) Budoucí veřejný protokol by neměl předstírat, že oba režimy jsou zaměnitelné. Každá dávka potřebuje `representation`, pokrytý interval a výslovné tvrzení o úplnosti. Chybějící objekt v částečné dávce nesmí způsobit smazání; chybějící výjimka v úplném DAV prostředku naopak může znamenat návrat původního slotu.

Google primární dokumentace vysvětluje původní start jako trvalou identitu výskytu i po přesunu; úprava „this and following“ se provádí rozdělením série. [Google recurring events](https://developers.google.com/workspace/calendar/api/guides/recurringevents) Musubi tuto identitu již používá. Pro přesuny, cancellation, reminder tags i restart recovery jde o stejnou doménovou hodnotu. Nesmí být nahrazena aktuálním začátkem. Split série potřebuje plán, vazbu mezi původní a novou sérií a samostatně potvrzené kroky; není to jeden bezpečný univerzální PATCH.

Zachovat naše RDATE tam, kde máme důkaz přesné projekce. [CalDAV RDATE contract](../../sync/caldav-rdate-writes.md) Kdybychom převzali Nylas nejmenší společný model, část existujících dat bychom zjednodušili ztrátově. Lepší jsou capability profiles: plně přenositelná jednoduchá série, provider rozšíření a přečtený nezapisovatelný objekt. Profil rozhoduje o přípustných operacích, nikoli o tom, zda objekt smí vůbec existovat.

## 5. Schůzky, RSVP a soukromé nastavení nejsou jeden objekt

**Doloženo:** Nylas Send RSVP není podporováno pro iCloud. U Graph připomíná, že stav nemusí být správně aktualizován. EWS decline může objekt odstranit podle konfigurace serveru. Nylas přidává vlastní RSVP email, který může duplikovat provider email; `skip_nylas_email` jej vypne. Bez email-send scopes může vrátit 200 s chybou: stav se změní u téhož providera, ostatní provideři jej neuvidí. [Send RSVP](https://developer.nylas.com/docs/reference/api/events/send-rsvp/)

To přímo potvrzuje náš model oddělených faktů: lokální commit, provider ACK, ověřený stav kalendáře a doručení informace účastníkovi. Nejde o výmluvu pro pomalé UI, ale o různá tvrzení o realitě. Klient může okamžitě zobrazit uložený intent a průběh; nesmí prohlásit organizátorovo potvrzení pouze na základě HTTP 200. Převzetí jednoduššího Nylas statusu bez čtení chyb by skrylo přesně ty závady, kterým náš outbox předchází.

Musubi již drží osobní provider observation mimo sdílený obsah: organizer identity, self response, raw enums a reminders jsou dostupné jen živému zdrojovému členství. [Provider event state](../../sync/provider-event-state.md), [provider-event-state.ts](../../../packages/types/src/provider-event-state.ts) Tuto hranici zachovat. Na jedné schůzce mají účastníci různé RSVP a připomínky. Jeden kanonický „event status“ proto nemůže současně reprezentovat stav schůzky, odpověď připojeného uživatele a výsledek doručování.

Příležitost ke zjednodušení je ve veřejném pojmenování: `respondToInvitation`, `changeOrganizerEvent`, `changePersonalReminders`, `removeCalendarCopy`. Každá operace má actor, scope, očekávanou verzi a deklarované notifikační účinky. Obsahové PATCHy nebudou muset odhadovat, jestli attendee změna znamená vlastní odpověď nebo přepis cizích účastníků. Backend může dál používat specializované Google, Graph a CalDAV writery, ale klient dostane stejný srozumitelný návratový formát.

## 6. Zápisy, konflikty a nebezpečí jednoduchých receptů

Nylas Update Event používá PUT a výslovně nahrazuje celý odeslaný vnořený objekt. U Microsoftu neověřuje shodu dodaného `calendar_id` se skutečným kalendářem eventu. Ve zkoumané referenci není uvedeno ETag, `If-Match` ani expected-version pole. [Update Event](https://developer.nylas.com/docs/reference/api/events/put-events-id/) To je omezení veřejně dostupného důkazu. Nelze z něj vyvodit, že Nylas žádnou souběžnost interně nechrání; také nelze tvrdit, že zaručuje náš CAS kontrakt.

V changelogu z 31. srpna 2026 Nylas uvádí automatický retry EWS update po odmítnutí kvůli stale `ChangeKey`. Neříká, jak získává novou baseline nebo zachovává souběžně změněná pole. [EWS fixes](https://developer.nylas.com/docs/changelogs/2026-08-31-scheduler-and-ews-fixes/) Pro naše potřeby nestačí „chyba zmizela“. Požadujeme odpověď, zda se stejný intent aplikoval proti schválené verzi, proti nové verzi, nebo zůstal nerozhodnutý. Automatické přebazování může být vhodné pro nezávislá pole, ale musí být explicitní politikou operace.

Two-way recipe ukazuje mapping, předem uložený content hash a `metadata.key1`. Echo porovnává obsahově; odmítá ochranu založenou na krátkém časovém okně. To je dobrý základ. Současně jeho ukázka `pushToCalendar` vždy volá create, hashuje request shape a inbound shape bez zobrazené kanonizace a vyhledává lokální ID přímo z metadata. [Two-way recipe](https://developer.nylas.com/docs/cookbook/use-cases/sync/two-way-calendar-sync/) **Statické posouzení:** tato ukázka není úplný dvoucestný sync algoritmus. Nebyla provedena a závěry nejsou reportem z Nylas provozu.

Konkrétně chybí důkaz pro ztracenou odpověď po přijatém create, dvě paralelní lokální změny, pozdní starý webhook, zaměněný účet a provider normalizaci. `JSON.stringify` různě tvarovaných dat není semantický hash. Seznam účastníků může změnit pořadí; provider doplní response, jméno či další pole. Metadata od providera je korelační vstup, který musíme ověřit proti účtu, zdroji a vlastnictví. Stejný hash dokazuje stejný vybraný obsah, nikoli původ operace, doručení pozvánek ani oprávnění adoptovat novou baseline.

Musubi [write boundary](../../sync/event-write-boundary.md), [outbox](../../sync/event-outbox-worker.md) a [create recovery](../../sync/event-create-recovery.md) tyto případy řeší výrazně přesněji. Není důvod je redukovat na synchronní HTTP. Zjednodušit lze opakující se lifecycle kontroly, tvorbu immutable snapshotů, definici canonical projections a společnou klasifikaci recovery. Provider-specific verifikace výsledku zůstává nutná. Stejný „delivery envelope“ může obalit různé proof algoritmy.

Nylas rozlišuje `request_id`, normalizovaný error type a optional raw `provider_error`; provider 502 podle error guide normalizuje na 504. [Error types](https://developer.nylas.com/docs/api/errors/event-codes/), [5xx errors](https://developer.nylas.com/docs/api/errors/500-response/) Protokol Musubi by podobně oddělil kategorii pro klienta od sanitizované provider diagnostiky. K tomu musí přidat `dispatchState` a `retryDisposition`: timeout po odeslání zápisu není totožný s odmítnutím před odesláním. Bez této informace je obecný retry nebezpečný zejména u pozvánek, RSVP a create.

## 7. iCloud podpora není univerzální CalDAV

Nylas iCloud connector používá app-specific password, nabízí mail, calendar a contacts a nevyžaduje OAuth scopes. [iCloud authentication](https://developer.nylas.com/docs/provider-guides/icloud/?redirect=reorg) Generic IMAP connector poskytuje pouze email; CalDAV podpora se z jeho existence nedá odvodit. [Generic IMAP](https://developer.nylas.com/docs/cookbook/email/messages/list-messages-imap/)

Veřejný CalDAV comparison připomíná REPORT, ETags, polling a částečnou iCloud podporu sync tokens. [CalDAV comparison](https://developer.nylas.com/docs/cookbook/calendar/caldav-vs-calendar-api/) Je však nutné oddělit omezení Nylas iCloud produktu od obecného protokolu. CalDAV má prostředky s `text/calendar`; ne každá operace balí ICS do XML. Resources mohou obsahovat master a exceptions. Scheduling rozšíření definuje samostatné inbox/outbox, privileges a Schedule-Tag. [RFC4791](https://www.rfc-editor.org/rfc/rfc4791), [RFC6638](https://www.rfc-editor.org/rfc/rfc6638)

Musubi jako kandidát pro otevřený sync protokol má silný důvod zachovat vlastní obecný DAV adaptér: self-hosted servery, VTODO a přesná preservation neznámých properties jsou jiné zadání než připojit iCloud pro SaaS booking. Nevytvářet jeden „iCloud fallback“ pro všechny DAV servery. Discovery musí vracet důkaz schopností konkrétní kolekce a prostředku. Alias uživatele, write privilege a možnost serverového scheduling jsou nezávislé otázky.

Když bude potřeba kompatibilitní fallback, definovat jej jako úzký profil s vlastním důkazem a viditelným omezením. Naše [CalDAV organizer](../../sync/caldav-organizer.md) a [RSVP](../../sync/caldav-rsvp.md) mají tuto strukturu již nastavenou. Neoslabovat globální discovery jen proto, že jeden účet nevrátí očekávanou property; zachytit sanitizovanou odpověď a rozšířit parser podle konkrétního standardního nebo provider profilu.

EWS je u Nylas samostatný konektor pro on-premises Exchange; Graph je pro Microsoft cloud. EWS má vlastní scopes a požaduje síťovou dosažitelnost backendem Nylas. [List EWS events](https://developer.nylas.com/docs/cookbook/calendar/events/list-events-ews/) Není důvod přidávat EWS do Musubi automaticky. Otevřený adapter interface by jej měl umožnit; implementace má smysl až při doloženém uživatelském požadavku, protože tím vznikne nová auth, discovery a acceptance plocha.

## 8. Rozpory a tvrzení, která je nutné ověřit

| Veřejné podklady | Rozpor / chybějící důkaz | Doporučené ověření |
| --- | --- | --- |
| Events overview vs listing reference a nový iCloud cookbook | Limit iCloud okna 6 měsíců vs 1 rok | V disposable účtu vyzkoušet hranice; při integraci deklarovat konzervativní limit |
| REST event vs webhook a SDK | `when` tři vs čtyři varianty; `maybe` vs `tentative`; webhook také `confidential` | Oddělená transportní schemas, unknown-value preservation |
| RRULE cookbook vs recurring reference | Obecná konzistence vs explicitní provider výjimky | Conformance fixtures pro každé pravidlo a provider |
| Cross-provider příklad vs iCloud reference | Příklad `calendar_id=primary`, nepodporované u iCloud | Discovery skutečného calendar ID |
| PUT reference | Veřejný CAS nebo idempotency-key kontrakt nenalezen | Zeptat se na garantované conditional write; nevymýšlet podporu |
| EWS stale-ChangeKey retry | Merge a conflict politika není popsána | Dvě nezávislé edits, stale update a native readback |
| RSVP HTTP 200 s chybou | Stav a doručení jsou různé výsledky | Obě odpovědi a organizer copy v jiné službě |

Zdroje rozporů: [Events overview](https://developer.nylas.com/docs/reference/api/events/), [iCloud listing](https://developer.nylas.com/docs/cookbook/calendar/events/list-events-icloud/), [event.updated schema](https://developer.nylas.com/docs/reference/notifications/events/event-updated/), [Python events](https://developer.nylas.com/docs/v3/sdks/python/manage-events/). Rozpory nejsou důkazem chyby služby; jsou důvodem nepoužívat cookbook jako normativní protokolovou specifikaci.

## 9. Implementační plán pro menší a otevřitelný Musubi sync core

Následující plán je návrh z této studie, nikoli nové tvrzení o Nylas internals. Doplňuje hlavní implementační roadmapu.

1. **Oddělit veřejný model od provider observations.** Veřejný obsah ponese time semantics, definitions/instances, scoped identity a revisions. Soukromá observation ponese native enums, self identity, ACL proof a raw source potřebný pro preservation. Typy musí umožnit unknown i partial místo vyplňování falešného defaultu. Akceptace: žádná soukromá observation neprojde do cizího sdíleného cache.
2. **Zavést jednotný popis schopností.** Schopnost není boolean „supportsCalendar“. Je kombinací objektového profilu, actor role, scope, mutation, side effects a dostupného concurrency důkazu. Vyrábět ji ze stejných rozhodovacích funkcí, které používá admission. Akceptace: klient nemůže nabídnout operaci, kterou backend podle stejného proof odmítá; chybějící důkaz je konkrétní reason code.
3. **Vymezit dva read kontrakty.** `readDefinitions` a `readInstances` s explicitním coverage a complete/partial dávkou. Každý batch má checkpoint; commit dat a checkpointu je atomický. Akceptace: moved-out exception potlačuje původní slot a neúplná stránka nezpůsobí purge. Graph expandované zdroje nesmějí být ještě jednou lokálně expandovány.
4. **Vyčlenit čisté provider projections.** `decode`, `plan`, `encode`, `compareAccepted` mají doménové typy a žádnou přímou DB závislost. Normalizovaný hash vypočítat nad specifikovaným projection shape s předepsaným pořadím a null semantics. Akceptace: provider doplnění nepovede k echo, ale změna pásma se neztratí za stejnými instants.
5. **Sdílet lifecycle orchestration, zachovat operation proofs.** Jedna implementace intent journaling, lease fences, privacy generation a immutable snapshots. Specializovaná část určí preconditions a výsledek readback. Akceptace: timeout po možné dispatch nevytváří druhou pozvánku; reboot dokáže navázat na stejný intent.
6. **Zlepšit veřejné výsledky operací.** Stejný receipt pro všechna zařízení: `localCommitted`, provider result, verification a notification outcome. Neslučovat je do `success`. Akceptace: decline s disappearance zůstane unresolved, pokud nemáme důkaz odpovědi, a klient uchová vhodný opravný postup.
7. **Publikovat conformance corpus před širokým API.** Fixture balíček s redigovaným native vstupem, očekávaným doménovým modelem, admissible operations a přesným native výstupem. License a provenance u každé fixture. Akceptace: stejný korpus běží nad adaptérem i nad veřejnou SDK implementací; testů se neúčastní přihlašovací údaje ani produkční kalendář.

Praktická priorita je capability kontrakt a fixture corpus. Ty zjednoduší klienty a zpřehlední současnou bohatou implementaci bez rozrušení bezpečných writerů. Nové časové či recurrence schopnosti potom přidávat po operacích. Plošné přepsání sync engine podle nejjednoduššího unified API by nám přidalo migrace a acceptance práci právě tam, kde již máme kvalitní důkazy.

## 10. Minimální sada interoperability scénářů

| Scénář | Co musí protokol dokázat |
| --- | --- |
| Stejná schůzka na dvou účtech | Oddělené identity a osobní odpovědi |
| Google cancellation s minimálním objektem | Suppression původního slotu bez vymazání série |
| Přesunutý výskyt mimo okno | Původní identita potlačena i při změně rozsahu |
| Master změna s overrides | Preservation nebo explicitní odmítnutí |
| Graph UNTIL v jiném pásmu | Stejný poslední native den, ne aproximace +/−24 h |
| Floating a all-day při změně viewer zone | Správný civilní význam a den |
| Fold, gap, half-hour DST | Zachování kotvy a předepsaná disambiguation |
| CalDAV více VEVENT v jedné URL | Resource CAS a stabilní component identity |
| Neznámý VTIMEZONE / alarm property | Přesné zachování nebo read-only refusal |
| Dvě souběžné editace a stale verze | Žádný tichý přepis novější změny |
| Create přijato, odpověď ztracena | Reconciliation bez druhého create |
| RSVP přijato, odpověď ztracena | Žádný automatický druhý email |
| Starý nebo duplicitní webhook | Generation/version fence, ne časová heuristika |
| Odejmuté private access během pull | Žádný únik přes pozdní odpověď |
| Neúplný import a invalid cursor | Checkpoint a sweep zůstávají necommitnuté |

Každý živý test má zaznamenat poskytovatele, jeho endpoint, actor role, přesný scope, předchozí verzi, native readback a cleanup. Úspěšný iCloud případ není důkazem všech CalDAV serverů; zelené fixture testy nejsou produkční aktivace. Současná [capability matrix](../../../packages/docs/src/content/docs/operations/capabilities.mdx) tuto zásadu již respektuje a měla by být výchozí autoritou pro rozsah implementace.

## Otevřené otázky

- Jaké jsou garantované interní i veřejné concurrency semantics Nylas na Google/Graph/iCloud update? Veřejná reference je nedokládá.
- Jak přesně Nylas normalizuje floating time, custom VTIMEZONE a all-day original start? Samotný optional timezone kontrakt nestačí.
- Jak se chová kombinace non-primary calendars, private access a delayed notifications při revokaci práv?
- Je metadata korelace k dispozici před úspěšnou create odpovědí a po všech podobách nejistého zápisu? Import endpoint ji výslovně nemá.
- Jaká je skutečná guarantee obnovy z webhook výpadku pro definitions, exceptions a změny mimo listing okno?
- Který iCloud intervalový limit a který webhook enum kontrakt je aktuálně normativní?
- Jaké části současného Musubi jsou skutečně deployed a aktivované? Přítomnost implementace v repozitáři to sama nedokazuje.

Tyto otázky určují případný další experiment nebo dotaz na Nylas. Bez jejich zodpovězení nelze tvrdit, že jeho jednoduché veřejné rozhraní nahrazuje všechny recovery, privacy a preservation záruky Musubi.
