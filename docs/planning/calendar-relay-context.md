# Vedlejší služba pro propojení kalendářů: kontext refaktoru

**Datum: 12. října 2026. Stav: návrh architektury a pozdější iniciativy.** Služba se v tomto refaktoru neimplementuje. Její potřeby slouží k ověření, že otevřené sync jádro opravdu není závislé na produktu Musubi. Názvy typů a modulů v tomto dokumentu jsou pracovní návrhy.

Uživatel chce v budoucnu samostatný uzel, který propojí kalendáře různých providerů. Uživatel může zůstat v Google Calendar a vidět tam obsah z jiných systémů; uzel určuje, co teče odkud kam a která úprava může téct zpět. Nepotřebuje další kalendářový editor, sociální model, stránky ani Musubi federaci. Potřebuje trvalý záznam propojení, pravidla přenosu a obnovu po nejistém zápisu.

## 1. Dopad na současný refaktor

Základ je společný: scoped identity, přesný časový model, coverage čtení, capability profil, credential/HTTP porty, neměnné operace, recovery a provider adaptéry. Autorita a politika synchronizace patří hostitelské aplikaci. Musubi host vlastní domácí události a oprávnění; relay host vlastní směrování, mapování kopií a přijaté změny mezi externími kalendáři.

Stávající [návrh otevřeného kontraktu](../research/nylas/05-protocol-and-plan.md) toto rozdělení umožňuje. Pro přijetí extrakce požadujeme jeden samostatný host bez `@musubi/db`, Better Auth session, Musubi memberships, SSE a UI. Zpočátku stačí testovací host s deterministickou sítí a úzkou provider operací. Produkční relay není podmínka dokončení refaktoru ani vydání první knihovny.

| Vrstva | Musubi host | Budoucí relay host |
| --- | --- | --- |
| Autorita | Domácí revize, origin calendar, lidské editace, ACL a členství | Pravidla konkrétní route a oprávnění připojených účtů |
| Přijetí změny | Atomicky lokální revize a outbound intent | Atomicky route/binding revize, baseline a outbound intent |
| Čtení | Provider observations mění domácí stav podle Musubi pravidel | Provider observations jsou důkazy pro propagaci po route |
| Uživatelský produkt | Editor, sdílení, task authority, federace | Připojení účtů, směrování, status a řešení konfliktů |
| Trvalý storage | Musubi Drizzle/PostgreSQL bridge | Vlastní ledger za stejnými runtime porty |
| Sdílená implementace | Provider operace a delivery runtime | Tytéž operace a runtime, vlastní reconciliation |

Relay potřebuje interní logickou identitu a přijatý stav, ale tento stav není nová veřejná domácí schůzka v Musubi. Název `canonicalObjectId` nesmí v kontraktu automaticky znamenat Musubi `events.id`, lokálního uživatele nebo origin server federace. Host rozhoduje, zda je kanonický stav autoritativní domácí objekt, nebo interní záznam pro přenos externího objektu.

## 2. Tři produkty, které nesmíme směšovat

| Režim | Vznik cíle | Co znamená editace v cíli | Co znamená smazání v cíli |
| --- | --- | --- | --- |
| Spravovaná projekce A → B | Relay vytvoří a nadále spravuje B podle A | Konflikt, nebo přepsání až podle výslovně zvolené politiky; žádný implicitní zápis do A | Cíl se odpojí, pozastaví, nebo obnoví podle zvolené politiky; nemaže A |
| Jednorázová nezávislá kopie | Jedna operace vytvoří nový samostatný objekt B | Editace už není věcí relay | Nemaže A a kopie se sama neobnovuje |
| Spravované propojení s návratem | Relay spravuje A/B jako jeden binding s rozdělenou autoritou polí | Pouze schválený patch z B může jít do A; konflikt potřebuje resolution | Samostatné pravidlo delete authority; nejde odvodit z povolené editace názvu |

První relay profil doporučujeme jako **spravovanou jednosměrnou projekci osobních událostí**. Jednorázová kopie může být další profil. Návrat není jen zapnutí druhé route B → A: dvě nezávislé auto-copy routes by vytvářely kopie kopií, soutěžily o pole a nerozlišovaly smazání zdroje od odstranění cílové projekce.

Pro uživatele, kteří chtějí Google Calendar jako editor, je návrat legitimní další krok. Vyžaduje vlastní model autority. Současná implementace Musubi [odmítá změny linked event kopie mimo origin calendar](../../packages/db/src/queries/external.ts) a má pro to dobrý důvod. Změna tohoto pravidla v Musubi by byla samostatná produktová změna s dopadem na ACL a sdílení. Relay nesmí vynutit její přijetí jako vedlejší efekt extrakce.

## 3. Route a binding místo obecného přepínače „sync both ways“

Route je verzované pravidlo mezi dvěma scoped kolekcemi. Potřebuje alespoň:

- `routeId`, owner/tenant scope a generaci lifecycle;
- source a destination jako connection + collection, nikoli pouze email nebo název kalendáře;
- režim přenosu, filtr událostí, časové coverage a explicitní transformaci obsahu;
- povolená pole a profil jejich autority;
- pravidlo source deletion, destination deletion a destination divergence;
- stav `active`, `paused`, `needs-reconnect` nebo `retired`, s konkrétním důvodem;
- verzi pravidel a serializer/projection profilu pro každý admitted intent.

Binding je jedno konkrétní propojení zdrojového objektu a relay vytvořeného cíle. Zachovává původní root identity, source a destination locator, důkaz vlastnictví cíle, baseline obou stran, generation a history přijatých operací. I po smazání cíle může potřebovat retained tombstone, aby další pull nevytvořil novou zdánlivou identitu.

Pro obousměrný profil se definuje matice autority. Například A drží čas a recurrence, Google B smí vracet název a místo, osobní reminders zůstávají na B. Jde o ilustraci, ne doporučený univerzální default. Zápis více souvisejících časových polí má být jedna sémantická změna, nikoli nezávislý merge `start` a `end`. Organizer, attendees, RSVP, recurrence a deletion nemají obecný deep-merge profil.

Rozhodování používá tři hodnoty: poslední potvrzenou baseline, právě pozorovaný source a právě pozorovaný destination. Patch z B se připraví pouze pro povolená pole a proti potvrzené baseline A; remote validator se ověří podle capability dané operace. Souběžná změna stejného pole nebo nejistý predecessor vede ke konfliktu či blokaci. Provider časové razítko neuděluje automaticky právo vyhrát nad druhou stranou.

Čistý relay také potřebuje způsob, jak konflikt řešit: minimálně stav přes API/CLI s čerstvými verzemi a explicitní novou resolution operací. Kompletní kalendářové UI není nutné.

## 4. Provenance, vznik cíle a adopce

Stejný iCal UID, název, čas nebo organizer nedokazuje, že dva objekty jsou spravované kopie. Uživatel už může mít vlastní událost, původní pozvánku nebo druhou skutečnou schůzku se stejnými atributy. Unikátnost a privacy boundary musí zůstat scoped na tenant, connection a collection. [Současné mapování Musubi](../../packages/db/src/schema.ts) je scoped na lokální mirror a nedělá globální cross-account UID join.

Výchozí relay pravidlo: spravovat jen cíle vytvořené relay s uloženým důkazem, nebo cíle výslovně adoptované uživatelem. Původní událost v A, existující událost B a relay vytvořená kopie B jsou tři různá vlastnická postavení.

Create má stabilní operation identity, uložený plán a checkpoint před dispatch. Po úspěchu se uloží nový provider locator. Po ztracené odpovědi lze cíl adoptovat jako výsledek **této vlastní create operace** jen podle jejího scoped operation markeru, provider idempotency identity nebo jiného zdokumentovaného důkazu; prostá shoda obsahu nestačí. Dokud výsledek zůstává nejistý, nevzniká druhý create.

Adopce cizí existující události je jiná operace: výslovně vybere locator, ověří oprávnění a zaznamená, která pole a případné smazání relay od té chvíle smí spravovat. Chybějící důkaz původu vede k omezenému profilu či nepodporované operaci. Create recovery není povolení převzít vlastnictví uživatelovy původní události.

Provider sidecar nebo private metadata mohou pomoci s dohledáním vlastní create a provenance. Nemají být jediná obrana proti loopům: mohou zmizet při exportu/importu, provider je nemusí zachovat a nemají se považovat za oprávnění k mutation bez scope a lokálního ledgeru.

## 5. Žádné smyčky a žádný „poslední timestamp vyhrává“

Každý binding drží původní root identity, route lineage a verzi naposledy přijaté projekce pro konkrétní destination. Pull vlastního výsledku potvrzuje operaci; nevytváří nový root ani nový edit. Normalizované porovnání obsahuje jen skutečně přenášená pole. Provider defaults, lokální reminders a lossy změna HTML nejsou bez další policy změnou source.

První profil má navíc jednoduchou strukturální obranu: relay vytvořené cíle jsou z importu dalších routes vyloučené. Graf povolených native-source routes je acyklický a source=destination se odmítá. Pokud později chceme řízený multi-hop A → B → C, dědí root a lineage; route nikdy nesmí přenést objekt zpět do již navštívené kolekce a destinace stejného root se nesmí znovu vytvořit. Návrat editace v jednom bindingu se řeší jeho field-authority pravidlem, nikoli druhým auto-copy průchodem grafu.

Hash baseline urychlí porovnání; nenahrazuje locator, důkaz práv, route generation ani variantu serializeru. Delayed echo starší operace nesmí přepsat novější admitted edit. Nevyřešený create/update predecessor blokuje další mutation stejného cíle nebo resource family.

## 6. Smazání, odpojení a změna pravidel

| Situace | Požadovaný výsledek |
| --- | --- |
| Source chybí v neúplné stránce nebo mimo nově posunuté časové okno | Coverage eviction či neznámý stav; žádný destination DELETE |
| Explicitní source deletion | Použít předem zvolenou delete policy pouze na prokazatelně relay-owned cíl |
| Uživatel smaže destination projekci | Zaznamenat suppression/pause nebo předem zvolenou obnovu; nesmazat origin implicitně |
| Uživatel odpojí source účet | Fenced retirement zastaví nové writes; neznamená to remote deletion všech cílů |
| Uživatel odpojí destination účet | Zastavit writes i queued admission pro starou generaci; žádná automatická reconnect resurrection |
| Uživatel změní filtr či route | Explicitně rozhodnout ponechat, odpojit či uklidit vlastní cíle; žádný sweep z nové neúplné množiny |
| Uživatel vypne route | Pozastavit další dispatch; už odeslané nejisté operace zůstávají evidované |
| Zápis byl odeslán těsně před revocation | Pozdní odpověď nesmí oživit route; ledger pravdivě uvádí možný remote účinek |

Odvolání přístupu nemůže vrátit už dokončený remote write a fyzicky neodvolá síťový request, který provider již přijal. Proto je potřeba rozlišit lokální retirement od skutečně potvrzeného vzdáleného odstranění. Pokud credentials zaniknou a recovery čtení už není možné, stav může zůstat unknown. „Odpojeno“ není důkaz „všechny vytvořené kopie smazány“.

Cleanup má být vlastní plán s potvrzením rozsahu, vlastnickým důkazem, čerstvou destination verzí a podporovaným delete profilem. Nesmí odstranit původní události uživatele ani použít cancellation schůzky jako univerzální kompenzaci. Stávající Graph guarded-preflight DELETE je podle [auditu](../research/nylas/04-musubi-audit.md) profil s přiznaným závodem; nemáme jej vydávat za atomický conditional DELETE. Způsobilost pro automatický relay cleanup se posoudí zvlášť.

## 7. Pozvánky nejsou kopie obsahu

První relay profil zahrnuje osobní události bez attendees a organizer scheduling. Pozvánka má role, autoritu organizátora, native participant copies, změny RSVP a vedlejší účinky; její prostá kopie do druhého kalendáře může vytvořit novou schůzku nebo znovu odeslat email. Relay nemá ze svého Google účtu automaticky vystupovat jako původní organizer.

Pozdější profil může přenášet schůzku jako výslovně označený osobní nebo busy blok bez attendees, bez scheduling authority a bez RSVP návratu. Exportovaná metadata a native notification suppression potřebují potvrzenou provider sémantiku a live test. Samotný `sendUpdates=none` nenahrazuje návrh meeting identity, role a vlastnického scope. Přímé sdílení native pozvánek a odpovědí má vlastní iniciativu; nezapíná se s content sync.

Každá operace musí deklarovat povolené side effects. Po timeoutu za dispatch následuje read-only recovery; zjištěná nejasnost neopravňuje opakovat create, cancellation nebo RSVP. Content ACK a notification outcome jsou oddělené výsledky. Pokud email nelze ověřit, receipt uvádí unknown.

## 8. Minimální ledger je součást funkce relay

„Čistě propojovací uzel“ neznamená bezstavový HTTP proxy. Bez historie nelze odlišit destination edit, echo vlastní projekce, smazanou kopii ani ztracenou create odpověď. Minimální trvalý ledger obsahuje:

- connection/collection scope a epochs, credential references a aktuální access evidence;
- route konfiguraci, verzi a lifecycle;
- binding původu, source/destination locators, důkaz vlastnictví a retained tombstones;
- source/destination baselines pouze přenášených polí a jejich serializer/profile verze;
- cursors a coverage, podle kterých se smí rozhodnout o absenci;
- neměnné accepted operations, predecessors, leases, dispatch proof a receipts;
- omezenou retained evidence pro konflikty a uncertain recovery.

Běžně není nutná plná kopie všech kalendářových detailů ani Musubi event/membership schema. U nejistých operací a konfliktů však ledger dočasně drží payload nutný k vysvětlení a bezpečné obnově. Retence, redakce po odebrání práv a purge při odstranění účtu jsou vlastnosti hosta; secrets nejsou součást operation payloadů. Zajištění transakce baseline/admission a outboxu není volitelné, pokud host deklaruje durable profile.

## 9. Graduation gates a pořadí

| Gate | Předmět | Důkaz dokončení |
| --- | --- | --- |
| G0: kontext a kontrakt | Provider transport oddělit od Musubi authority; zdokumentovat relay potřeby | Tento návrh, dependency rules a host-independent identity/receipt profil |
| G1: extrakční proof | Jeden read/write/observe slice v samostatném test hostu | Žádný import Musubi DB/session; stejné relevantní recovery traces jako Musubi |
| G2: bezpečný sdílený runtime | Versioned immutable operations, storage porty, deadline/retry a fenced ACK | Crash/lease/serializer/retirement conformance; Musubi parity |
| G3: relay model | Route/binding/authority/provenance design bez produkčního nasazení | Deterministická simulace forward sync, destination divergence, deletion a loops |
| G4: privátní relay pilot | Osobní jednotlivé události, jeden směr, dvě konkrétní provider varianty | Isolované live round-tripy a jasná matice nepodporovaných operací; pause/cleanup/reconnect fungují |
| G5: návrat a rozšíření | Vybraná návratová pole, recurrence a další providers postupně | Třícestné konflikty, native capabilities a rodiny ověřené pro každé rozšíření |

Současný refaktor plní G0–G2. G3–G5 jsou pozdější iniciativa bez pevného slibu data. G1 využije testovací/reference host z otevřeného plánu; nový produkční daemon, UI, billing ani veřejný relay SaaS nejsou potřeba. Po G2 lze samostatně rozhodnout, zda má relay nejdříve CLI/self-host host, nebo službu. Přidávání nových balíčků se řídí skutečnou dependency boundary, nikoli počtem řádků.

## 10. Acceptance cesty pro pozdější relay

| Scénář | Očekávaný invariant |
| --- | --- |
| CalDAV osobní událost → Google | Jedna prokazatelně relay-owned projekce; all-day a zoned čas zachovají význam |
| Google echo po forward create/update | Potvrdí baseline; nevytvoří další objekt ani zpětnou operaci |
| Timeout create po provider success | Recovery adoptuje výsledek vlastního operation ID; žádný blind druhý create |
| Před importem existuje podobná událost v Google | Relay ji nespojí ani nepřevezme podle UID/názvu/času |
| Dva účty sdílí stejný veřejný calendar locator | Jejich bindings a rozhodnutí zůstávají v odděleném tenant/connection scope |
| Uživatel upraví jednosměrnou Google projekci | Viditelný konflikt nebo předem zvolená divergence policy; žádný tichý edit source |
| Povolený návrat title/location z Google | Patch pouze povolených polí proti potvrzené baseline a čerstvému validatoru |
| Obě strany změní stejné povolené pole | Konflikt, čerstvá explicitní resolution; žádný timestamp-wins full overwrite |
| A → B a návrh B → A | Independent auto-copy cycle odmítnut; return path používá jeden binding |
| A → B → C, delayed echo z B | Stejný root/lineage; žádný další root ani návrat do A |
| Window reset nebo chyba poslední stránky | Žádný destination delete z absence a žádná nová root identita |
| Source native delete vs destination manual delete | Každý používá vlastní deklarovanou delete policy; origin se nesmaže omylem |
| Odpojení během dispatch a pozdní HTTP reply | Retirement generation se zachová; receipt uvádí nejistý remote účinek |
| Upgrade serializeru s pending operací | Stejná admitted projekce, případně explicitní block; žádná změna přijatého záměru |
| Schůzka s attendees přijde do prvního relay profilu | Explicitně unsupported; žádná nová pozvánka ani RSVP |
| Pozdější synthetic meeting/busy profil | Žádní nově pozvaní účastníci; role nepřechází na relay a native notification výsledek je pravdivý |
| Recurring master s přesunutou výjimkou a DST | Gate rozšíření se otevře až po správném original-slot a family round-trip |

Deterministické testy dokazují lifecycle a policy. Storage integrační testy dokazují atomické admission a fencing. Živé testy v izolovaných provider kalendářích dokazují skutečnou idempotenci, notification sémantiku, concurrency profil a normalizaci. Jedna úroveň nenahrazuje druhou.

## 11. Doporučené změny backlogu

1. Rozšířit identity/coverage RFC o **host authority boundary**: kanonická identita je hostitelská a nemusí být Musubi event; transport neprovádí obecný merge ani nepřiděluje origin autoritu.
2. U extrakčního proof přidat acceptance **samostatný relay-like test host bez Musubi DB/ACL/session**; stále jde o jeden úzký slice, ne nový produkt.
3. U operation envelope doplnit **route/source generation, přijatý projection profil a allowed side effects** tak, aby změna konfigurace neměnila staré queued operace a late reply neobnovila odpojený route.
4. U coverage oprav výslovně testovat **window eviction nepropaguje destination delete**. Pro relay je to ochrana přímo cizích provider kalendářů, nikoli jen lokálního pohledu.
5. U conformance přidat **owned create adoption, cílové echo, cross-account scope a suppression tombstone**; stejné primitivy pomáhají Musubi a budoucímu relay.
6. Založit odloženou iniciativu **Calendar Relay: návrh routes a binding authority** s G3 acceptance; žádné produkční implementace v prvních refactor cyklech.
7. V relay iniciativě oddělit **jednosměrný personal-event pilot** a **povolený návrat editací**. První má úzkou provider matici, druhý vlastní třícestnou baseline a resolution.
8. Nechat **recurrence, synthetic meeting mirrors, native RSVP/organizer relaying a veřejný SaaS provoz** jako oddělené odložené scope s konkrétními graduation gates, nikoli jako podmínku veřejného sync core.

Tento dokument nemění produkční kód ani současná Musubi origin/linked-copy pravidla. Jeho konkrétní přínos pro nynější plán je ověřit použitelnou hranici otevřeného jádra a ponechat budoucímu relay vlastní autoritu a produktový rozsah.
