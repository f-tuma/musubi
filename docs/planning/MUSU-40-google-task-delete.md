# MUSU-40 · Addressed Google Task DELETE

Navazuje na [Google Task UPDATE](MUSU-40-google-task-update.md), sloučený přes
PR #381 jako `14d694f922b27fdfe0faf4743b77c94ece2da3bf`. Tento samostatný C08
slice převádí již adresovaný pinned Google Task DELETE do sdíleného provideru,
jednoho claimed runtime a nezávislé referenční task aplikace. C08 jako celek
zůstává otevřené pro ostatní task/specialized rodiny. Dokončení source, lokální
instalované obrazy, publikace a produkční provoz mají oddělené důkazy.

## Native a host kontrakt

| Hranice | Musubi API | Referenční host |
| --- | --- | --- |
| Běžná cesta | GET → permission GET → writer-final GET → DELETE; tři sessions | Stejné guardy + samostatný GET readback |
| První GET 404/410 | ACK bez DELETE a bez silného původního tagu | Totéž, skutečná scoped absence |
| Permission GET 404/410 | Pokračuje do writer-final GET; znovu přítomný resource se nesmí přehlédnout | Stejná native preflight hranice |
| Writer-final GET 404/410 | Bez DELETE; rozlišený writer-return receipt | Skutečný GET absence proof |
| DELETE response | Any native 2xx a 404/410; bez parsování body/tagu a bez povinného dalšího GET | Raw response fact; ACK vyžaduje skutečný GET 404/410 |
| DELETE redirect | Dosavadní default follow | Refusal; přesný scope čtení, žádný partial/redirect absence proof |
| Známý response z předchozího pokusu | Původní restart reprezentace uncertainty | GET-only; stále přítomný resource znamená HOLD |

Každý přítomný native GET zachovává exact ID, silný ETag a odmítnutí truthy
assignmentInfo. Delivery/permission GET obnovuje 401 nejvýše jednou; writer-final
GET a DELETE se pro autentizaci neopakují. Calendar scope neopravňuje Tasks.
Před přístupem ke credentials a po host-owned refresh se znovu ověří physical
connection/generation a Tasks scope. Opaque native ID se nezaměňuje s logical
account ID nebo s prefixed Musubi task-list locatorem.

Plán DELETE má skutečný codec `body:null`; native request nemá body ani
Content-Type. Hostem přijatý adresní/validator/baseline pár je zmrazený. Neznámý
dispatch lze znovu podmíněně odeslat pouze na původní adresu, se stejným silným
ETagem a úplným původním baselinem. Novější tag z GET neuděluje write authority.
Přísný referenční profil po jakémkoli známém DELETE response (2xx nebo 404/410)
už pouze pozoruje. GET 200 s `deleted:true` není v tomto gate HTTP absence proof;
reference jej odmítne, API zachovává svůj původní parser floor.

Starý executor výslovně neblokuje sekundární DELETE jen kvůli recurrence.
Nová cesta nepřidává blanket recurrence zákaz; skutečně nepodporovaný profile
zůstává na dosavadním legacy handleru podle existing admission/codec cutoff.
Deferred-address CREATE successor se na nový již adresovaný writer nepřevádí.
Neregistrovaný custom adapter zůstává na svých portech; vybraný neplatný pinned
DELETE nikdy nespadne zpět do jiného writeru.

## Oddělené nativní důkazy

DELETE má vlastní typ přijatých statusů 200–299. UPDATE zůstává u svého
samostatného 200/201/204 kontraktu. Dva DELETE-only sidecary zachycují skutečný
2xx `acceptedStatus` a raw DELETE404/410 `responseAbsenceStatus`; pozdější
absence response nesmaže dřívější známé 2xx. Obecný provider receipt `accepted`
zde znamená úspěšné splnění DELETE requestu, nikoli tvrzení, že 404 bylo HTTP
přijetí mutace nebo že se na provideru něco změnilo.

Remote absence vzniká pouze z konkrétního scoped GET a má provenance
initial-read/writer-read/readback. Direct response ACK v API nevymýšlí GET ani
remote-absence observation. Aktuální rejection/status/Retry-After zůstává
oddělený od starší acceptance/uncertainty; nový skutečně neznámý dispatch
nahradí předchozí rejected fakt uncertainty. HTTP408 receipt má after-delay
retry stejně jako stávající API retry policy; PATCH/UPDATE kontrakt se nemění.

Dosavadní Task executor nastavuje hrubý `mutationAccepted` po návratu
pushTaskDelete i tehdy, když writer-final GET našel absenci bez DELETE. Nový
provider vrací přesný `writerResult`, zachycený před následujícím cancellation
guardem. API tento starý settlement příznak zachová zvlášť od pravdivých native
facts. Writer absence tedy nevytváří fiktivní dispatch/HTTP acceptance, ale
false ACK či timeout po vráceném writeru má stejný API výsledek jako dříve.

## Canonical a referenční storage

Musubi znovu používá hardened task ACK: captured predecessor-resolved ref,
signal v čekající transakci, current locked claim, DB-clock lease a mapping CAS.
Smazání sekundární kopie nepotvrzuje smazání hlavního tasku a neobnovuje odpojený
mapping. Při neúspěšném závěrečném settlementu se provisional změny vrátí zpět;
potvrzený COMMIT vyhraje pozdní timeout.

Reference používá stejný samostatný task ledger. Explicitní DELETE admission
provede canonical CAS do tombstoned stavu, uchová bohatší content a zmrazí
body:null, původní native ID/tag a vlastní delete accepted baseline. Nepředstírá
UPDATE masku; UPDATE saved projection/mask a jeho acceptance status zůstávají
action-specific. Serial pending barrier a immutable command/admission platí dál.

Teprve skutečná absence a atomický ACK změní retained destination presence na
absent. Binding zůstane obsazený původní adresou, aktivní source se neretiruje,
source generation ani původní ETag/baseline se tím nepřepisují. UPDATE odmítá
absent/tombstoned binding. Nevzniká nový resurrection/reuse/resolution kontrakt.
Forward SQL upgrade musí zachovat původní Task UPDATE i sedm event rodin,
historické řádky/sidecary, epochs a existující table/index OID i při opakované
migraci s populated DELETE ledgerem.

## Ověření

```sh
pnpm test:behavior --suite google-task-delete --scenario fresh-delete --json
pnpm test:behavior --suite google-task-delete --json
```

Driver spouští skutečný codec → claimed kernel → provider. Dependency receipts
jsou pouze data na existujících portech; neočekávané či nespotřebované požadavky
selžou nezávisle na tom, zda runtime zachytil chybu. Bez DB/služeb se kontroluje
native wire, průběh a fakta; nikoli SQL atomicita nebo live Google If-Match.

Actual old/new API regrese používají nonce PostgreSQL a vlastní HTTP server.
Obsahují secondary unlink/home authority, native 202/206/299 a bodyless success,
permission disappearance/reappearance, každou assigned/read401 hranici, known
rejection versus lost applied/unapplied reply, skutečné ACK lock waits a COMMIT
před pozdrženou odpovědí. Actual inbound u pending DELETE import odkládá;
samostatně označený injected mapping race dokazuje CAS bez tvrzení, že jde
o tentýž inbound behavior.

Nezávislá revize reprodukovala nový fail-open rozdíl s poškozeným host task
payloadem: stará cesta provedla nula native requests, nová původně GET/GET/GET/DELETE.
Regrese je zachovaná; `TaskSchema.parse` v host prepare nyní odmítá payload před
prvním native readem, bez přidání recurrence zákazu.

První CI head `ef571a1d48400ec2f87f62c27476dbfe84e95a28` v
[Quality 40221975531](https://github.com/f-tuma/musubi/actions/runs/40221975531)
prošel všemi 46 DELETE i 29 UPDATE věcnými případy, ale obě sady poté selhaly
při `DROP DATABASE WITH (FORCE)`: neuzavřený `BoundPool` dostal neošetřený
PostgreSQL `57P01`. Rozdílné tsx module identities jsou možnou příčinou;
netvrdíme, že se tato loader odlišnost reprodukovala v každém prostředí.
Test-only oprava vlastní všechny skutečně připojené pooly již před dynamickými
importy, všechny ukončí, ověří nulu sessions přes `pg_stat_activity` a použije
obyčejný DROP bez FORCE. Neskrývá pool chyby a nemění věcné assertions ani
produkční code. Obě source sady po opravě znovu prošly (46 + 29), včetně
nulových sessions/úspěšného odstranění DB, a API typecheck prošel. Dotčený API
obraz a installed corpus byly následně sestavené a ověřené znovu; původní CI
selhání i původní lokální důkazy zůstávají zachované.

### Source a skutečné dependency hranice

| Kontrola | Výsledek |
| --- | --- |
| Všech deset rychlých JSON sad | 308/308 |
| Nový DELETE driver / fail-closed harness | 59/59 + 13/13 |
| Google provider / DELETE kernel | 79/79 + 17/17 |
| Actual old/new API, PostgreSQL a vlastní native HTTP | 46/46 |
| Reference pure / storage / native-process | 147 / 158 / 244, vše prošlo |
| Zachované task a operation-admission gates | Všech 12 + 3 původních gates prošlo |
| Whole-workspace unit, typecheck, lint, contracts, metadata, peers a query runtime | Prošlo; web 841 testů ve 109 souborech |
| Behavior runner a CI inventory | 33/33; inventory 133 DB sad |

Provider count zahrnuje původní UPDATE i nové DELETE skupiny; každá ze sta
nativních 2xx odpovědí má vlastní kontrolu uvnitř nové skupiny. Původní UPDATE
kernel i 39 JSON scénářů zůstávají zelené. Source API testy používají skutečný
DB-clock, mapping/source lock waits a skutečný COMMIT; deadline spouští skutečný
host timer. Reference procesní testy používají samostatné native HTTP fixture
servery, durable PostgreSQL a skutečné child procesy.

### Lokální instalované obrazy

[Sanitizovaný API souhrn](evidence/MUSU-40-google-task-delete/api-installed-summary.json)
zachycuje image `musubi-c08-google-task-delete-api:proof`:

- OCI index `sha256:9b6746a076fa6e3af056d9844d8e0f74e7d7eda9f7bd277d78961d1aaa559c98`,
  amd64 manifest `sha256:0563a0f69d7fb1ea287e785e5461ca37eea037b20c52ead21167e4d08238cb52`,
  config `sha256:f2bce5c148cc4f352c533443ff2671c0d2d61c9069777ed563fcbef32429b7ce`.
- Zmrazený 875-file context zůstává byte-identical; 444 installed production
  TS/SQL a 25 test/behavior source hashů souhlasí. Hash inventář neznamená,
  že každý behavior source byl v instalovaném corpus samostatně spuštěný.
- Prázdná DB → 86 migrací, source default encoder ON, nonroot a bez source
  bind mountů. Produkční layout prošel 17 skutečnými auth/CRUD HTTP kontrolami,
  včetně Better Auth signup/login/cookie session, bez auth bypassu či DB seedů.
- Oddělený installed task corpus má osm sad: DELETE46 + UPDATE29 + DB ACK15
  + API ACK4 = 94 číslovaných případů a čtyři původní suite gates.
  Test-only `/packages` symlinky odkazují na instalované balíčky; nemění
  produkční HTTP smoke layout ani source.
- Všech 22 raw artifact hashů a délek je znovu ověřeno; 20 původních artefaktů
  před cleanup revizí je zachovaných odděleně a netvoří důkaz jejího úspěchu. Vlastní API kontejnery
  i všechny jejich nonce DB byly odstraněné a jejich absence ověřená.

[Sanitizovaný referenční souhrn](evidence/MUSU-40-google-task-delete/reference-installed-summary.json)
zachycuje image `musubi-c08-google-task-delete-reference:proof`:

- OCI index `sha256:de63e9850d2d4dbba8fb6b1088fb3cf1a45e378c3fd5e0c526b14c9873e908cf`,
  amd64 manifest `sha256:7c34e657f09f36e129f18f9780e53072e2234655d3f0504e44018b6c3617898f`,
  config `sha256:4c7dad9c7488c12452f054f0e18a043ea203a300a29004a4615b214144347b83`.
- Zmrazený 220-file context, všech 191 TS/SQL source a 106 production souborů
  souhlasí s instalovaným obrazem i finálním source. Closure má 30 named
  packages, bez Musubi DB/auth/config/mobile či Better Auth dependency.
- Původní installed osmiprofilový obraz `sha256:a0b3ccccd624ddc0d37608b1626d8e5a80a411190d9eb320bdaa753f4deba771`
  vytvořil skutečné pending operace všech sedmi event rodin a Task UPDATE.
  Nový obraz zachoval jejich payloady, epochs, sidecary, celou historii i 28
  table/index OID a všech osm pending deliveries dokončil.
- Samostatný upgrade/native/crash probe prošel 28 případy, 147 skutečnými CLI
  invocations a 147 vlastněnými native fixture HTTP requests za 110.106 s.
  Devět skutečných SIGKILL ukončení zahrnuje původní Task UPDATE a osm nových
  DELETE hranic. Dvě opakování celé migrace nad populated devítiprofilovým
  ledgerem neztratila původní historii ani DELETE sidecary/tombstones.
- Plný installed corpus prošel 147 pure / 158 storage / 244 native-process
  případy (5.686 s + 269.745 s), nonroot, read-only filesystem, bez source
  mountů. `ENVIRONMENT=test` patří pouze test harnessům; vlastní production
  CLI používá pouze `REFERENCE_*` konfiguraci a bounded test transport preload.
- Všech 35 raw artifact hashů a délek je znovu ověřeno. Obě vlastní nonce DB
  i referenční CLI kontejnery byly odstraněné.

Původní source pro oba buildy schválila nezávislá revize jako tree
`f626fb646711922ca8efbff181a5e85bce676d68`. Nové API IMAGE CLEAR po dvou
test-only cleanup opravách má tree `985fbdc0aba8088831239911e2b395d2f191173f`.
Referenční context zůstal beze změny; opakovaný API build má nový context/test
hash a image identity. Dokumenty a evidence jsou mimo oba image contexts.
Lokální OCI index, platform manifest a config nejsou registry publication ani
production rollout evidence.

### Poslední kontrola běžící aplikace

[Browser a cleanup souhrn](evidence/MUSU-40-google-task-delete/browser-summary.json)
zachycuje poslední Chromium test: 8/8 za 13.7 s, desktop 1280×900/light
+ 390×844/dark. Skutečná aplikace/router/komponenty provedly JSON scénáře editace
se zachováním bohatšího contentu, zachování draftu při konfliktu, read-only
mirror a zrušení DELETE. Screenshoty obou šířek byly vizuálně ověřené; žádný
overflow, neočekávaná API mutace, page error ani neočekávaná console chyba.
Auth a HTTP jsou zde fixture, nikoli nový důkaz DB atomicity nebo real auth;
ty mají samostatné installed API a PostgreSQL gates výše.

Browser plugin nebyl dostupný, proto běžel existující Playwright driver.
Před jeho spuštěním oba image autoři ukončili všechny testy, v dočasném
PostgreSQL zůstala pouze systémová DB a vlastní PG kontejner/port 55443 byly
odstraněné a absence ověřená. Uživatelský QA kontejner zůstal zachovaný.
V posledním důkazu vlastní Docker cleanup neběžel souběžně s Chromium.
Původní běh před CI revizí prošel 8/8 za 13.1 s. Mezilehlý běh po revizi
také prošel 8/8 za 14.0 s, ale byl spuštěný před potvrzením odstranění
kontejneru, proto je z finální acceptance vyloučený. Samostatný poslední běh
výše začal až po úspěšné kontrole absence kontejneru i portu. Všechny původní
logy jsou zachované. Žádná testovací výjimka ani změna UI nebyla potřeba.

## Vendor a zbývající rozsah

[Google tasks.delete](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/delete)
dokumentuje route, prázdné request/response body a Tasks scope. Přiřazený DELETE
maže i původní Docs/Chat Spaces task; proto tato rodina zůstává odmítnutá.
Dosavadní conditional endpoint profil není novou live CAS certifikací.
Žádný skutečný provider zápis, publikace do registru ani produkční rollout
není součástí těchto source/local důkazů.

CREATE, navazující UPDATE s odloženou adresou, To Do/VTODO, recurrence a
specialized event/RSVP/scheduling zůstávají samostatné C08 gates.
