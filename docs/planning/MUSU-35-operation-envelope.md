# MUSU-35: versioned operations and immutable admitted plans

**C03 · 12. října 2026 · implementace ve dvou publication slices.**

## Decoder-first floor

První slice přidává [strict kontrakt](../protocol/sync-operation-v1.md) a společný
row-binding decoder. Pouze absence vlastní property `operationEnvelope` dovolí
explicitní legacy-v0. Present malformed/unknown schema/profile/serializer nebo
binding mismatch končí `blocked` před adapter factory i provider GET. Valid v1
má v prvním slice `codec-unavailable` HOLD; encoder, codec registry a backfill v něm nejsou.

[Event](../../apps/api/src/sync/event_delivery.ts) a
[task](../../apps/api/src/sync/task_delivery.ts) zachovají lease fencing, celý
accepted payload, IDs, response evidence a předešlou dispatch nejistotu.
Claim sám není důkaz dispatch; older floor však při odebrání live unknown
worker lease musí konzervativně zachovat možný dispatch jako uncertainty. Unknown operace přejde z due fronty do HOLD,
takže další podporované operace v dalším batch mohou pokračovat.

Pull odmítne legacy echo fallback před organizer, baseline, onlyReplaceObservation,
DELETE, late unmapped-create i CalDAV family deletion shortcuts. Neadresovaný
unknown task CREATE se při shodném source/privacy capture neadoptuje jako druhý
canonical task. Completed cancellation history a všechny řádky CalDAV split
páru/causal resolution chain se dekódují před legacy interpretací. Nejasnou native
observation uloží, ale nepřepíše accepted payload a neprovede ACK. Resolution
context odmítne převést unknown persisted formát do nové legacy operace.

První slice má JSONB typing optional `operationEnvelope?: unknown`; nepotřebuje SQL migration.
Privacy loss/regain nadále zachovává marker i hash celého payloadu. Žádný
historický intent nebyl přepsán či doplněn chybějící admission evidence.

## Lokální důkazy prvního slice

[DB fixture](../../apps/api/src/sync/operation_decoder.integration.test.ts) běží
na disposable PostgreSQL a ověřuje nula adapter factory/provider volání,
schema/profile/serializer/binding refusal, valid-v1 HOLD, task dispatch projection,
expired lease, payload/hash/evidence parity, specializované pull bypassy a skutečný
Google event/task privacy loss→regain. Obě fronty prošly přes 60 unknown operací
k následující legacy operaci. Suite je zapojená do `test:db:operation-decoder`.

Pure schemas/decoder fixtures, API typecheck, původní event/task delivery,
DB event-outbox a 32 Google personal privacy recovery scénářů prošly.
Po integraci s main coverage prošly také celé CalDAV scope a Google/CalDAV
organizer/occurrence suites, všechny sdílené type/wire fixtures a consumer
typecheck. Explicitní finální skeptické review schválilo zdrojový diff
`2335e899e0bdd30a766a0010e462f9bf93af5b42` vůči main `b01813a` před PR.
PR CI a main merge jsou následné důkazy. Legacy URL/JSON budgets zůstaly stejné;
nové v1 limity se na historické journaly retroaktivně neuplatňují.

## Publication prvního slice

[PR #346](https://github.com/f-tuma/musubi/pull/346) zveřejňuje decoder-first floor
na head `3654734ea04acac2ce7eb937047c9e1e19675cff`. Explicitní approval source diffu
předcházelo otevření PR; pozdější commit přidal pouze publication facts.
[Quality run](https://github.com/f-tuma/musubi/actions/runs/38260564869) dokončil
všech 21 checks success na uvedeném headu. PR byl squash merged do main jako
`1248ce285f29c61650bbb8570d329653b1bca460`.
Tento floor záměrně neumožňuje dispatch v1 a sám neuzavírá MUSU-35.

## Druhý slice: pinned codec a atomické admission

Nový [@musubi/sync-codec](../../packages/sync-codec/src/index.ts) je čistý balík bez
DB, credentials, HTTP, env nebo ambient clock. Host předává operation ID, native
UID a čas přijetí. Šest explicitně registrovaných serializer ID/version 1 odpovídá
osobním Google/Graph/DAV eventům a Google/Graph/DAV tasks. Přesné bounds,
recurrence/time omezení a compatibility jsou v
[sync-operation-v1](../protocol/sync-operation-v1.md).

[Admission](../../packages/db/src/queries/operation-admission.ts) vytváří envelope
po canonical CAS a ukládá outbox ve stejné transakci s výslednou canonical revizí.
Event/task retry používá saved target a native values, včetně deterministic
Google ID/marker, Graph transaction ID a DAV UID/DTSTAMP. Nevybírá znovu aktuální
projector. DAV update aplikuje saved property allowlist do aktuálního exact
UID/ETag resource a zachová alarmy, VTIMEZONE a ostatní nezměněné properties.
Graph event CREATE a Google/Graph task CREATE mají před response null address;
UPDATE/DELETE bez adresy mají exact persisted predecessor dependency.

Generic conflict resolution přijme nový intent s novým ID, přesnou native ref a
novou přijatou revizí; superseded payload nepřepisuje. Codec/admission failure
vrátí zpět canonical i outbox změnu. Specialized organizer/RSVP/reminder/series/
occurrence intents, všechny explicitně známé event time models a neprokázané DAV
UID zůstávají nynějším legacy/specialized profilem. Explicitní výběr zachovává
legacy také pro recurrence/content mimo v1 profil a validní legacy input mimo
nové identity/JSON budgets, včetně celé planned DAV URL. Destination compatibility
limit nesmí vrátit zpět authoritative source import; malformed vybraný input
stále způsobí atomický rollback. Jde o oddělení supported
admission profilů, nikoli rozšíření provider capabilities.

`operationCapture` zachytí source UUID, write permission generation
(`providerAccessRevision`), account row ID/generation a event/task privacy epoch.
C34 READ source/window/checkpoint generation sama write intent nezneplatní.
Admission může zachytit neaktivní sekundární grant, aby jeho výpadek nevrátil
zpět authoritative source import. To neuděluje write authority: dispatch/ACK
vyžaduje active grant a stejnou zachycenou generaci.
OAuth monotonic `sync_read_generation` zachytí grant loss→regain ABA; DAV account
`updatedAt` v milisekundách je pouze nynější host revision convention, nikoli
plnohodnotný monotonic ABA counter. Exact source/account/privacy evidence se
ověřuje před factory, před mutation a znovu uvnitř mapping ACK transakce.
Přístup změněný po native write nemůže vytvořit falešný mapping/ACK; native
response evidence a uncertainty se zachovají. Provider HTTP není pod DB locks. Fresh admission po změně zachycené generace
uvolní pouze známý v1 predecessor s důkazem no-write a bez lease/response/remote
observation/saved dispatch. Unknown a uncertain history nadále blokuje. Pokud
stará no-write CREATE nemá mapping, čerstvý plán musí být CREATE. Immutable
envelope starého intentu zůstane beze změny.

Immutable je accepted envelope. Task host může později doplnit
`dispatchProjection` mimo ni, až získá predecessor/current baseline. Uložený target
musí zůstat admitted projection a patch jejím přesným diffem vůči baseline.
Proto hash celé task payload nemusí být před/po první dispatch projection stejný,
ale accepted envelope se nemění. Schema a runtime nepředstavují SQL immutable
trigger; historické payloady nemají backfill ani nově vymyšlené capture.

## Důkazy druhého slice

[Pure/golden fixtures](../../packages/sync-codec/src/index.test.ts) ověřují všech
šest formátů proti existujícím serializerům, frozen time/ID, recurrence/DATE
konvence, DAV preservation a odmítnutí poisoned/mismatched native plans.
Suite je explicitně součástí root `pnpm test`, takže běží i v `pnpm check`.

[Admission/runtime DB fixture](../../apps/api/src/sync/operation_admission.integration.test.ts)
používá skutečné canonical create/update/CAS a outbox workers. Pokrývá default-OFF
legacy, výslovně zapnutý encoder a nové envelope, A→B projector změnu před prvním dispatch,
restart/lost reply se stejným ID a plan hash, task target před saved baseline,
transakční rollback, unknown ID/version i poisoned dispatch snapshots před
factory, source/grant/privacy fencing, pre-ACK DAV predecessor UID, pinned pull
projection a nové conflict resolution admission. Skutečný task CREATE/pull race
před odpovědí POST neimportuje druhý canonical task ani nepředstírá correlation:
uloží uncorrelated observation, zachová aktivní lease/status i accepted payload,
identity přijme až původní worker z response. Další úplný read po ACK importuje
nesouvisející tasks. Historický legacy profil zachovává původní chování. Další skutečné native pull
cases ověřují RRULE do Google secondary, neaktivní OAuth mirror a následný
reconnect s novou zachycenou generací a jedním skutečným zápisem. Popis o délce
2 000 001 znaků se uloží beze zkrácení a použije legacy; hodnota 1 990 000
projde v1. Existing DAV collection o délce 2 105 i planned URL o délce 2 049
zachovají legacy; planned URL o délce přesně 2 048 je v1 positive control.
Dedicated causal recovery corpus ověřuje 32 skutečných DB scénářů pro event/task:
nová operace po reconnectu se claimne, old no-write CREATE dostane poctivý nový
CREATE, unknown/uncertain/response/observation/expired-attempting/saved-dispatch
history zůstane překážkou. Source/private epoch, DAV timestamp a OAuth sibling
scope mají positive/negative controls; hash původního payloadu zůstává stejný.
Pure semantic fixtures odmítnou DATE/dateTime UPDATE rozpor a all-day target
mimo UTC midnight, také u empty UPDATE a DELETE.

[Fake-provider transport fixture](../../apps/api/src/sync/pinned_transport.integration.test.ts)
ověřuje skutečné Google/Graph/DAV HTTP body, conditional updates, observe-only
recovery po lost reply, task subset patches a zachování DAV properties.
Tyto dvě suites i
[causal recovery fixture](../../packages/db/src/queries/outbox_causal_retirement.integration.test.ts)
běží přes `test:db:operation-admission`; shard inventory je odvozen
z root `test:db`, takže žádný paralelní ruční seznam nevzniká. Publication tohoto
slice vyžaduje finální nezávislé skeptické schválení a zelené checks přesného PR head.

Po integraci s finálním decoderem prošlo všech deset shared types/wire commands,
pure/golden codec suite, consumer typecheck a admission/decoder/fake-provider
transport fixtures, včetně skutečného task CREATE/pull race. CI shard self-check
ověřil 99 unikátních DB suites ve čtyřech shards (25/25/25/24) a všechny tři nové testy
v inventáři. Route/realtime contracts a release metadata self-check jsou zelené.
Celý API unit script (81 příkazů), všechny consumer typechecks a 23 sekvenčních
legacy DB kompatibilitních suites prošly po integraci s finálním decoderem.
Širší 23-suite běh při finalizaci causal helperu také prošel, ale source SHA
kontrola zachytila poslední změny během běhu, takže netvrdí jediný frozen source
snapshot. Finální důkaz tohoto helperu poskytuje samostatný 32-case corpus a
opakované cílené delivery/resolution/capability suites po zmrazení kódu.
Manifest s jednotlivými exit codes prvního běhu: `/tmp/musubi-c03-codec-legacy-compatibility.json`;
DB byla syntetická, encoder default OFF. Druhý širší manifest se source SHA
kontrolou: `/tmp/musubi-c03-codec-legacy-compatibility-final.json`. `db:generate` potvrdilo beze změny SQL
schématu; peers check, DB schema/settings a docs build prošly.
Tyto lokální důkazy nepředstavují produkční deploy ani live provider acceptance.

## Provozní hranice a zbývající gate

Pinned codec a admission encoder musí zachovat projection i skutečný
native write plan při změně serializer A→B před prvním dispatch i po lost reply.
Zápis accepted payloadu a canonical revize musí být atomický. Retry nesmí vytvořit
nové operation ID ani použít aktuální serializer jako fallback.

`SYNC_OPERATION_V1_ENCODER_ENABLED=false` udržuje encoder **default OFF** až do ověřeného nasazení kompatibilního decoderu
ve všech skutečných consumers. Merge do main není deployment gate. První floor
je rollback do HOLD; dostupnost doručení vyžaduje přesně registrovaný pinned codec.
Unknown/malformed formáty se automaticky neodblokují a historical payload hash
není oprávnění doplnit do starého intentu nový plán.

Tento report eviduje implementation/validation snapshot druhého slice před jeho
publikací. Stav issue MUSU-35, přesný PR head, CI a squash merge se po publication
zapisují do aktuální roadmap v Its a Plan; decoder-only slice sám immutable-write
gate nesplňuje. Další implementační fáze je C04/MUSU-36 po green CI a squash merge
obou slices.
Produkční rollout ani live provider mutation neproběhly.
