# Vypořádání auditních pozorování

Výchozí audit: 5. listopadu 2026, b138056, 11 nezávislých reviewerů a oponentury. Přenosný index nenahrazuje specifikaci a neznamená 81 potvrzených chyb. Soukromé reporty nejsou podmínkou použití plánu. Disposition rozlišuje zúžení, hypotézy i P3 odložení.

| ID | Pozorování | Požadavky | Checkpoint | Disposition / hranice |
| --- | --- | --- | --- | --- |
| ARCH-01 | Dvě až tři živé write cesty pro tutéž operaci, bez kritéria odchodu legacy | SC-02 | CP05/06 | Zhodnotit aktuální společný lifecycle, nikoli opakovat hotové C08. |
| ARCH-02 | Routovací autorita „specializované operace“ je rozkopírovaná a ručně synchronizovaná | SC-01/04 | CP05/06 | Zúženo: reserved guard keys a terminal adoption nejsou důkaz špatného routingu. |
| ARCH-03 | Kanonická architektonická dokumentace nepopisuje nový sync stack; stav vydání má tři zdroje | WF-01/SC-01 | CP01/05 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| ARCH-04 | Matice ~10 feature flagů jako trvalá konfigurace, závislosti flagů vynucované po call-sitech včetně DB vrstvy | ID-06 | CP10 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| ARCH-05 | Testová topologie: ruční registrace v ≥5 místech, bez orphan guardu; testy balíčků nejsou typecheckované | VT-02 | CP02 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| ARCH-06 | `packages/db` je de facto doménová vrstva, ale je popisovaná jako „schema + client“ | WF-01/ID-02 | CP01/05 | Pojmenovat skutečné DB/doménové authority; nepřesouvat jen kvůli názvu balíčku. |
| ARCH-07 | Cena portable/reference stacku a evidence procesu vůči malému self-hosted produktu | WF-01 | CP12 | Design trade-off; zachovat přenositelnost a proof, měřit cenu před změnou. |
| TEST-01 | Neexistuje jedna aktuální autorita pro „finální ověření“; veřejná dokumentace popisuje starší stav | VT-05 | CP01/02 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| TEST-02 | Behavior runner je druhá orchestrace, jejíž skutečná cesta se v CI nespouští, a jeho registr je ručně zrcadlený na 4+ místech | VT-01/02 | CP02 | Scénáře v CI běží; mezera je společné CLI lepidlo. |
| TEST-03 | Jediné end-to-end testy proti skutečnému CalDAV serveru jsou mimo CI a závisí na neverzovaném souboru mimo repo | VT-04 | CP03 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| TEST-04 | Browserové fixtures jsou převážně ručně psané, nevalidované a obsahují stavový fake backend | VT-03 | CP03 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| TEST-05 | Produkční browser smoke vybírá testy regexem titulků bez kontroly počtu; hlavní e2e běží proti dev serveru a flaky testy se tiše počítají jako pass | VT-02/05 | CP02/03 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| TEST-06 | Registrace testů ručními `&&` řetězci: dnes úplná, ale bez strážce mimo DB a s maskováním dalších selhání | VT-02 | CP02 | Dnešní inventář je úplný; guard předchází dalšímu driftu. |
| TEST-07 | Cena a křehkost zpětné vazby: rozpočty na hraně a test-titulky jako smluvní data | VT-05 | CP02 | Změřit; seznam Quality jobů už má test shody, ne nehlídanou duplikaci. |
| REL-01 | Ve verzovaných záznamech chybí aktuální doložený drill izolované obnovy produkčního dumpu; DR schopnost je neověřená | PB-05 | CP11 | P2 otázka; absence veřejné evidence neznamená nikdy neprovedenou obnovu. |
| REL-02 | „Aktuální runbook“ je datovaný dokument se statusem HOLD; autorita si odporuje | WF-01 | CP01 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| REL-03 | `latest` a version tag se posouvají před hlídaným deployment tagem | PB-03 | CP04/11 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| REL-04 | Deklarované pořadí API → web nic nevynucuje | PB-03 | CP04/11 | Chybějící enforcement je fakt; StartedAt není app readiness. |
| REL-05 | Nepoměr evidence: ~940 řádků provenance CI, nasazení a obnova bez skriptů | PB-04 | CP04/11 | Trade-off; další operátorské nástroje doplnit bez rušení provenance. |
| REL-06 | Publikovaný digest se před produkcí nebootuje; smoke testy běží na jiném buildu | PB-02 | CP04 | Stejný schválený SHA; jiný skutečný build/digest potřebuje vlastní smoke. |
| REL-07 | Mobilní release nemá jediný vstup ani vlastníka | PB-04 | CP01/11 | Současný store stav unknown do inventury; zachovat Play/TestFlight kanály. |
| REL-08 | Krátce žijící evidence a „současný stav“ zapsaný na třech místech | PB-04 | CP04 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| DX-01 | Starlight průvodce pro přispěvatele popisují projekt bez web klienta a se zastaralým `pnpm check` | WF-01/02 | CP01 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| DX-02 | Rozštěpená autorita „aktuální release": README a docs/README tvrdí 0.2.2 | WF-01 | CP01 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| DX-03 | Ručně řetězené test inventáře v jednořádkových `package.json` skriptech | VT-02 | CP02 | Není doložen dnešní orphan; zabránit tichému budoucímu vynechání. |
| DX-04 | Jediný test proti reálnému CalDAV serveru je vázán na stroj vlastníka a mimo CI | VT-04 | CP03 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| DX-05 | PR smyčka nemá střední úroveň; `check` a CI jsou „vše nebo nic" | VT-05 | CP02 | Timing hypotéza; žádné vypnutí required gates. |
| DX-06 | Nejednotná autorita verze Node | WF-02 | CP01 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| DX-07 | Evidence a plánování přehlušují aktuální dokumentaci | WF-01 | CP12 | P3 navigace/archiv; žádné hromadné mazání důkazů. |
| DX-08 | Zastaralý artefakt `apps/ui-catalog` v namespace aplikací | WF-01 | CP12 | P3 odloženo do CP12 po kontrole skutečných referencí. |
| PROD-01 | Autorita „kdo smí upravit událost“ má tři implementace a dokumentovaná brána je v produkci mrtvá | ID-02 | CP09 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| PROD-02 | Role `viewer` znamená dvě různé věci a jen events cesta to rozlišuje | ID-02 | CP09 | Odlišit aplikační roli a provider evidence; nesloučit authority. |
| PROD-03 | Events a tasks deklarují stejný home model, ale kontrakt se liší v názvech, adresování, obálkách i fallbacku | ID-05/CL-02 | CP08/09 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| PROD-04 | Smazání home kalendáře: tasks zachytí provider delete pro přeživší destinace, events ne | ID-03 | CP08 | D1 a reprodukce před změnou removal policy. |
| PROD-05 | Federované kalendáře se nabízejí jako cíl úkolů, ale task mutace se nikdy nesměrují přes federaci | CL-01 | CP09 | Přiznat unsupported task write bez nové federované feature. |
| PROD-06 | Chybový kontrakt je ad hoc a uživateli prosakují interní identifikátory | CL-02 | CP09 | P3 copy/typed contract; žádný tichý wire break. |
| CLIENT-01 | Mobilní refresh: neslučované plné snímky celé historie při každém probuzení | CL-03 | CP09 | Zméřit a scoped coalesce; full snapshot recovery zachovat. |
| CLIENT-02 | Mobilní SSE nemá backoff, jitter ani kontrolu session; web ano | CL-04 | CP09 | Chování knihovny vyžaduje cílené ověření. |
| CLIENT-03 | Kontrakt widget snapshotu v2 je ručně synchronizovaný ve třech jazycích a Android parser CI netestuje | CL-05/VT-06 | CP03/09 | Build/DEX není behavior test; golden examples čtou skuteční konzumenti. |
| CLIENT-04 | Globální mutable requestery nastavované během renderu jako autorita pro federované zápisy | CL-01/03 | CP09 | Scope actor/server musí být stabilní i přes rerender a souběh. |
| CLIENT-05 | Min-version gate na mobilu je jednorázový, fail-open a 426 uprostřed session nemá stav | CL-04 | CP09 | 426/session policy i po startu, bez samoúčelného zvýšení floor. |
| CLIENT-06 | Mobil klasifikuje chyby podle řetězců, web má typované chyby | CL-02 | CP09 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| OPS-01 | Alerty nehlídají stavy doručení, které čekají na člověka; čítač „push failure“ dává flapující, neakční signál | SR-04 | CP07 | Určit user/ops ownership; ne automaticky P1. |
| OPS-02 | Logovací kontext (`requestId`, `userId`) uniká z HTTP požadavku do sdíleného sync coordinatoru | SR-03 | CP07 | Mechanismus potvrzen, výskyt neověřen; nejde o auth důkaz. |
| OPS-03 | Chybí signál „pokrok se zastavil“ pro pull a čekání (deferral/cooldown) nemá věkový strop | SR-04 | CP07 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| OPS-04 | Dvě nesladěné taxonomie závažnosti pro tutéž chybu a vícenásobné logování jedné poruchy | SR-01/04 | CP07 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| OPS-05 | Trvale nepodporovaný MS mailbox je chronická „chyba“, kterou release acceptance normalizovala | SR-04 | CP07 | Známý stav zůstane viditelný, nezakrýt nové selhání. |
| OPS-06 | Recovery/runbook autorita je zastaralá a observability runbook si sám odporuje | WF-01/PB-05 | CP01/11 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| OPS-07 | Žádné graceful shutdown: deploy přerušuje rozjeté provider zápisy | SR-05 | CP07 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| TRUST-01 | Shadow účet zabírá neověřený e-mail v přihlašovacím namespace; invariant „no session“ se nevynucuje | ID-01 | CP08 | Prioritní skutečný auth test; exploit není prokázaný. |
| TRUST-02 | Federovaný (shadow) principal má plný rozsah lokálního uživatele | ID-01 | CP08 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| TRUST-03 | Dva SSRF guardy s různou silou; zdůvodnění v ADR-005 je zastaralé | ID-06 | CP10 | Actual connection guard; bez živého útoku. |
| TRUST-04 | `FEDERATION_ALLOW_PRIVATE_HOSTS` tiše řídí i CalDAV (privátní cíle + plaintext HTTP) | ID-06 | CP10 | Upgrade-compatible explicitní private/HTTPS policy. |
| TRUST-05 | Životní cyklus klíčů: validace až při použití, nevratné side-effects před selháním, tichý decrypt fallback | ID-06 | CP10 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| TRUST-06 | Dva origin allowlisty; hostované domény natvrdo v kódu každého self-hostu | ID-06 | CP10 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| TRUST-07 | Nejednotná politika parsování env a pět míst dokumentace | WF-02/ID-06 | CP10 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| TRUST-08 | Supply-chain gate je implicitní a výjimky jsou širší, než tvrdí komentář | WF-02 | CP10 | P3 ověřit skutečnou pnpm policy a glob; změnu provést jen podle výsledku. |
| SYNC-01 | Řídicí deferral z poolu se uživateli i metrikám hlásí jako selhání doručení | SR-01 | CP07 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| SYNC-02 | Porovnání DB času s časem aplikace v `submitSyncWork` a `choose` | SR-06 | CP07 | Clock hypotéza, ne potvrzený produkční incident. |
| SYNC-03 | Zadrátovaná globální kapacita 4 sdílená dlouhými pully a interaktivními preflighty | SR-02/06 | CP07 | Capacity trade-off; změna jen se saturací, nikoli prodloužením timeoutu. |
| SYNC-04 | Asymetrická propagace selhání executorů uvnitř jednoho koordinátoru | SR-01/04 | CP07 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| SYNC-05 | Shutdown je crash-only; každý deploy nese 120 s "lease stín" a studené buckety | SR-05 | CP07 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| SYNC-06 | Náklady výběru rostou s frekvencí dokončení práce, ne s množstvím práce | SR-06 | CP07 | P3 změřit SQL/planner náklad před optimalizací. |
| SYNC-07 | Produkce běží vždy s koordinátorem a budgetem, většina testů a docs ne | VT-03/SC-07 | CP02/06 | 0.2.16 má skutečný coordinator PG/HTTP test; gap je širší pokrytí. |
| SYNC-08 | Invarianty poolu existují jako próza a scénáře, ne jako pojmenované asserty | SC-07/SR-02 | CP07 | P3 pojmenování invariantů dle potřeb scénářů, bez druhé business implementace. |
| DATA-01 | Delta `deletedIds` nikdy nevrátí uživatelské smazání eventu | ID-04 | CP08 | Kontrakt a privacy-scope; full recovery zachovat. |
| DATA-02 | Dvě sémantiky „home kalendář / tvůrce zmizel“, eventy vs. tasky a kalendář vs. účet | ID-03 | CP08 | P2 asymetrie; resurrekce je hypotéza ovlivněná retention. |
| DATA-03 | Delta cursor je wall-clock, ne commit pořadí | ID-04 | CP08 | P3 cursor race až podle kontraktu a reprodukce. |
| DATA-04 | Tři různé sémantiky retry/idempotence podle entity a typu zápisu | ID-05 | CP08 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| DATA-05 | Autorizační pravidla existují ve 4 kopiích (TS i SQL), jedna je mrtvá | ID-02 | CP09 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| DATA-06 | Federační identita má jen jednu stranu životního cyklu | ID-01/03 | CP08 | Obě strany federovaného lifecycle, nikoli jen lokální cleanup. |
| DATA-07 | Kalendářové provider mutace obcházejí outbox doktrínu (provider-first) | ID-05 | CP08 | P3 dokumentovat provider-first výjimku; ne automatický outbox rewrite. |
| DATA-08 | Schéma není jediný zdroj pravdy migrací; zbytky duálních sloupců | WF-01/SC-05 | CP12 | P3 odloženo: vyjasnit ORM vs SQL/trigger authority a retained sloupce před případnou retire. |
| WHOLE-01 | Rozporné autority aktuálního releasu | WF-01 | CP01 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| WHOLE-02 | Dvě architektury syncu vedle sebe; veřejná dokumentace popisuje jen tu starou | SC-01/02 | CP05/06 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| WHOLE-03 | Inventář JSON scénářů a DB testů se udržuje ručně na 4–5 místech a už se jednou rozešel | VT-02 | CP02 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| WHOLE-04 | Publikace je bezpečná, ale každý release se píše ručně třikrát a kontrakt „21 jobů“ je duplikovaný | PB-01/04 | CP04 | Job-name shoda už je testovaná; zbývá evidence/current authority. |
| WHOLE-05 | Vstupní příkazy pro běžný vývoj se liší mezi README, docs a AGENTS | WF-02/VT-05 | CP01/02 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| WHOLE-06 | `verify` job je sériový monolit a název „integration“ nic nevypovídá o potřebě DB | VT-05 | CP02 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| WHOLE-07 | Evidence, plány a kontrakty sdílejí `docs/` bez strukturního oddělení; roadmap je česky, zbytek anglicky | WF-01 | CP12 | P3 navigace a jasný jazyk dokumentů; zachovat historii. |
| WHOLE-08 | Self-hosting default `latest` + migrace při bootu bez generovaného pinu | PB-03/05 | CP04/11 | Zahrnuto do uvedeného checkpointu; dopad a skutečné výsledky ověřit jeho vlastní gate. |
| K-09 | Freshness accepted CI attemptu vs carried-over same-SHA jobs | PB-01 | CP04 | Statický kontraktový nesoulad; main partial chování neověřené; minulé releasy se nezneplatňují |

## Uzavření

CP05 ověří sync tvrzení proti aktuálnímu kódu. Již splněný požadavek se doloží bez redundantní implementace. P3 může mít odůvodněné odložení. Bezpečnostní a lifecycle hypotézy potřebují konkrétní reprodukci nebo věcně podložené vyvrácení. Počet nálezů není důvodem automatické opravy.
