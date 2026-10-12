# Musubi sync refactor: roadmap a stav trackeru

**Aktualizováno 12. října 2026. Projekt Its a Plan: frgtn.MUSU.** Plán má pouze pořadí a podmínky postupu, bez pevných termínů. C01/MUSU-32 je implementovaný a lokálně ověřený. GitHub kontrola a merge jsou samostatné kroky; produkční acceptance zůstává v provozních úkolech. Ostatní fáze zůstávají plánem.

## Architektonické rozhodnutí

Jedno sdílené sync jádro budou používat dva různé hosté. Musubi zachová domácí události, memberships, task home authority, ACL, klienty a federaci. Budoucí Calendar Relay bude mít vlastní route/binding ledger a pravidla přenosu mezi externími kalendáři. Provider adaptéry, čas/identity, operation evidence a delivery runtime budou společné.

Propojovací uzel umožní člověku zůstat v Google Calendar a mít tam obsah z dalších providerů. První pozdější pilot bude jednosměrná spravovaná projekce osobních neopakovaných DAV událostí do Google. Návrat editací bude samostatný profil s povolenými poli a třícestnou baseline. Dvě nezávislé kopírovací trasy A→B a B→A nejsou bezpečná obousměrná synchronizace.

Samostatný host potřebuje trvalý minimální ledger pro identity kopií, potvrzené projekce, cursory, konflikty a nejisté zápisy. Nepotřebuje Musubi editor ani veřejný domácí event model. Extrakční acceptance proto vyžaduje běh bez Musubi DB, auth session, memberships a app config.

Podrobnosti: [relay kontext](./calendar-relay-context.md), [refactor návrh](./refactor-cycle-proposal.md), [audit současného jádra](../research/nylas/04-musubi-audit.md).

## Pořadí cyklů

Nativní cycles v Its a Plan vyžadují začátek a konec. Na výslovné přání bez termínů jsou C01–C10 zapsané jako **číslované plánované iniciativy**. Úkoly mají skutečné blokující vazby; nejsou jim přidělené datum začátku, deadline ani nativní cycleId. Každá fáze má gate; změna stavu na started proběhne až při skutečné implementaci.

| Fáze | Implementační úkoly | Podmínka postupu |
| --- | --- | --- |
| C01 · Delivery recovery a provozní baseline | MUSU-32 | Sjednotit task/event deadline, cancellation, Retry-After a backoff; oddělit background recovery od pull cadence. Gate: visící task nezadrží worker a timeout po dispatch zachová nejistotu. |
| C02 · Sync profil a provider capabilities | MUSU-33 | Normativní identity, čas, recurrence, coverage, source epochs, receipts a host authority. Gate: conditional, guarded-preflight a unsupported jsou explicitně odlišné profily. |
| C03 · Coverage a neměnný přijatý zápis | MUSU-34, MUSU-35 | Samostatně opravit Graph window eviction a zafixovat admitted projections/versioned envelope. Gate: žádný fan-out delete pouze z absence v okně; starý intent se po upgrade neserializuje jinak. |
| C04 · Provider porty a Musubi bridge | MUSU-36 | Storage-free model, credential/HTTP/clock/account-session porty a explicitní Musubi authority bridge. Gate: první podporovaný adapter slice neimportuje @musubi/db ani app session. |
| C05 · Samostatný host a extrakční důkaz | MUSU-37 | Clean test/CLI host s vlastním durable storage; parity read/write/observe první osobní operace. Gate: jádro běží bez Musubi DB/ACL/Better Auth; přepočítat další rozsah podle skutečných závislostí. |
| C06 · Společný runner a lease fencing | MUSU-38 | Storage claim/renew/ACK a typed handler lifecycle pro první personal content update. Gate: stale worker nemůže ACK a shadow mode nemá druhý HTTP write. |
| C07 · Create a delete recovery | MUSU-39 | Převést podporované personal create/delete s jejich současnými recovery důkazy. Gate: lost reply nevytvoří duplicitu; Graph guarded DELETE zůstává přiznaný profil bez blind replay. |
| C08 · Tasks a specializované event operace | MUSU-40 | Převést task a stávající specialized event dispatch orchestrace po rodinách. Gate: zachované home authority, original slots, provider proof a no-resend RSVP/organizer policy. |
| C09 · Férové plánování a provider budgets | MUSU-41 | Per-connection/collection work, collision keys, budgets a account-scoped DAV session/discovery. Gate: pomalý účet nevyhladoví jiný a dirty coalescing neztratí novou generaci. |
| C10 · Conformance a samostatná sync alpha | MUSU-42 | Reprodukovatelné crash/upgrade/retirement/echo corpus, reference host, supported matrix, compatibility a release kandidát. Gate: čistá instalace bez Musubi secrets; rozhodnutí o veřejné licenci/publikaci je zvlášť. |

C03 má dva oddělené bezpečnostní slices. C04/C05 rozdělují extrakci portů a ověřitelný druhý host; C07/C08 personal create/delete a task/specialized migraci. Rozdělené odhady RF05/RF07 se počítají pouze jednou.

**Orientační úsilí core: 45–79 člověkodnů.** Jde o původní forecast pro omezený profil, ne závazek délky fáze. C03 a C05 přepočítají zbytek podle migration/parity výsledků. RF05 může rozšířit nový storage rozsah; RF07 vyžaduje inventory specialized rodin. Portable alpha neslibuje implicitně všechny legacy Musubi operace.

První fáze **C01/MUSU-32 je dokončená** na úrovni implementace a lokální acceptance. Důkazy a upgrade konfigurace: [MUSU-32 delivery recovery](./MUSU-32-delivery-recovery.md). Další na řadě je **MUSU-33**. Ostatní nové úkoly jsou v backlogu za svými gates; tracker žádného automatického agenta nespouští.

## Záruky, které refactor zachová

- Scoped identity a original occurrence slot, zoned/floating/DATE model a explicitní all-day mapper.
- Host local CAS, current ACL/privacy epoch a atomickou admission canonical změny + durable intent.
- Neměnnou accepted projection a serializer/profile version; kompatibilní old/unknown envelope a decoder-before-encoder rollout.
- Source/access retirement pod lifecycle fence; window eviction není globální deletion.
- Provider-specific validators, conditional versus guarded write profil, no blind uncertain CREATE/DELETE/RSVP replay.
- Oddělený local commit, provider acceptance, remote readback a notification outcome.
- Task home authority, loss-aware projection a zachované family boundaries.
- Singleton deployment boundary do samostatného rozhodnutí o clusteru.

## Aktuální provozní a release proud

Refactor nenahrazuje zbývající acceptance vydaného produktu.

- MUSU-4: skutečná CalDAV root cause a oprava; sloučená diagnostika není vyřešení incidentu.
- MUSU-5: živé přijetí již implementovaného Google GET recovery/reconnect; resource 401 sama neprokazuje revoked grant.
- MUSU-3/11/12/13: dokončení provider, dvouuživatelského a provozního převzetí shared tasks v0.2.2.
- MUSU-14: skutečné runtime digests/revize, DB journal, gates a bezobsahová queue baseline před rolloutem.
- MUSU-15: konkrétní API/web candidate; source 0.2.3 je nepublikovaný, release vyžaduje vlastní accepted scope a oprávnění.
- MUSU-16/17/18: distribuce a device/provider acceptance konkrétních Android/iOS buildů.
- MUSU-19/20/21: monitoring a skutečný QA receiver, Google review, veřejné nasazení dokumentace.

Lokální refactor nezačíná produkčním zásahem. API/web-only candidate nemá plošný blocker v Android store distribuci nebo všech native provider scénářích. Příslušná acceptance se stane blockerem, až když ji konkrétní release opravdu tvrdí. Diagnostic-only 0.2.3 candidate rovněž neslibuje CalDAV root-cause fix.

## Budoucí relay a volitelný push

| Úkol | Rozsah | Vstupní závislost |
| --- | --- | --- |
| MUSU-43 · Přidat volitelné Google/Graph push spouštění s durable inboxem | Optional provider invalidation; odlišné od human activity inbox MUSU-25. | MUSU-41 |
| MUSU-44 · Ověřit sdílené jádro na samostatném DAV→Google relay PoC | Pozdější PoC druhého hosta; osobní neopakované events, jeden směr, izolované kolekce. Neimplementuje se v core refactorem. | MUSU-42, MUSU-45 |
| MUSU-45 · Definovat směrovací pravidla a vlastnictví kalendářových kopií | Produktový route/binding model: source→destination, pole/redakce, ownership/adoption, pause/retire/filter-change/cleanup a conflict policy. | MUSU-37 |
| MUSU-46 · Navrhnout bezpečný návrat vybraných editací z Google Calendar | Pozdější field-authority write-back v jednom bindingu; není druhá nezávislá kopírovací route. | MUSU-44, MUSU-45 |
| MUSU-47 · Vymezit další relay profily a provoz samostatné služby | Postupné recurrence, busy/content meeting mirrors a samostatný daemon/API/self-host nebo hosted režim. | MUSU-44, MUSU-45 |

Relay issues jsou v samostatné **proposed** iniciativě a bez termínů. PoC čeká na C10 technický gate i přijatý routing model MUSU-45. Návrat editací MUSU-46 čeká na jednosměrný pilot a model. Reminder, recurrence, meeting/native RSVP a hosted provoz se zapínají pouze jako další explicitní profily.

Volitelný push MUSU-43 zůstává v produktovém backlogu po scheduleru MUSU-41. Jeho ingress inbox není human activity inbox MUSU-25. Push neblokuje alpha, polling ani self-host. Relay není Musubi federace MUSU-24 a nevyžaduje recurring task projekce MUSU-23.

## Co se změnilo v Its a Plan

- Zrevidováno všech 30 původních issues; 13 přepsaných na konkrétní současný scope, čtyři provider acceptance rehomed.
- MUSU-6 je Canceled jako nahrazená orchestrace; její zbývající acceptance přešla na MUSU-4/5/14/19/15.
- MUSU-1 a MUSU-7–10 zůstávají Done; nikde nebyla nově prohlášena hotová live/device/production acceptance.
- Zachované lidské assignees, watchers a původní MUSU-4 checklist.
- Odstraněno šest zastaralých hard blockers; doplněné skutečné core/relay dependency a odpovídající relates.
- Přidaných 16 issues MUSU-32–47: 11 core, jeden optional push a čtyři budoucí relay.
- Čtyři původní iniciativy dostaly aktuální scope; přidaných deset číslovaných fází a jedna budoucí relay iniciativa.
- Původní dlouhý plánovací dokument byl zachovaný jako archiv před přepsáním current roadmap; historie issues zůstává dohledatelná.

Strojový záznam tracker mappingu: [tracker-state](./itsaplan-refactor-state.json). Review podklady: [revize starého backlogu](./tracker-backlog-review.md), [cyklus proposal](./refactor-cycle-proposal.md). Rešerše: [Nylas a alternativy](../research/nylas/README.md).

## Ověření této plánovací změny

Final readback trackeru ověřuje stavy, přiřazení, checklisty, dependency graph a absenci nových datumových polí. Obsahové review proběhlo třemi agenty proti source a snapshotu. Neproběhla nová produkční inventura, provider zápis, deploy, store upload ani veřejné publikování package. Žádná nová implementace se tímto plánováním neoznačuje hotová.
