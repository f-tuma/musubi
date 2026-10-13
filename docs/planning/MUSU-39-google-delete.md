# MUSU-39 · C07: první Google personal DELETE

První implementační slice C07 převádí DELETE existující osobní neopakované timed
události na stejný storage-free již claimnutý runtime v Musubi i samostatném
referenčním hostu. Celý MUSU-39 zůstává In Progress: Google CREATE, Graph guarded
DELETE a DAV conditional profily mají další samostatné gates. Žádné termíny ani
nativní tracker cycles se nepřidávají.

## Přijatý rozsah a hranice

- Pouze Google `google-personal-event@1`, platný pinned envelope, delete plán
  `body:null`, přesná existující adresa a silný přijatý ETag; bez recurrence,
  original slot, all-day a specializovaných markerů.
- Registrace `googlePersonalDeleteV1` je opt-in capability skutečného Google
  adaptéru. Decoder floor precedes adapter/credential factories. Legacy, custom
  adaptér bez registrace, známé jiné rodiny, chybějící adresa či baseline zachovají
  své existující host routes. Žádný fallback po výběru sdíleného writeru.
- Claim provádí host jednou. Sdílený runtime vlastní jediný finite deadline a
  heartbeat přes prepare, credentials, přesný GET, ACL/event preflight, DELETE,
  evidence a ACK. Fyzický grant a logické account ID zůstávají odlišné identity.
- Strong validator slouží jako podmínka dispatch; aktuální weak/missing/changed
  validator je konflikt, nikdy nové write oprávnění. C06 strict UPDATE read
  typy ani chování nejsou oslabeny.
- DELETE má vlastní native DTO a facts. Přesný 404/410/cancelled GET potvrzuje
  pouze accepted scoped target absence; nepřidává provider acceptance, ETag,
  content projection nebo globální canonical tombstone.
- Google před každou mutací znovu otevře account session a provede poslední
  source/lease fence po credentials. Explicitní organizer `self:false` nebo
  známý organizer email dovoluje odstranit osobní attendee kopii; organizer
  `self:true` s dalšími hosty zůstává specializovaný profil.

## Rozdíly hostů

| Vlastnost | Musubi | Reference |
| --- | --- | --- |
| Úspěšná odpověď DELETE | Accepted response může ACK | Následuje přesný GET a absence ACK |
| Nejistá odpověď | Recovery se odloží do dalšího claimu | Přesný GET ve zbylém budgetu stejného pokusu |
| Canonical/source authority | Existující Musubi DB, ACL, source/grant/privacy a retained pull fences | Vlastní canonical tombstone + monotonic lifecycle generation a source/grant/privacy captures |
| Mapping ACK | Stávající transaction odstraní pouze odpovídající scoped mapping | Vlastní transaction přepne destination present→absent a ACK |
| Historical baseline | Host ji nezamění za nový provider validator | ETag/baseline zůstane v historii; absent binding nepovolí UPDATE |

Musubi legitimní DELETE pokračuje po canonical tombstone, unlink nebo purge,
pokud původní zdroj a grant zůstávají aktuální. External account/source unlink,
disable, reconnect nebo privacy retirement oprávnění ruší. DB ACK zůstává
atomický a po cancellation během pool/row-lock čekání rollbackuje provisional
mapping změny. Již committed ACK je autoritativní.

Reference zachová původní `schema.sql` a aplikuje nový `schema-delete.sql` ve
stejné migration transaction. Existující UPDATE rows jsou default action=update,
canonical generation=1. Změny lifecycle/presence zvyšují monotonic captures;
ABA nevrátí starému intentu oprávnění. Historií, tabulkami, FKs a indexy se
nepřestavuje ledger. UPDATE potřebuje active+present; DELETE svůj accepted
canonical tombstone incarnation+present až do absence ACK. Admission provádí
CAS tombstone a vložení immutable DELETE intentu atomicky.

Reference má stále jeden unfinished operation per binding. UPDATE→DELETE
handoff je serial po ACK; obecný predecessor/cancellation graf, CREATE occupancy,
provider discovery ani pull/inbox nejsou tímto slicem implementované. Duplicate
import po DELETE řeší skutečný Musubi pull, nikoli referenční host.

## Actual parity a bezpečnostní změny

Corpus spouští skutečný původní registered pinned executor s vypnutou pouze
novou registrací a skutečný nový writer nad oddělenými PG/HTTP fixtures. Porovnává
wire method/path/body/If-Match i status, uncertainty, mapping a retained snapshot.
Pure shadow nad zachycenými old-path facts nemění HTTP, credentials ani DB.

Jedna výslovná safety změna: pokud exact event GET ve fresh preflightu už prokáže
absence, nová cesta ACKne bez původního redundantního DELETE. Outcome zůstane
stejný; rozdíl requests je samostatně asserted. Kontrola grant/source po obnovení
credentials uzavírá předchozí suspendované okno před mutací. Nejde o tvrzení
shody obou paths pro všechny unsupported legacy vstupy.

## Ověření

- Google provider: 32 testů; shared runtime: 47 testů včetně zachovaných UPDATE.
- Reference: 48 pure testů, 51 vlastních PG scénářů a 46 skutečných child-process
  HTTP/PG fixtures včetně SIGKILL uvnitř canonical admission transaction a po
  dispatch/acceptance/readback/ACK. Lost reply restart provede GET-only, jeden DELETE.
- Musubi: 55 PG/HTTP scénářů včetně skutečné old/new parity, organizer variant,
  404/410/cancelled absence, 401/403/412/429/500, změny source/grant, unknown/legacy/
  known-time routing, sole heartbeat, late HTTP a waiting ACK rollback.
- Nové sady patří do root unit/DB scripts a odvozeného CI inventory (107 DB sad).

Celých 107 DB sad prošlo na čtyřech samostatně migrovaných PostgreSQL17 DB
(27/27/27/26), s encoder env unset. Tři starší loopback transport fixtures byly
upravené tak, aby zachovaly logical provider response URL; native redirect/address
check zůstává zapnutý. Po opravě byly jejich selhávající a zbývající sady spuštěné
znovu. Také celé `pnpm test`, workspace typecheck, lint, frozen offline install,
release metadata, route/realtime kontrakty, peer graph a CI inventory testy prošly.

Reference production image
`sha256:63340082526ecc11ce95d4165e8ae734a785e14050d586f5c9f681d68dc28404`
má přesně shodných 76 TS/sql souborů se source, z toho 53 runtime souborů;
runtime manifest `efbab12ffafb96589bd16f5730eaf9273b11fdfd9222756b322823fdaca2088b`.
Jeho 24-entry package map včetně app neobsahuje Musubi DB/auth/config. Actual
installed artifact bez bind mounts prošel všemi 16 DELETE process fixtures:
syntetický HTTP/PG, SIGKILL a lost reply/restart mají právě jeden DELETE a
GET-only recovery. Jen REFERENCE_* stačí; vlastní fixture DB/container byl uklizen.

API production image
`sha256:d7ca631b36b7a5f766442f80d2ba51ab5d43de81b99d87d6ce9fe76862f9a88e`
má přesně shodných 632 TS/sql souborů, z toho 400 runtime souborů;
runtime manifest `81a885cc1ecb5e8d06aa8eceffa86d7284e76922d8dacb7fa84ec045f765c19d`.
Closure má 177 package entries včetně app, bez mobile Expo framework/RN nebo
build tools; server auth `@better-auth/expo` je očekávaná závislost. Actual prod
boot proti vlastní empty DB bez source mounts aplikoval migrace (40 public tables),
vrátil health200/verzi0.2.3 a unset encoder default ON. Fixture container a DB byly
odstraněné. Jde o lokální packaging evidence, nikoli externí deployment.

Publication vyžaduje nezávislé explicitní APPROVE finálního frozen headu před
PR a squash merge až po zelených current-head checks. Lokální packaging a
syntetické provider scénáře nejsou externí produkční rollout ani live Google
acceptance. Public open-source alpha, CREATE a ostatní provider gates čekají.
