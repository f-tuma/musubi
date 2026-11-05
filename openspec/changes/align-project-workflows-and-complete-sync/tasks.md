# Tasks

Stav: navržené implementační checkpointy, nic z níže uvedeného není nyní vykonané.
Každý checkbox obsahuje vlastní ověření; při změně hranice se použijí i povinné integrační/aplikační/CI gates z AGENTS. „Ověřit“ není totéž co pouze přidat test.

Po přijetí návrhu se vybírá **jeden konkrétní checkpoint nebo jeho bounded rodinný slice** a jeho stop condition. Číslování není povolení k nepřerušenému apply celého programu. Jedna session nesmí označit staré acceptance za čerstvý PASS jiného zdroje.

Závislosti: CP01→CP02→CP03; prerekvizitní slice CI-brand-fixtures (TEST-08, checkpoints/CI-brand-fixtures.md) odblokuje current-head Quality pro CP01 a smí proběhnout před dokončením CP01 i CP02–CP03, neuzavírá žádný CP02/CP03 box; CP04.1–4.2 (K-09) mohou předběhnout CP02; zbytek CP04 používá full plán CP02; CP05 může začít s CP01; CP06 vyžaduje CP02+CP05; CP07 CP02+CP05; prioritní auth reprodukce CP08.1 může začít hned po přijetí scope nezávisle na CP01–07; policy fixy CP08 vyžadují vlastní rozhodnutí; CP09/10 jen odpovídající přijaté kontrakty; CP11 readiness sdružuje dokončený vybraný release scope; CP12 vyžaduje příslušné rodinné a compatibility důkazy, ne nutně veřejnou distribuci.

## Přijetí konkrétního checkpointu (CP brief)

CP01–CP12 níže jsou pracovní balíky programu, nikoli předem přijaté implementační relace. Před apply vybraného boxu/slice vznikne v tomto change soubor checkpoints/<CP-slice>.md s požadavky, konkrétními soubory, jedním očekávaným pozorovatelným výsledkem, přesnými argumenty fast/full/ui, prerequisites, evidence výstupem, dotčenými audit ID a aktualizací jejich stavu/odkazů v audit-disposition.md a stop/return podmínkou. Není to paralelní design; brief smí jen zúžit a konkretizovat tento design/tasks/specs. Nový požadavek nebo odchylka scope se nejprve zapíše do těchto kanonických artefaktů a znovu reviduje, teprve potom do briefu. Před prvním briefem i po odchylce projde strict OpenSpec validace. Brief je před kódem nezávisle revidovaný a přijatý v rozsahu zadání. Chybějící driver se nejprve vymezí jako vlastní testovací slice, ne jako nepozorované rozšíření jednoho boxu. Materiální změna briefu znovu otevírá review. Session STATUS.json odkazuje na přijatý brief cestou/hashem a zaznamenává jen průběh/výsledky. Před implementací se podle briefu aktualizují skutečné checks.fast/full/ui v .spec-pilot.json dle T1; nezmění se sdílený goal/stop a souběžné streamy používají oddělené větve/mapy.

Společný return: při rozporu normativního kontraktu, novém policy rozhodnutí, chybějící platformě/přístupu, neočekávaném live side effectu nebo změně scope neoznačit box done; uložit přesný výsledek/HOLD a vrátit se k briefu/designu. Kontrolovaný reprodukovaný defekt je výsledkem reprodukce, nikoli souhlasem jej opravit. Žádné nahrazování povinného gate lokální podmnožinou.

Do dodání full vstupu CP02 je full gate dokončení implementačního slice: `pnpm check`, všech 21 current-head Quality jobů vyžadovaných publication proofem a skutečné branch-protection checks; podle hranice ještě integrační/aplikační/platformní kontroly. Merge čeká na skutečné výsledky aktuálního headu. Toto není tvrzení, že se Quality dá vykonat jediným lokálním příkazem.

### Výchozí kontrolní kontrakty a návrat

<absolute-repo-root> v příkladech znamená skutečný absolutní root vybraného checkoutu, nikoli doslovný argument. Příkazy jsou ověřené existující vstupy, nikoli tvrzení o dnešním spuštění. CP brief vybere nejmenší přesný scénář pomocí `pnpm test:behavior --list`, zaznamená ID a podle něj zúží suite. Široké integrační vstupy níže se v briefu rozepíší podle aktuálního package/CI zdroje; žádné neexistující ID se nespouští.

| Balík | Relevantní existující vstupy a evidence | Return navíc ke společnému |
| --- | --- | --- |
| CP01 | `git diff --check`; `pnpm docs:build`; `spec check --project <absolute-repo-root> --phase orient` a `--phase design`. Ruční link ledger pro všechny editované živé odkazy: source, target, existence/anchor nebo HTTP stav; odkazy označené current porovnat s docs/releasing.md. Full gate výše. | Nefunkční živý odkaz, nová duplicitní autorita nebo runtime změna → zpět k 1.1/briefu; historické odkazy se zachovají a označí. |
| CP02 | `node --test scripts/test-behavior.test.mjs scripts/ci-shards.test.mjs`; skutečné `pnpm test:behavior --list` a vybraný `--scenario … --json`; inventory/mutation diff a explicitní lokální/CI/externí full plán. | Discovery nesouhlasí nebo nový parser ignoruje příkaz → nepřijmout; změna frozen expected IDs vyžaduje nové review. |
| CP03 | `pnpm test:e2e:radicale`, `pnpm test:behavior:browser`, příslušné widget parser/native joby z Quality; fixture hranice a artifact/device výsledky odděleně. | Nedostupný Mac/device je HOLD příslušného gate, nikoli behavior PASS z DEX scanu. |
| CP04 | `node --test scripts/quality-proof.test.mjs scripts/verify-publication.test.mjs`; přidané startup/promotion fixtures se jmenovitě uvedou v briefu; schema receipt a redigovaný dry-run. | Jakýkoli posun aliasu/tagu při failure → nepropagovat; neznámý consumer čeká na D3. |
| CP05 | `git merge-base --is-ancestor` pro tři plné commity v research vůči vybranému headu; statický úplný router/admission diff a `pnpm test:behavior --list` jako inventář, ne runtime důkaz. | Nezařazená rodina/guard nebo důkaz jiného headu → tabulku nepřijmout. |
| CP06 | Konkrétní JSON z inventáře; podle rodiny `pnpm test:db:shared-runtime`, `pnpm test:db:event-compatibility`, `pnpm test:db:task-compatibility`, `pnpm test:db:operation-admission`; installed alpha program podle docs/sync-alpha/README.md. Brief vybere konkrétní programy místo celé sady. | Změněná guarantee/serializer, nový side effect či uncertain resend → HOLD a návrat k family briefu. |
| CP07 | JSON fair-work a zvolené work failure cases; dotčené reálné PG/HTTP testy odvozené z test:db:sync; process SIGTERM/singleton fixture s doloženým timeoutem; promtool/observability Quality job. | Dva writeři, připsaný commit bez důkazu nebo send po bariéře → HOLD; produkční drain čeká na PB-03/D3. |
| CP08 | Pro 8.1 konkrétní kontrakt níže; ostatní `pnpm test:federation-db`, `pnpm test:db:events`, `pnpm test:db:tasks` dle vybraných skutečných programů; vlastní DB a časové pull/ACK race fixtures. | Chybí D1/D2, skutečný auth boundary či dostatečné privacy očekávání → reprodukce/policy zůstane otevřená. |
| CP09 | Zvolené capability/refresh JSON; `pnpm test:behavior:browser`, `pnpm --filter @musubi/web lint`, `pnpm storybook:web:test`; reálný Android/iOS tok se skutečným build ID při native změně. | Client hints obcházejí fresh auth nebo refresh ztratí invalidaci → návrat ke kontraktu; neodstraňovat full recovery. |
| CP10 | Zvolené existující config/outbound unit a integration programy z package.json; test connection/redirect ports bez skutečného útoku; redigovaná env matrix. | Legacy konfigurace tiše změní authority nebo test potřebuje cizí endpoint → HOLD a návrat k alias/trust návrhu. |
| CP11 | Exact source/installed/full evidence vybraných předchozích slices; izolovaný restore/drain a simulated consumer trigger; manuální readiness packet ověřený proti skutečným digestům. | Neověřený consumer/backup/readiness/store build → příslušný status unknown/HOLD; žádná automatická produkční aktivace. |
| CP12 | `pnpm test:db:operation-decoder`, admission/retirement PG podle rodiny, installed corpus, link/index a traceability diff; strict OpenSpec validate. | Živý v0 admission, podporovaný starý backup nebo nedoložený reader floor → ponechat kompatibilitu. |

### První slice a auth reprodukce

CP01.1–1.2 lze zpřesnit společně jako čistě dokumentační brief: vstupy jsou T2 autority a jejich živé odkazy, výstup jedna ownership mapa a opravená navigace. Kontroly i return jsou v řádku CP01. Toolchain 1.3 je samostatný slice s kontrolou deklarací a relevantním build/CI headem; nesmí se schovat do docs změny.

CP08.1 je samostatný prioritní reprodukční brief: produkční Better Auth factory + API middleware/federation + vlastní disposable PG, fixture OTP/social transport v existujícím portu, žádné mocknutí vydání session knihovnou. Současné `pnpm --filter @musubi/auth test` je pouze cookie/landing baseline a tento invariant neprokazuje. Brief nejprve vymezí nový integration driver a JSON scénář `shadow-email-session-scope` v nové auth suite; před přidáním driveru toto ID ani suite neexistují a nesmí být vykázány jako PASS. Po zavedení driveru budou přesné vstupy `pnpm test:behavior --suite auth --scenario shadow-email-session-scope --json` a vlastní registrovaný PG integration program (cesta a příkaz v briefu před implementací). Evidence: původní shadow/member identity, nová ověřená local identity, výsledky přístupu starým tokenem i novou session k lokálním i federovaným zdrojům; vymazat vlastní fixture data. Chybějící skutečné vydání session, nečekaná změna identity nebo překročení disposal ownership vrací práci k briefu; zranitelnost se neoznačí potvrzenou z portové simulace. Bez tohoto briefu lze jen číst a navrhovat test, nikoli začít apply.

## 1. CP01 — Aktuální autority a vstup do projektu

Požadavky: WF-01 až WF-04. Stop: člověk najde platné příkazy a runbook; app/runtime chování se nezmění.

- [ ] 1.1 Sjednotit README, docs/README, current capability/release odkazy a označení staré C08–C10 roadmapy; ověřit všechny živé odkazy a rozpor 0.2.2/0.2.16 proti zvolené autoritě, historické receipts ponechat.
- [ ] 1.2 Opravit existující contributing/running-locally/onboarding, Starlight commands/releases a docs/releasing.md podle T2 ownership mapy; ověřit clone→běh→test→PR→release odkazy a skutečné příkazy. Nevytvářet další quickstart/runbook/current index.
- [ ] 1.3 Sjednotit deklarovaný toolchain s ověřovaným runtime a lokálními doporučeními; ověřit rozdíl .nvmrc/CI/Docker a doplnit kontrolu koherence bez neověřeného zvýšení major verze.
- [ ] 1.4 Zdokumentovat vlastníky záměru, protokolů, UI, příkazů, release faktů a history a potvrzenou roli trackeru Its a Plan dle D6 (bez D6 tento box zůstává otevřený); ověřit SPEC orient/design mapping a nezávislý review tohoto CP včetně návratu při materiální změně.

## 2. CP02 — Jeden inventář a pravdivý ověřovací workflow

Požadavky: VT-01, VT-02, VT-05. Stop: stejné suite/selektory mají ověřený vstup a žádný povinný případ se tiše neztratí.

- [ ] 2.1 Rozšířit existující scripts/test-behavior.test.mjs o root behavior CLI reálným spuštěním existujících driverů včetně --json a unknown/empty/unconsumed chyb; ověřit, že kontrolovaný defekt vstupního lepidla test skutečně shodí.
- [ ] 2.2 Rozšířit stávající SUITES a test:db/ci-shards odvození o kontrolu package/runner/discovery shody bez nového registru; jako konkrétní seed ověřit ci-shards.test.mjs v CI i lokálním vstupu a inventář proti skutečně vybraným případům a proti importovaným child suites, ne jen globu názvů.
- [ ] 2.3 Doplnit inventory guard pro unit/DB scénáře a nezávislý diff frozen conformance; ověřit přidaný i odebraný case, aniž by generátor automaticky přijal nový expected kontrakt.
- [ ] 2.4 Zajistit count/list guard produkčního browser smoke a přiznaný flaky/skip souhrn; ověřit přejmenování povinného testu jako skutečné selhání selekce.
- [ ] 2.5 Dodat pouze full plán/preflight: odvodit všech 21 jobů z Quality/proof autority, každý označit lokální/CI/externí a uvést předpoklady; ověřit fail-before-resource při chybějících požadavcích. Implementaci nových platformních runnerů vyčlenit do vlastních přijatých slices; pnpm verify neoznačit jako „vše“.
- [ ] 2.6 Doplnit metriky trvání a srovnání stejné sady bez falešného výkonového budgetu; ověřit current-head Quality včetně všech dosavadních 21 Quality jobů požadovaných publication proofem, pokud se struktura mění, společně změnit proof kontrakt a jeho test.

## 3. CP03 — Reprodukovatelné protokolové a native hranice

Požadavky: VT-03, VT-04, VT-06, CL-05. Stop: lokální protokolová lane a klientské fixtures jsou přenositelné a jejich limity viditelné.

- [ ] 3.1 Přidat verzovaný/připnutý Radicale startovací profil bez soukromého HOME; ověřit čistý nonce-owned start, existující CalDAV integrační a browser scénář a přesný cleanup; nevydávat Radicale za iCloud.
- [ ] 3.2 Validovat používané browser response fixtures proti skutečným response schématům; ověřit konkrétní month-read toky a odmítnutí neplatného payloadu, s přiznáním fake server hranice.
- [ ] 3.3 Zavést sdílené widget snapshot příklady a změnový kontrakt; ověřit skutečné TS/Kotlin/Swift parsery v příslušných lane včetně unknown version a jiné identity.
- [ ] 3.4 Doplnit nebo doložit skutečné zapojení native behavior runnerů vedle artifact scanů; ověřit samostatné označení build/DEX/parser/signed-device výsledků a relevantní narrow/light/dark aplikační stavy.

## 4. CP04 — Publication a release evidence

Požadavky: PB-01 až PB-05. Stop: tooling vynucuje deklarovaný kontrakt; žádná produkční aktivace ani tag nevznikne tímto CP.

- [ ] 4.1 Přidat carried-over partial-rerun fixture na existujícím fetch/readJSON portu s konzistentními časy; ověřit fail na starém validatoru a pass pro úplný nový attempt bez GitHub rerunu.
- [ ] 4.2 Svázat job i povinný native step s accepted attempt start v collector i verifieru; ověřit intervaly, stejný SHA, original pin, změněný attempt a nezměněné odmítání chybějících/skipped jobs.
- [ ] 4.3 Přidat actual candidate-digest startup/closure gate pro deklarované platformy před propagací; ověřit, že jiné same-SHA image nebo nedostupný důkaz nejsou přijaty jako tento artefakt.
- [ ] 4.4 Sjednotit retenci digest/proof evidence a per-release strojový záznam s oddělenými source/publication/runtime/mobile fakty; ověřit schema, redakci a odvozené current odkazy bez změny historických receipts.
- [ ] 4.5 Připravit immutable consumer/promotion kontrakt a fail-before-promotion test; ověřit, že pozdní guard failure neposune produkčně konzumovaný alias a že pouhé přeházení latest/tag nevyvolá starý deploy.
- [ ] 4.6 Doložit dry-run reconciliation nejistého publish, create-only tag/release a per-profile rollback HOLD; ověřit celý nástrojový checkpoint, současný publication kontrakt a nezávislý finální review bez experimentálního releasu.

## 5. CP05 — Skutečný inventář sync přechodu

Požadavky: SC-01, SC-04, SC-06. Stop: každá dnešní rodina má skutečnou cestu a acceptance hranici; nic se nepřepíná.

- [ ] 5.1 Zrekoncilovat C08/e75d5c7, C09/f500467, C10/1cf603b a následné hotfixy s current source; ověřit ancestry a skutečné router/composition root větve, ne staré tracker statusy.
- [ ] 5.2 Doplnit inventář personal Google/Graph/DAV, Google tasks, retained-v0, VTODO, To Do, všech 13 specialized rodin a Outlook move; ověřit úplnost proti dispatch/admission seznamům včetně reserved guard keys.
- [ ] 5.3 Pro každou skupinu uvést admitted input, authority, codec/profile, conditional/guarded/observe-only, serializer a rollback floor; ověřit, že tabulka nepovyšuje generic Graph/DAV UPDATE, VTODO/To Do ani RSVP na portable. Odlišit živý v0 admission od historických v0 řádků a mapovat legacy-v0/retained-v0 názvosloví.
- [ ] 5.4 Zapsat současné gaps source→installed consumer→publication→activation a vlastníka každé compatibility cesty; ověřit proti skutečným příslušným receipts a novému public guide bez doplnění nepozorované produkční acceptance.

## 6. CP06 — Konvergence po rodinách

Požadavky: SC-02 až SC-07. Stop každého checkboxu: jediná účinná cesta pro vybranou rodinu a source-bound regresní důkaz. Každá rodina je samostatný slice; pokud již gate splňuje, doloží se to bez redundantního přepisování. Průřezovou podmínkou každého skutečného přepnutí jsou jeho konkrétní tests/guide, relevantní PG/process/crash/upgrade/old-client/peer kontroly, finální běžící aplikace, exact-head review a required CI. Není to samostatný souhrnný checkbox; nesplněné rodiny zůstanou otevřené.

- [ ] 6.1 Sjednotit family classification a reserved/refusal guards pro admission/router; ověřit přesnou precedenci včetně timeEdit, graphOccurrence, nested RSVP a terminal graphCreateAdoption, nikoli obecný „vše keyof payload“ předpoklad. Negativní pinned-v1 + reserved top-level klíč musí skončit HOLD/blocked před HTTP i u Google content/delete; brief určí guard v supports/routeru, bez změny legitimního admission.
- [ ] 6.2 Potvrdit/případně narovnat Google personal event CREATE/UPDATE/DELETE bridge; ověřit existující kernel JSON, host/native PG, uncertainty a immutable projection každé změněné akce.
- [ ] 6.3 Potvrdit Graph personal CREATE/DELETE a host-compatible UPDATE; ověřit weak-validator/guarded hranici a uncertain reconciliation bez nové CAS či portable UPDATE deklarace.
- [ ] 6.4 Potvrdit DAV personal CREATE/DELETE a host-compatible UPDATE; ověřit resource URL/UID/ETag, conditionality, legacy time vstupy a aktuální iCloud read regresní cases.
- [ ] 6.5 Potvrdit Google Task addressed/causal/retained lifecycle; ověřit NULL admission, spárované predecessor ID/tag/baseline, ACK fencing a chybějící adresu bez successor CREATE.
- [ ] 6.6 Potvrdit VTODO a To Do host compatibility; ověřit resource/precision/home policy, původní odmítnutí secondary To Do writes a bez nové portable conditionality.
- [ ] 6.7 Potvrdit Google reminderEdit/reminderInstance/googleOccurrence; ověřit původní slot, defaults/off/custom a cancellation hranice příslušnými existujícími JSON/native programy.
- [ ] 6.8 Potvrdit caldavAlarm/caldavSeries/caldavSeriesDeletion/caldavSplit; ověřit zachování celého resource, scopes, dva journaled split kroky a observe-only uncertain recovery.
- [ ] 6.9 Potvrdit Graph family create/adoption/deletion/content/meeting-cancel a move child lifecycle; ověřit úplný family ACK, finite bounds, stop/partial a pozdní ACK bez obnovení zastavené práce.
- [ ] 6.10 Potvrdit organizer a RSVP všech tří providerů; ověřit separate notification outcome, permanentní možné-send barrier a markerless GET-only HOLD bez uncertain resend.
- [ ] 6.11 Ověřit nezávislý reference consumer a actual installed closure dotčených portable profilů; požadované IDs/assertion completion bez skipů, bez Musubi DB/auth/config a bez relabelování starých artifact PASS.

## 7. CP07 — Scheduler, stavy a provozní diagnostika

Požadavky: SR-01 až SR-06, PB-03 pro shutdown. Stop jednotlivého slice: pravdivý stav a zachovaná authority/capacity; ne samotné snížení počtu error logů.

- [ ] 7.1 Reprodukovat durable pre-dispatch deferral odděleně od post-dispatch unknown a neuloženého preflight timeoutu; ověřit skutečné localCommitted, operation identity a původní client wire interpretaci.
- [ ] 7.2 Implementovat přijatou kompatibilní queued/failure klasifikaci a testovat response/log/metric pro každou fázi; ověřit, že uncertain CREATE/DELETE/RSVP nikdy nepřejde na blind retry.
- [ ] 7.3 Izolovat work log kontext od probouzejícího requestu; ověřit A request→B work, explicitní fields a nezměněný permit/controller ALS včetně native leaf.
- [ ] 7.4 Přiřadit due/blocked/conflict/unconfirmed reason vlastníky a signalizaci event/task inbox/ops; ověřit promtool fixture, snapshot health a privacy-safe labels.
- [ ] 7.5 Klasifikovat trvalou resource nezpůsobilost a transient chyby konzistentně; ověřit Microsoft resource-isolation a zachování viditelných nových poruch místo nekonečných duplicitních incidentů.
- [ ] 7.6 Zavést izolovaně bounded SIGTERM s doloženými drain/lease/deployer timeouty, PID1/tsx signálem a pg_try_advisory_lock fail-fast singletonem; ověřit process kill/drain, active send, ACK a start nového procesu během drainu bez dvou writerů/restart-loop readiness. Aktivace je PB-03 + CP11.3/D3 gate.
- [ ] 7.7 Ověřit nynější fair-work kapacitu a clock/budget hranice v produkčním složení; zachovat 0.2.16 foreground/OAuth regresi, PG/HTTP saturace, dirty generations a finální app tok. Změnu capacity policy oddělit od klasifikace chyb.

## 8. CP08 — Identity a datové rozhodovací gates

Požadavky: ID-01 až ID-05, SC-03. Stop reprodukce: doložený výsledek, ne automatická změna policy. Stop policy slice: zvlášť přijaté rozhodnutí a příslušné důkazy.

- [ ] 8.1 Prioritně ověřit shadow email E→skutečný Better Auth OTP/social fixture→původní member token a nové lokální zdroje; ověřit oba výsledky a reprodukci případné chyby bez skutečných credentials.
- [ ] 8.2 Rozhodnout minimální opravu pouze podle 8.1 a vynutit přijatý identity/principal scope; ověřit route×session/member-token matici, existing federation acceptance a odmítnutí neověřeného sloučení identity.
- [ ] 8.3 Zrekonstruovat current removal výsledek pro event/task × calendar/account × home/secondary; ověřit skutečný DB/pull/ACK včetně createIdentityVersion a retained observation, ne odvozenou resurrekci.
- [ ] 8.4 Získat a zaznamenat owner decision D1 před změnou removal policy; ověřit úplnou očekávanou matici a negativní scénáře cizích kalendářů. Bez D1 tento policy task zůstává blocked.
- [ ] 8.5 Implementovat pouze přijaté odchylky lifecycle a jejich fanout/tombstone kroky; ověřit transaction/fence races, pozdní ACK, provider kopie a atomické invalidace na skutečné PG hranici.
- [ ] 8.6 Charakterizovat DELETE→GET since a commit/cursor race s privacy/membership hranicí; ověřit last-link tombstone a současný full refresh. Jakoukoli změnu veřejné delta smlouvy podmínit D2 a kompatibilitním návrhem.
- [ ] 8.7 Udržet actor/operation/idempotence význam pro event/task create/update/delete/link/fork; ověřit replay/duplicate/commit pravdivost proti oběma klientům a nepřepsaný durable intent.

## 9. CP09 — Sjednocení klientských capability a lifecycle

Požadavky: CL-01 až CL-05, ID-02. Stop: konkrétní klientský tok odpovídá skutečně podporované serverové smlouvě.

- [ ] 9.1 Odvodit event edit hints z kanonického serverového capability kontraktu a narovnat staré odkazy assertCanEditEvent; ověřit server/web/mobile role×provider×home matrix a nezměněnou fresh server kontrolu.
- [ ] 9.2 Vyřadit nepodporované federované task write cíle při zachování read/event funkcí; ověřit web i mobil proti home/remote task route a serverovému 403 fallback. Nový task gateway je mimo tento CP.
- [ ] 9.3 Sjednotit typované výsledky neuloženo/queued/uncertain/conflict/done a retry identity; ověřit existující native timeout/draft tok a web, bez překlasifikování uložené operace na nový záměr.
- [ ] 9.4 Sloučit pouze totožné scoped refresh požadavky bez ztráty pozdější invalidace; ověřit server/account switch, foreground/SSE/network souběh a zachovaný full snapshot recovery.
- [ ] 9.5 Zpřesnit mobile SSE reconnect/session/upgrade policy podle skutečné knihovny; ověřit 401/426, cancellation a bounded retry na produkčním hooku s fixture porty i finálním nativním tokem.
- [ ] 9.6 Svázat federované requestery s explicitním server/actor lifecycle místo globálního nastavování během renderu; ověřit souběh dvou kontextů, přepnutí serveru a nezměněnou autorizaci bez mount-order závislosti.
- [ ] 9.7 Doložit změněné UI interakce podle musubi-ui, relevantní Storybook/Playwright, focus/keyboard, narrow a light/dark; native/widget chování ověřit příslušným artefaktem/zařízením, s přiznáním neprovedených platforem.

## 10. CP10 — Konfigurace a odchozí trust

Požadavky: ID-06, WF-02. Stop: nastavený profil je explicitní, chyby rozlišitelné a upgrade neprovede skrytou změnu authority.

- [ ] 10.1 Sjednotit parse/validate nastavených booleans, intervalů a klíčů a zdroj env dokumentace; ověřit validní legacy hodnoty i konkrétní neplatné vstupy bez secret dumpu.
- [ ] 10.2 Oddělit nebo výslovně deklarovat private-network/HTTPS výjimky s kompatibilní alias/deprecation politikou; ověřit prod/dev/self-host matrix a žádné tiché rozšíření cílové sítě.
- [ ] 10.3 Sjednotit outbound guard skutečného připojení a redirectu pro federační cesty; ověřit kontrolovaný DNS rebinding/redirect port, native TLS chování a povolené privátní profily bez živého útoku.
- [ ] 10.4 Odvodit CORS/trusted callback origins z přijaté konfigurace; ověřit hosted i cizí self-host a nedokumentovaný hosted fallback.
- [ ] 10.5 Zajistit validaci známě chybného klíče před novým remote side effectem a rozlišit decrypt/config chybu od provider odmítnutí; ověřit skutečné credential/federation boundaries a aktuální recovery návod.

## 11. CP11 — Integrovaná release a activation připravenost

Požadavky: PB-02 až PB-06, VT-03, SC-01. Stop: reviewovatelný readiness/rollout postup pro vybraný scope; produkční deploy není automatický výsledek tohoto programu.

- [ ] 11.1 Pro zvolený dokončený scope sestavit source/artifact/config/compatibility packet a nový redigovaný baseline collector; ověřit schema, actual digest matching, singleton a úplný journal na vlastním prostředí.
- [ ] 11.2 Ověřit isolated upgrade/restore/drain scénář pro dotčené formáty a změny; ověřit journal/counts/retained payload/credential key reference bez obnovy do produkce a bez cizího cleanup.
- [ ] 11.3 Zapsat konkrétní production activation požadavky D3, consumer/trigger a přesný HOLD při neověřené konfiguraci; ověřit simulated tag/alias ordering a immutable manifest consumer před skutečnou změnou automatiky.
- [ ] 11.4 Připravit oddělený API/web a native evidence index, existující Play/TestFlight kanály a relevantní finální app/live matici; ověřit, že neprovedené live/store/device kroky nejsou označené done.
- [ ] 11.5 Sestavit pouze readiness index výsledků již provedených kontrol vybraných slices s head/digest a odkazy; ověřit úplnost a unknown/HOLD bez půjčeného historického PASS. Chybějící kontrola se vrací vlastnímu slice, nikoli skryté souhrnné implementaci.

## 12. CP12 — Uzavření přechodu a udržovaná compatibility

Požadavky: SC-05, SC-06, WF-01, WF-03. Stop: inventář má finální explicitní stav a nepodporované/retained hranice jsou čitelné; veřejný alpha release není vyžadovaný.

- [ ] 12.1 Pro každou navrženou retire rodinu doložit D4: aktivní/retained/uncertain řádky, podporované restore/peer vstupy, živý v0 admission dané rodiny a minimální reader; ověřit negative case „prázdná fronta, starý backup“ jako HOLD.
- [ ] 12.2 Odstranit jen jednotlivou prokazatelně nahraditelnou write větev po příslušných profile tests; nebo doložit finální maintained compatibility s jedním host portem a vlastníkem, bez falešné universal portability.
- [ ] 12.3 Zachovat potřebné read decodery, marker/history a unknown-version refusal; ověřit immutable upgrade, C08 Google RSVP no-resend floor a source/installed recovery corpus bez binary rollback slibu.
- [ ] 12.4 Vyjasnit referenční roli ORM schématu, SQL migrací a triggerů a případné retained duální sloupce; ověřit skutečné readers/writers před jakýmkoli odstraněním, nepotřebný cleanup lze výslovně odložit jako P3.
- [ ] 12.5 Provést pouze závěrečný traceability diff již průběžně udržované audit→requirement→konkrétní task→evidence mapy; ověřit status/defer a rozbité reference. Neprovádět tímto boxem chybějící věcné opravy; vrátit je příslušnému slice/owner gate.
- [ ] 12.6 Zrevidovat konečný design i kombinovaný diff a předat jeho přesnou revizi; ověřit nevyřešené blocker gates a skutečný stav tasks bez schvalování veřejné SDK/Relay/push distribuce D5.

## Workflow follow-up

- Implementaci zahájit až novým výslovným zadáním po předložení těchto plánovacích artefaktů; vybrat konkrétní přijatý CP/slice.
- Merge jednotlivého implementačního PR provést squash až po zelených required kontrolách jeho aktuálního headu.
- Samostatně vybrané a autorizované vydání provede skutečnou publication/deployment/device/live acceptance; readiness packet ani archiv tuto práci nenahrazují.
- OpenSpec main specs synchronizovat/archivovat teprve po skutečném splnění přijatých tasks a projektovém review; v témže PR aktualizovat .spec-pilot.json a živé odkazy na přesunuté canonical soubory; mechanický planning-complete není důkaz implementace.
- Nový Relay, provider push, cluster a veřejný standalone package mají vlastní changes a owner rozhodnutí; nejsou skrytou podmínkou dokončení interní konvergence.
