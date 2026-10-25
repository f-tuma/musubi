# MUSU-40 · Addressed Google Task UPDATE

Navazující C08 slice po [task ACK gate](MUSU-40-task-ack.md), main
`1e5b83ab23d1235a960a312f70e15982a39824db`. Převádí jedinou rodinu:
již adresovaný, pinned-v1, neopakovaný Google Task UPDATE. C08 jako celek zůstává
rozpracované. Source, instalovaný obraz, publikace a produkční provoz mají
samostatné důkazy; tato stránka neprohlašuje živý provider ani rollout.

## Rozdělení odpovědností

- `@musubi/provider-google`: Tasks DTO, native GET/PATCH a skutečná čtyřpolová
  normalizace; samostatný Tasks grant, nikoli Calendar oprávnění.
- `@musubi/sync-runtime`: jeden již claimnutý pokus, budget/signal/heartbeat,
  validace uloženého codec targetu, baseline a masky, recovery a readback.
- Musubi API: existující claim, source/privacy/credential capture, predecessor,
  write-once dispatch projection a atomický task ACK z předchozího slice.
- `sync-reference`: vlastní bohatší canonical task, admission/CAS a čtyři
  samostatné task ledger tabulky. Sdílí pouze existující šifrované connection
  úložiště; nevytváří event s náhradními daty začátku a konce.

Kernel ani provider nemají DB/auth/config závislost. Vstupy a cílové hodnoty se
kopírují před asynchronními porty; změna aktuálního canonical tasku nepřepíše
admitted native plan. Připravená maska musí přesně odpovídat uloženému rozdílu
baseline a celého targetu. Host může vybrat názvy polí, nikoli dosadit nové hodnoty.

Explicitní `collectionIdentity` rozlišuje skutečné native task-list ID a Musubi
`musubi-google-task-list:` locator. Prefix se rozbaluje právě jednou; native ID,
které samo začíná stejnými znaky, zůstává celé. Změněná predecessor adresa
nepřesměruje již adresovaný pinned task.

## Zachované a přísnější profily

| Hranice | Musubi | Referenční host |
| --- | --- | --- |
| Běžný zápis | GET → GET → GET → PATCH → GET; čtyři session materializace | Stejná bounded native cesta |
| Prázdná maska | Dva GET, žádný PATCH | Totéž, explicitní not-dispatched + confirmed ACK |
| Readback | Dosáhl všech uložených patch polí | Dosáhl celého admitted targetu |
| Ztracená odpověď | Odložené GET-only ověření v dalším claimu | Ověření v témže pokusu nebo po restartu |
| Native GET | Původní any-ok/parser/notes/due floor | Exact 200, úplná platná pozorovatelná pole, bez redirectů/partial response |
| PATCH | Původní default redirect a success-body etag parser | Redirect refusal; usable tag nebo samostatné ověření |
| Tasks 401 | Delivery/preflight/readback GET se jednou obnoví; writer-final GET a PATCH se neopakují | Bez nově vymyšlené token obnovy |
| Accepted status před JSON | Fakt pouze aktuálního pokusu; durable uncertainty zůstává původní reprezentace | Explicitní task operation/attempt status sidecar |

Title-only PATCH nepřenáší `in-process`, přesný čas termínu ani priority.
Tyto hodnoty zůstávají canonical. Při změně neodeslaných native notes může API
potvrdit dosažený title a uloží skutečný celý pozorovaný baseline. Referenční
full-target profil takovou souběžnou změnu odmítne; baseline si nevymyslí.

Po uncertainty lze potvrdit dosažený target i s novějším tagem. Další PATCH
vyžaduje původní silný ETag a úplný původní baseline; čtení nedává právo rebase.
Adresovaný reference UPDATE může při zaznamenané recovery potvrdit celý target
i po známém odmítnutí předchozího pokusu. Provider zůstane `rejected`; nevzniká
fiktivní native acceptance.

HTTP 200/201/204 se zaznamená před parsováním response JSON/tagu. Vadná odpověď
nedokazuje `not-written`. Přijatý zápis z aktuálního pokusu může být následně
ověřen čtením; historická acceptance zůstává oddělená od aktuálního odmítnutí
429/412 a jeho Retry-After. Nový neznámý dispatch nahradí starší `rejected`
fakt nejistotou. Pozdní callback nemůže podruhé potvrdit nebo uzavřít pokus.

## Referenční task authority

Canonical model uchovává name/notes, todo/doing/done, přesný dueAt a importance.
Admission používá skutečný `encodeTaskV1`, původní plný baseline a jedinečnou
seřazenou masku. Jedna binding má nejvýš jednu nepotvrzenou operaci; idempotency
je v task rodině oddělená od event command namespace. Nový reference helper
vyžaduje lowercase UUID operation ID podle existujícího codec contextu; tím se
nezužují opaque operation ID veřejného již claimnutého runtime/provideru.

Connection, canonical, binding a operation se zamykají v pevném pořadí. Žádné
HTTP neběží v transakci. Autorita zahrnuje Tasks scope, aktuální credential
incarnation/expiry, source active epoch, privacy/lifecycle epoch a accepted
canonical revision. Živá lease se kontroluje podle DB času po čekání na zámky.
Neúspěšný závěrečný settlement vrací předběžné změny zpět. Aktivní signal se
kontroluje uvnitř transakce před COMMIT; potvrzený COMMIT vyhraje pozdní timeout.

Stávající connection trigger rozlišuje active/scope/credential-presence změny,
nikoli dvě různé neprázdné ciphertext hodnoty. Nová physical credential identity
proto vyžaduje novou connection nebo explicitní retire/reconnect přechod.
Prostá výměna tokenu se nepovažuje za důkaz nového incarnation.

## Ověření

Nejmenší rychlý test bez služeb:

```sh
pnpm test:behavior --suite google-task-update --scenario fresh-title-update --json
pnpm test:behavior --suite google-task-update --json
```

Driver spouští skutečný codec → kernel → provider. Datové receipt fronty musejí
být spotřebované přesně; nečekané porty, chybná data a neshody selžou. Samostatné
runtime testy prověřují accessors, pozdní mutace vstupů, adresní režimy, odmítnutý
ACK a signal-ignoring transport. SQL atomicitu ani skutečný native server tyto
rychlé scénáře nedokazují.

API integration používá skutečnou nonce PostgreSQL databázi a vlastní HTTP server
bez externího fallbacku. Porovnává starý pinned executor s novou registrovanou
cestou včetně úplného wire/body/If-Match a uložených výsledků. Zvlášť ověřuje
source retirement, změněný predecessor ID, actual inbound mapping race,
deadline během mapping lock wait a skutečný SQL COMMIT s pozdrženou odpovědí.
Reference testy odděleně prověřují storage, native HTTP, skutečné CLI/SIGKILL a
opakovanou migraci s původními sedmi event rodinami a novým task ledgerem.

Výsledky finálního source corpus:

| Kontrola | Výsledek |
| --- | --- |
| Google provider, starý i nový | 63/63, z toho 18 nových task testů |
| Task kernel adversariální testy | 13/13 |
| Nová JSON sada | 39/39 + 13 fail-closed harness kontrol |
| Všech devět JSON sad | 249/249 |
| Reference task admission/runner | 16/16 |
| Reference task skutečný PostgreSQL | 26/26 |
| Reference task native/process/CLI/SIGKILL | 25/25 |
| API old/new PostgreSQL/native HTTP a fences | 29/29 |
| Původní task a admission regrese | Celé `test:db:tasks` a tři `test:db:operation-admission` gates prošly |
| Workspace unit/typecheck/lint/contracts/metadata/peers/query | Prošly; web 841 testů ve 109 souborech |
| Runner/CI inventory | 32/32; inventář 130 DB sad zahrnuje všechny tři nové integrační soubory |

Nezávislá revize před image capture potvrdila mimo jiné opravy nově nalezených
post-wait lease/credential kontrol, snapshot session identity a validace celého
strict native těla při ACK. Samotný provider guard není náhradou locked ACK
validace. Testy skutečně drží operation/attempt/mapping řádky jiným PG spojením;
neúspěšný finální guard vrací zpět i předběžné evidence či mapping zápisy.

### Instalované obrazy

[API summary](evidence/MUSU-40-google-task-update/api-installed-summary.json)
zachycuje skutečný production-layout boot bez source mounts, 86 migrací z prázdné
DB, default encoder ON a 17 skutečných auth/CRUD HTTP kontrol. Všech 437
production TS/SQL souborů a 18 hashově ověřených test/behavior zdrojů odpovídá image;
861 souborů credential-free build contextu zůstalo byte-equal. Samostatný
installed corpus má sedm sad: nových 29 API případů, předchozích 15 DB ACK +
4 API ACK případů a čtyři původní gates tasks/shared_tasks/task_delivery/optional_tasks.
Číslovaný součet je 48, nikoli odhad počtu assertions starých sad.
Test-only tmpfs package aliases jsou oddělené od production-layout HTTP smoke.

[Reference summary](evidence/MUSU-40-google-task-update/reference-installed-summary.json)
zachycuje 172 TS/SQL a 96 production souborů shodných s image, celý shodný
200-file context a úplnou closure 30 pojmenovaných packages bez Musubi
DB/auth/config/mobile. Z instalovaného obrazu prošlo 138 pure, 137 skutečných
storage a 213 native/process případů. Samostatný starý-image → nový-image proof
má 24 případů, 121 skutečných CLI spuštění, 122 native fixture HTTP požadavků a
sedm SIGKILL ukončení. Zachoval všech sedm původních event rodin, Graph unknown
ID/adopted NULL/weak tag a DAV sidecars, celé historické řádky a 15 původních
table/index OID. Opakovaná migrace společných devíti tabulek zachovala 28 OID.

API local OCI index je `e3745c06f53a3868b0de28abe4ee6517611e0c7c495d1ab6e243189fb7c39133`;
reference index je `a0b3ccccd624ddc0d37608b1626d8e5a80a411190d9eb320bdaa753f4deba771`.
Oba machine-readable souhrny rozlišují index, platform manifest a image config
digest. Celkem 19 API a 35 reference artefaktů má ověřené hashe i byte lengths;
source contexty byly ověřené znovu po dokončení proof. `gitHeadAtBuild` je base
commit; skutečný schválený staged source doloží manifesty a capture tree,
nikoli tvrzení, že image byl sestavený ze starého base obsahu.

### Závěrečná běžící aplikace

Jako poslední behavior kontrola proběhl skutečný web na `http://127.0.0.1:3000`:
task inspector → edit/conflict/read-only/cancel delete → očekávaný task stav.
Playwright/Chromium ověřil všech 8 případů za 14.8 s, desktop 1280×900/light a
390×844/dark. Page identity, obsah, framework overlay, console/page errors,
interakce a horizontal overflow prošly; oba screenshoty byly vizuálně ověřené.
Browser plugin není dostupný, proto se použil existující Playwright workflow.
Auth/API fixtures z této UI kontroly nedokazují skutečnou DB ani provider.

První pokus skončil 7/8 s `ERR_NETWORK_CHANGED` při souběžném odstranění vlastní
Docker sítě; jeho trace zůstala zachovaná. Po dokončení úklidu prošla celá sada
8/8 bez source/test změny nebo nové výjimky. Finální screenshoty a QA záznam
jsou v `/tmp/musu40-task-update-final-browser-verified/`; původní neúspěšný
záznam v `/tmp/musu40-task-update-final-browser/`.

Všechny vlastní proof kontejnery a nonce DB jsou odstraněné, včetně společného
QA PostgreSQL na portu 55443. Uživatelský `musubi-ui-qa-20260913` zůstal
nedotčený. Dva lokální image tagy zůstaly pro audit. Zachycené source/test
kontexty obou obrazů zůstaly po svém capture shodné. Po finálním API capture
se měnily pouze tyto souhrny a plánovací dokumentace.

## Zbývající rodiny a vendor hranice

Google Task CREATE/DELETE, null-address CREATE successor adoption, Microsoft
To Do, CalDAV VTODO, recurrence, assignment/move/hierarchy/reorder a specialized
event/RSVP/scheduling zůstávají samostatné host-only nebo pozdější gates.
Neregistrovaný custom adapter a legacy-v0 nepřecházejí na nový writer. Vybraná,
ale neplatná pinned rodina selže uvnitř svého kernelu bez fallbacku.

Google dokumentuje [Task PATCH a Tasks scope](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/patch)
a [day-only due, dva stavy a assigned task rozdíly](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks).
Existující conditional profil není novou live certifikací endpointového CAS.
Neproběhl žádný skutečný provider zápis, publikace registru ani produkční rollout.
