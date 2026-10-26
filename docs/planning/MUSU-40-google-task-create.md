# MUSU-40 · Google Task CREATE

Navazuje na [adresovaný DELETE](MUSU-40-google-task-delete.md), sloučený přes
PR #382 jako `8077ad93494cead098c8101af78d7132266f380e`. Tento samostatný gate
převádí standalone pinned Google Task CREATE a jeho stejnou operaci při obnově
do společného provideru/kernelu a nezávislého referenčního task ledgeru.
[Celý C08 inventář](MUSU-40-family-inventory.md) zůstává otevřený.

## Nativní a host kontrakt

| Hranice | Musubi API | Nezávislá reference |
| --- | --- | --- |
| Fresh wire | Task-list GET → POST → task GET, tři sessions | Stejná native rodina s explicitním strict profilem |
| Task-list GET | Exact list ID; any response.ok; bez Cache-Control | Exact scoped 200, bez redirect/partial response |
| Task GET | Cache-Control:no-cache, původní ID/title/status/strong-tag/assignment floor a normalizace | Strict native JSON, task bez assignmentInfo/deleted:true, full-target proof |
| POST | Původní 200/201/204; default redirect; JSON + nonempty ID + strong body ETag | Oddělená raw acceptance, candidate ID a použitelný tag; redirect/scope guard |
| Concrete GET401 | Jedna host-owned recovery; druhý 401 zůstává ProviderAuthError | Stejné explicitní porty, žádná POST auth replay |
| Unknown dispatch bez ID | HOLD, nula dalších native requests | Totéž, žádný list/search nebo druhý POST |
| Známá adresa při obnově | Přesný GET a celý admitted target, nikdy další POST | Přesný GET a strict celý target |
| POST429 | Dosavadní conclusive retry policy hosta | Durable marker zůstává single-send; další pokus pouze pozoruje/HOLD |

Native list identita je oddělená od logical account a Musubi prefixed locatoru;
prefix se odstraňuje právě jednou podle explicitního identity režimu. Tasks
grant se ověřuje po token refresh, fyzická connection/generation před i po něm.
Calendar grant nenahrazuje Tasks. Původní plain API parser se nezúžil přísnějšími
referenčními pravidly, velikostí ignored metadat ani limitem generated ID.

Codec skutečně zmrazí čtyři pole title/notes/status/day-only due a native JSON
body. CREATE envelope i operation row ponechávají resource ID NULL. Candidate
ID je response evidence, nikoli přepsání admitted locatoru. Bohatší canonical
doing, přesný deadline, priority a další neprojektovaná data zůstávají host-owned.

CREATE s predecessor lineage i queued CREATE→UPDATE/DELETE successors zatím
zůstávají na dosavadní cestě. Vybraný poškozený standalone pinned plan HOLDne
bez fallback writeru. Nepřidává se nové recurrence či assigned-task oprávnění.

## Acceptance, adresa a cancellation

Raw přijetí HTTP200/201/204 se liší od parsed ID, strong response ETag,
potvrzeného readbacku a host ACK. Reference ukládá skutečný status před JSON
parse a candidate ID před kontrolou response tagu. Status může existovat bez ID.
Candidate s chybějícím/weak response tagem lze pouze přečíst na původním listu;
strict úplný GET s reálným silným tagem teprve dovolí atomickou adoption.

API výslovně zachovává původní durable resultRef boundary: až dokončený awaited
writer return s ID a strong tagem. Dřívější raw callback facts tento starší
durability gap neuzavírají. Neúplná odpověď či timeout během JSON parse tedy
nevymyslí uloženou adresu. Timeout při následném readbacku již dokončenou adresu
zachová. Obě race hranice mají skutečnou old/new HTTP/PG parity.

Jeden claimed attempt má jeden timeout/heartbeat/signal. Po ukončení attemptu
neprovede late, signal-ignoring transport žádnou další host capability. Commitnutý
ACK vyhraje pozdní timeout. API znovu používá hardened task ACK s captured old
reference, aktuální locked lease, DB-clock, mapping CAS a úplným rollbackem.

## Nezávislá storage a forward upgrade

CREATE rezervace nemá vymyšlený native ID, ETag ani baseline. Má immutable
createOperationId/profile, bohatší canonical task, originální physical collection
a vlastní CREATE admission. UPDATE saved mask a DELETE baseline zůstávají
action-specific. Raw acceptance a candidate sidecary jsou monotone a nezávislé.

Přesný původní marked attempt smí doplnit kompatibilní concrete native facts
i po uplynutí DB-clock lease; tento historický append neuděluje nový dispatch,
credential, adoption ani ACK authority a nesmí přepsat novější důkaz. Runtime
po vlastní cancellation/uzavření žádný takový host call nevykoná. Remote/ACK
důkaz stále vyžaduje aktuální vlastnictví a všechny source/privacy/credential fences.

Adoption zamkne aktuální connection, canonical task, binding a operaci;
teprve úplný scoped GET vloží ID + skutečný tag/baseline, posune source epoch
jednou a commitne ACK. Finální lease i credential expiry se měří po všech
čekáních a po provisional mapping write; false/cancel vše vrátí zpět.
DELETE absence naopak dál nemění source epoch ani nemaže původní binding proof.

Additive desátý profil zachová devět původních event/task profilů, jejich
historické řádky/sidecary a 28 table/index OIDs. Full migration rerun nad
populated CREATE ledgerem nesmí reinstalovat užší staré DELETE constraints.
Po potvrzené adoption samostatný UPDATE/DELETE admission spáruje nové ID,
source epoch, tag a baseline; pending deferred-address portability má vlastní gate.

## Vývojové ověření

```sh
pnpm test:behavior --suite google-task-create --scenario fresh-create --json
pnpm test:behavior --suite google-task-create --json
```

Driver volá skutečný encodeTaskV1 → claimed kernel → provider; nahrazují se
pouze existující porty. Scénáře neprokazují SQL atomicitu ani live Google behavior.
Všech 352 rychlých scénářů v jedenácti sadách prošlo; nový driver má 44 případů
a 38 fail-closed harness kontrol. Provider má 97 testů včetně 79 předchozích;
kernel má 29 testů. Reference prošla 157 pure, 182 storage a 268 native-process případy,
včetně nových 24 + 24 a šesti skutečných SIGKILL hranic. API má 62 skutečných
PG/HTTP případů: 46 párových old/new módů a 16 dalších shared authority/route kontrol. Celý workspace unit/typecheck/lint/build, release metadata, route/realtime
kontrakty, peers a query runtime prošly. Web má 841 testů ve 109 souborech;
34 runner/inventory kontrol prošlo a CI objevuje všech 136 DB sad. Původních
12 task a tři admission gates zůstávají zelené. Starý memory-adapter admission
test výslovně neaktivuje novou HTTP factory, stejně jako předchozí UPDATE/DELETE
factory; jeho assertions zůstaly zachované, novou cestu ověřuje samostatná
62-case PG/HTTP sada. Installed a poslední browser důkazy jsou oddělené níže.

Nezávislá revize reprodukovala odmítnutí legacy-valid ignored metadata
(array257/object129/depth20, raw exponent1e400) kvůli admission snapshot limitům.
Nativní evidence má nyní samostatný iterative own-data snapshot bez těchto
limitů; admitted plány zůstaly omezené, strict provider proof zůstal přísný.
Gettery/toJSON/cykly se nepouštějí. Párová HTTP regrese kontroluje i přesné
Cache-Control list/task hlavičky a rozdílné JSON-time/readback-time cancellation.

## Lokální instalovaná evidence

Source schválila nezávislá revize pro capture jako přesný staged tree
`4daeae14748b2f87df460a01aa87513b431aed8f`. Build context neobsahuje pracovní
.env, credentials, data ani source bind mounty; source/proof metadata se
nezaměňují s registry publication nebo produkční aktivací.

API image `musubi-c08-google-task-create-api:proof` má 888-file context,
452 production/support TS/SQL (450 production + dva API behavior helpers)
a 31 hash-checked task test/behavior sources. Dva helpery jsou v obou
inventářích, celkem jde o 481 jedinečných souborů. Hashový
inventář neznamená, že všechny JSON/harness soubory běžely v installed corpus;
to má konkrétních devět integračních sad. Canonical production layout prošel
86 migracemi z prázdné DB, default encoder ON, nonroot/no mounts a 17 real
auth/CRUD HTTP kontrolami. Oddělený installed corpus prošel CREATE62 + DELETE46
+ UPDATE29 + DB ACK15 + API ACK4 = 156 číslovanými regresemi (62 nových CREATE + 94 zachovaných) a čtyřmi původními
suite gates. Všechny používané task pooly byly zavřené před plain DROP.

První připravovaný HTTP smoke vynechal běžný Origin header a správně dostal
Better Auth403. Opravený harness poslal standardní browser Origin; CSRF ani
authentication ochrana se nevypínala a image/source se neměnily. Původní
nezdařený harness pokus zůstává oddělený od finálního úspěšného důkazu.

Reference image `musubi-c08-google-task-create-reference:proof` má 241-file
context, 210 TS/SQL sources a 115 production souborů; closure 30 named
packages neobsahuje Musubi DB/auth/config/mobile ani Better Auth. Předchozí
image `sha256:de63e9850d2d4dbba8fb6b1088fb3cf1a45e378c3fd5e0c526b14c9873e908cf`
vytvořil devět rodin s deseti skutečnými pending operacemi, včetně samostatných
Task DELETE2xx a DELETE404 větví. Nový image zachoval celou historii, sidecary,
epochs a 28 table/index OIDs, dokončil všech deset operací a dvakrát zopakoval
migraci nad populated desetiprofilovým ledgerem. Custom probe má 17 bounded
případů, 117 skutečných CLI invocations, 94 native fixture requests a šest
container SIGKILL (tři staré task hranice + tři nové CREATE hranice).

[API souhrn](evidence/MUSU-40-google-task-create/api-installed-summary.json)
uvádí OCI index `sha256:7f782c360996d79b3de6310686a72a58e506028c306bbe07b9a883f6d257ac1c`,
amd64 manifest `sha256:c4f5d4af9903b03995e9bc40492249530f66454d72dd9471bd9c6bed2a5a43b7`
a config `sha256:84d8071c00c56099077b5f9f733fd28cba16fbc264b4af900782a75dba0ed122`.
Všech 30 jeho raw artifact hashů/délek je ověřeno; první Origin403 harness pokus
je zachovaný odděleně. OCI vrstvy se nezaměňují s registry RepoDigest/publikací.

[Referenční souhrn](evidence/MUSU-40-google-task-create/reference-installed-summary.json)
uvádí OCI index `sha256:58dbf36c53aab92cd5408abad62f0aa7e2c6bac22ac01da91fb639819229477f`,
amd64 manifest `sha256:ee195a07b563bcb597a0f7fd15e5e1bb174d39559538069f99c0c760bcf79dee`
a config `sha256:a88fc338ff368cd40f736fe34e98362fba890418fcc0289447bc3efd9bdbd09e`.
Plný installed corpus prošel 157 pure / 182 storage / 268 native-process případy
(6.172 s + 280.544 s); vlastní parent nonce i child DB byly odstraněné.
`ENVIRONMENT=test` používají pouze test harnessy; production CLI má jen
`REFERENCE_*` konfiguraci a explicitní bounded native HTTP fixture preload.
Všech 275 raw artifact hashů/délek je ověřeno a úplný manifest zůstává přiložený.

### Poslední běžící aplikace

[Browser a cleanup souhrn](evidence/MUSU-40-google-task-create/browser-summary.json)
zachycuje finální Chromium 8/8 napoprvé za 14.3 s: desktop 1280×900/light a
390×844/dark. Před spuštěním oba autoři ukončili veškerou DB/behavior práci;
v QA databázi zůstala pouze postgres a vlastní kontejner i port55443 byly
ověřeně odstraněné. User QA na55437 zůstalo zachované. Browser plugin nebyl
k dispozici, proto běžel existující Playwright scénářový driver.

| Kontrola | Výsledek |
| --- | --- |
| Skutečný app route a viditelná Tasks region | Prošlo |
| Editace se zachováním bohatších polí, conflict draft, readonly mirror, cancel DELETE | Prošlo na obou šířkách |
| Page/console chyby a framework overlay | Žádné neočekávané; exact fixture409 diagnostic zůstává explicitní |
| Horizontal overflow | Žádný |
| Screenshoty desktop/light a narrow/dark | Oba vizuálně ověřené |

UI auth/HTTP jsou fixture; real authentication/DB/provider proof má samostatné
hranice výše. Žádný skutečný Google účet, live provider mutation, publikace
nebo produkční rollout tím nebyl provedený. Zůstávají zachované vlastněné raw
logy a screenshoty mimo repo; committed JSON souhrny nesou jejich hashe/délky.

## Vendor a rozsah tvrzení

[Google tasks.insert](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/insert)
dokumentuje POST do konkrétního task listu, Tasks OAuth scope a novou Task
odpověď. Assigned Docs/Spaces tasks mají samostatná omezení.
[Task resource](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks)
popisuje due jako scheduled day; čas se zahodí. Tyto podklady nejsou novou
certifikací create idempotence nebo live exactly-once. Bez zachycené adresy se
proto žádný uncertain POST neopakuje. Registry publication a produkční rollout
nejsou součástí source/local acceptance; nasazení proběhne až společně později.
