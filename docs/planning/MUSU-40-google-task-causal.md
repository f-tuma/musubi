# MUSU-40 · Google Task causal UPDATE/DELETE

Navazuje na samostatný [CREATE gate](MUSU-40-google-task-create.md), v main
přes PR #383. Tento gate je rozpracovaný: source, instalované upgrade/crash
důkazy a poslední běžící aplikace mají vlastní ověření. Celá C08 zůstává
otevřená podle [family inventory](MUSU-40-family-inventory.md); CREATE s vlastním
předchůdcem, VTODO/To Do a specialized rodiny se tím nepovažují za převedené.
Nasazení zůstává společným navazujícím krokem.

## Opravená hranice a skutečný RED

Původní databázový predecessor walker sice sledoval scope mismatch, ale jeho
veřejný wrapper tuto informaci zahodil a vrátil adresu cizího úkolu. Skutečné
PG/native HTTP případy před opravou reprodukovaly UPDATE
GET→GET→GET→PATCH→GET a DELETE GET→GET→GET→DELETE na takto podstrčenou adresu;
ACK teprve následně odmítl mapping. Jde o porušení vnitřní trusted-admission
hranice při neplatné uložené historii, nikoli důkaz veřejného API exploitu.
Opravený walker odmítá chybný scope před vrácením adresy a před native HTTP.

Další skutečný PG RED potvrdil přechodovou v0 historii s existujícím cizím
physical capture. Každý přítomný capture se nyní validuje a dostupné captures
se porovnávají bez ohledu na přítomnost v1 envelope. Opravdu chybějící capture
zůstává výslovný legacy profil. Nezávislá revize dále odhalila, že první
resolution přebíral čerstvou DB admission místo původního claimed DTO;
skutečný PG RED zachoval staré DTO, změnil uložené actor/position a původní
helper změnu přijal. Host porovnává snapshot původního záměru s prvním
lookup i locked row před odvozením či uložením resolution. Samostatný PG/HTTP
RED ukázal u NULL historical baseline vyměněnou uloženou masku za prázdnou:
operace se dříve dokončila po jediném GET s native title Before místo After.
První prepare nyní porovnává přesnou přítomnost i hodnotu všech tří převzatých
sidecarů (mask, resolution, projection witness). Jejich odstranění nesmí
přeadresovat retry. Další assert/projection porty dovolují vlastní pokrok
téhož pokusu; prepare se v kernelu volá jednou. Opakování se starým claimed
DTO po vlastním pokroku se odmítne, nový retry získá nový skutečný claim.

Celý řetězec se prochází iterativně s detekcí cyklů, bez umělého limitu počtu
článků. Platný bližší resultRef nesmí zakrýt chybného vzdálenějšího předchůdce.
Task/source/account/list/privacy a dostupné physical captures se ověřují na
každém článku. Vlastní actor/command/revision operací se mohou legitimně lišit;
nesmějí se zaměnit nebo při retry potichu změnit. V0 historie zachovává skutečné
row scope/ref/snapshot a nedostává smyšlený v1 physical capture.

## Jedna operace, původní NULL admission

UPDATE/DELETE jsou nominálně vybrané i při resourceId NULL s predecessor ID.
Původní envelope, row binding, target a native plan se nepřekódují na aktuální
mapping. Stejný runtime attempt a signal zahrnují host.prepare i resolution.
Před credentials runtime přijme pouze typed `GoogleTaskPredecessorResolution`
pro tentýž operation/attempt/immediate predecessor a zmrazí native pár.

Address proof obsahuje skutečný evidenceOperationId, taskId, validator a jeho
projectionBaseline spolu s opaque witness. Witness sám není write authority:
trusted host znovu odvodí celý semantic chain a porovná jej před mutation i
uvnitř atomického ACK. Změna pouhé baseline při stejném ID/ETag je konflikt.
Generated native ID používá dosavadní existing-Google parser floor; strict
reference zachovává svůj explicitní limit. Admission data zůstávají bounded.
Native JSON evidence se nekopíruje s umělými admission depth/field/array limity.

API ukládá attempt-independent `dispatchResolution` právě jednou. Samostatný
write-once projection witness váže uloženou masku k témuž historical páru;
koherentní změna baseline a masky se tím nestává novou authority. Historická
NULL baseline má explicitní existing-host compatibility a jednou navázaný
první native-read baseline. Strict deferred reference vyžaduje skutečný úplný
pár z předchozího ACK.

CREATE/not-needed bez adresy má samostatný no-task proof jen při úplném validním
no-write řetězci. API DELETE jej může potvrdit bez HTTP jako
`predecessor-no-resource`, bez provider acceptance nebo smyšleného GET404.
Chybějící adresa UPDATE zůstane HOLD; nikdy nevyvolá nový CREATE. Reference
tento compatibility profil nepřijímá a čeká na skutečně dokončený CREATE.

## Vlastní referenční queue

Referenční host ukládá neměnné záměry zvlášť od jediného aktivního execution row.
Jeho canonical policy materializuje queued změnu až po ACK bezprostředního
předchůdce; Musubi canonical změny zůstávají okamžité. Queue admission proto
nezneplatní revision/content/lifecycle fence rozpracovaného CREATE. Výstup show
rozlišuje materializovaný canonical stav a požadovaný queued stav.

Aktivace v claim transaction zamkne connection→canonical→binding→predecessor
a ancestor operations, ověří přesný pár předchůdce a uloží původní
NULL-address envelope. Neměnné intent rows se čtou bez vlastního row locku.
Opakovaná aktivace nesmí canonical revision zvýšit podruhé. Neznámý nebo
nedokončený CREATE blokuje všechny successors bez HTTP, hledání či resend.

CREATE/UPDATE ACK atomicky uloží vlastní immutable present completion pair:
taskId, readback validator/projection, observation a effective source epoch.
Root CREATE prokazuje přesně svou rezervaci→present a jediný generation g→g+1
přechod. Původní queued capture zůstává g; výjimka je součástí ověřené host
lineage, nikoli obecného oslabení generation guardů. Nová queue a sidecary jsou
aditivní; starý pending-binding index a historie se zachovávají.

Každý ancestor receipt patří vlastní operation/attempt a committed canonical
ID/revision. Shoduje se s přesným uloženým completion attemptem; významná
receipt historie vstupuje do witness. Vlastní proměnlivý retry receipt současného
successor nevstupuje do jeho admission digestu. Regrese odmítají cizí receipt
i post-activation drift a zachovávají pravdivé rejected GET-only recovery a
not-dispatched UPDATE s prázdnou maskou. Potvrzená remote projekce se tím
nezaměňuje za tvrzení, že náš provider write byl aplikovaný.

## Zdrojové ověření

Nejmenší nový JSON `deferred-update-keeps-null-admission` byl před změnou RED
a po rozšíření skutečného kernelu GREEN. Aktuálně prošlo 386 scénářů v jedenácti
sadách, včetně 57 UPDATE a 75 DELETE scénářů. Tyto ports fixtures neprokazují
skutečnou databázi, authentication ani live provider chování.

48 causal kernel případů ověřilo original admission, scoped native URI,
conditional tag/mask, malformed proof před credentials, getters, pozdní
resolution po timeoutu, dlouhé native ID, raw metadata a odlišný no-resource
profil. Runtime typecheck včetně provider importů a 34 runner/inventory kontrol prošly.
CI nyní obsahuje všech 140 databázových sad; váhy mají provenance z úspěšného
CREATE run 40306897202, 136 naměřených sad a čtyři nové s původním fallbackem.
Všechny sady se rozdělují právě jednou a desetiminutový limit se nemění.

Reference pure corpus má 161 případů; receipt-hardened full corpus prošel
207 storage a 287 native-process případy. Po posledním lokálním zpřesnění
own-data completion helperu znovu prošlo 25 causal PG a 19 causal process
případů s 203 native metrics a 10 skutečnými SIGKILLs. Přídavný čistě paměťový
near-limit wrapper případ není důkaz end-to-end velkého tasku; dosavadní
provider/runtime/recordEvidence budgets se nemění. Getter/prototype/unknown
fields, non-enumerable data a explicit adoption:undefined se odmítají.

Po opravě původního claimu prošlo 71 skutečných PG contract případů a 83
PG/native HTTP případů, celkem 154 nových číslovaných regresí. Patří mezi ně
substituce celé původní admission před prvním prepare, změny všech tří portů
během skutečného lock wait, paired v0 historie, no-resource ambiguity, mapping
race, canonical home/revision zachování, parser floors a actual-COMMIT před
pozdním timeoutem pro UPDATE, DELETE i no-resource ACK. Vlastní pooly se zavřely,
sessions klesly na nulu a nonce DB se mazaly bez FORCE. Původních 156
číslovaných regresí a osm task/admission gates mají samostatné retained důkazy.

Workspace unit (včetně web 841/109), typecheck, lint, build, release metadata,
contracts, peers a query-runtime kontroly prošly. Po následném source review
se znovu spouštějí dotčené testy a typecheck; jejich původní zelený běh se
nezaměňuje za důkaz nově upravených řádků.

Installed image/upgrade/crash a browser evidence následují po schválení přesného
zdrojového stromu. Žádná registry publication, live-provider certifikace ani
produkční rollout tím nejsou doložené.
