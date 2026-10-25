# MUSU-40 · Task ACK fencing before runtime extraction

První C08 slice opravuje potvrzení task delivery v Musubi. Navazuje na C07 source
gate `3ab0bbc84375af5b79a4fbe3d0627f7ea42d6ce0`. Neimplementuje nový Google Task
provider/kernel ani task storage v referenčním hostu. Existující task CREATE,
UPDATE a DELETE zachovávají své native routes a oprávnění.

## Dvě reprodukované chyby

1. Skutečný `acceptTaskOutboxDelivery` čekal na zámek mappingu po výběru živého
   claimu. Během čekání vypršela lease. Funkce potom vrátila `false`, ale
   transakce přesto commitnula nový mapping ETag/baseline. Neúspěšný ACK tak měl
   lokální vedlejší efekt.
2. Skutečný `upsertExternalTask` při pending UPDATE zachoval bohatší canonical
   task, ale posunul native mapping na novější `v3`. Starý ACK jej pak přepsal
   zpět na `v2` a ohlásil úspěch. Test používá inbound i ACK production funkce,
   nikoli přímé SQL přepsání mappingu jako náhradu aplikace.

Oba případy byly zachycené RED proti původnímu kódu v samostatné migrované nonce
databázi. Zvlášť byla reprodukovaná kompatibilita legacy CalDAV záznamu bez
captured UID; příliš přísný nový fence by tuto platnou starou cestu odmítal.

## Transakční kontrakt

`acceptTaskOutboxDelivery(row, token, evidence, deletionRef?, signal?, expectedRef?)`
zachovává původní boolean výsledek a přidává volitelné argumenty. Před prvním await
kopíruje caller-owned pozorování a reference. Authority a scope pak bere z nově
načteného, zamčeného outbox claimu; mutable caller row neurčuje cíl změn.

ACK kontroluje živou lease podle DB `clock_timestamp()`, source/privacy capture,
aktuální stav tasku a attachment. Neúspěšné finální dokončení vyhodí lokální
sentinel, který vrátí zpět celou transakci včetně předběžných změn mappingu.
AbortSignal se kontroluje po čekání a před COMMIT. Již odeslaný a potvrzený
COMMIT zůstává uloženou pravdou; pozdní timeout jej nepřepíše na chybu.

Očekávaný native ref se řeší stejným predecessor algoritmem jako při dispatch,
tentokrát uvnitř ACK transakce. Volitelný caller capture musí tomuto důkazu přesně
odpovídat. Nový inbound ETag se nestane novým očekávaným validátorem jen proto,
že je dostupný v mappingu. Porovnává se scope, native ID, opaque ETag, baseline
a UID tam, kde bylo prokazatelně zachycené.

Povolený je původní očekávaný mapping nebo totožné již pozorované echo. Úzký
predecessor fallback pokrývá situaci, kdy starší ACK uložil platný native výsledek,
ale po detach/delete nepřepsal původní mapping. Následný DELETE smí použít tuto
stejnou source historii; nesmí převzít nesouvisející novější pull. Novější
canonical revize sama nezruší historický pár native ref/projection.

Source witness nového resolveru se uplatňuje při ACK. Veřejný dispatch resolver
zachovává své původní rozhraní; tento PR nepřidává nový cross-source fence před
native dispatch. Tam nadále platí existující trusted admission kontrakt.

Při skutečném mapping konfliktu se novější mapping nemění. Živý claim skončí
`conflict/task-provider-conflict` se zachovaným přesným pozorovaným ref/projection
a nejistotou; následné obecné finish starého workeru tento záznam nepřepíše.
Pokud již lease vypršela, starý worker nemá právo zapisovat ani dodatečnou historii;
celý ACK se vrátí zpět a obnovu převezme nový claim.

## Kompatibilita

| Případ | Zachované pravidlo |
| --- | --- |
| Staré čtyřargumentové volání | Resolver odvodí očekávaný ref v transakci; vynechaný nový argument nevypne fence. |
| Přijatá mapping baseline vs dispatch read baseline | Původní NULL baseline zůstává platná. Pozdější native read použitý pro výběr patch polí nevytváří novou historickou mapping baseline. |
| Completed/not-needed predecessor | Adresa, verze a projekce pocházejí ze stejné operace. ACK nepoužije slepě původní `row.expectedEtag`, pokud dispatch legitimně použil predecessor výsledek. |
| JSON persistence | Date/undefined hodnoty se porovnávají podle existující JSON persistence sémantiky; shodné uložené echo se neodmítá kvůli JS reprezentaci. |
| Legacy CalDAV bez captured UID | Pouze dosavadní legacy-v0 unknown-UID cesta může zachovat přesný stávající mapping UID. Non-null capture nebo pinned native-plan UID zůstává identity fence. Nejde o obecný null wildcard. |
| Detached/deleted task | Mapping se neoživuje. Platný historický response pár může zůstat pro již přijatou scoped návaznou operaci. |

Neprobíhá SQL migrace, změna native HTTP, přepočet admitted intentu ani přidání
provider schopnosti. Source fences, home/secondary authority, richer canonical
data a existing conditional/observe-only profily zůstávají oddělené od lokálního
mapping ACK. Reference stále nemá task ledger ani task runtime; event model není
důkaz podpory tasků.

## Task executor bridge a rychlé JSON scénáře

Všech šest skutečných ACK cest v `task_delivery.ts` předává tentýž attempt signal:
CREATE recovery, DELETE absence, achieved UPDATE recovery, empty mask, accepted
DELETE a normální readback. Před native awaits se zachytí skutečný resolved ref;
mutable adapter reference jej během čekání nenahradí.

`false` ACK není ignorovaný ani zaměněný za ztrátu ACL. Stávající error cesta
zachová unconfirmed stav po mutation/recovery, nebo retry bez vyrobené nejistoty
při nulovém dispatch. Před čekáním na ACK se zkopíruje přesné pozorování pro
případnou povolenou finish fázi. Terminální DB conflict a committed ACK jsou
autoritativní. Read-only absence nevyrobí provider acceptance či projekci.

```sh
pnpm test:behavior --suite task-delivery --scenario ack-signal-forwarded --json
pnpm test:behavior --suite task-delivery --scenario false-ack-after-write --json
pnpm test:behavior --suite task-delivery --json
```

Nová osmá sada spouští skutečný `deliverTaskOutbox`, codec a decoder. Nahrazuje
pouze existující DB/config a adapter module ports pevnými datovými receipts.
Node module mocks jsou test-only; runner nastaví potřebné Node flags sám. Nic
neimportuje tyto mocks do produkčního app flow. Neočekávaný nebo nespotřebovaný
port, přeskočený scénář, pozdní continuation či poškozený manifest selžou.

Devatenáct případů a jedenáct harness kontrol pokrývá uloženou masku polí/native
plan, všech šest ACK cest, cancelled waits, preserved observation, predecessor
capture, empty patch, changed baseline a late readback s nulovým ACK. Driver
uvádí čtyři adapter port calls pro UPDATE; netvrdí pět native HTTP požadavků,
SQL atomicitu, skutečné credentials ani shared task runtime. Tyto hranice mají
samostatné skutečné integrační důkazy.

## Ověření

| Hranice | Důkaz |
| --- | --- |
| Fast edit loop | 210 případů v osmi JSON suites, zero failures/errors; task-delivery 19. Dva nové caller kontrakty mají skutečný RED→GREEN: předání signal a zachování observed projection při false ACK. |
| Storage | 15 skutečných PostgreSQL případů: expiry/cancel rollback, inbound mapping, immutable inputs, source capture, predecessor/detach/delete, NULL baseline/UID a JSON echo. |
| Skutečný executor + PostgreSQL | Čtyři případy: title-only zachová bohatší canonical task; timeout při ACK wait rollbackuje a další claim jen čte; inbound v3 zůstává s historickým v2 receipt; skutečný COMMIT vyhraje timeout před client reply. |
| Původní task regrese | tasks, shared_tasks a operation_admission prošly v samostatné migrované nonce DB. |
| Workspace | Celé unit testy včetně web 841, úplný typecheck, lint, contracts, metadata, peers a query runtime prošly. Runner a CI inventory testy mají 31 úspěšných případů. |

### Instalovaný artifact

[Sanitizovaný API souhrn](evidence/MUSU-40-task-ack/api-installed-summary.json)
dokládá frozen 846-file context, 429 byte-equal production TS/SQL a deset dalších
executed/behavior souborů se shodnými hashi. Všech 18 podkladových artifact SHA256
a byte lengths bylo nezávisle ověřeno. Lokální OCI index, platform manifest a
config digests jsou evidované odděleně; nejsou registry publication proof.

Mount-free, nonroot production-layout API aplikovalo 86 migrací z prázdné DB
a s default encoder ON bez override prošlo 17 skutečnými HTTP kontrolami:
metadata/unauthenticated refusal, signup/login/cookie a canonical calendar/event
CRUD/idempotency/revision conflict/readback. Externí účty/targets, event/task
outbox, SMTP a push nebyly nakonfigurované.

Samostatné test kontejnery ze stejné installed closure spustily všech šest sad:
nových 15 DB +4 executor případů a čtyři původní gates tasks/shared_tasks/
task_delivery/optional_tasks. U starších sad se neeviduje vymyšlený počet jejich
interních assertions. Test-only tmpfs `/packages` aliasy míří pouze na installed
workspace balíčky pro původní relativní imports; nejde o source mount ani patch
produkčního kódu. Workspace `.env` se nečetlo. Native HTTP jde pouze na owned
fixture endpoints; žádné live-provider přijetí se neprokazuje.

### Finální běžící web

Po všech předchozích kontrolách prošel skutečný web 8/8 napoprvé za 14.7 s.
`frontend-testing-debugging` použil standardní projektový Playwright, protože
Browser plugin nebyl dostupný. Prostředí `http://127.0.0.1:3000`, Chromium,
1280×900/light a 390×844/dark. Tasks route → inspector → edit/conflict/read-only/
cancel-delete JSON interakce potvrdily obsah, zachovaný draft a zamýšlené writes.
Kontrolují se meaningful Tasks obsah, route, žádný framework overlay/page error,
neočekávaný console error nebo horizontal overflow; výjimka je pouze přesný
úmyslný HTTP 409 diagnostic. Desktop a narrow screenshot byly vizuálně ověřené.

UI používá HTTP/auth fixtures, takže nepotvrzuje storage atomicitu ani native
task transport. Transakční chování dokazují samostatné skutečné DB/installed
testy výše. Native transport se touto změnou nemění a fixture HTTP v původních
sadách není live endpoint certifikací. Žádný UI source se neměnil.

Výsledky: `/tmp/musu40-task-ack-final-browser.log`,
`/tmp/musu40-task-ack-final-browser/evidence-{desktop,narrow}.png`. Vlastní API,
corpus a test-created nonce DB/kontejnery byly uklizené; poté byl zastaven vlastní
`musubi-c08-task-ack-qa-20261025` PostgreSQL a absence ověřena. Port 3000 je po
testu také volný. Lokální image je ponechaný pro dohledatelnost.

COMMIT-race test nechá skutečné `pg.Client.query` provést nezměněné SQL a pozdrží
jen návrat již potvrzené odpovědi. Žádný production test hook se nepřidává.
Nové DB a API integrační sady jsou v root `test:db:tasks`; CI inventory je odvozené
z těchto skutečných commands, nikoli z druhého ručně udržovaného seznamu.

Source repro logs jsou `/tmp/musu40-task-ack-{lease,inbound,legacy-uid}-red.log`;
caller JSON reports `/tmp/musu40-task-ack-{json,observation}-{red,green}.json`.
Jde o dočasné lokální podklady, nikoli deployment evidence.

## Další C08 gate

Celé MUSU-40 a checklist37–40 zůstávají otevřené. Teprve po tomto ACK gate
následuje samostatný Google Task UPDATE provider/runtime slice s actual
five-call compatibility, Tasks grantem, stored field mask a vlastním task
canonical/admission/ACK modelem v druhém hostu. Deferred-address successors,
task CREATE/DELETE a ostatní specialized/provider rodiny nejsou touto opravou
označené za migrované. Produkční/live aktivace má samostatné podmínky.
