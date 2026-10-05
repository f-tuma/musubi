# K10 acceptance — časový model a identita výskytu

> Historický audit K10. Níže uvedené checkpointy zachycují tehdejší omezení
> a přijetí; nejsou aktuálním seznamem otevřených funkcí. Nevydanou přípravu
> 0.1.8 nahradil koordinovaný release 0.2.0, zachycený v
> [historickém aktivačním záznamu](../releases/core-0.2.0-activation.md).
> Současné schopnosti a důkazy popisuje [matice v0.2.2](../../packages/docs/src/content/docs/operations/capabilities.mdx),
> stav vydání a kompatibilitu [release přehled](../../packages/docs/src/content/docs/operations/releases.mdx).

K10 uzavírá implementaci lokálního časového modelu, identity a společných konzumentů. Produkční aktivace a release nejsou součástí tohoto převzetí. K11–K15 zůstávají otevřené. Historické checkpointy v implementačním plánu popisují stav při jednotlivých PR; následující matice je aktuální souhrn.

## Převzaté chování a důkazy

| Oblast | Výsledek | Regresní evidence v repozitáři |
| --- | --- | --- |
| Kontrakt a storage | Zoned/floating/all-day, unresolved legacy bez odhadované zóny; nullable aditivní metadata, původní čas a revize beze změny. | `packages/types/src/event_time.test.ts`, `packages/db/src/queries/event-time.integration.test.ts`; upgrade0062→0063 ověřen v PR131. |
| DST a expanze | Explicitní gap/fold politika, recurrence gap nečerpá COUNT, rozdílné US/EU týdny, nehodinový posun, inclusive all-day. | `packages/calendar/src/time-zone.test.ts`, `time-edit.test.ts`, `time-expansion.test.ts` v UTC/Prague/New_York. |
| Identita výskytu | Původní recurrence start se nemění při přesunu; moved/cancelled definice potlačují původní slot; identity přežijí DB a native cache. | Typové/DB time testy, sdílená expanze a native durable-cache regrese převzatá v PR137. Veřejné vytváření detached rodin se ještě nepovoluje. |
| Konzumenti | Web, native, widget snapshot, anonymní preview a server/native/web reminders dostávají společnou projekci a explicitní zónu. Neplatná expanze se hlásí. | PR134–146, root testy; skutečný PostgreSQL reminder test a SQLite cache test. Fyzické OS doručení viz K14/K15. |
| Lokální edit | Jeden CAS pro čas i obsah; oběma editorům zůstává draft při odmítnutí; known model se nezahazuje. | PR147–152, `apps/api/src/handlers/event_time.integration.test.ts`, web/native editor testy. |
| Celá série | Stejný model a zóna, prosté RRULE: civilní posun vybraného výskytu se přenese na zmrazený master. | PR153–154; `series-time-edit.test.ts`, HTTP CAS, native composer/reminder a web scope/full-editor Playwright. |
| Create/copy | Tři explicitní modely, recurrence při vytvoření, permission/lifecycle transakce; copy zachovává přesný instant včetně druhého DST foldu. | PR155; shared draft test ve třech zónách, autentizované HTTP/DB, native Weekly civil-date regrese, web narrow-dark/desktop-light refusal/retry a axe. |
| Legacy/provider hranice | Legacy časový diff proti known modelu se odmítne pod CAS; metadata nelze podstrčit do generic create/PATCH; provider preflight i worker odmítají neznámý write kontrakt. | PR139/149 a `test:db:events` / provider delivery regrese. |
| Rodiny a odstranění | Generic unlink/tombstone odmítá detached identitu i master s dítětem včetně tombstone; odmítnutí zachová revizi a vazby. | `packages/db/src/queries/event-time.integration.test.ts`. Atomic family operace patří do K12. |
| Aktivace | Produkční start se zapnutým flagem selže před migrací/listen, dokud produkt i vynucená klientská/peer minima nejsou novější než vydané 0.1.8. | `apps/api/src/event_time_activation.test.ts`; globální version middleware a federation gate z K09. |

## Záměrně nepovolené operace

Lokální explicitní writery odmítají externí kalendáře, provider mappings/outbox historii a detached rodiny. Scope This event / following, změna typu/zóny/recurrence existující série a adopce legacy série vyžadují K12. Provider rehydratace a component mapping jsou K11. Shared reader umí původní identity zpracovat, ale tím se nepovoluje jejich veřejný zápis.

## Podmínky produkční aktivace

`EVENT_TIME_EDITS_ENABLED` zůstává false. Žádná minimální ani produktová verze se v tomto převzetí nezvyšuje. Samotné nastavení flagu na produkčním buildu 0.1.8 nyní ukončí start s konkrétní chybou.

Při budoucím koordinovaném release musí být vydané kompatibilní web/native klienty a peer servery, produktová verze i `MIN_CLIENT_VERSION` a `MIN_PEER_VERSION` musí být novější než 0.1.8 a server musí tato minima vynucovat. Starý klient umí při vytvoření kopie odstranit metadata a poslat nový generic POST, u kterého server zdroj nepozná. Proto nestačí pouze chránit PATCH nebo nový endpoint. Číselný startup guard kontroluje nutnou podmínku; nenahrazuje release/compatibility QA K15 ani fyzické testy K14.

Migrace/backfill v produkci, providerové živé zápisy, push doručení fyzickým OS a samotné zapnutí nejsou tímto dokumentem prohlášeny za provedené. Výchozí produkční režim nadále obsluhuje legacy data. Následujícím implementačním bodem je K11.

## Závěrečná validace

Create/copy: root `pnpm check` (225 native / 397 web), celá event DB/HTTP sada, native composer 24 testů v Prague i samostatném New York procesu, 2 Playwright scénáře dark390/light1280 včetně axe. Closure: znovu root `pnpm check` a celá `pnpm test:db` v disposable PostgreSQL včetně OAuth, federation, provider a deletion regresí. Čisté nezávislé review create/copy našlo a po opravě znovu ověřilo native Weekly civilní den; samostatné čisté review closure nemá findings a nezávisle spustilo activation test.
