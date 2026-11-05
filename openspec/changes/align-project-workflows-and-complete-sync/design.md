# Design

## Context

Motivace a scope jsou v [proposal.md](proposal.md); reprodukované statické zdroje a již dodané C08–C10 v [research.md](research.md). Sedm delta specs vlastní cílové požadavky, [brief](../../../docs/project/brief.md) záměr projektu. Výchozí kód je b138056.

Toto je návrhová část delivery. Stop condition současné relace je kompletní, mechanicky validní a nezávisle revidovaný plán. Žádný implementační task není tímto dokumentem vykonán. OpenSpec „planning complete“ ani SPEC mechanical pass nesmí být zaměněn za přijetí uživatelem.

## Goals / Non-Goals

**Goals:** sjednotit autority, odvodit menší checkpointy z existujících hranic a dokončit dohledatelnou sync konvergenci bez ztráty kompatibility. V každé oblasti je jediný kanonický návrh; historické auditní dokumenty nejsou další aktivní backlog.

**Non-Goals:** opakovat C01–C10, portovat všechny operace do obecného SDK, přepsat native mappers, budovat Relay/push/cluster, publikovat alpha nebo automaticky měnit mazání/identity. Přijetí programu není oprávnění k deploymentu.

## Decisions

### T1 — OpenSpec je autorita plánované změny

Jedna zastřešující změna nese požadavky a checkpointy. Každý checkpoint má vlastní rozsah, branch, work-session a revision-bound evidence; provádí se jen právě přijatý checkpoint. Paralelní práce nesmí přepisovat sdílený goal ani stejné plánovací soubory.

.spec-pilot.json je sdílený navigační index s trvalým projektovým cílem; protokoly jsou architecture, nepřijatý design je jen active_change. Autoritou scope, stop a kontrol je přijatý CP brief; oddělený git-ignorovaný backups/spec-sessions/<session-id>/STATUS.json na něj odkazuje cestou a hashem a nese pouze průběh a výsledky relace. Před implementačním slice se checks.fast/full/ui v .spec-pilot.json záměrně nastaví na skutečné příkazy přijatého briefu, bez změny sdíleného goal/stop. Fast musí zahrnovat nejmenší relevantní produkční JSON scénář dle AGENTS.md a relevantní types/lint; whitespace má zvláštní planning-whitespace klíč. Současná absence fast/full je přiznaná mezera, nikoli zelená. Paralelní streamy používají vlastní branch/mapu a session ID. Veřejná redigovaná acceptance patří k příslušnému checkpointu v tomto change. Při sync/archive se v témže PR aktualizují všechny indexované cesty a aktivní odkazy; archiv není oprávnění označit nesplněné úkoly za hotové. Index naviguje brief, protokoly, design, specs, tasks a existující command definice. Nevzniká druhý DESIGN.md, EGM draft ani testovací framework. EGM není aktuálně nastavené review.mode; použije se čerstvý spec-review stejného designu.

Alternativa: nový samostatný RFC/roadmap mimo OpenSpec by znovu zdvojil autoritu, proto se nepoužije. Současný docs/planning roadmap dostane při CP01 historické označení a odkaz na aktuální plán; jeho původní evidence se nemaže.

### T2 — Oddělit živá fakta, protokol a historii

Záměr zůstane v docs/project/brief.md. Nynější protokolové smlouvy a jejich invariants zůstávají normativní ve svých docs/protocol zdrojích, dokud není explicitně přijatá změna. Nové cílové požadavky jsou zatím delta, nikoli potichu aktivovaný main spec.

CP01 použije existující autority; nezakládá nový runbook, release index ani contributor quickstart:

| Odpovědnost | Jediná autorita | Ostatní povrchy |
| --- | --- | --- |
| Current release a obecný upgrade/recovery postup | docs/releasing.md | README.md, docs/README.md a Starlight operations/releases.mdx odkazují; datované acceptance zůstávají historií |
| Publication proof a promotion nástroje | docs/releases/publication.md | Obecný runbook na něj odkáže, neopisuje algoritmus |
| Contributor workflow a fáze ověření | packages/docs/src/content/docs/guides/contributing.mdx | AGENTS.md zůstává autoritou povinných agent pravidel; README a onboarding odkazují na workflow |
| Lokální setup a předpoklady | packages/docs/src/content/docs/guides/running-locally.mdx | onboarding.mdx zůstává výukový kurz, nikoli další command reference |
| Skutečné příkazy a CI rozsah | package.json a .github/workflows/quality.yml | Starlight reference/commands.mdx přestane tvrdit „canonical“; CP01 ji převede na navigaci ke scripts/CI a případné příklady budou kontrolované proti jejich autoritě |
| JSON selekce | docs/testing/behavior-scenarios.md | Contributor vstup na ni odkáže |
| Incidenty, metriky a scaling | Starlight operations/observability.mdx | docs/observability.md už je rozcestník; CP01 zkontroluje jeho cíle |

CP01 odstraní živé odkazy označující datované readiness jako „current“, aniž přepíše historické výsledky. CP04 nepřidá druhou current autoritu: zavede redigované schema jednotlivého release receiptu (source/publication/deployment/native odděleně) a validaci odkazu z docs/releasing.md na konkrétní receipt. Žádný druhý mutable current pointer ani kopírované current tabulky. News zůstává redakční výstup, ne approval gate.

### T3 — Testovací orchestrace má jeden inventář, konformance vlastní očekávání

CP02 rozšíří existující odvození, nezavádí nový registr řídící package.json. Autoritou DB vstupů zůstává package.json test:db a jeho fail-closed parser scripts/ci-shards.mjs; behavior suite vlastní SUITES v scripts/test-behavior.mjs. scripts/test-behavior.test.mjs již hlídá unknown/empty/unconsumed chyby. Doplní se skutečné CLI volání a kontrola orphan/discovery proti těmto autoritám, nikoli druhý seznam. Alternativa nového společného registru by přidala migrační framework a riziko paralelních autorit bez doloženého přínosu, proto se nyní odmítá. Každé volání zůstane nad produkčním driverem.

Frozen conformance manifest se **negeneruje jako automatický souhlas** z právě editovaných testů. Discovery smí vygenerovat diff; změna očekávaných IDs/assertion completion podléhá nezávislému review. Kontrola úplnosti unit inventáře nesmí označit importované child suites jako sirotky jen podle názvu souboru.

Dokumentované vrstvy budou fast → cílená integrace/UI → full CI → artifact/live. Současné pnpm check ani pnpm verify nejsou kompletní Quality. CP02 sestaví full plán přímo proti QUALITY_JOB_NAMES a Quality definici: zahrne source/verify, 4 DB a 4 web shardy, observability, compat, bundle, Storybook, Android build/DEX všech 5 image jobů včetně arm64 a oba boot smoke joby API container boots and serves / Web production container boots in Chromium; přesné aktuální názvy převezme ze zdroje. Každý gate bude lokální, CI nebo externí a označí prerequisites. iOS má samostatný macOS gate. Není nutné emulovat všechny platformy lokálně; chybějící gate je HOLD, nikoli skip/pass. Plán/preflight nesmí spouštět produkční služby ani přidělit prostředky před validací předpokladů.

Změna počtu či názvů CI jobů vyžaduje společný update Quality proof kontraktu a jeho testu. Do té doby platí všech 21 Quality jobů vyžadovaných publication proofem; skutečné required checks pro merge se navíc ověří proti branch protection. Docs-only optimalizace je samostatná budoucí policy změna, nikoli obcházení gate v tomto programu.

### T4 — Skutečný stav syncu je výchozí bod, nikoli další greenfield

C08/e75d5c7, C09/f500467 a C10/1cf603b jsou v main. C08 už přesunulo task/specialized lifecycle do sdíleného runtime; C09 koordinátor a provider budgets jsou v produkční composition root; C10 má samostatný frozen alpha corpus. CP05 proto rekonciluje rodinný inventář proti aktuálním routerům a upgraduje popis autorit.

Rozhraní zůstává:
- Musubi host: canonical content, memberships, home authority, ACL/privacy, admission/claim/ACK, import.
- Sdílený runtime: bounded lifecycle, plánování a typed host/native porty.
- Provider/native port: serializace, endpointy, HTTP/readback evidence a side effects.
- Reference host: vlastní ledger a credential store, pouze deklarovaných deset profilů.

CP06 smí sjednotit klasifikaci a odstranit skutečně dvojí orchestraci jen po jednotlivé rodině s dokazatelným chováním. Pokud inventář ukáže, že rodina již splňuje SC-02, zapíše existující cestu a neprovádí redundantní extrakci. Trvalá host compatibility je legitimní finální hranice; neznamená nedokončený obecný SDK.

Reserved timeEdit/graphOccurrence guard keys se modelují zvlášť od writer rodin. Neodstraňují se jen proto, že dnes nemají producer. Present malformed/unknown envelope vždy HOLD; missing v0 zůstává explicitní decoder/host cesta. Decoder ji nazývá legacy-v0, host profil retained-v0. Nejde jen o staré řádky: specialized, VTODO/To Do, některé generic UPDATE a vypnutý v1 encoder ji stále aktivně admitují. Inventář proto oddělí živý v0 admission profil od historických v0 dat.

### T5 — Přepnutí a vyřazení jsou samostatné gates

Pro každou rodinu CP05/06 evidují supported shapes, selected path, retained input, known/unknown serializers, actor/source/grant, uncertainty a rollback floor. Původní admitted payload a native plan se po upgrade nikdy nepřepočítají.

Exit gate v CP12 se týká admission i decoderu konkrétní rodiny, nikdy globálního v0 decoderu jen podle jedné prázdné fronty. Musí zahrnout živé v0 admission cesty, current i retained/uncertain řádky, podporované backup/peer vstupy a historické replay. Prázdná aktivní fronta nestačí k odstranění decoderu. Pokud pro rodinu nelze bezpečně uzavřít starý formát, zůstane udržovaný kompatibilní reader a jeden explicitní host port.

Nezavádí se mixed-version writers ani cluster. C08 Google RSVP no-resend marker vyžaduje barrier-aware reader nejméně e75d5c7. Vypnutí encoder flagu není oprávnění přepsat původní intenty nebo vynechat marker.

### T6 — Čekání, side effect a lokální commit jsou nezávislé dimenze

CP07 nejdřív reprodukuje deferred vs unknown výsledek nad existujícími porty; potom opraví klasifikaci a klientskou interpretaci. Odklad před raw send lze vyjádřit jako known queued; možný dispatch zachová unconfirmed. Každá odpověď nadále pravdivě nese lokální commit a původní operation identity.

Návrh nefixuje předem nový HTTP status ani nerozbíjí staré wire DTO. CP07 musí vybrat zpětně kompatibilní reprezentaci přes aktuální kontrakty a old-client test. Změna veřejné obálky mimo aditivní možnosti vyžaduje zvláštní schválenou kompatibilitní změnu.

Logger oddělí request identitu a work identitu bez zrušení permit/controller ALS. Serverová korigovaná pole mají vyšší autoritu než děděný kontext. Žádná korelační identita se nestává autorizačním důkazem.

Needs-human ownership: uživatel řeší své viditelné oprávnění/reconnect/conflict; provozovatel infrastrukturu a agregované stárnutí. CP07 přesně přiřadí reason classes existujícím delivery inboxům a provozním alertům, bez exportu event obsahu či identity do metric labels.

Shutdown slice CP07.6 zároveň spadá pod PB-03: musí deklarovat držení/uvolnění pg_try_advisory_lock singletonu (nový proces dnes fail-fast), PID 1/tsx propagaci signálu a skutečný stop timeout deployeru vůči drain/lease budgetu. Negativní process scénář spustí nový worker během drainu starého; nesmí umožnit dva writery ani vydávat restart loop za readiness. Izolovaná implementace může předcházet produkční inventuře, ale aktivace vyžaduje CP11.3/D3 včetně pořadí stop/start, readiness a rollback HOLD. Delší drain nelze bezpečně zapnout pouze lokálním unit testem.

### T7 — Rizikové doménové změny začínají vymezenou reprodukcí

CP08 má tři konkrétní testovací vstupy:
1. createExternalUser s e-mailem E → skutečný Better Auth OTP/social fixture pro E → původní member token: zda získá nová lokální data.
2. Event/task home A s přeživší provider destinací B → calendar-delete a account-delete → read/ACK/pull včetně createIdentityVersion.
3. Uživatelský event DELETE → GET since původního kurzoru → očekávané deletion evidence při současné privacy/membership hranici.

Před implementací odlišné removal policy se uloží owner decision D1. Do té doby jsou povolené jen reprodukce a zachování stávajícího chování. U identity se testuje existující bezpečnostní invariant ID-01, nikoli předpokládaný exploit; vyvrácený nález se uzavře bez vymyšlené opravy.

Deklarovaný delta kontrakt se nejdřív charakterizuje; full snapshot zůstane recovery. Jeho tiché stažení nebo použití neúplné delty k optimalizaci je mimo scope. Případná změna veřejného kontraktu vyžaduje D2 a vlastní kompatibilitní přijetí.

CP09 pro federované task cíle zvolí konzervativní existující hranici: bez přijatého task gateway se nepodporovaná write akce nenabízí. Neimplementuje se nové federační task API. Capabilities neobcházejí fresh server authorization.

### T8 — Konfigurace se sjednocuje s upgrade politikou

CP10 zavede konzistentní validaci nastavených hodnot a dokumentaci odvozenou nebo kontrolovanou z jedné authority. Žádná přejmenovaná env proměnná nesmí tiše změnit existující self-host profil. Případné rozdělení private-network a HTTPS výjimek musí mít explicitní alias/deprecation a redigovaný effective config.

Privátní cíle, auth trusted origins a klíče se posuzují podle ID-06. Kompatibilita není důvod označit špatný klíč za provider auth chybu nebo provést nevratný remote accept před validací známé neplatné konfigurace.

### T9 — Publikace drží nynější silnější CI kontrakt

CP04 zachová politiku „úplný čerstvý accepted attempt“ a uzavře doložený K-09 rozdíl implementace. Job a povinný Android krok musí začít nejdříve accepted run_started_at; verifier má stejnou mez. Fixtures musí mít konzistentní sample/run/job/step časy a testovat skutečný carried-over tvar, nikoli jen neúplný seznam. Neprovádí se experimentální rerun vydaného main běhu.

Candidate digest se ověří před propagací. Cílový produkční consumer používá release-bound neměnné digests; latest je distribuční alias, ne druhý zdroj schválení. Přesné propojení skutečné deployment automatiky je gate CP11: dokud není ověřen trigger a pinned consumer, změna pořadí latest/tagu se nesmí produkčně aktivovat. Pouhé přesunutí latest za tag bez změny consumeru by mohlo nasadit starý image a není přijatelné řešení.

Store kanály zůstávají stávající Google Play a iOS TestFlight. Záznam konkrétních buildů je oddělený od API verze; server hotfix nemusí mít nový store build. Veřejná alpha distribuce, název, support window a security SLA nejsou tímto plánem schválené.

## Risks / Trade-offs

- Zastřešující scope může svádět k velkému PR → každý CP má vlastní výsledek a stop, doménové rozhodnutí otevírá jen příslušný CP.
- Jedna tabulka klasifikace může ztratit reserved/refusal rozdíly → zachovat oddělené discriminant classes a negativní scénáře, ne vynucenou univerzální payload union.
- Zelená mechanika může skrýt neprovedené testy → výsledky vrstvit; unknown není pass.
- Cleanup může zasáhnout cizí QA → nonce ownership, nulové sessions, plain DROP a přesné resource IDs.
- Zpětná kompatibilita komplikuje úklid → ponechat maintained compatibility, dokud není reader/backup/peer gate; žádné bulk re-encode.
- Přechod na delta/single-flight může ztratit novější invalidaci → zachovat full recovery, scope a dirty-generation test.
- Runtime a shutdown změny zasahují síť/SQL/leases → deterministic test nestačí, vyžadují PG/HTTP/process a finální aplikaci.
- Ukládat veřejné provozní inventáře může zveřejnit soukromá data → jen redigované verze, hashes, counts a reference; recovery secrets zůstávají privátní.

## Migration Plan

1. CP01–03 upraví authority a testovací cestu bez datové migrace; baseline vady a čas budou evidovány odděleně.
2. CP04 připraví publication tooling; změny consumeru nebo triggeru se zatím neaktivují.
3. CP05 zrekonciluje aktuální sync inventář; CP06 postupuje pouze po vybraných rodinách, decoder-before-encoder a bez druhého writeru.
4. CP07 spustí změněnou runtime sémantiku v izolovaném prostředí a přijatém rozsahu.
5. CP08 rozřeší bezpečnost a data konkrétními testy; D1/D2 blokují pouze nové dotčené chování. Prioritní auth reprodukce může předběhnout ostatní CP.
6. CP09–10 sjednotí klientské a konfigurační smlouvy v povolených hranicích.
7. CP11 pro samostatně vybraný release ověří aktuální zálohu/recovery, old-consumer stop, singleton, journal, images, flags a rozsahový live/app smoke. Současný plán nic nenasazuje.
8. CP12 může odstranit jednotlivou legacy větev jen po SC-05. Rollback je per-profile compatibility postup, nikoli obecné povolení spustit starý binary.

## Rozhodnutí vyžadovaná před dotčenou implementací

Tato rozhodnutí jsou explicitní blokované úkoly v CP08/11/12, nikoli skryté TODO pro autora kódu:
- **D1 — Home/creator removal:** zachování nebo odstranění kanonického obsahu a přeživších provider kopií v matici ID-03. Owner přijme výsledek po reprodukci, před změnou policy.
- **D2 — Veřejná delta hranice:** zachovat a opravit deklarované deletions; případné omezení/stažení veřejného since kontraktu vyžaduje samostatný compatibility návrh.
- **D3 — Produkční activation a recovery:** skutečný consumer/trigger, vlastníci privátního recovery inventáře a vybraný release. Bez potvrzeného rozsahu zůstává CP11 HOLD.
- **D4 — Retire admission/decoder konkrétní rodiny:** podporované historické řádky/backup/peer floor a konkrétní rodina. Dokud gate neexistuje, kompatibilita se zachová.
- **D5 — Veřejná distribuce standalone sync:** samostatný pozdější change; CP12 končí interní konvergencí, nikoli npm/daemon/Relay releasem.
- **D6 — Role Its a Plan frgtn.MUSU:** před dokončením CP01.4 potvrdit vztah externího trackeru k OpenSpec. Navržená varianta je navigační projekce tasks/evidence; tracker nikdy sám neprokazuje přijetí ani merge. Živý stav nebyl v této relaci inventarizován. Bez rozhodnutí neměnit ani neuzavírat issues a CP01.4 ponechat otevřený; žádná automatická migrace nebo druhý autoritativní backlog.

Přijetí této specifikace schvaluje postup evidence a gates; nevolí zatím neprokázanou removal policy ani veřejný support závazek.

## Open Questions

Deferrable údaje bez změny cílových kontraktů: aktuální timing budget nejpomalejší CI lane, konkrétní poslední store build IDs, stáří autorizovaného recovery drillu, skutečné používané config profily a případný bezpečný termín deprecated aliases. Zjišťují se v uvedených CP a nemají být vyplněny odhadem.
