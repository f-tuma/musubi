# MUSU-37 / C05: independent durable host

**13. října 2026. Implementační snapshot před PR; publikace a produkce jsou
samostatné důkazy.** C04 je sloučený přes [PR #348](https://github.com/f-tuma/musubi/pull/348),
po všech 22 current-head kontrolách, jako `0ac6bc4951ed45f3cce81395c54e814c6e370f15`.
C05 spouští stejný native Google personal content UPDATE/readback v druhém hostu
s vlastními credentials, canonical modelem a PostgreSQL ledgerem.

## Výsledek extrakce

`apps/sync-reference` závisí jen na `@musubi/provider-google`, `@musubi/types`,
`@musubi/sync-codec`, `pg` a `tsx`. Nemá Musubi DB, Better Auth, app config ani
API. Jeho vlastní `ReferenceContent` používá name/notes/place a neměnné UTC
časové konce; nevytváří Musubi Event/Task DTO ani nevolá jejich encoder.

Pět vlastních tabulek drží connections, objects, bindings, operations a attempts.
Credentials jsou oddělené od accepted payloadu a šifrované AES-256-GCM s AAD
connection identity. CLI čte pouze vlastní REFERENCE konfiguraci. Produkční
image obsahuje jen tento dependency closure. Seed vytváří explicitní nový
fixture binding; není onboarding/discovery ani OAuth refresh.

Canonical CAS, accepted projection, sparse native plan a intent vznikají v jedné
transakci. Validated admission identity a primitive patch se kopírují před prvním await;
stejný snapshot řídí fingerprint i accepted obsah. Seed rovněž kopíruje
credentials/content/identity před pool await, aby AAD odpovídalo uloženému
connection ID. Skutečné blocked-PG/pool fixtures mění původní vstup a potvrzují
uložení původního A. Evidence a ACK před prvním await kopírují také všechny
validated receipt hodnoty, strong validator a bounded lossless projection;
pozdější změna caller DTO nesmí předefinovat přijetí nebo binding ETag.
Finish obdobně kopíruje retry metadata, včetně Infinity reconnect gate. SQL brání změně jejich identity a obsahu. Capture zahrnuje skutečné
connection/source/privacy generace a accepted revision. Lifecycle triggery
odlišují loss→regain ABA; běžná rotace přítomného tokenu sama nezmění generaci.
Jedna neACKovaná operace na binding drží causal barrier.

Runner vlastní claim/renew/dispatch marker/evidence/ACK; jde stále o reference
implementaci před společným runnerem C06. Claim má 120 sekund, běh 45 sekund,
heartbeat 20 sekund. HTTP je mimo databázové transakce. ACK atomicky mění
binding ETag/baseline a operaci pouze pod aktuálním živým lease a current
connection/source/privacy/canonical fences. Stale attempt může uložit svou
historickou evidence, ale nemůže přepsat current receipt, mapping ani nový lease.

## Podporovaný profil a poctivá evidence

Pouze existující osobní nerekurentní Google timed event, summary/description/location
UPDATE a exact GET. Součástí zůstává native personal/organizer/guest/grant
preflight a conditional If-Match. Meetings, tasks, recurrence, all-day, time
editace, CREATE/DELETE, scheduler a veřejná relay služba zůstávají za dalšími gates.
Neznámá/přítomná vadná envelope i legacy payload se drží HOLD před credentials/HTTP.

Recovery po possible dispatch nejdřív načte přesný remote objekt. Úplný saved
accepted target plus strong ETag dovolí ACK bez PATCH. Při rozdílu jen původní
nezměněný ETag dovolí nový fresh preflight a conditional pokus; nový validator
nezakládá právo přepsat cizí editaci. Partial 206/content-range, malformed JSON,
wrong ID nebo chybějící strong ETag nejsou confirmation. Absence/cancelled nevede
na globální canonical delete.

Čtyři receipt osy zůstávají nezávislé. Accepted PATCH není potvrzený readback;
proto reference host po úspěchu přidává exact GET. Lost reply s pozdějším matching
GET zachová `provider=uncertain`, `remote=confirmed`. Po předchozím 429 lze
potvrdit externě dosažený accepted target s `provider=rejected`, jen pod persisted
recovery/dispatch důkazem a current fences. ACK zde znamená potvrzený target,
ne vymyšlenou HTTP acceptance nebo notification. 412 zůstává terminal conflict,
429 zachovává Retry-After (ceil milisekund), 401/403 jsou after-reconnect HOLD.

Parita se týká admitted mutation, native guardů, readback a recovery, nikoli
identické celé HTTP sekvence. Extra GET a referenční receipt jsou explicitní
rozdíly hostu. Metriky počítají dokončené transportní hranice; SIGKILL uvnitř
HTTP nemá durable exactly-once telemetry záruku.

## Zapnutí Musubi encoderu

Na výslovný pokyn uživatele je `SYNC_OPERATION_V1_ENCODER_ENABLED` ve zdrojích
výchozí true; přesné `false` jej vypne. Neplatná hodnota zastaví startup bezpečnou
chybou. API startup uvádí encoder boolean a `sync-profile-v1`. Event i task
consumers v nynějším singleton API již mají decoder/codec a authority guards.

Zapnutí odhalilo legitimní dangling source po odstranění physical credential
row. Pro novou admission se v takovém případě volí explicitní legacy profil až
po ověření exact scoped source. SQL chyby, chybějící/mismatched source a chybný
capture se neskrývají. Již přijatá v1 operace se nemění a nedostane legacy fallback.

Legacy all-day timestamps mimo UTC midnight se volí na původní legacy profil
před strict codec: jejich normalizace na DATE nesmí zablokovat validní starou
CREATE/UPDATE/DELETE ani authoritative import. Midnight v1 a chybná vybraná
chronologie mají samostatné pozitivní/negativní fixtures. Nová envelope rovněž
normalizuje pouze fyzické Musubi UUIDs na PostgreSQL lowercase; opaque
connection/calendar/resource keys zůstávají case-sensitive a historické payloady
se nemění.

Historický raw-journal fixture bez source rows výslovně testuje legacy profil;
celá CI jinak nechává flag unset, tedy testuje default ON. Graph native fixtures
obsahují synthetic refresh token, který dispatch guard již vyžadoval. Google
HTTP fixtures nově vracejí exact calendarList ID a zachovávají addressed PATCH
ID; native kontroly se kvůli nedostatečným starým fixtures neuvolňují.
Žádné skutečné `.env`, credentials, provider kalendář ani produkční DB se neměnily.
Lokálně neběžel žádný existující API/worker runtime. Ověřený image boot proti
prázdné disposable DB s encoderem true dokládá balení; nedokládá externí rollout.
Postup pro zastavení a nahrazení starých consumers před aktivací sdíleného ledgeru
je v [normativním protokolu](../protocol/sync-operation-v1.md).

## Lokální ověření

- 7 čistých admission a 26 runner scénářů, včetně immutable target, exact body,
  Retry-After, rejection/uncertainty/readback a deadline/cancellation.
- 29 skutečných PostgreSQL ledger scénářů: CAS/intent rollback, command reuse,
  SQL immutability, causal barrier, lease/current authority a čtyři receipt osy.
- 30 skutečných process crash/restart scénářů, včetně SIGKILL uvnitř admission
  před COMMIT a lost reply po aplikovaném PATCH; restart zachová intent hash a
  neprovede druhý write při prokázaném accepted target.
- 101 default-ON admission scénářů pro chybějící Google/Graph/DAV credentials,
  source fan-out, unchanged old envelope a negativní source/capture mismatch.
- Full database CI inventory zahrnuje i obě samostatné host suites a encoder
  missing-credential corpus; všechny běží s unset encoder flag v izolovaných DB.
- API unit corpus, workspace TypeScript, protocol/codec/provider/config testy,
  peer/contracts/release checks, frozen install a CI inventory.
- Samostatný image `sha256:756228bfa68fbc0aa95bf78cd6de991a6104b8f500d9cc2822698d1d74446bb7`:
  44 runtime souborů odpovídá zdrojům; closure 22 packages neobsahuje
  Musubi DB/auth/config/API ani Express/Better Auth. Přímý CLI migrate/show,
  přerušení otevřeného stdin a skutečný lokální HTTP/PG UPDATE i lost-reply
  SIGKILL/restart recovery prošly pouze s vlastní REFERENCE konfigurací.
- API production image `sha256:4523aff49abde9392db3b4ef717145f359da36f4fdcce0d083c27dbf6d4ee79d`
  má shodné encoder/admission/provider zdroje; boot v ENVIRONMENT=prod proti prázdné disposable DB
  je healthy a startup uvádí encoder true bez override. Všechny image důkazy
  používají lokální syntetické credentials; živá acceptance je zvlášť.

Final review a current-head CI jsou povinné před merge. Tento dokument je
předpublikační snapshot; GitHub PR ponese skutečnou publication evidence.
Its a Plan nebyl dostupný v root capabilities, ale delegated connector uspěl.
Ověřený tracker readback má C04 Done/completed včetně bounded checklistu a PR
evidence; C05 je In Progress/active s checklistem dosud false před finálním
review/publication. Projektový roadmap document 2 je version 35. C06 zůstává
backlog/planned, datumová/cycle pole null a lidská přiřazení zachovaná. Dokončení
C05 v trackeru čeká na skutečný merge evidence.

## Další gate C06 / MUSU-38

Vlastní ledger ukázal potřebný portable storage port: claim, renew, session,
mark-dispatch, attempt evidence, fenced ACK a finish. Další milestone extrahuje
sdílený handler lifecycle pro první personal content UPDATE. Musubi bridge musí
zachovat své ACL/canonical/membership/source guards; druhý host své captures.
Shadow mode porovná rozhodnutí bez druhého HTTP write. Stale worker nikdy
neACKuje. C07/C08 rozšíří create/delete/tasks až po tomto gate.

Veřejný package/license/release, produkční rollout a budoucí routing/write-back
Calendar Relay jsou samostatná rozhodnutí. Nynější fixture jejich rozsah neslibuje.
