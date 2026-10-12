# Audit Musubi: co zachovat, co zjednodušit a co lze vydat jako sync protocol

Datum: **12. října 2026**. Auditovaná lokální revize: `99e613f4d43336131b844b62c3d0c06635ff5964`. Zdroje a čísla řádků v tomto dokumentu odkazují na tuto revizi, nikoli na historické zářijové audity. Jde o audit skutečných toků v kódu a návrh hranic pro budoucí veřejné jádro. Produkční konfigurace, živé účty a doručení pozvánek nebyly během tohoto auditu ověřovány.

## 1. Hlavní zjištění

Musubi již řeší velkou část obtížné synchronizace způsobem, který má vlastní hodnotu: drží odděleně kanonickou událost, kopie u providerů, původní identitu výskytu, privátní providerové pozorování a trvalý záměr zápisu. Nezaměňuje úspěšné uložení do PostgreSQL za doručení do Google, Outlooku nebo CalDAV. Tyto vlastnosti je vhodné použít jako základ veřejného projektu, nikoli je odstranit při inspiraci jednodušším jednotným API.

Trvalý zdrojový záměr však není plošná garance neměnné providerové serializace napříč upgradem. Generic event executor projekci znovu počítá a task ji definitivně fixuje až před dispatch. Stejně tak korektní bounded Graph import dnes nerozlišuje všechny důsledky coverage eviction od provider deletion. Tyto konkrétní mezery rozebírá §9.1–9.3; nejsou připsané již dokončenému veřejnému protokolu.

Zbytečná složitost leží především v hranicích modulů. Současný `CalendarAdapter` přenáší databázové typy a desítky specializovaných operací, obecný engine obsahuje přímé větvení podle provideru a stejná orchestrace se opakuje v několika executorech. Rozhraní v `apps/api/src/sync/adapter.ts:144` má 311 řádků, `apps/api/src/sync/engine.ts` 1 014, `apps/api/src/sync/event_delivery.ts` 804 a `packages/db/src/queries/external.ts` 1 699. Počet řádků sám není chyba; ilustruje však, že „malý providerově nezávislý adapter“ dnes popisuje pouze část reality.

První doporučení je proto **vyjmout model, záruky a runtime mechanismy za explicitní porty**, zachovat specializované providerové operace a Musubi ponechat jako prvního konzumenta. Nylas je užitečný srovnávací vzor pro ergonomii integrací a jejich veřejný kontrakt. Z veřejného jednotného endpointu ale nelze odvozovat, že jeho interní sémantika, konzistence nebo způsob uložení jsou jednodušší než naše.

## 2. Jak synchronizace skutečně funguje

### Pull a autoritativní discovery

`syncUser` v `apps/api/src/sync/engine.ts:577` spouští sdílený `runProviderSyncs`. Ten izoluje selhání discovery a jednotlivých účtů; plánovaný běh pokračuje na zdravé účty, uživatelský connect se při `throwOnError` zastaví (`apps/api/src/sync/orchestrator.ts:29`). Toto rozlišení je dobré: účet, jehož bootstrap selhal, se nesmí uživateli prezentovat jako připojený a naplněný.

`syncProviderImpl` nejprve získá celý seznam kalendářů, řeší zmizelá zrcadla, přístup a nové kalendáře a následně stahuje každou kolekci (`apps/api/src/sync/engine.ts:301`, `apps/api/src/sync/engine.ts:381`). Discovery výsledek má `taskListsComplete`: chybějící volitelný Tasks grant není důkaz smazání task-listů (`apps/api/src/sync/adapter.ts:128`). Google tuto hranici skutečně implementuje v `apps/api/src/sync/adapters/google.ts:751`; nejde pouze o poznámku v dokumentaci.

`reconcileExternalChanges` rozlišuje jednotlivý event, celý event resource a task, vede samostatné množiny viděných událostí a úkolů a sweep provede jen při úplném resetu (`apps/api/src/sync/engine.ts:201`). Cursor se ukládá až po zpracování v `apps/api/src/sync/engine.ts:535`. Jednotlivé DB operace se mohou před pozdější chybou již commitnout; další běh opakuje starý cursor a musí být idempotentní. Kód proto v `apps/api/src/sync/engine.ts:521` oznamuje také změny z úspěšné části neúplného běhu. To je podstatně poctivější než předstírat jedinou transakci přes HTTP a všechny záznamy.

### Zápis a durable delivery

Event create ukládá kanonickou událost, účast autora, členství v kalendářích a outbox v jedné transakci (`packages/db/src/queries/events.ts:47`, `packages/db/src/queries/events.ts:80`). `appendEventOutbox` zapisuje přijatou revizi a předchůdce stejného cíle (`packages/db/src/queries/event-outbox.ts:98`). Zápis providerovi běží mimo transakci. Následník může pokračovat jen po dokončeném nebo nepotřebném předchůdci (`packages/db/src/queries/event-outbox.ts:163`).

Claim používá `FOR UPDATE SKIP LOCKED`, trvalý lease token, dvouminutové lease a příznak nejistoty ještě před síťovým požadavkem (`packages/db/src/queries/event-outbox.ts:203`). Event executor obnovuje lease, používá `AbortController`, ověřuje aktuální identitu destination a po 45 sekundách pokus ukončí (`apps/api/src/sync/event_delivery.ts:104`, `apps/api/src/sync/event_delivery.ts:140`, `apps/api/src/sync/event_delivery.ts:734`). Takový timeout není důkaz neprovedení vzdáleného zápisu. Znovu převzatá operace proto přechází do reconciliation.

Scheduler je součást API procesu. Každý drain vezme nejvýše 40 položek a má čtyři workery (`apps/api/src/sync/engine.ts:116`, `apps/api/src/sync/engine.ts:143`). Provoz je vědomě single-replica: start získává PostgreSQL singleton lock před migrací a posloucháním (`apps/api/src/index.ts:698`). Není tedy korektní doporučit pouhé nasazení druhého API a prohlásit systém za škálovaný díky `SKIP LOCKED`; SSE, plánování a další stav stále mají jinou hranici.

## 3. Identita je nejsilnější část jádra

Schéma odděluje `events.id` a lokální `revision` od `external_events.externalEventID`, ETag a iCalendar UID (`packages/db/src/schema.ts:257`, `packages/db/src/schema.ts:868`). Mapování je scoped na provider a **lokální mirror kalendář**, nikoli na globální vzdálené calendar ID. Komentář i unique constraint v `packages/db/src/schema.ts:881` a `packages/db/src/schema.ts:901` explicitně řeší dva uživatele se stejným veřejným Google kalendářem. Automatický cross-account join přes `iCalUID` by tuto izolaci porušil.

Kanonická identita výskytu je dvojice series ID a **original start**, nezávislá na přesunutém start/end (`packages/types/src/event_time.ts:56`, `packages/types/src/event_time.ts:88`). DB vyžaduje společnou existenci series/originalStart, zakazuje self-reference a má unikátní dvojici série a původního času (`packages/db/src/schema.ts:298`). Tato identita umožňuje přesun, zrušení a následné obnovení výjimky, aniž by vznikl druhý výskyt.

Současně existují různé reprezentace. Běžný Graph calendarView poskytuje rozbalené instance, jejichž providerový parent je observation-only a nesmí automaticky vytvořit kanonickou lokální sérii (`apps/api/src/sync/adapter.ts:18`, `apps/api/src/sync/adapters/microsoft.ts:643`). Explicitně sledovaná konečná Graph family má jiný kontrakt a reconciliuje se jako celek (`apps/api/src/sync/engine.ts:399`). CalDAV resource může obsahovat master i detached výjimky a vstupuje atomicky přes `replaceExternalEventResource` (`packages/db/src/queries/external.ts:714`). Je správné sdílet identitní primitiva; není správné zaměnit tyto reprezentace jen proto, že všechny obsahují události.

## 4. Časový model není přebytečné komplikování

`EventTimeModel` rozlišuje `legacy-unknown`, `all-day`, `zoned` s civilními kotvami a IANA zónou a `floating` bez zóny (`packages/types/src/event_time.ts:30`). Uchování startLocal/endLocal je nutné i tehdy, když máme UTC instant: explicitní čas v DST gapu se může po převodu zpět změnit a nesmí tím změnit kotvu opakování.

`civilToInstant` řeší explicitní čas a generated recurrence rozdílně: explicitní gap používá pravidla kompatibilního rozlišení, generated gap vynechává (`packages/calendar/src/time-zone.ts:14`). Pro providerové operace, u nichž nedokážeme jejich chování doložit, existuje přísnější `unambiguousCivilToInstant` (`packages/calendar/src/time-zone.ts:34`). Úplné time edit je samostatná hodnota, nikoli patch náhodné kombinace časových polí (`packages/types/src/event_time.ts:98`).

Historickou komplikací je inclusive poslední datum all-day v Musubi, zatímco providerový konec bývá exclusive. Je přímo součást dnešního kontraktu (`packages/types/src/event_time.ts:118`). Veřejný nový protocol může zvolit standardnější date interval `[startDate, endDateExclusive)`, ale musí mít explicitní Musubi bridge a migraci. Přepnutí pole bez verze by rozbilo staré klienty, alarmy a exporty. Zde lze zjednodušit **nový kontrakt**, ne potichu přepsat současný význam.

Další dluh představují dvě časové cesty: legacy a known-time. Jsou oprávněné kvůli již vydaným klientům a neúplným starým datům. Pro nový balíček lze ponechat legacy import bridge jako explicitní kompatibilní modul; výchozí jádro by mělo vyžadovat plně typovaný čas. Z evidence bez zóny se zóna nesmí domyslet podle serveru nebo uživatele.

## 5. Providerové pull rozdíly, které normalizace nesmí skrýt

| Oblast | Ověřená implementace | Důsledek pro veřejné jádro |
| --- | --- | --- |
| Google | `apps/api/src/sync/adapters/google.ts:579` stránkuje seznam a používá sync token. HTTP 410 zahodí všechny částečné stránky a restartuje úplný set (`:590`). Chybějící master instance hydratuje před importem (`:617`). | Cursor je neprůhledný stav provideru; reset je autoritativní až po úplné sadě a povinných závislostech. |
| Microsoft | `apps/api/src/sync/adapters/microsoft.ts:547` používá calendarView/delta; cursor obsahuje link a konec okna (`:487`). Okno má −180 / +730 dní (`:61`). Master cache je pro konkrétní běh a chybná hydratační GET zastaví import (`:521`). | „Nic nenačteno“ neznamená „žádná událost“. Výsledek musí umět deklarovat coverage interval a typ reprezentace. |
| CalDAV | `apps/api/src/sync/adapters/caldav.ts:847` používá sync-collection a multiget; kontroluje úplnost získaných resources (`:784`). Fallback provádí kompletní PROPFIND bez časového omezení (`:1552`). | Resource je jednotka verzování i zápisu. Chybějící response nesmí být interpretována jako smazaný VEVENT. |

CalDAV tedy již inkrementální sync má. Doporučit jeho zavedení jako novou úlohu by vycházelo z neaktuálního obrazu. Skutečné zlepšení je omezit opakovanou discovery a zviditelnit fallbacky. `listCalendars` volá `client.fetchCalendars` (`apps/api/src/sync/adapters/caldav.ts:1492`) a každé `fetchChanges` znovu (`apps/api/src/sync/adapters/caldav.ts:1522`). Pro účet s mnoha kolekcemi jde o zřejmou možnost sdílet validovaný account session context v jednom běhu. Práva se stále musí čerstvě ověřit v bodech, kde představují podmínku mutation.

Google sbírá celý stránkovaný payload do paměti, Graph celý delta set, engine poté iteruje DB operace. Pro větší účty stojí za pilot staging buffer v PostgreSQL nebo omezené dávky. Streaming přímo do kanonických tabulek před potvrzením reset completeness by však obnovil chyby sweepu. Optimalizace musí zachovat commit barrier „celý snapshot je známý“, nikoli jen snížit spotřebu paměti.

## 6. Privacy retirement je synchronizační invariant

Přístup není jen atribut kalendáře pro zobrazení tlačítka. Discovery změna zvyšuje `providerAccessRevision`, invaliduje cursor a při zúžení rediguje mirror před dalším fetch (`packages/db/src/queries/external-access.ts:19`). Každý přijatý import ověřuje přesnou source identitu a tuto generaci (`packages/db/src/queries/external-access.ts:36`). Staré HTTP čtení dokončené po odebrání práv proto nesmí obnovit soukromý obsah.

Lifecycle fences mají pevné pořadí a rozdíl shared/exclusive (`packages/db/src/queries/calendar-lifecycle.ts:4`). Celý CalDAV resource je přijat až pod fence, family locks a kontrolou pending writes (`packages/db/src/queries/external.ts:718`, `packages/db/src/queries/external.ts:760`). To nelze nahradit obecným „last write wins“ ani pouze porovnáním ETag.

Busy intervaly jsou správně oddělené od detailových událostí. Google `freeBusyReader` jde do samostatné discovery množiny, nikoli do mirroru obsahujícího staré názvy (`apps/api/src/sync/adapters/google.ts:730`). Availability dotaz kontroluje zdrojové i account generation před a po požadavku, rozlišuje reconnect-required/unavailable/available a validuje celé pokrytí (`apps/api/src/sync/google_availability.ts:9`, `apps/api/src/sync/adapters/google_freebusy.ts:5`). Prázdný potvrzený interval je důkaz dostupnosti; síťová chyba jím není.

Veřejný protocol by měl tyto vlastnosti pojmenovat jako **source admission epoch**, **read retirement** a **coverage evidence**, s přesnými zárukami. Nemá kopírovat názvy `Google` do obecného privacy portu; dnešní `getGoogleMirrorReadCalendars` i `removeGoogleCalendarMirrors` již engine používá pro více providerů (`apps/api/src/sync/engine.ts:322`, `apps/api/src/sync/engine.ts:525`). To je opravdový naming/ownership dluh, nikoli důvod odstranit ochranu.

## 7. Pozvánky, RSVP a „doručeno“

Provider state obsahuje organizer/self proof, kompletnost attendees, vlastní response, nativní reminders, privacy, availability a conference URLs (`packages/types/src/provider-event-state.ts:5`). Nativní enumy se cíleně neslévají do enumu jiného provideru (`:18`). Tento privátní observation model je oddělený od Musubi social attendance a od osobních lokálních připomínek.

Executor má permanent dispatch marker před operacemi, které mohou rozeslat pozvánku nebo odpověď, a specializované read-only recovery. Graph organizer větvení v `apps/api/src/sync/event_delivery.ts:194` umí observed/deleted/rejected/unknown; CalDAV větev v `:204` používá vlastní transport a proof. Naivní abstrakce `retry(action)` by mohla podruhé pozvat hosty. Sdílet lze skeleton lease, timeout, outcome a persistence; providerová rozhodnutí, kdy je bezpečný nový zápis, musí zůstat u operace.

Současný receipt je po destination, nikoli „vše synchronizováno“ (`packages/types/src/event_delivery.ts:6`). `completed` pro konkrétní záznam není důkaz, že host dostal email. Capability matrix tento rozdíl veřejně uvádí (`packages/docs/src/content/docs/operations/capabilities.mdx:13`). Vývoj veřejného protocolu musí rozlišovat nejméně lokální commit, přijetí providerem, readback výsledku a samostatný notification outcome. Slíbit exactly-once email nad API bez odpovídající providerové garance by bylo nepravdivé.

## 8. Úkoly ukazují, jak se vyhnout synchronizační smyčce

`upsertExternalTask` aktualizuje kanonický obsah jen při pullu do `originCalendarID`; sekundární kopie potvrzuje vlastní projection baseline (`packages/db/src/queries/external.ts:1366`). Jen změny polí, která provider reálně reprezentuje, vstupují do patch; následně se fanout posílá do ostatních kopií (`:1368`, `:1378`). Retained delete a nevyřešený create brání opětovnému importu nové zdánlivé identity (`:1326`, `:1390`).

Task executor při nejistém create u Google/Graph bez zachycené adresy odmítá další POST. CalDAV může přečíst deterministickou URL (`apps/api/src/sync/task_delivery.ts:58`). Nový validator po GET se nestává automaticky write baseline (`:90`). Tyto vlastnosti jsou dobrý základ pro obecný synchronization protocol i mimo kalendář.

Konkrétní zjednodušení s funkčním přínosem: event a task runtime dnes divergují. Event má celkový deadline, AbortSignal, Retry-After, exponenciální backoff a jitter (`apps/api/src/sync/event_delivery.ts:734`, `:764`). Task má lease renewal a pevné retry za 60 sekund, ale executor nemá obdobný celkový deadline (`apps/api/src/sync/task_delivery.ts:28`, `:119`); `ProviderTaskWriteError` nepřenáší Retry-After (`apps/api/src/sync/task_write.ts:7`). Tick čeká sekvenčně event → task → Outlook moves (`apps/api/src/index.ts:671`). Nejde o reprodukovaný provozní incident, ale je doložená nesymetrie: dlouhý task request může zadržet další drain. Společný runtime port pro deadline/cancellation a retry výpočet zde má vyšší prioritu než přejmenování souborů.

## 9. Co je dnes opravdu zbytečně složité

1. **Rozhraní závislé na storage implementaci.** `apps/api/src/sync/adapter.ts:2`, `:7`, `:11` importuje typy z `@musubi/db`; specializované metody v `:145` nesou GraphMeetingContext a jiné DB struktury. Providerový balíček tak není použitelný s cizím storage bez Musubi schema. Přesunout transportní evidence a přijaté intent typy do samostatného modelu, query specifické kontexty ponechat v bridge.
2. **Operace reprezentované volitelnými properties payloadu.** Outbox payload v `packages/db/src/schema.ts:944` může mít organizer, rsvp, caldavSplit, graphSeriesCreate a další současně. Větve executorů pak zajišťují, která kombinace je legitimní. Nová verze má používat discriminated envelope s operation kind a schema version; staré řádky dostanou explicitní decoder. Přínos je dohledatelná admission a jednoduchá evoluce kontraktu.
3. **Podobná orchestrace rozptýlená mezi providery a features.** Lease, destination check, error mapping, retry a notifikace mohou být sdílené. Source/series/organizer proof a no-resend pravidla musí zůstat samostatné. Cílem je registry handlerů operací, nikoli jeden obří writer pro všechny event varianty.
4. **Plánování čtení a recovery sdílí vypínač.** `EXTERNAL_SYNC_INTERVAL_MIN=0` vypne také background outbox (`apps/api/src/index.ts:742`). Dokumentace to pravdivě popisuje v `packages/docs/src/content/docs/architecture/sync.mdx:193`, ale provozovatel může chtít webhook/on-demand pull a trvalou recovery. Oddělit konfiguraci a stav workeru od poll interval.
5. **Serializace všech uživatelů a účtů.** `apps/api/src/index.ts:622` a `apps/api/src/sync/orchestrator.ts:68` jsou sekvenční. Bezpečný další krok jsou per-account fronty s omezenou konkurencí a rozpočtem providerových požadavků, nikoli nekontrolované `Promise.all` pro každý kalendář.
6. **Přísně omezené CRUD kalendáře mají jinou recovery.** Calendar mutations jsou provider-first; po vzdáleném úspěchu může selhat lokální uložení (`packages/docs/src/content/docs/architecture/sync.mdx:107`). Sjednocení durable modelu pro calendar lifecycle je další skutečná funkční práce. Nevydávat tuto oblast za transactional jen proto, že events outbox už existuje.

Pull errors navíc často obsahují HTTP status jen v textu a transient classifier je parsuje regexem (`apps/api/src/sync/errors.ts:43`). Zavedl bych strukturovanou chybu s phase, status, retryAfter, reason a outcome. Samotný HTTP wrapper nesmí automaticky opakovat mutation; rozhodnutí patří handleru operace.

### 9.1 Graph reset: absence v okně se dnes propaguje jako deletion

Při obnově Graph okna nebo neplatném cursoru vrací `fetchMicrosoftChanges` `reset` (`apps/api/src/sync/adapters/microsoft.ts:569`). Engine předá všechny ID z nového okna, doplněné o zvlášť přijaté tracked families, do `sweepExternalEvents` (`apps/api/src/sync/engine.ts:510`). Sweep projde **všechna** mapování daného mirror kalendáře a každé chybějící ID předá běžné `deleteExternalEvent` (`packages/db/src/queries/external.ts:1197`, `packages/db/src/queries/external.ts:1223`). U autoritativního domácího eventu tato cesta vytvoří tombstone, zvýší revizi a přidá outbound delete fanout (`packages/db/src/queries/external.ts:1183`).

To znamená, že událost, která pouze zestárla nebo se přesunula mimo načítané okno, může lokálně projít stejnou cestou jako skutečná provider deletion. Pokud má sekundární provider kopie s mapováním nebo předchozí operací, může vzniknout záměr jejich smazání (`packages/db/src/queries/event-outbox-fanout.ts:70`). Existence tohoto intentu ještě nedokládá provedený HTTP DELETE: následný writer může konkrétní časový nebo providerový tvar odmítnout (`apps/api/src/sync/event_delivery.ts:508`). Jde o ověřený tok v kódu, nikoli během studie reprodukovaný živý incident. Zvlášť tracked Graph families mají samostatné retention ID a deletion guard (`packages/db/src/queries/external.ts:1096`); nález se nesmí zobecnit na jejich libovolné smazání.

Navržený nový read profil má rozlišit **explicitní deletion**, **úplný collection inventory** a **úplné časové okno**. Absence v okně může odsunout data z aktuálního mirror coverage, nesmí sama získat autoritu smazat sdílený kanonický event nebo jeho další kopie. Zavedení coverage obálky tedy není pouze kosmetická změna DTO. První extrakce má transparentně pojmenovat současný host profil; změna eviction sémantiky potřebuje vlastní rozhodnutí, kompatibilitu klientských tombstones a explicitní pravidla uchování identity.

Navržený DB test: importovat domovský Graph event sdílený do lokálního kalendáře a jiného podporovaného provider cíle; změnit okno tak, že event vypadne. U nového coverage profilu potvrdit, že nevznikl foreign delete intent, nevznikla nová canonical identity a explicitní pozdější native deletion stále projde správnou authority cestou. Přidat samostatný přesunutý override mimo okno, pending edit během resetu a controlled tracked-family variantu.

### 9.2 Zdrojový intent a dispatch projection potřebují různé verze

Generic event executor načítá uložený `payload.event`, ale následně volá **aktuální** `adapter.projectEvent` (`apps/api/src/sync/event_delivery.ts:512`). Výsledek používá pro recovery comparison a ukládá přes `setEventOutboxProjection` (`apps/api/src/sync/event_delivery.ts:525`). Tento query update nemá podmínku „projekce ještě neexistuje“; při platném lease přepíše `providerProjection` (`packages/db/src/queries/event-outbox.ts:250`). Záměr tedy nevychází z novějšího canonical eventu, ale jeho providerová reprezentace se může po změně serializeru mezi vydáními změnit.

Task má užší, ale důležitou hranici: pokud existuje `dispatchProjection`, použije její target; jinak znovu serializuje uložený task aktuálním `projectTask` (`apps/api/src/sync/task_delivery.ts:52`). Před dispatch uloží target/baseline/patch a DB writer jej podmíněně fixuje jen jednou (`apps/api/src/sync/task_delivery.ts:76`, `packages/db/src/queries/task-outbox.ts:179`). Po této fixaci target drží. Předběžná `providerProjection` z admission však není plošný závazek, že upgrade před prvním dispatch nebo před uložením dispatch projection zachová stejný serializer výsledek.

Nový contract proto potřebuje operation schema version **i serializer/profile version**, explicitní uloženou přijatou projection a pravidlo, kdy se může bezpečně dopočítat dispatch baseline z předchůdce. Legacy decoder nesmí starý záměr „vylepšit“ aktuálními defaulty. Navržený test má mezi enqueue a restartem změnit serializer A→B: jednou před prvním dispatch, podruhé po nejistém vzdáleném úspěchu. Ověřit nezměněnou původní projection, nulový neautorizovaný resend a pokračování nebo explicitní blokaci při nedostupném původním serializer profilu. Nejde o požadavek zavádět immutable raw request bytes pro všechny dynamické hlavičky a credentials.

### 9.3 Graph DELETE je guarded preflight, nikoli conditional CAS

Osobní Graph DELETE má v implementaci výslovně zaznamenaný, uživatelem schválený kompromis (`apps/api/src/sync/adapters/microsoft_event_content.ts:87`). Ověří právě přijatou nativní verzi, odešle DELETE s `If-Match` pouze jako best effort a přečte výsledek (`apps/api/src/sync/adapters/microsoft_event_content.ts:91`). Protože Graph tento condition ignoruje, změna mezi posledním GET a DELETE může být smazána. Conditional PATCH má odlišný endpointový důkaz; společný ETag-shaped string tyto dvě operace nesjednocuje.

Executor po nejistém DELETE pouze pozoruje. Ani opět přítomná stejná verze neopravňuje druhý unconditional DELETE; nový zápis vyžaduje čerstvý explicitní resolution intent (`apps/api/src/sync/event_delivery.ts:604`). Existující DB test kontroluje lost-success read recovery bez druhého DELETE (`apps/api/src/sync/microsoft_delete.integration.test.ts:75`). Veřejná capability má zvlášť deklarovat profil **conditional-write** a **guarded-preflight-with-race**, včetně omezení příslušného endpointu. Požadovat CAS plošně by odstranilo dnes podporovanou schválenou funkci; vydávat preflight za CAS by naopak zamlčelo její riziko.

Při extrakci zachovat regression scénáře pro stale PATCH rejection, remote edit po posledním delete GET, timeout při retained objektu a explicitní nový intent. Runner nesmí po sjednocení retry politik začít znovu odesílat původní nejistý Graph DELETE ani jeho scheduling variantu.

## 10. Návrh hranice pro open-source vydání

| Navržená vrstva | Co vyjmout ze současného kódu | Co ponechat Musubi |
| --- | --- | --- |
| Model / protocol | Time a occurrence identity, operation envelope, source scope, capability proof, delivery outcome, schema version. | Uživatelé, produktové barvy, social attendance, stránky a konkrétní API texty. |
| Čistá doména | Temporal převody, expanze, scope plány, comparison projekcí, výpočet recovery rozhodnutí. | UI drafts a popisy tlačítek, layout a renderování kalendáře. |
| Runtime | Claim/renew/finish port, deadline, transport hooks, structured retries, admission epoch, scheduler signal. | Express, Better Auth, SSE a současný single-replica boot. |
| Provider packages | Google/Graph/CalDAV read/write evidence a serialization, capability evaluation, operace a jejich safety contracts. | Načítání tokenů přímo z Musubi DB a query kontexty; nahradit credentials/storage portem. |
| Storage reference | PostgreSQL bridge, atomic append intent, ordering a lifecycle locks, migrace pro vlastní reference schema. | Historické Musubi migrační řady a vazby na memberships/social data. |
| Conformance | Replay traces, fake HTTP providers, property/invariant fixtures, crash/recovery suite. | Produktová browser acceptance a nativní device release evidence. |

První veřejná verze může být knihovna se specifikací a reference PostgreSQL implementation. Není nutné hned navrhovat nový HTTP standard, daemon a multi-tenant SaaS. Opačně nestačí zveřejnit dnešní `apps/api/src/sync/adapter.ts` a nazvat to protocol: chyběly by jeho skryté DB garance, privilege proof a recovery.

Musubi↔Musubi federace má odlišný smysl. ADR-005 odmítá provider mirror kvůli ztrátě členství, rolí, attendance a pozvánek (`docs/adr/ADR-005-federation-gateway.md:23`). Aktuální gateway skutečně vybere callerovu connection z DB, sestaví cíl, kontroluje peer verzi a přiloží jen upstream credential (`apps/api/src/handlers/federation_proxy.ts:57`). Nevydával bych ji v první fázi jako čtvrtý calendar provider. Později může používat identity/outcome model, ale společná spolupráce potřebuje vlastní protokol oprávnění a federované autority.

## 11. Testy: co existuje a co zatím nemůžeme tvrdit

Audit reprezentativně ověřil obsah testů, nikoli pouze názvy. `apps/api/src/sync/engine.test.ts:12` kontroluje mixed event/task import, oddělené sweepy a tichý no-op bez resetu. `apps/api/src/sync/orchestrator.test.ts:40` izoluje vadnou discovery a vadný účet, potom potvrzuje další retry a strict trigger. `apps/api/src/sync/adapters/provider_http.test.ts:134` simuluje částečnou Google stránku následovanou 410. `apps/api/src/sync/event_delivery.integration.test.ts:252` ověřuje odklad i explicitního ticku podle Retry-After. Schéma i DB migrační a sync suites jsou zapojené do čtyřshardové PostgreSQL CI (`.github/workflows/quality.yml:190`, `:249`); fake provider však stále není živá certifikace.

Během tohoto auditu prošlo **sedm cílených kontrol** přes `node --import tsx`: `packages/types/src/event_time.test.ts`, `packages/types/src/wire.test.ts`; `packages/calendar/src/time-zone.test.ts`, `packages/calendar/src/time-expansion.test.ts`, `packages/calendar/src/scope-plan.test.ts`; `apps/api/src/sync/orchestrator.test.ts` a `apps/api/src/sync/engine.test.ts`. To ověřuje aktuální čistý model a reprezentativní orchestrace. Plné `pnpm` suites nebyly dokončeny a nepřipisuji jim úspěch. Neproběhl DB integrační běh ani live provider round-trip.

Pro veřejné jádro chybí především **sdílená conformance sada běžící proti každému provideru**. Dnes mají jednotlivé operace bohaté vlastní regression suites; registry by měl navíc každému adaptéru vynutit stejné scénáře: duplikovaný trigger, crash před dispatch markerem, crash po provider accept před lokálním ACK, propadlý lease, downgrade access mezi GET a commit, neúplná stránka, souběžný delete a delayed echo. Doplnit cílený timeout/Retry-After test task runtime a konfiguraci recovery při vypnutém pollu.

Další doporučená evidence: deterministické trace replay pro payloady se odstraněnými osobními daty; metamorfické testy zachování původních slots při přesunu a DST; bounds testy pro velkou collection a mnoho kalendářů; upgrade testy decoderu starých intents. Živé testy musí používat vlastní disposable resources a výslovně evidovat mailbox/tenant/server, datum, operation contract a cleanup. Aktuální capability matrix má správně zvlášť implemented, automated, live, deployed a deferred (`packages/docs/src/content/docs/operations/capabilities.mdx:13`); tento formát převzít i do open-source projektu.

## 12. Doporučené pořadí práce

**První malá dávka:** přidat společnou structured error a deadline/retry politiku, napojit na ni task executor, oddělit background recovery od poll vypínače. Acceptance: timeout u jednoho tasku nezablokuje příští plánování, Retry-After se respektuje, nejistý create se nikdy slepě neopakuje a současné event/task integration testy zůstanou beze změny výsledků.

**Druhá dávka:** zavést nové storage-free typy pro source, normalized evidence a operation envelope. Napsat bridge z dnešního outbox payloadu a DB contextů. Převést jednu jednoduchou osobní event operaci a jednu task operaci, nikoli všechny providerové specializace naráz. Acceptance: žádný import `@musubi/db`, Express ani produktové config v novém modelu; beze změny wire kontraktu Musubi.

**Třetí dávka:** vyjmout čisté occurrence/time/scope jádro a registry handlerů. První provider package musí běžet s fake storage a injected credentials, vedle Musubi PostgreSQL bridge. Každé další vyjmutí se hodnotí podle absence nových cyklických závislostí a stejné admission/recovery trace.

**Čtvrtá dávka:** omezit opakovanou discovery, přidat per-account request budget a coverage model, teprve potom staging/streaming a webhook invalidation. Webhook má označit zdroj k syncu, nikoli přepsat kanonický event podle potenciálně duplicitního nebo neúplného notification payloadu. Polling zůstane legitimní pro self-hosting.

**Veřejná release dávka:** napsat normativní invarianty a omezení, conformance harness, kompatibilní schema versioning a reference application. Dnešní `packages/types/src/wire_contract.ts:39` už kontroluje směrově odlišnou kompatibilitu request/response; využít princip, nikoli exportovat celý Musubi wire registry s produktovými dokumenty.

Výsledná studie by měla čerpat inspiraci z Nylas tam, kde zmenšuje integrační práci konzumenta: jeden účetový lifecycle, dohledatelné capabilities, konzistentní chybový model a dobré SDK. Naše vlastní výhoda je doložitelný vztah mezi uloženým záměrem, jeho autoritou, providerovým důkazem a bezpečnou recovery. Právě tento vztah je vhodné vydat otevřeně.
