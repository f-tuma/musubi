# Sync operation v1: přijatá projekce a pinned native plan

**MUSU-35 · Decoder-first floor a následný pinned codec/admission slice.**
Kontrakt je v [sync_operation.ts](../../packages/types/src/sync_operation.ts),
čisté verze serializerů v [sync-codec](../../packages/sync-codec/src/index.ts),
host admission a lifecycle fences v
[operation-admission.ts](../../packages/db/src/queries/operation-admission.ts).
Navazuje na [sync profile v1](./sync-profile-v1.md).

Slova **MUSÍ** a **NESMÍ** označují požadavky na implementátora. Publication
prvního decoder-only slice je vedena v [PR #346](https://github.com/f-tuma/musubi/pull/346).
Ten nemá encoder ani dispatch codec a každou přítomnou v1 obálku drží v HOLD.
Následný slice přidává explicitně registrované verze codeců a admission pouze
nových podporovaných operací. Historické outbox payloady se nepřepisují.
Merge zdrojů a skutečné nasazení všech consumers jsou samostatné důkazy.

## Přítomnost formátu a výběr codeců

Decoder nejprve rozliší vlastní property `operationEnvelope`:

| Persistovaný payload | Výsledek |
| --- | --- |
| `operationEnvelope` nemá vlastní property | `legacy-v0`: současný transport může pokračovat beze změny payloadu |
| Property existuje, ale je undefined/null/malformed | Blocked; nikdy fallback do legacy |
| Unknown schema/profile/serializer nebo binding mismatch | Blocked s konkrétním bezpečným kódem |
| Valid v1, bez registrovaného přesného codec ID/version | `operation-envelope-codec-unavailable` HOLD |
| Valid v1, přesně registrovaný codec, platný saved plan a host capture | `pinned-v1`; současnou authority musí ještě ověřit host |

Kontrola property používá `Object.prototype.hasOwnProperty.call`, kompatibilní
s ES2020 buildem. Přítomná undefined property je jiná než absence, i když JSONB
takovou hodnotu běžně neuloží. Decoder bez availability callbacku zůstává
bezpečným decoder-only floor. Seznam rozpoznaných názvů není registry ani
provider capability. Registrace navíc kontroluje allowlist native fields,
sémantickou shodu uloženého plánu s přijatou projekcí, create identity a capture.

Decoder MUSÍ běžet před adapter factory, provider preflight, GET i write.
Neznámý či vadný formát zachová payload, accepted IDs a nejistotu předchozího
dispatch. NESMÍ být přepsán aktuálním mapperem, automaticky upgradován nebo
spuštěn legacy transportem. Unknown ID/version vede na
`delivery-serializer-unavailable`; registrovaný, ale nedostupný/neplatný plán
zůstane HOLD. Lease fencing a ACK patří storage/runtime hostu.

Absence obálky je explicitní legacy profil. Jeho existující retry reprojection
se nemění. V1 retry používá uloženou projekci a uložený native plan; aktuální
`projectEvent`/`projectTask` neurčuje hodnoty této již přijaté operace.

## Význam v1 obálky

| Pole | Význam |
| --- | --- |
| `schemaVersion: 1` | Tvar celé obálky |
| `profileVersion: sync-profile-v1` | Sémantika identity, času a evidence |
| `operation.kind/action/version` | Event/task a create/update/delete; verze významu operace |
| `serializer.id/version` | Konkrétní provider/family datový formát a jeho verze |
| `commandId`, `operationId` | Přijatý záměr a stabilní operace; retry nevytváří nové ID |
| `hostObjectId` | Canonical objekt, pro který host přijal intent |
| `locator`, `predecessorOperationId` | Exact provider/connection/collection/resource target a případná causal dependency |
| `sourceEpoch`, `acceptedRevision`, `privacyEpoch` | Zachycená source write generace, canonical revize a privacy lifecycle evidence |
| `allowedSideEffects` | Explicitní side effects; tento admission přijímá pouze `provider-content-write` |
| `admittedProjection.data` | Přesně přijatá normalizovaná JSON projekce |
| `nativePlan.kind/data` | Pinned codec data; není obecná HTTP request obálka |

Attempt ID, lease token, response ref a následná baseline NESMÍ měnit immutable
obálku. Schéma je strict a odmítá neznámá pole i duplikující top-level version.
Native data nemají synonymní verzi; jejich formát řídí serializer ID/version.
Operation version řídí sémantiku operace, nikoli JSON layout.

Host přijímá v1 až po canonical compare-and-swap a ukládá envelope/capture/outbox
ve stejné databázové transakci s výslednou canonical revizí. Chyba encoderu nebo
INSERT vrátí zpět i canonical změnu. Generic conflict resolution vytvoří nový
intent s novým ID a aktuální přijatou revizí; původní intent se neserializuje znovu.

Immutability je zde kontrakt admission a runtime: envelope se po přijetí nemění.
Není to SQL immutable trigger ani JavaScript `Object.freeze`. Task payload může
později přidat attempt evidence mimo obálku; nelze proto pro všechny task retries
slibovat stejný hash celého payloadu. Hash samotné accepted envelope zůstává stejný.

## Pinned verze a bounded profily

[Pure package](../../packages/sync-codec/package.json) nemá DB, OAuth, HTTP, env
ani ambient clock. Host předává stabilní operation ID, native UID a čas přijetí.
Codec vytváří allowlisted JSON body nebo DAV property plan; nevybírá credentials,
URL origin, HTTP headers, transport metodu ani current authority.

| Serializer version 1 | Podporovaný plán a hranice |
| --- | --- |
| `google-personal-event` | Osobní event; full CREATE, sparse UPDATE vybraných content/time/recurrence fields, DELETE; create ID a private operation marker z operation ID |
| `microsoft-personal-event` | Osobní nerekurentní event; CREATE/DELETE a UPDATE title/description/location; UTC nebo legacy all-day native shape; transaction ID z operation ID |
| `caldav-personal-event` | VEVENT se známým exact UID nebo deterministic CREATE; update jen saved allowlisted properties v aktuálním exact resource |
| `google-task` | Native title/notes/status/date-only due; full přijatý target a následně baseline diff; recurrence není v tomto profilu |
| `microsoft-task` | Native title/body/status/importance/start/due; full target a následně baseline diff; recurrence není v tomto profilu |
| `caldav-task` | VTODO content/status/time/completion/priority/recurrence/relations/sequence/URL; exact UID, saved properties a CREATE DTSTAMP z času přijetí |

Existující provider preflight, source access, ETag, recurrence a specialized
capability guards zůstávají rozhodující. Registrace codeců je nerozšiřuje.
Host event admission vynechává attendees, meeting/organizer, RSVP/reminder,
occurrence/series a ostatní specialized intents. Každý již známý explicitní
`timeModel` včetně all-day zůstává v nynější specializované/legacy cestě; nový
admission přijímá pouze absent nebo `legacy-unknown` time model. Staré
`isAllDay`/UTC konvence zůstávají bounded legacy časovým profilem. Pure codec
samotný umí DATE shape, což ještě není host capability pro známý all-day model.
Zoned a floating event writes tento generic v1 profil nepřijímá. Host výslovně
volí legacy také pro recurring Google/Graph tasky, recurring generic Graph eventy,
Graph UPDATE mimo pinned content fields, cancelled non-DELETE eventy a recurrence
syntax mimo tento profil. Takový nový destination intent nesmí vrátit zpět validní
authoritative source import; dosavadní worker capability refusals se zachovají.
Chybný vstup uvnitř vybraného profilu stále vrátí zpět celou admission transakci.

Google/DAV recurrence zde zahrnuje representable RRULE a UTC/DATE EXDATE/RDATE.
Event EXRULE a TZID recurrence nejsou podporovaným novým plánem. Native all-day
end je exclusive DATE; serializer zachovává nynější převod z legacy canonical
inclusive end. Graph recurring eventy využívají stávající specializovanou cestu.

DAV UPDATE nezrekonstruuje celý server resource z canonical objektu. Do aktuálního
resource načteného s exact UID/ETag aplikuje jen uložený property allowlist a
uložené replacement values. Zachová ostatní provider properties, alarmy,
VTIMEZONE a nezměněné fyzické řádky. Nepodporovaná/ambiguous family se odmítne.
Portable connection keys zůstávají opaque. Tento Musubi host ukládá physical
DAV account row ID jako UUID; neprokázaný legacy text alias se nekastuje do
physical UUID SQL a nová admission zůstane legacy. Neuděluje retirement ani
write authority a guard musí odmítnout lookup před SQL, aby nepoškodil ACK
transakci. Přítomná envelope nikdy nedostane legacy fallback.

Predecessor CREATE může poskytnout prokázaný saved UID; bez prokázaného UID
UPDATE/DELETE zůstává explicitní legacy profil. Canonical UUID se nesmí vydávat
za neznámý native UID.

Po publikaci NESMÍ změna mapperu předefinovat již přijatý v1 formát. Změna native
serializace či jejího významu vyžaduje novou serializer verzi a nové explicitní
registry selection. Starý decoder/codec musí zůstat k dispozici pro uložené v1
operace; nepodporovaná novější verze končí HOLD. Oprava parseru musí zachovat
význam validních uložených v1 plánů a odmítat jejich vadné kombinace.

## Row binding a lifecycle evidence

Decoder porovnává kind, action, operation/command/host IDs, provider, connection,
collection, accepted revision a známý resource ID. UPDATE/DELETE bez resource ID
vyžaduje přesně stejný persisted predecessor ID a null native address. CREATE
Graph eventu a Google/Graph tasku zachovává poctivý null target před odpovědí.
Google event ID a DAV URL jsou plánované deterministic identity; registered
codec ověří jejich přesný vztah k uloženému operation/task ID a native markeru.

JSONB `operationCapture` je host evidence mimo portable envelope:
source UUID, `writeGeneration`, skutečný account row ID, connection generation
a privacy epoch. Envelope `sourceEpoch.generation` znamená pro tento WRITE
admission `providerAccessRevision`. Není to C34 `sourceGeneration`, window/config
ani checkpoint revize pro READ coverage. Samotná změna read okna nesmí zneplatnit
write. Locator connection key nadále používá opaque host account key; captured
row ID/generation zvlášť brání použití jiného host connection incarnation.

OAuth capture používá monotonic account `sync_read_generation` zavedený v 0085
pro lifecycle scope/status/refresh-presence/identity změny, včetně loss→regain ABA.
Routine non-null token rotation sama tuto generation nemění. Nová admission
může zrušit causal překážku starého známého v1 intentu při změně capture pouze
s důkazem, že nebyl zapsán: bez uncertainty, lease, response, remote observation
a saved dispatch evidence. Neznámé formáty i možné remote effects zůstávají
překážkou. No-write CREATE bez mappingu se při nové generaci plánuje jako nový
CREATE; jeho původní accepted envelope se nepřepisuje. Pro DAV host nyní
zachytí account ID a `updatedAt` v milisekundách. Timestamp není monotonic ABA
counter: stejné timestampy nebo změna provedená mimo nynější host update
convention nemusí být odlišena. DAV stále potřebuje nynější source access a
native preflight/ETag guard; tento slice netvrdí plnou grant ABA evidence pro DAV.

Admission smí zachytit i neaktivní sekundární OAuth grant, aby výpadek cílové
kopie nevrátil zpět authoritative source import. Capture není write authority:
dispatch/ACK stále vyžaduje active grant s refresh tokenem a přesně stejnou
generaci. Reconnect neprohlásí starý captured intent za nově povolený.

Host ověří exact source/account/privacy capture před adapter factory, znovu před
mutací a uvnitř mapping/ACK transakce pod lifecycle/canonical/source/account
fences. Změna přístupu nebo privacy mezi native write a lokálním ACK nesmí založit
mapping ani falešně potvrdit delivery; response evidence a uncertainty zůstanou
zachovány v blocked operaci. Žádný provider HTTP call neprobíhá pod DB transakcí.

Historické rows nemají vymyšlený current capture. Přítomná obálka bez potřebné
captured evidence nemá registry availability; absence zůstává legacy-v0.

## Codec JSON a credential hranice

Codec data MUSÍ být bounded, lossless JSON: finite numbers, strings, booleans,
null, dense arrays a plain objects. Undefined, functions, Date/toJSON objects,
accessors, symbols, cycles, nonfinite values, sparse arrays i nestandardní array
prototype se odmítají. Limit je 10 000 nodes, hloubka 32 a dva miliony UTF-16
string/key units. Přítomný v1 payload překračující limit se zablokuje; data se netruncují. Při
novém host admission validní legacy input mimo v1 identity/JSON bounds zůstane
na explicitní legacy cestě, aby nevrátil zpět authoritative import. Výběr
kontroluje i celou planned DAV resource URL; žádný uložený PRESENT envelope
se kvůli překročení nepřevede na legacy.

Native plan povoluje jen `kind: codec-data` a data. Nepovoluje HTTP metodu,
headers, credentials ani session. Strukturální credential field filtr není důkaz,
že libovolný string neobsahuje secret. Serializery používají vlastní allowlist
skutečných provider write fields a nekopírují credential/session/raw response.

## Task target a následná dispatch evidence

V1 task přijímá **full target a native values při canonical admission**, před
prvním dispatch. Preflight `providerProjection` je diagnostický preview, ne
admitted target. Temporary preflight failure ani změna projector A→B nesmějí
změnit přijatý plán.

`dispatchProjection` zůstává mimo envelope. Host ji může jednou doplnit až po
získání predecessor/current baseline; obsahuje version 1, saved target, baseline
a diff patch. Target musí přesně odpovídat admitted projection; patch musí být
přesným rozdílem baseline→target. Native transport vybírá z accepted values jen
požadované patch keys. Baseline se nesmí změnit na novější ETag jen proto, že
nový GET uspěl. U neadresovaného aktivního v1 CREATE se unmapped pull observation
neadoptuje jako nový canonical task ani nepotvrdí původní operaci. Host ji zachová
jako uncorrelated evidence a ponechá live worker lease; exact identity přijme z
response. Nesouvisející unmapped items zdroje se mohou importovat při dalším
úplném čtení po ACK. Vadná projection, unknown version, jiný target nebo jiný patch
je blocked před provider GET. Retry accepted projection znovu neprojektuje.

Legacy-v0 task dispatch snapshots zachovávají dosavadní lossless JSON a identity
limits; nové v1 budgets na ně retroaktivně neplatí. Přítomná malformed/null/undefined
projection nebo unknown version je blocked také u legacy rows. Valid legacy
version 1 prochází s původní saved baseline, bez přepsání mapperem decoderu.

## Compatibility a rollout gate

`SYNC_OPERATION_V1_ENCODER_ENABLED=false` je výchozí hodnota. Flag řídí pouze
admission nových podporovaných operací, nikoli dispatch již přijatých v1 rows.
Zapnutí MUSÍ předcházet doložené nasazení decoder floor do **všech API procesů,
delivery workers a dalších outbox consumers** a ověření skutečných image digestů.
Merge do main ani zelené CI samy tento produkční gate nesplní.

Decoder-only worker je rollback do HOLD pro v1 rows; doručování potřebuje přesně
registrovaný pinned codec. Worker starší než decoder floor není bezpečný rollback
pro databázi obsahující nové envelopes. Vypnutí encoderu nepřepisuje pending rows
ani nezastavuje jejich doručení. Historical backfill ani automatický unknown-format
upgrade tento slice neprovádí. Produkční rollout a live provider acceptance mají
samostatný checklist a zůstávají oddělené od lokálních fixtures a publication.
