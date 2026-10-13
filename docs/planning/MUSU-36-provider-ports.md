# MUSU-36 · C04: Google provider porty a Musubi bridge

Snapshot implementace a lokálních důkazů k 13. říjnu 2026 před publikací PR.
Zelené CI a squash merge konkrétního head commitu se dokládají zvlášť v GitHub
PR; tento záznam sám nedokládá nasazení. Encoder v1 zůstává default OFF.

## Implementovaný gate

Nový privátní `@musubi/provider-google` provádí první omezený výřez: osobní
neopakovaný Google UPDATE přijatého názvu, popisu a místa, jeho čerstvý
preflight a přesný native GET pro readback/recovery. Runtime importuje pouze
vlastní typy. Neimportuje Musubi Event/Task, storage, app config, OAuth
implementaci, auth session ani globální fetch či ambientní hodiny.

Vstup je již přijaté sparse Google JSON (`summary`, `description`, `location`),
přesný strong ETag, konkrétní native calendar/event ID, opaque connection ID a
jeho generace, operation/attempt ID a serializer `google-personal-event` v1.
Provider nemapuje současný canonical event znovu. Calendar alias `primary`
není součást tohoto výřezu: odpověď musí jmenovat konkrétní přijatý kalendář.

Porty vlastní host:

| Port / výstup | Odpovědnost |
| --- | --- |
| Account session | Krátkodobý token a scope evidence po případném refreshi; kontrola stejného připojení a generace. |
| HTTP + cancellation | Skutečný leaf dispatch s caller signal; pevný Google origin, jednotlivě encoded ID, zakázané redirecty a přesný If-Match. |
| Clock | Epoch čas pro Retry-After HTTP-date; monotonic čas pro délku skutečného HTTP requestu. |
| Telemetry | Jednou za dispatch, pouze provider/family/method/status/duration. Bez URL, identit, tokenů a obsahu. |
| Before-mutation fence | Host znovu prokáže current source/privacy a neexpirovanou lease až po credentials, těsně před PATCH. |
| Native evidence | Present/absent/cancelled observation, HTTP acceptance nebo typed rejection/uncertainty. Nikdy canonical commit či místní ACK. |

Preflight a update jsou dvě metody. **Host musí předat stejnou neměnnou
přijatou operaci oběma**, zavolat preflight a zachovat svůj authority/lease
workflow. ETag podmiňuje následný PATCH vůči vzdáleným změnám. Samotné veřejné
`update()` není nezávislý ACL/organizer admission API.

Preflight ověřuje čerstvý calendarList owner/writer, přesnou calendar/event
identitu a validator, organizer self a absenci skrytých či dalších hostů a
recurring family. Readback vyžaduje complete 200 bez content-range, přesné ID,
validní DATE/RFC3339 endpoints a strong validator. Civilní data nepřijímají
tiché JavaScript rollover převody. 404/410 nebo cancellation jsou observation,
ne důkaz globálního smazání. Výřez má přísnější read evidence než legacy trasa.

PATCH se automaticky neopakuje. 412 je conflict/refusal; ztracená odpověď,
server error, nečekaný úspěšný status nebo explicitně jiné ID v success body
zachovají nejistotu. Chybné success ID nesmí dodat validator místní mapping
ACK; příští pokus může pouze podle dosavadních recovery pravidel nejprve
pozorovat přesný přijatý target. Stejně jako dosavadní adapter může úspěšný
HTTP status s chybějícím/malformed body dodat nullable validator: acceptance
se tím neoznačuje za ověřený content readback. Prázdné přijaté body nevysílá
PATCH. Event GET zde nedostal nový OAuth retry; dosavadní GET recovery jiných
rodin zůstává oddělené.

## Musubi authority zůstává v hostu

`event_delivery` vybírá port pouze pro rozpoznaný pinned-v1 Google UPDATE,
jehož přijaté body obsahuje jen uvedená pole, projection nemá recurrence a
událost nemá known time model. Kontext je ephemeral; obsahuje přijatou
connection capture a aktuální lease token jako attempt ID. Stejný kontext
používá preflight, PATCH i uncertain/conflict read. Unknown envelope HOLD se
provádí stále před adapter factory.

`google_provider_bridge` čte uložené credentials před i po async token
acquisition. Po refreshi musí stále sedět skutečný account row, monotonic
connection generation, active status a refresh presence. Scope grant se
předává z této čerstvé evidence. Před PATCH host znovu renewuje přesnou
neexpirovanou lease a ověřuje current source/privacy. HTTP neběží v DB
transakci. Po efektu zůstává atomic mapping ACK pod canonical/outbox/lifecycle
locks s current source/account/privacy fences. Refused ACK zachová native
resultRef a uncertainty.

Canonical CAS, membership, source retirement, coverage/deletion proof,
immutable admission, causal predecessors, resolution, normalizace do Musubi
DTO a SSE jsou nadále host-owned. CREATE/DELETE/tasks/time/recurrence/meeting,
RSVP/reminders a jiné pinned či explicitní legacy operace používají své
stávající trasy. Dřívější velká legacy JSON/identity data nedostala nové limity.

OAuth snapshot, token persistence CAS i local reconnect/revocation CAS nově
zahrnují existující `sync_read_generation`; refresh coalescing key ji také
rozlišuje. Opožděný success nebo invalid_grant nemůže přepsat či lokálně
revokovat grant, který mezitím ztratil a obnovil scope/status/refresh presence
s byte-identical původními hodnotami. Běžná non-null token rotation tuto
generaci nemění. Nová SQL migrace není potřeba; zdrojem generace je trigger z
0085. Toto není změna remote Google revoke endpointu ani nový DAV ABA důkaz.

## Ověření

- 24 storage-free fake-host provider testů: přesná body/If-Match, scoped IDs,
  grants, guest/recurrence refusal, request outcomes, injected clock a telemetry,
  cancellation, host fence a runtime dependency boundary.
- 27 skutečných lokálních HTTP + PostgreSQL bridge scénářů: accepted A body,
  412 bez opakování, lost-reply GET recovery, jiné success ID, neúplné/malformed
  read a chybějící validator; source/privacy/connection změny během credential
  await i před ACK; long-ID/velké legacy body; každé HTTP včetně refresh přesně
  jednou v metrikách.
- OAuth delayed HTTP fixtures pro scope/status/refresh-presence ABA se success
  i invalid_grant, nezávislé coalescing po obnovení grantu a běžnou rotaci.
- Dosavadní source-read testy včetně 23 000 mappingů, decoder floor a všechny
  tři C03 admission/transport/causal suites (38 causal případů).
- API unit corpus, workspace TypeScript, CI shard inventory a frozen install;
  lockfile přidává pouze dva workspace importery, bez změny resolved závislostí.
- Skutečný produkční API image build, import/test nového package v image a
  boot proti vlastní prázdné testovací DB. Tyto důkazy platí pouze pro fixture.

První API unit spuštění bez ENVIRONMENT zastavilo na chybějící test config;
validace se opakuje se syntetickou konfigurací. Review zachytil a opravy s
negativními fixtures pokrývají calendar identity, PATCH response identity a
RFC3339 normalizaci. Další publikace vyžaduje explicitní independent skeptical
approval finálního stromu a všechny current-head checks success.

## Následující gate C05

Porty dokazují provider boundary. Další milestone musí spustit tentýž výřez
v druhém hostu s vlastním durable ledgerem, credential persistence, admitted
operation storage a crash/restart recovery. Fake-host unit test ani úspěšný
API image nedokládají nezávislý durable host. Až jeho parita dovolí vyhodnotit
rozsah společného runneru v C06. Veřejná licence/package release, nasazení
všech decoder consumers a případné zapnutí encoderu jsou samostatná rozhodnutí.

Its a Plan connector nebyl při tomto snapshotu dostupný. Repo drží technické
podklady; tracker změna neproběhla a z tohoto záznamu se nemá odvozovat jeho
aktuální stav.
