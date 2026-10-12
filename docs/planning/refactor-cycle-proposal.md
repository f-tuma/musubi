# Návrh implementačních cyklů pro sync refactor

**Plánovací podklad, 12. října 2026.** Vychází z [návrhu otevřeného protokolu](../research/nylas/05-protocol-and-plan.md), [auditu Musubi](../research/nylas/04-musubi-audit.md) a zachyceného stavu projektu Its a Plan k dnešnímu dni. Sám neověřuje novější PR, nasazení ani provider účty. Konkrétní stav práce a přiřazení cyklů vede Its a Plan.

## Cíl a pořadí

Musubi zůstane první aplikací nad společným sync jádrem. Pozdější samostatná služba bude druhým hostem: propojí vybrané kalendáře a bude mít explicitní pravidla směru, návratu změn, vlastnictví kopií a konfliktů. Její produktový rozsah se nyní neimplementuje. Refactor ale musí prokázat, že engine nepotřebuje Musubi membership, Better Auth ani konkrétní databázové tabulky.

První změny mají okamžitou provozní hodnotu: společná deadline/retry politika, pokračující recovery při vypnutém pollingu, jasné pokrytí čtení a neměnný přijatý zápis. Až po těchto zárukách se přesouvá více operací na sdílený runner. Přesun souborů do nových balíčků sám není dokončením refactoru.

Tři pracovní proudy mají odlišné podmínky dokončení:

1. **Aktuální vydání a živé ověření:** zachovat otevřené CalDAV/Google, release, native, OAuth a monitoring úkoly. CI, sestavený artefakt, test na zařízení a nasazení jsou samostatné důkazy. Staré záznamy zůstanou dohledatelné.
2. **Sync refactor:** devět balíků níže tvoří kritickou cestu k samostatnému jádru. Nepřidávají automaticky nové provider schopnosti.
3. **Budoucí calendar relay:** nejprve malý druhý host jako důkaz hranice; plnohodnotný produkt a obousměrná pravidla zůstávají odložené. Push subscriptions jsou volitelné zlepšení provozu a neblokují open-source alpha ani druhého hosta.

## Úsilí a reprezentace cyklů

Na přání vlastníka mají cykly **pouze pořadí a výstupní podmínky, bez pevných dat a délky**. C01–C10 je deset postupných fází core refactoru. Pozdější relay a optional push zůstávají mimo tuto posloupnost jako nezahájený backlog. Do další fáze se přechází po splnění jejího vstupního gate, nikoli po uplynutí kalendářního intervalu.

Nativní cyklus Its a Plan vyžaduje `startDate` a `endDate`. Aby se nevymýšlela data, představují tento plán **očíslované iniciativy C01–C10** s issues a blokujícími závislostmi. V projektu se kvůli tomuto plánu nezakládají nativní cykly s daty. Devět hrubých balíků má jedenáct implementačních issues: RF05 a RF07 mají po dvou samostatně reviewable výsledcích. Každá issue patří do jedné hlavní fáze; rozdělené issues neduplikují stejnou acceptance.

Výchozí kapacitní model je jeden hlavní implementátor podporovaný agenty. V jednom okamžiku běží nejvýše dva malé kódové slices; agenti mohou připravovat fixtures, RFC, nezávislé review nebo provider rešerši. Násobení agentů se nepřevádí na stejný násobek integrační kapacity. Živé QA a provozní změny čerpají stejný lidský rozpočet.

Součet core odhadů je **45–79 člověkodnů**, přibližně střed 62 dní. Je to odhad práce, ne kalendářní příslib ani délka fáze. Odhady a pořadí zbývajících slices se přezkoumají po C03 a C05; při vyšším úsilí se nesnižuje acceptance. RF07 počítá s vybranými stávajícími rodinami a explicitně označeným zbytkem legacy host-only profilů. Inventář rodin může tento odhad rozšířit; nelze za 5–9 dní slíbit převod všech organizer/RSVP/recurrence kombinací.

Relay proof má dodatečný odhad **8–12 dní**. Volitelný push má dalších **7–14 dní**. Původní studie uváděla 45–86 dní včetně push; tento plán místo povinného push zařazuje skutečnou opravu coverage a předsouvá bezpečné envelope. PoC relay je nový, zvlášť přiznaný rozsah.

## Balíky pro tracker

Identifikátory RF01–RF09, rozdělené RF05A/B a RF07A/B, RL01–RL04 a OP01 jsou zde plánovací klíče. Založené issue má používat skutečný identifikátor Its a Plan. Detailní kroky patří do checklistu issue; není potřeba zakládat samostatný ticket pro každý field či test.

| Balík | Výsledek a odhad | Závislosti | Hlavní fáze | Důkaz dokončení |
| --- | --- | --- | --- | --- |
| RF01 | **Sjednotit delivery policy a oddělit recovery od pollingu.** 4–8 dní; R01–R04. | Nezávislé na extrakci. | C01 | Event/task pokusy respektují deadline, AbortSignal, Retry-After a omezený backoff. Timeout po dispatch zachová nejistotu. Poll=0 v deklarovaném režimu nezastaví recovery. Změřené provider calls a due lag bez osobních metrických labels; dokumentovaná kompatibilita konfigurace. Nasazený monitoring a alerty zůstávají MUSU-19. |
| RF02 | **Popsat normativní sync profil a skutečné provider capabilities.** 4–7 dní; R05, R07 a definice R06. | Audit stávajících operací; žádný runtime rewrite. | C02 | Identity, zóny/floating/DATE, původní occurrence slot, source epoch, coverage a receipts mají runtime schéma/fixtures. Matice uvádí operaci, scopes/role a conditional vs guarded-preflight vs unsupported. Čtení recurrence se nezamění za právo ji zapsat. Musubi inclusive all-day hranice má explicitní mapper. |
| RF03 | **Zabránit smazání domácího eventu při změně read window.** 4–7 dní; implementace R06. | RF02 coverage a scope; test současného chování před změnou. | C03 | Graph reset a neúplné/window čtení neodvodí proven deletion z absence. Coverage eviction zachová domácí/shared event, klientské tombstones a downstream kopie podle explicitního kontraktu. Source epoch se revaliduje uvnitř apply/checkpoint/sweep transakce. Poslední chybná stránka nedovolí sweep. Rollout má vlastní flag a regresní fixtures. |
| RF04 | **Zafixovat přijatou projekci a připravit kompatibilní operation envelope.** 4–7 dní; bezpečnostní část R11. | RF02; nelze přepočítat starý intent na novou podobu. | C03 | Nový intent uchová operation/schema/serializer/profile verze a přesně přijatou projekci. Změna serializeru po enqueue/restart nezmění zápis. Nejprve kompatibilní decoder/router, potom nový encoder. Neznámá verze provede nula HTTP mutací, zůstane bezpečně čekat a neblokuje jiné due operace. Rollback je vyzkoušený na deklarovaný kompatibilní build. |
| RF05A | **Vyjmout provider porty a zachovat Musubi authority bridge.** Společně s RF05B 7–12 dní; R08–R10. | RF02, RF03, RF04. | C04 | První adapter slice používá storage-free model a Credentials/AccountSession, HTTP, clock a evidence porty bez `@musubi/db`, Better Auth či app sessions. Host drží local CAS, lifecycle/membership locks, privacy a atomické canonical commit + outbox admission. Refresh/revoke race neoživí starý credential; exact ETag, changeKey a local revision se nesměšují. |
| RF05B | **Prokázat read/write/observe slice v samostatném hostu.** Součást společného RF05 odhadu 7–12 dní. | RF05A. | C05 | Clean CLI/test host s vlastní durable storage má parity jedné podporované osobní operace. Import graph nepotřebuje Musubi DB/ACL/session; canonical ID patří hostu. Atomická admission + immutable intent, restart, source epoch a uncertain response mají traces; memory storage je pouze test profil. Důkaz nemusí ještě používat společný runner RF06. |
| RF06 | **Převést první event slice na sdílený runner a storage port.** 6–10 dní; první část R12–R13. | RF01, RF03, RF04, RF05B. | C06 | Personal content update běží přes typed handler prepare/execute/observe a shared claim/renew/ACK. Stale worker nemůže potvrdit novou lease. Uncertain dispatch nejprve pozoruje; shadow mode neodešle druhý write. Staré persisted payloady mají parity. Jeden intent má jednoho dispatch ownera; canary a rollback zachovají receipts, ordering a authority. |
| RF07A | **Převést personal create/delete a jejich bezpečnou recovery.** Společně s RF07B 5–9 dní, po inventory reforecast; část R12–R13. | RF06 parity a rollback gate. | C07 | Stabilní create correlation a read-only recovery po lost reply nevytvoří druhý CREATE. Conditional a guarded-preflight DELETE jsou odlišné profily; nejistý Graph DELETE se znovu neodešle bez resolution intentu. Predecessor/retained delete/source epoch/stale ACK mají parity; žádné rozšíření provider sémantiky. |
| RF07B | **Převést task a vybrané specializované event operace.** Součást společného RF07 odhadu 5–9 dní; množství rodin může odhad rozšířit. | RF07A. | C08 | Task secondary echo/delete nemění home authority ani bohatší canonical data. Typed series/organizer/RSVP evidence, original slots, DAV/Graph family boundary a no-resend recovery přežijí migraci. Inventory a rollout po rodinách mají rollback; portable profily a zbývající legacy host-only profily jsou explicitní. Nepřevedená rodina není označená jako migrovaná. |
| RF08 | **Zavést férové work partition a provider budgets.** 5–9 dní; R14–R16. | RF01, RF06 a RF07B. | C09 | Work je partitioned per connection/collection/stream, kolizní family a predecessors se serializují. Jeden 429/pomalý účet nevyhladoví jiné. Dirty coalescing zachová nejnovější generaci. DAV discovery/session cache sníží calls vůči změřené baseline a nezhorší access retirement. Zachovaný singleton deployment boundary. |
| RF09 | **Připravit samostatnou conformance alpha a veřejný release kandidát.** 6–10 dní; R19–R20. | RF03, RF04, RF05B, RF07B, RF08. | C10 | Clean install reference hosta bez Musubi secrets, deterministické model/transport a DB crash traces, verze/compatibility policy a sanitizované fixtures. Supported matrix oddělí portable vs host-only a deterministic/DB/live/deployed důkazy konkrétních providerů/endpointů/serverů. Licence/provenance, bezpečnostní kontakt a maintenance rozsah jsou připravené k rozhodnutí vlastníka. Push není podmínkou. |
| OP01 | **Přidat optional Google/Graph push a durable inbox.** 7–14 dní navíc; R17–R18. | RF08 work/budgets. | Nezahájený backlog | Durable ingress před ACK, ověřené challenge/signature, duplicate/reorder/loss/expiry/renew/disconnect testy. Polling fallback a periodic reconciliation zůstávají. Scope se volí podle call/latency baseline; veřejný webhook endpoint není povinný pro self-host. |
| RL01 | **Prokázat druhého hosta na malém calendar relay PoC.** 8–12 dní navíc. | Níže uvedený graduation gate RF09; bezpečné create/delete pro vybraný provider pár. | Nezahájený backlog | Samostatný CLI/service host využije stejné jádro pro DAV→Google sandbox mirror, vlastní durable storage a credentials. Jednoduché osobní neopakované events bez attendees/RSVP. Směrovací pravidlo, owner mapping, echo baseline, target divergence a restart/reconnect nemají Musubi importy; UID není ownership. |
| RL02 | **Definovat směrovací pravidla a vlastnictví kopií.** Zpřesnit po standalone proof. | RF05B. | Nezahájený backlog | Source/destination, pole/redakce, managed vs independent copy, provenance, pause/retire/filter change/cleanup a conflict policy. Route cycles/reimport řízených kopií se odmítají; access loss, window eviction a source/target delete mají odlišné významy. |
| RL03 | **Navrhnout návrat vybraných editací z Google Calendar.** Zpřesnit po jednosměrném pilotu. | RL01, RL02. | Nezahájený backlog | Field authority a rights/validators v jednom supervised bindingu; třícestná baseline, souběžná změna vede k novému resolution intentu. Žádný obecný merge time/recurrence/organizer/attendees/deletion; delayed echo a reminders nezvrátí novější source edit. |
| RL04 | **Vymezit další relay profily a provoz samostatné služby.** Budoucí scope decision. | RL01, RL02. | Nezahájený backlog | Recurrence, busy/content meeting mirrors a daemon/API/self-host/hosted mají zvlášť vybraný scope a gates. Synthetic mirror nepřidá attendees/organizer authority či pozvánky. Credential store, retention/purge, status/resolution API a deployment boundary jsou explicitní; federation/recurring tasks mají vlastní backlog. |

Rozdělení RF03 a RF04 je úmyslné: mají vlastní bezpečnostní efekt, migrační riziko a rollback. RF05A/B dělí změnu portů od konkrétního druhého hosta; RF07A/B dělí personal create/delete od task a specialized migrace. Každá část má jiný reviewable výsledek. Ostatní kroky mají být checklisty uvnitř balíku; to udržuje backlog čitelný.

Společný RF05 odhad 7–12 dní předpokládá úzce vymezený slice a malý reference storage profil. Pokud proof objeví potřebu nové produkční storage implementace nebo plošné adapter parity, C05 znovu odhadne potřebné úsilí. RF07A/B před přepisem udělají inventory: maximální původní odhad není důkaz, že všechny specialized rodiny lze za tento čas přenést.

## Pořadí fází bez dat

Fáze se nevyplňují duplicitními implementačními úkoly. C05 dokončuje samostatný host nad porty z C04; C07 převádí jiné operace než první content update z C06. Každá má vlastní implementační issue a acceptance. Na hranici fáze se neodkládá bezpečnost do nesouvisející pozdější práce.

| Fáze | Výsledek a podmínka přechodu |
| --- | --- |
| C01 · Delivery recovery a provozní baseline | RF01. Event/task cancellation, throttle a restart mají společnou policy a naměřenou baseline. V samostatné live QA lane vybrat nejbližší otevřené ověření ze stávajících MUSU-4/5/6, 11–21 podle dostupných účtů/zařízení; nezačínat všechny současně. |
| C02 · Sync profil a provider capabilities | RF02. Normativní coverage, identity, time, receipts a host authority. Gate: conditional, guarded-preflight a unsupported mají explicitní odlišné významy. |
| C03 · Coverage a neměnný přijatý zápis | RF03 a RF04. Graph absence v okně nevytváří neoprávněný globální delete; serializer změněný po enqueue nemění přijatou projekci. Unknown envelope nic nezapíše a kompatibilní rollback je prokázaný. Oba balíky blokují C04. |
| C04 · Provider porty a Musubi bridge | RF05A. Storage-free model, Credentials/AccountSession, HTTP, clock a evidence porty; Musubi authority bridge zachová současné lokální záruky. |
| C05 · Samostatný host a extrakční důkaz | RF05B. CLI/test host s durable storage a parity read/write/observe jedné podporované operace. Import graph bez Musubi DB/auth; přezkoumat hranice a zbývající odhady. |
| C06 · Společný runner a lease fencing | RF06. Personal content update přes typed handler a claim/renew/ACK. Old pending payloads, uncertain dispatch, lease loss, stale ACK, source retirement a rollback mají důkazy; jeden intent má jednoho dispatch ownera. |
| C07 · Create a delete recovery | RF07A. Podporované personal create/delete a jejich konkrétní recovery důkazy. Lost reply nevytvoří duplicitu, guarded Graph DELETE se nereplayuje naslepo. |
| C08 · Tasks a specializované event operace | RF07B. Zachovat současné operation/capability profily, scheduling evidence, original slots a task home authority. Canary rollout po vybraných rodinách s rollbackem; zbylé host-only profily zůstávají přiznané. |
| C09 · Férové plánování a provider budgets | RF08. Scheduler/session slice a fairness experiment; jeden zpomalený účet neblokuje jiné, dirty generation ani access retirement se neztratí. |
| C10 · Conformance a samostatná sync alpha | RF09. Clean install, crash traces, deklarovaná kompatibilita, supported matrix a veřejný release kandidát. Technický gate pro dalšího hosta; samotné veřejné zveřejnění/licence je rozhodnutí vlastníka. |

Pokud RF05 odhalí neabstrahovanou authority nebo storage transakci, doplní se potřebný slice do kritické cesty. Relay zůstane podmíněný a není zdůvodněním vynechání parity. Volitelný push se vybere při plánování po RF08 podle měření a přání vlastníka.

## Graduation gate pro standalone host

Druhý host může začít používat engine, až když je současně splněno:

- Veřejný model, adapter a runtime importují pouze porty a společná schémata. ACL, home authority, canonical reconciliation, memberships a federation zůstávají zodpovědností hosta.
- Host umí pod deklarovanou atomickou hranicí přijmout svoji revizi a durable intent. Memory storage je pouze test profil; reference service má ověřený durable storage a recovery.
- Connection/collection scope, source epoch, complete inventory vs window a access retirement mají conformance vektory. Absence v okně se nezaměňuje za proven deletion.
- Accepted projection je neměnná a verzovaná; old/unknown envelope, uncertain dispatch, stale ACK a rollback mají deterministické crash traces.
- Pro vybraný provider pár jsou create correlation a conditional/guarded write profily prokázané konkrétními testy. Pro PoC se zvolí jen podporované operace; nejisté create se automaticky nereplayuje.
- Evidence/receipts mohou vysvětlit local committed, provider accepted, remote confirmed a unknown notification bez přenosu Musubi cookies, tokenů či privátního sidecar do veřejného kontraktu.

Veřejná licence není technickým předpokladem interního PoC. Může být současně dokončená jako část alpha kandidáta. Interní proof nesmí v dokumentaci předstírat zveřejněný ani certified projekt.

## Kontrakt budoucího relay produktu

Relay bude mít vlastní authority profil. Provider connection, zdrojový objekt a řízená cílová kopie jsou odlišné identity. Musubi canonical ID a memberships nejsou povinnou součástí takového hosta.

Pravidlo musí určit zdroj a cíl, směr toku, synchronizovaná pole a redakci, vlastnictví cílové kopie, politiku cílových změn, smazání a konfliktu. „A↔B“ samo nestačí: dvojice jednosměrných pravidel bez provenance by vytvořila smyčku a mohlo by přepisovat originál svou vlastní ztrátovou kopií. Návrat změn bude explicitní profil pro konkrétní pole a prokazatelná práva.

První PoC je **jednosměrný DAV→Google mirror vlastních osobních neopakovaných eventů**, bez produktu UI a bez automatického write-back. Vybere se testovací DAV server a izolované Google kalendáře. Read time model a all-day mapping se ověří na jednoduchých events bez attendees; recurrence, organizer/attendee, scheduling a RSVP se tím automaticky neaktivují. Pokud testovací credentials nejsou dostupné, lze dokončit deterministický PoC a uvést live gate jako neověřený, nikoli tvrdit provider acceptance.

PoC má prokázat tyto situace:

- Změna původního eventu aktualizuje právě jednu řízenou kopii. Echo cílových defaults nevytvoří nový origin ani další kopii.
- Timeout po create a restart/reconnect nezaloží druhou cílovou kopii.
- Přesun originálu mimo sync window zachová řízenou kopii podle coverage kontraktu; absence sama neopravňuje její zrušení.
- Prokázané smazání originálu může odstranit jeho vlastní řízenou kopii podle pravidla; neprovádí scheduling/RSVP ani smazání cizí schůzky.
- Edit nebo delete cílové kopie se zobrazí jako explicitní konflikt či odchylka podle pravidla. Nepřepíše původní kalendář ani se svévolně obnoví bez deklarované policy.
- Odpojení jedné connection nezruší nesouvisející routes, při návratu nepoužije starou epoch a neobnoví odvolaná práva.

Full relay backlog bude obsahovat produktovou konfiguraci, bezobsahový busy mirror vs content mirror, opt-in write-back, dvoucestné konflikty a route graph, audit/receipts, lifecycle/cleanup, bezpečnost credentials a provozní nasazení. Tyto práce zatím nemají calendar závazek. Profil zdroje pravdy, notification policy a podpora edit-back jsou před implementací konkrétních režimů zásadní produktová rozhodnutí.

## Úprava stávajícího trackeru

Stávající hotové MUSU-1 a MUSU-7–10 zůstanou hotové. Otevřené živé/provider/device/provozní důkazy se nezruší proto, že nový plán má jinou architekturu. MUSU-3, MUSU-13 a MUSU-15 mají dlouhou historii přípravy a vydání: jejich aktivní popis lze zkrátit na konkrétní zbývající acceptance, historii ponechat v dohledatelném záznamu.

Budoucí recurrence tasks, federace, durable activity notifications, sidebar kalendáře, To Do CAS a další provider activation zůstanou backlog. Nejsou dependency refactoru. Uživatelské notifications MUSU-25 jsou jiný problém než provider push inbox OP01.

Staré iniciativy mohou zůstat jako release/živé QA proud. Očíslované iniciativy C01–C10 reprezentují core refactor podle tabulky; RL01–RL04 jsou v samostatném budoucím relay backlogu a OP01 v odloženém rozvoji. Přidají se blokující závislosti podle tabulky, ale pouze dostupné bezprostřední slices se povýší do Todo. Zařazení do fáze neznamená, že práce běží. Nativní cykly a pevná data se nepřidávají.

Při každém cyklu se zapisuje konkrétní evidence: který commit/profile prošel automatickou conformance, zda proběhl live test a na jakém izolovaném provideru, jaký rollout skutečně proběhl a které neověřené capability zůstávají vypnuté. Společný engine je hotový tehdy, když je toto chování udržitelné i po restartu a upgradu.
