# Závěry studie: co převzít a jak zmenšit Musubi sync

**12. října 2026.** Nylas je pro Musubi velmi relevantní reference. Největší přínos má jeho veřejné rozdělení connections, objektů, operací a integračního provozu. **Nedoporučujeme přepsat Musubi podle nejmenšího společného modelu Nylasu. Doporučujeme zjednodušit moduly a runtime a naše přesnější záruky popsat jako otevřený, testovatelný kontrakt.**

Tato kapitola je rozhodovací syntéza. Doložené Nylas detaily obsahují [kalendářová studie](./02-calendar-normalization.md) a [sync/auth studie](./03-sync-auth-operations.md), konkrétní důkazy Musubi [audit kódu](./04-musubi-audit.md). Nové API a balíčky v [RFC a plánu](./05-protocol-and-plan.md) jsou návrhy. Přítomnost kódu, passing test a aktivace funkce v produkci jsou tři různé důkazy.

## 1. Hlavní rozdíl zadání

Nylas zpřístupňuje externí účet přes jednotné API. V aktuální v3 u Google a Microsoft popisuje přímý provider přístup; historická v2 používala jiný způsob replikace. Nelze vzít otevřený historický sync-engine a označit ho za zdrojový kód dnešního backendu. [Uvedení v3](https://www.nylas.com/blog/introducing-nylas-apiv3/), [historický repozitář](https://github.com/nylas/sync-engine)

Musubi navíc drží domácí kanonická data, více memberships a provider projekce, lidské local revisions, privátní observations, sdílené task authority a durable delivery. To je jiná práce než sjednotit GET/POST. Naše „uloženo lokálně“ musí přežít pád i tehdy, když vzdálené doručení nešlo potvrdit.

Příklad: uživatel přejmenuje schůzku a API commitne revizi 17. Provider přijme update, ale odpověď se ztratí. Mezitím uživatel v Outlooku upraví místo a Musubi přijme lokální revizi 18. Jednoduché retry celé revize 17 může přepsat novější obsah nebo znovu poslat pozvánku. Durable operation potřebuje neměnný plán, preconditions, predecessor a observation recovery. Jednotný event JSON tuto situaci neřeší sám.

Proto se studii nedaří „zjistit, že půlku Musubi můžeme vyhodit“. Naopak potvrzuje hodnotu jádra a ukazuje, kde je jeho implementace příliš provázaná. Přesnější cíl je **méně opakované orchestrace, více explicitních kontraktů**.

## 2. Co Nylas opravdu normalizuje

Společné endpointy a response shape výrazně zjednodušují integraci. Providerové rozdíly ale dál existují v IDs, recurrence, cancellation, query filtrech, reminders a notifications. Nylas to v technických průvodcích sám připouští. iCloud konektor není obecný server-to-server CalDAV adaptér a generic IMAP není kalendářový protokol. [Cross-provider sync](https://developer.nylas.com/docs/cookbook/calendar/cross-provider-calendar-sync/), [Events reference](https://developer.nylas.com/docs/reference/api/events/get-all-events/)

Marketingový počet providerů tudíž nelze převést na počet bezeztrátově podporovaných kalendářových sémantik. U každého objektu se ptejme na operaci, práva, časový model, recurring family a concurrency guarantee. „Podporuje Microsoft“ je užitečné produktové označení, ale nedostatečná specifikace zápisu výjimky série se souběžně změněným organizátorem.

V otevřeném protokolu navrhujeme tři různé výsledky: faithful read; faithful write pro konkrétní profil; readable but unsupported for write. Nemusíme ztratit informaci při importu jen proto, že ji neumíme bezpečně exportovat. Jednotnost by měla spočívat v předvídatelném výsledku, nikoli v předstírání identických schopností.

## 3. Kterou složitost zachovat

| Vlastnost Musubi | Proč existuje | Doporučení |
| --- | --- | --- |
| Local ID / provider locator / UID | Kopie schůzky a práva jsou scoped | Zachovat, zlepšit typové oddělení |
| Original occurrence start | Přesunutá výjimka musí potlačit původní slot | Zachovat jako doménovou identitu |
| Zoned/floating/all-day/legacy model | UTC instant neurčuje civilní význam recurrence | Zachovat; přesný transportní profil |
| Resource family u DAV a Graph | Verze a write scope nemusí být jeden event row | Zachovat jako samostatnou boundary |
| Local CAS a immutable intent | Novější edit nesmí být přepsán starým retry | Zachovat; verzovat operation envelope |
| Durable outbox a predecessor | Pád po local commit nesmí ztratit přijatý záměr | Zachovat; společný runner |
| Dispatch proof a uncertain state | Timeout nemusí znamenat žádný write | Zachovat; read-only recovery |
| Provider validator | Read-before-write neřeší souběžný remote edit | Zachovat přesný typ a důkaz podpory |
| Source/privacy generation | Pozdní HTTP odpověď nesmí vrátit odebraná data | Zachovat; obecnější pojmenování |
| Projection baseline u tasks | Lossy secondary copy nesmí smazat domácí obsah | Zachovat; samostatný task authority profil |
| Completeness před sweep | Absence v neúplném čtení není deletion | Zachovat; strojově čitelná coverage |
| Samostatný notification outcome | Uložená schůzka není doručený email | Zachovat v receipts |

To nejsou hypotetické požadavky navíc. Jsou to ověřené hranice našeho kódu a existujících kontraktů. Zdrojové odkazy s řádky jsou v [auditu](./04-musubi-audit.md). Nemusí být všechny součástí minimálního gateway profilu; musí být součástí synchronizované Musubi varianty.

## 4. Co je u nás skutečný dluh

**Databázové typy v adaptéru.** CalendarAdapter importuje @musubi/db a nese řadu provider-specific kontextů. To brání samostatnému použití. Vyjmout transportní evidence a accepted operation model; lokální query context bude převádět Musubi bridge. Začít jedním slice a ověřit, že ho lze spustit bez naší DB.

**Rozptýlený delivery lifecycle.** Event a task executor mají odlišnou deadline a retry politiku. Event používá AbortController, celkový deadline, Retry-After a backoff s jitter. Task má pevné retry a chybí obdobný celkový deadline. To je konkrétní prostor pro zlepšení chování, nejen pro kosmetickou refaktorizaci.

**Operation payload přes optional fields a měnitelná projekce.** Mnoho specialized operací je rozpoznáno podle přítomnosti volitelných properties. Generic event executor navíc projekci znovu počítá aktuálním serializerem. Discriminated envelope potřebuje také serializer/profile version a neměnnou admitted projection. Staré persisted operace vyžadují decoder; přepsat TypeScript union bez migrace nestačí.

**Coverage a delete profily potřebují explicitní hranice.** Graph reset dnes může zmizení z importního okna proměnit v domácí tombstone a další delete intenty; to samo nedokládá provedený foreign DELETE. Rozlišení coverage eviction versus skutečného smazání je funkční změna s vlastní acceptance. U Graph DELETE je současný guarded preflight s přijatým závodem jiný profil než conditional CAS. Oba nové nálezy dokládá [audit](./04-musubi-audit.md).

**Background recovery sdílí vypínač s pollingem.** Interval 0 dnes zastaví i plánované recovery durable writes. To je správně zdokumentované, ale provozně svazuje dvě odlišné věci. Oddělit je a zachovat výslovnou kompatibilitu konfigurace.

**Uniformní sekvenční scheduling a opakovaná DAV discovery.** Audit našel možnost account/session contextu a bounded concurrency. Zavést per-account budgets a kolizní domény. Pouhé Promise.all přes všechny kolekce by ignorovalo provider limity i family pořadí.

**Nejednotné pull error struktury.** Status někdy zůstává v textu a classifier jej interpretuje regexem. Sdílená error taxonomy má vracet phase, status, retryAfter, certainty a next action. K rozhodnutí bezpečného retry ale stále potřebuje specializovaný operation handler.

**Calendar lifecycle zůstává provider-first.** Event/task durability neřeší automaticky create/rename/delete kalendáře. Po provider úspěchu může selhat lokální DB. Je to relevantní další práce, ale přidávat ji do první extrakce by zvětšilo scope. Do veřejné matice vyznačit odlišný profil; následně navrhnout vlastní lifecycle journal.

## 5. Čemu se učit z dalších řešení

| Reference | Nejlepší inspirace pro nás | Hranice |
| --- | --- | --- |
| Nylas v3 | Přehledné API a integrace, auth pojmy, provozní metadata | Veřejný CRUD není důkaz Musubi consistency |
| Nylas historický engine | Durable action log a downstream delta feed | Historická architektura a méně přesná nejistota |
| Cronofy | App-controlled managed ID, per-event actions, coverage repair | Upsert identity není expected-version CAS |
| Aurinko | Delta sync jako jednotný veřejný kontrakt | Updated/deleted stream boundary vyžaduje ověření |
| Nango | Typované checkpoints, runtime porty, partitions | Doménová kalendářová policy zůstává na implementátorovi |
| vdirsyncer | Persistovaná baseline a explicitní konflikty | Dvojice stores je užší zadání než Musubi |
| DAVx⁵ | DAV compatibility, resource validators a preservation | Server-wins policy není naším accepted intent profilem |
| Etebase | Revision, cursor, removed access a transaction preconditions | E2EE native sync neřeší plaintext externích providerů |
| JSCalendar | Referenční JSON sémantika Event/Task/recurrence | Datový standard není delivery runtime |

Důkazy: [alternativní architektury](./06-alternative-architectures.md), [Cronofy](./07-cronofy-reference.md), [otevřené projekty](./08-open-source-references.md), [SDK a standardy](./09-sdk-and-adjacent-models.md). Tabulka porovnává přístupy, ne měřenou kvalitu nebo bezpečnost služeb.

Cronofy je obzvlášť užitečné tím, že přiznává sync okno a potřebu periodického doplnění i bez webhooku. Nango zase zřetelně odděluje auth, sync a action. vdirsyncer připomíná, že bez historie nelze rozhodnout, zda nepřítomná položka vznikla na druhé straně nebo byla odstraněna. Etebase poskytuje jinou perspektivu na native protokol a ztrátu členství. Kombinace těchto lekcí dává robustnější návrh než kopie jediné služby.

## 6. Co z veřejných podkladů nemůžeme tvrdit

Nenahlédli jsme do produkčního backendu Nylas. Nemáme důkaz jeho interních queue transakcí, CAS v každém provider endpointu, replay logu, freshness SLA nebo conflict merge. Absence takového popisu není důkaz absence mechanismu; je to hranice veřejné záruky, na kterou můžeme stavět vlastní produkt.

Stejně tak neprovozovali jsme disposable Nylas účet a netestovali webhook výpadky ani email notifications. Posouzení SDK a příkladů je statické. Sedm lokálních kontrol Musubi ověřilo vybrané čisté toky; neověřilo PostgreSQL races, deployment ani skutečný provider provoz. Přesné testy a jejich omezení obsahuje audit.

Studie zjistila dokumentační rozpory, ne prokázané incidenty služby. Například:

- omezení iCloud query okna má různé hodnoty v různých průvodcích;
- webhook formulace at-least-once není totéž co úspěšné doručení po bounded retry;
- API, SDK a notifications nemusí mít stejné time/status enums;
- nový Scheduler guide a reference se liší u buffers a podpory některých hostů;
- recurring cookbook slibuje snadnou unifikaci, zatímco reference uvádí provider výjimky.

Tyto body jsou zdrojované v příslušných kapitolách. Naše odpověď nemá být „dokumentaci nelze věřit“. Má být: **normativní kontrakt, příklady a conformance testy musí říkat totéž**. Tuto vlastnost můžeme otevřenému Musubi projektu dát od začátku.

## 7. Jak má vypadat výsledek otevření

Veřejný projekt bude mít malý normativní profil a rozšiřitelné provider operations. Vývojář dostane jednoduchý začátek pro běžnou osobní událost, ale také přesnou informaci, kdy operace není podporovaná a kdy zůstává uncertain. Na tomto kontraktu lze postavit různé hosts: Musubi, CLI sync nebo jinou aplikaci se svou DB.

Public model má obsahovat časový význam, scoped identity, observations, coverage, capabilities, errors a receipts. Provider package bude přes credential a HTTP port implementovat read/prepare/execute/observe. Host vlastní ACL a local commit. Shared runner vlastní lifecycle mechaniku. První verze nemusí být zcela obecná; musí mít jasně uvedený rozsah a prokázaný standalone host.

API ergonomii navrhnout shora: connection → collection → object → konkrétní action. Correctness záruky specifikovat zdola: accepted intent → immutable plan → dispatch evidence → provider evidence → fenced acknowledgement. Když některý důkaz chybí, výsledek zůstane otevřený. Tím bude malý kontrakt srozumitelný a zároveň pravdivý.

Do v0.1 nespojovat externí provider sync s redesignem Musubi federace, novým booking SaaS, mailbox API, E2EE klientským agentem a horizontálním shardingem. Tyto nápady mají vlastní přínos, ale každý rozšiřuje trust boundary a acceptance práci. První otevřený release má stát na tom, co již umíme a dokážeme oddělit.

## 8. Doporučené rozhodnutí pro první etapu

Začít provozním balíkem: společný task/event deadline a retry, oddělení recovery od poll interval a měření skutečných provider requestů. Současně sepsat identity/coverage/receipt profil, postavit capability matrix nad skutečnou admission a vyjmout jeden storage-free slice.

Další etapou bude verzovaný operation registry s kompatibilitou starých outbox řádků. Optional push a fair scheduling přidat přes stejné work/reconciliation rozhraní. Open-source alpha vydat až s reference hostem, deterministic conformance corpus, licencí a jasnou podporovanou maticí. [Detailní backlog, odhady, migrace a testovací scénáře](./05-protocol-and-plan.md)

To přinese hodnotu i tehdy, kdyby veřejný projekt nakonec začal jen jako knihovna modelů a adaptérů. Naše aplikace bude mít méně divergentních runtime pravidel a integrační logika bude použitelná samostatně. Není potřeba vymýšlet nový sync systém; potřebujeme z existujícího systému vytáhnout jeho nejlepší kontrakty a zpřehlednit, na kterých důkazech stojí.
