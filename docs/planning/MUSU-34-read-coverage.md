# MUSU-34: Graph coverage and proven source absence

**C03 · 12. října 2026 · výchozí main `920df6fe93f549bb961f5f32a3d77aadcdc65240`.**

Obnovené Graph calendarView okno už nesmí vyvolat globální tombstone ani DELETE
intent pro další kalendář. Oprava zachovává kanonické UUID, native bindings,
original slots, memberships a přijaté pending/unconfirmed zápisy. Mění se
source coverage a checkpoint; skutečná native absence se posuzuje samostatně
pod současnou host authority.

## Původní chyba a přijatý profil

[Historický JSON](./evidence/MUSU-34-pre-refactor.json) a
[reprodukce na přesném starém commitu](./evidence/MUSU-34/README.md) zachycují
skutečný `microsoftAdapter → syncProvider → reset/sweep` s PostgreSQL a lokálním
fake providerem. Native event stále existoval, ale byl před novým lower edge.
Kanonická revize se změnila z 1 na 2 a vznikl Google DELETE outbox intent.
Všechny čtyři HTTP požadavky byly GET; žádný cizí DELETE nebyl doručen.

[Graph reader](../../apps/api/src/sync/adapters/microsoft.ts) vrací kompletní
**window** coverage, nikoli kompletní inventory. Cursor v2 váže opaque delta
link na native kalendář a oba přesné okraje okna. Plain/v1/unknown cursor začne
nový bezpečný snapshot; chybějící start se neodhaduje. Graph vrací `reset=false`
i při renewal/410, se samostatným `cursorRestarted` diagnostic. Stránky musí mít
validní `value`, přesné IDs a právě nextLink nebo deltaLink ve stejném originu
a scoped calendarView path. Partial/redirected/cyclic/malformed odpověď
necertifikuje checkpoint. Neúspěšný GET zachová read error a Retry-After.

`@removed` není tombstone: Microsoft popisuje i změny mimo okno jako
`@removed` ([calendarView delta](https://learn.microsoft.com/en-us/graph/api/event-delta?view=graph-rest-1.0)).
Neznámá adresa nebo neověřená private-read authority zůstává absencí bez práva
na deletion a bez retained tombstone. U známé adresy s plným oprávněním:

- Scoped GET 200 se normalizuje jako present i mimo okno. Moved exception
  zachová original slot; `originalStart` se validuje před převodem na Date.
- Dvě kompletní přesné `ErrorItemNotFound` 404 obklopující kompletní exact-calendar
  GET s aktuálním `canViewPrivateItems === true` mohou potvrdit absenci source
  adresy. Unknown/false permission, maskované 404, 403, 410, 429, 5xx a partial
  response takový důkaz neposkytují.
- Stejná negativní pravidla platí pro complete finite-family reader. Neověřená
  source authority nesmí odstranit celou přijatou family.

Nedostupný negativní důkaz po odeslané cancellation/DELETE zachová `unconfirmed`;
denied, partial nebo malformed calendar read není důkaz odmítnutí mutace.
429/5xx read navíc zachová Retry-After i po přijatém POST/DELETE. Recovery pouze
pozoruje a neposílá další mutaci; nové fixtures ověřují přesně jeden dispatch.

Profil nedokazuje atomický upstream snapshot ani fyzické smazání napříč
kalendáři: přesun může opustit původní adresu. Host rozhoduje podle origin
authority. Source-origin absence může tombstonovat domácí event a admitovat
fanout; absence odvozené kopie pouze odpojí tuto kopii. Doručení intentu je
samostatná operace. Historické chybné tombstones a intents se automaticky
nevracejí ani neruší.

## Atomické apply a lifecycle

[DB read host](../../packages/db/src/queries/source-read.ts) odděluje admission
před HTTP od atomického apply. [Engine](../../apps/api/src/sync/engine.ts)
provádí ordinary i tracked-family změny, coverage a checkpoint jednou
transakcí. SSE/unlink receipts publikuje až po commitu. Chyba druhé položky
vrátí zpět první změnu, její fanout i checkpoint.

[Migration 0085](../../packages/db/drizzle/0085_graph_read_coverage.sql) je
additive. Source má generation, checkpoint revision, configuration fingerprint
a coverage. `providerAccessRevision` dál slouží permission admission zápisů;
window/config shift jej nezvyšuje a nemění pending payloads. První konfigurace
nového profilu vědomě vyřadí starý cursor před HTTP, bez přepisu eventů/intents.

Read fence zahrnuje source UUID/generation, connection ID/generation,
permission revision/role, konfiguraci, mapping incarnation a předchozí
checkpoint revision/cursor. Null→null reset má novou revizi. Pozdní paralelní
read nemůže přepsat novější dávku ani při stejném tokenu. Budoucí portable
bridge musí mapovat celý složený source/connection incarnation, nikoli pouze
starou access revision.

Access/capability/config/retirement rotace používají lifecycle fence.
Current-row-only account trigger zachytí i přímé Better Auth scope/status/
refresh-presence ABA před hookem; běžná non-null token rotation generation
nemění. Apply drží současnou connection/membership authority pod row locks.
Úplná související calendar fence se získá jednou před deterministickými
canonical row locks a její closure se znovu ověří. Velké ID sady používají
single typed-array bindings. Tento první host drží související calendar
fences exkluzivně; jemnější plánování patří do C09. HTTP je mimo DB transakci.

## Ověření

| Oblast | Reprodukovatelný důkaz |
| --- | --- |
| Původní reset/sweep | Historický witness na `be267b2`, oddělený od current testů. |
| Renewal/410/pending parity, source versus copy deletion, moved slot, HTTP failure a SQL rollback | [Pipeline integration](../../apps/api/src/sync/graph_read_coverage.integration.test.ts) používá skutečný adapter, engine a DB; DELETE ovládá pouze fixture. |
| Source/config/grant/null-checkpoint ABA, shared copies v obráceném pořadí, grant update blokovaný apply a velká source | [DB suite](../../packages/db/src/queries/source-read.integration.test.ts): 11 scénářů včetně 23 tisíc uchovaných mappings a skutečného souběhu PostgreSQL. |
| Strict pages, nulová timed délka, chybný original slot, unknown permission a masked family 404 | [Adapter corpus](../../apps/api/src/sync/adapters/microsoft_read_coverage.test.ts), existující full-family a HTTP boundary fixtures. |

[Populated upgrade](./evidence/MUSU-34/populated-upgrade.md) proběhl na stejné
DB nejprve naplněné baseline `0000–0084`, potom migrované na 0085. Historické
identity, všechny původní sloupce a čtyři pending/unconfirmed payloads zůstaly
přesně stejné. Old/current range a delta wire měly shodných šest řádků; první
nový empty-window read ponechal historické sdílené události a převedl oba staré
cursor formáty na v2. Neběžel delivery worker ani provider mutation.

Lokálně prošlo všech 81 API unit/fake-provider příkazů, 15 Microsoft adapter
testů, osm převzatých Graph integration souborů, celý typecheck, DB schema
checks, docs build a route/realtime/release kontroly. Kompletní DB inventory
prošlo napříč prvním během a zaznamenaným pokračováním 78 leaf příkazů;
poslední rozšířené cancellation/deletion fixtures byly znovu ověřené po finální
opravě uncertainty/Retry-After. Původní optional Tasks fixture prošla také na
baseline runtime. Finální stabilní diff výslovně schválil nezávislý skeptický
reviewer před otevřením PR. Nové testy jsou zapojené do CI; PR CI/main merge
jsou následné samostatné důkazy.

## Rollout a rollback

Produkční rollout má vlastní candidate/runtime inventuru, backup a kontrolu
historických nejasných/chybně přijatých intents podle MUSU-14/15. Nejprve
migration 0085, potom kompatibilní reader build. První read obnoví staré cursory
bezpečně; completion ani pending payloads se nebackfillují.

Starší engine umí číst additive schema, ale opět by povolil destructive Graph
window sweep. Binary rollback před touto opravou proto není bezpečný s aktivním
Graph importem. Bezpečná provozní hranice je maintenance se zastavenými API/sync
procesy, zachovanou schema a následná oprava reader build. Samotné vypnutí poll
interval/recovery background nezablokuje request wakeups. Restore starší DB je
vlastní provozní rozhodnutí, nikoli automatický rollback této migrace.

PR/green CI/main merge, produkční rollout a live provider acceptance zůstávají
oddělenými důkazy. Další MUSU-35 zavede decoder-before-encoder a neměnný zápis.
