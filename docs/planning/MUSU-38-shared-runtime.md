# MUSU-38 · C06: společný runtime prvního Google UPDATE

Implementační snapshot před publikací PR. Zelené CI a merge konkrétního head
commitu se dokládají zvlášť v GitHub PR. Tento záznam nedokládá nasazení.
Plán zachovává pouze pořadí cyklů, bez termínů a nativních cycles.

## Výřez a hranice

Privátní `@musubi/sync-runtime` zpracuje jednu již claimnutou pinned-v1 operaci:
Google personal timed nonrecurring UPDATE s neprázdným sparse body omezeným na
`summary`, `description`, `location`. Spotřebuje uloženou admitted projection,
native plan, skutečný row binding, native target a hostem doloženou recovery.
Nemapuje současný Musubi Event/Task a nesahá do DB, auth, konfigurace ani env.
Závisí pouze na types, sync-codec a storage-free provider-google.

Jádro před prvním await kopíruje a validuje saved plan, binding, adresu, policy
a prior provider evidence. Unknown/přítomné vadné formáty zůstávají HOLD před
factory/credentials/HTTP. Physical credential ID je oddělený od logical account
locatoru; kalendář a resource musí přesně odpovídat envelope. Host může uvnitř
stejného budgetu připravit nový strong validator z prokázaného predecessor ACK,
ale nemůže tím změnit přijatý obsah ani adresu.

## Výslovná pravidla hostů

| Rozhodnutí | Musubi | Reference |
| --- | --- | --- |
| Úspěšný PATCH | ACK z odpovědi, nullable ETag, remote unobserved; žádný extra GET | Exact complete GET, full target a strong ETag před ACK |
| Lost reply | Unconfirmed a GET při příštím claim | GET v remaining budgetu téhož pokusu |
| Empty/null popis a místo | Dosavadní ekvivalence | Literal porovnání |
| Untouched preflight fields | Dosavadní native ETag/capability guard | Porovnání nedotčených polí accepted target |
| Canonical revision | Dosavadní successor-chain proof | Exact accepted revision |
| Durable evidence | Dosavadní uncertainty/resultRef/remoteSnapshot a status | Vlastní čtyři receipt osy a stale-attempt historie |

Provider acceptance, remote confirmation a místní mapping ACK nejsou zaměnitelné.
Pozorování po odmítnutí 429 nepromění rejection v acceptance. Povoluje jen dosažení
saved target pod persisted recovery/current authority; 412 zůstává conflict.

## Jediný writer a lifecycle

Claim zůstává v hostu; společný runner vlastní jediný attempt deadline/heartbeat
pro tuto trasu. Default 45 s / 20 s, žádný druhý budget pro readback. Musubi zachovává dosavadní
konfigurovatelné konečné timeouty C01; reference drží svůj limit 45 s / 20 s
a validuje jej před claim. Promise race
odpojí transport ignorující signal; každý nový capability call ověřuje active
attempt. Host atomicky potvrzuje mapping a operaci pod lease, source/privacy,
credential incarnation a canonical authority. Signal uvnitř čekající ACK
transakce před COMMIT způsobí rollback. Po již odeslaném COMMIT rozhoduje uložená
pravda; pozdější timeout nebo diagnostický checkpoint ji nesmí degradovat.

Cutover je pevný v této verzi pro rozpoznaný bounded profil a registered Google
native port. Ostatní known pinned rodiny a custom adapters bez portu zachovávají
svůj existující pinned handler; absent envelope svůj legacy handler. Po začátku
shared writeru není fallback. Rollback provozu znamená vrátit předchozí ověřený
release artifact. Encoder flag ovládá nové admissions, není rollback existující
pinned operace. Canary ani externí rollout nebyly provedeny.

## Shadow a důkazy

Shadow přijímá pouze immutable saved context a zaznamenané native facts plus
skutečná authoritative rozhodnutí. Nemá port pro credential, HTTP, claim, renew,
marker, ACK ani finish. Vrací bounded mismatch kategorie bez obsahu, identit,
tokenů či URL. Replay samotných kernel rozhodnutí je smoke, ne důkaz legacy parity.
Parita se ověřuje odděleně skutečným starým pinned executor flow a shared flow
pod stejnou Musubi policy, bez produkčního druhého writeru.

Lokální gate prošel:

- 28 shared runtime testů: policy rozdíly, immutable vstupy, phase-tagged native
  failures, noncooperative GET/PATCH, lease loss, čekající ACK/finish a čistý shadow.
- Reference: 35 pure testů, 30 vlastních PostgreSQL ledger scénářů a 30 skutečných
  child-process/HTTP/PG crash/restart scénářů, bez Musubi env nebo tabulek.
- Musubi: 14 shared PG/HTTP scénářů s actual old/new paired wire/status parity,
  27 dosavadních Google bridge scénářů, successor validator handoff, jediný
  heartbeat, nullable ETag, zrušený čekající ACK a oba custom-adapter fixtures.
- Celých 104 databázových sad na čtyřech nezávislých čerstvě migrovaných DB,
  s encoder env unset; všechny exit 0. Nová sada je součást root `test:db` i
  automaticky odvozeného CI inventory.
- Celé `pnpm typecheck`, `pnpm test`, frozen offline install, release metadata,
  route/realtime kontrakty, peer check a testy CI inventory.

Reference production image `sha256:6b31307a7858988e5ea3a713dae1161d29fa99f386d0f4e6847a6076dc14046e`
má přesně stejných 49 runtime TS/schema souborů jako pracovní strom; hash manifest
`647fbb6db777fd20829e25423448de01c0668f6d565fd746916491ae82fac30a`.
Transitive closure má 23 packages včetně sync-runtime a neobsahuje Musubi
DB/auth/config, Express ani Better Auth. Jen REFERENCE_* stačí pro CLI migrate/show.
Skutečný image HTTP/PG sparse conditional PATCH + exact GET prošel. Lost reply,
SIGKILL a restart provádějí pouze recovery GET, celkem jeden PATCH, s
provider uncertain / remote confirmed. SIGTERM při otevřeném stdin vrací safe
HOLD a nula HTTP. Všechny credentials a DB byly syntetické/disposable.

API image `sha256:41c061ceed206f7f5ad625dc92351b7bb6b2cf8d147dd6460b646245fe81e11d`
má přesně stejných 309 runtime TS souborů jako pracovní strom; hash manifest
`e805681e34131ce09115729156475a4ea6d17a8055d8abcaeac6784739b7d702`.
Production closure neobsahuje Expo/React Native/expo-sqlite, Turbo, TypeScript
ani drizzle-kit. Produkční režim proti vlastní prázdné fixture DB aplikoval
migrations, startoval s unset encoder flag jako ON/profile-v1 a vrátil zdravé
`/api/v1/server/ok`. Boot container byl odstraněn. Jde o packaging evidence,
nikoli externí produkční nasazení.

Publication gate zůstává nezávislé explicitní skeptical approval finálního
headu před PR a squash merge až po všech zelených current-head kontrolách.
C07 je další gate pro personal CREATE/DELETE; meetings, recurrence, all-day/time
write, tasks a veřejný Relay sem nepatří.
