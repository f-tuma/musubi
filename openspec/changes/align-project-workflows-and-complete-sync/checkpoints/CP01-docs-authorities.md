# CP01 — vstupní dokumentace a autority

Stav: revidovaný rozsah k nezávislému design review před editací příslušných návodů. Výchozí source base: 1bf82a8985113f8c6f3165c2c127aa831326eea4; PR #406 dosud čeká na výslovný souhlas s mergem (automatická kontrola jej odmítla), takže tento slice se připravuje v oddělené codex větvi bez změny main. Source base se při povoleném merge plánovacího PR zapíše do acceptance; kontroly finálního diffu použijí skutečný merge-base a head. Zadání vlastníka z 5. listopadu 2026: začít implementaci s Claude agenty; Its a Plan používat jako přehled nad SPEC a rovnou jej srovnat s přijatým postupem. Přijatý program: align-project-workflows-and-complete-sync. Tento brief zužuje tasks 1.1, 1.2 a 1.4; task 1.3 (toolchain koherence) zůstává samostatný slice a otevřený. Žádné nové produktové požadavky.

## Výsledek a požadavky

WF-01, WF-03, WF-04 a dokumentační část WF-02/VT-05: nový přispěvatel najde z README platný setup, nejmenší skutečný JSON scénář a pravdivý rozdíl mezi cíleným ověřením, pnpm check a celou Quality. Provozovatel najde jedinou current release autoritu a obecné recovery hranice. Historické C08–C10 readiness/acceptance nejsou vydávané za živý backlog ani důkaz nového releasu. T2 ownership mapa je realizovaná v existujících vstupech, nevznikne další runbook/registry/quickstart.

## Přesný rozsah souborů

- Koordinátor: tento brief, design.md (již upřesněný T1/D6 je součástí subjektu tohoto pre-apply review), tasks.md (jen skutečně dokončené 1.1/1.2/1.4), audit-disposition.md (jen dotčená ID), docs/project/brief.md a .spec-pilot.json (navigace/checks, bez přidání funkce).
- Contributor stream: packages/docs/src/content/docs/guides/contributing.mdx, running-locally.mdx, onboarding.mdx a reference/commands.mdx. Opravit aktuální workspace a workflow; pouze potřebné příklady, skutečnou autoritu scripts/CI odkazovat, ne ručně zrcadlit celý inventář. commands.mdx nepoužívá označení canonical pro vlastní kopii seznamu. Nepřepisovat výukový obsah nesouvisející s cílem.
- Release/navigation stream: README.md, docs/README.md, docs/releasing.md, packages/docs/src/content/docs/operations/releases.mdx, operations/capabilities.mdx (jen datovací banner, frontmatter a release odkaz; žádná nová matice nebo přepis řádků evidence) a pouze historický banner/vazba v docs/planning/sync-refactor-roadmap.md. docs/releasing.md zůstává jediný current release pointer; ostatní mají odkazy. Datované release záznamy a acceptance se nemění. Zachovat užitečná historická omezení a recovery floors.
- Acceptance/review záznamy tohoto slice pod checkpoints/ a reviews/. Read-only navíc docs/observability.md a jeho cíle pro link ledger; OPS-06 se tímto neuzavírá v runtime/alert části. Trvalá mapa autorit bude v existující sekci Vlastnictví dokumentů v docs/project/brief.md: záměr, normativní protokoly, navržené specs/design/tasks, UI (AGENTS.md, musubi-ui, docs/ui/design-system.md, packages/design-system), skutečné commands/CI, release fakta, datovaná historie, capability evidence a tracker projekce. Ostatní vstupy na ni odkážou. ARCH-06 se zde uzavře jen pokud se skutečně opraví konkrétní nepravdivý popis DB authority; jinak zůstane u CP05. Žádné edits aplikací, package skriptů, lockfile, workflow, .nvmrc, Dockerfiles, protokolů, provider feature flags nebo private env.

## Přijatá rozhodnutí

D6: vlastník výslovně zvolil Its a Plan jako přehled nad SPEC a následně požádal o srovnání trackeru. Kanonické požadavky/design/tasks a acceptance zůstávají v repu; tracker odkazuje na přesné CP a PR. Board stav sám není důkaz merge/runtime. Staré C01–C10 jsou historický program; skutečné completed stavy se bez opory neotevírají. Specifické nedokončené live/store/OAuth úkoly se nemažou a neoznačí hotové jen kvůli novému plánu. Odpovídající issue se znovu použije, pokud skutečně pokrývá celý stejný výsledek; jinak dostane vazbu na nový program. Před tvorbou hledat duplicity. Bez nových termínů a bez vyvolání jiných AI agentů přes mention.

Checks politika před CP02 je nyní již zapsaná v kanonickém T1 a research indexu, obojí je součástí pre-apply review subjektu. Brief ji pouze konkretizuje; finální merge neponese dočasný globální fast posledního slice. Node/pnpm tvrzení, .nvmrc a build toolchain se zde nemění; nesoulad lokálního Node doporučení a CI zůstává otevřený task 1.3 / DX-06.

## Tracker projekce — cílové zápisy

Jediný cílový projekt je frgtn.MUSU (id 1). Zápisy provede pouze koordinátor přes Its a Plan konektor; Claude workery zůstanou vůči trackeru read-only. Autorizace: explicitní volba vlastníka „Its a Plan jako přehled nad SPEC“ a „Rovnou ho i srovnej ať sedí k tomu co jdeme dělat“ (5. listopadu 2026), zapsáno v D6 před review tohoto briefu.

Pořadí: read-only projekt/issue inventura včetně celých acceptance MUSU-3/14/54/15/21 → vyhledat duplicity → sanitizovaná mapa před/po v soukromém receiptu → minimální zápisy → nové read-only ověření výsledku. Bez čtení celého issue se jeho scope ani stav nemění. Řešením nejistoty je ponechání stavu a přiznaná hranice, nikoli odhad hotovo.

Povolené zápisy: aktualizovat projektový popis na SPEC jako autoritu; jedna nová programová iniciativa a nejvýše jeden pointer issue pro každý CP01–CP12, bez kopírování 72 tasků; dva úzké child issues CP01 docs (tento slice) a CP01 toolchain (1.3, backlog). Pokud čerstvé hledání najde přesný ekvivalent, znovu jej použít. CP01–CP12 jsou přehled programu, nikoli schválení apply všech etap. Pointers začínají backlog/unstarted; skutečně zahájený doc slice je started až po schválení briefu. Toolchain i ostatní CP zůstanou backlog.

Issue popis obsahuje stručný výsledek, odkaz na kanonickou sekci tasks.md, stav vybraného briefu a evidence hranici. Přidat jen vztahy relates na odpovídající staré acceptance/historii (především MUSU-21→CP01, MUSU-14/15→CP11, MUSU-54→CP02/CP01.3, MUSU-40/41/42→CP05/06/07/12); žádné nové hard blockers ke starým issue. Související otevřená live/store/OAuth issue se nemažou, nearchivují a nepřesouvají do completed. Neměnit jejich lidské assignees, watchers, původní acceptance ani historii. Žádné nové termíny/cykly nebo @mentions. Nevytvářet ani neměnit columns, issue types, labels, custom fields, views, dashboards ani existující iniciativy; nová programová iniciativa používá existující projektové struktury. Žádné změny jiných projektů či Relay/push backlogu.

Sekvence vůči PR #406: dokud automatickou kontrolou vyžádaný explicitní souhlas s jeho mergem nepřijde, tento brief dovoluje lokální implementaci/ověření a autorizovanou tracker projekci, nikoli otevření CP01 PR do main, jeho merge nebo přenesení čtyř plánovacích commitů jinou cestou. CP01 PR do main se otevře až po povoleném merge #406 a přenesení pouze CP01 změn na nový main; final review i diff kontroly použijí tuto skutečnou base. Případný zamítnutý merge zůstane HOLD bez workaroundu.

Do té doby budou tracker odkazy na tasks/brief používat dostupný immutable permalink na commit obsahující soubor s výslovným stavem „přijatý plánovací obsah, PR #406 otevřený; zatím není v main“. Nevytvářet blob/main odkazy na dosud neexistující soubor ani blob/<temporary-branch> odkazy. Necommitnutý brief se nepředstírá jako dostupný URL; nejprve se commitne na codex branch a zveřejní jen branch, nikoli PR/merge. Po merge #406 se vazby aktualizují na skutečný zdroj. Aktuální PR #406 může být uveden jako otevřený návrhový PR; není source merge. Odkaz na CP01 implementační PR se přidá teprve po jeho skutečném otevření. Dokud checkpoint není mergnutý s current-head green checks a acceptance, není jeho issue completed; při dokončení této relace se truthful stav upraví podle zbývající práce (žádné zanechané vlastní started issue bez aktivní práce). CP01 umbrella není done, dokud zbývá 1.3. Tracker receipt a veřejná redigovaná mapa v acceptance odliší vytvoření/úpravu issues od source/publikace/runtime. Nejasné pokrytí či nově nalezená duplicita → return k mapě před dalším zápisem.

## Přesná branch mapa kontrol

Dočasné argument arrays (kontroly se nejdřív přečtou; nejsou automatické oprávnění spouštět config):

```json
{
  "fast": ["pnpm", "test:behavior", "--suite", "task-inspector", "--scenario", "conflict-keeps-draft", "--json"],
  "planning-whitespace": ["git", "diff", "--check"],
  "docs-build": ["pnpm", "docs:build"],
  "source": ["pnpm", "check"]
}
```

checks.full se nevytváří: neexistuje jeden ověřený příkaz pro celou Quality a source=["pnpm","check"] se za něj nevydává. Úplné dokončení checkpointu se posuzuje souhrnem skutečného source výsledku, 21 current-head Quality jobů a platných branch-protection požadavků. Jde o výslovně pojmenované CI gates mimo lokální array, nikoli vynechání testů; dokud nejsou zelené, slice není dokončený. CP02 vytvoří pravdivý full plán. Absence full v mapě znamená přiznanou chybějící orchestraci, nikdy PASS. Pro docs-only edit se cílené types/lint navíc nevyžadují: žádný TS/UI/runtime kód se nemění, MDX zkompiluje docs-build a finální pnpm check zahrne existující types/lint. Whitespace není behavior PASS.

checks.ui je v dočasné mapě vynechané: současný task-inspector browser replay je pro tento dokumentační flow neaplikovatelný, nikoli zelený. UI ověření je ruční proklik koordinátorem přes Orca browser nad build preview. Server argv: ["pnpm", "--filter", "@musubi/docs", "exec", "astro", "preview", "--host", "127.0.0.1", "--port", "4531"], cesty /docs/guides/contributing/, /docs/guides/running-locally/, /docs/guides/onboarding/, /docs/reference/commands/, /docs/operations/releases/. Desktop a úzký viewport; zaznamenat konkrétní odkazy a cíle. Přípustný produkční ekvivalent pro standalone node adapter je ["node", "packages/docs/dist/server/entry.mjs"] s HOST=127.0.0.1, PORT=4531, ASTRO_NODE_LOGGING=disabled (stejně jako docs Dockerfile). Vybere se jeden z těchto dvou režimů; záznam uvede konkrétní start a čerstvý build source/čas, aby se nepoužil starý dist. Pokud nefunguje ani jeden, je UI gate HOLD; dev server se nesmí vydávat za ověřený produkční build. Žádný nový runner ani Playwright test pro tento nízkorizikový edit.

pnpm check použije explicitní veřejné testovací env hodnoty podle Quality verify jobu: ENVIRONMENT=test, BETTER_AUTH_URL=http://localhost:7531 a DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:65439/musubi_cp01_test (záměrně vlastní neprodukční cíl, source-only check DB nepotřebuje). Žádný server, migrace či produkční DB se tímto krokem nespustí. config standardně načítá root .env; soukromý soubor se ručně neparsuje ani nevypisuje do evidence a testovací overrides se předají procesním prostředím. Pokud by kontrola vyžadovala další reálnou konfiguraci/službu, zaznamená se HOLD a změní se prostředí, nikoli business očekávání. Skutečný env/předpoklad fail je zaznamenaný HOLD, ne PASS. Konkrétní použité nonsecret hodnoty budou v acceptance.


## Ověření

- Baseline a demonstrace dokumentovaného edit-loop: `pnpm test:behavior --suite task-inspector --scenario conflict-keeps-draft --json`. Skutečný produkční inspector/serializer/client, fixture API a jsdom; není DB/auth/provider důkaz. Dokumentace tento příklad neoznačí za univerzální test projektu. Koordinátor zde výslovně volí význam relevance: jde o ověření existence a funkčnosti nově doporučeného příkladu v návodech, nikoli o regresní důkaz změněné business logiky; ta se v tomto slice nemění.
- Po úpravách: stejný JSON scénář, `git diff --check <base> HEAD` i nestaged/staged diff, `pnpm docs:build`; SPEC orient/design check a strict OpenSpec validate se skutečným absolutním repo rootem.
- Link ledger v acceptance pro každý změněný aktivní odkaz: source, target, existence/anchor nebo HTTP výsledek; interní Starlight href zkontrolovat proti skutečné route/base konfiguraci a vygenerovanému buildu. Canonical package/CI příklady porovnat se skutečnými scripts/job definicemi. Historické odkazy mít označené jako historie, nikoli automaticky zmazané.
- Finální full gate: skutečný `pnpm check` a všech 21 current-head Quality jobů plus platné branch-protection požadavky, žádný bypass. Chybějící gate zůstává HOLD.
- Finální proklik běžícího docs webu: contributor/setup/command/release navigace na desktop i úzkém viewportu, ověřit správné cíle a obsah. Je to dokumentační flow; žádná aplikace/task/DB/provider acceptance ani fyzický mobil se tím netvrdí. Browser/dev server vlastní coordinator s přesným cleanup.
- Fresh-context nezávislý spec-review před implementací briefu a před PR finálního content diffu. Vliv nových evidence souborů odlišit od schválených content bajtů.

## Audit IDs a evidence

Dotčené: ARCH-03, ARCH-06 (pojmenování autorit, nikoli přesun DB), TEST-01, REL-02, REL-07 (jen dokumentační vstup; store inventura zůstává CP11), DX-01, DX-02, OPS-06 (jen autority, ne recovery drill), WHOLE-01, WHOLE-05. Aktualizovat jen doloženou část a zachovat zbývající CP vazby. DX-06/task 1.3 zůstává otevřený. Audit řádek není uzavřený celý, pokud má ještě nedodanou runtime/policy část.

Výstup: konkrétní revize, design review, finální review, link ledger, výsledky příkazů a browser potvrzení; oddělený tracker change receipt s ID/URLs a před/po stavem bez soukromých údajů. Source merge, publication a runtime aktivace se nevydávají za totéž.

Známé meze tohoto slice: údaj Node v setupu zůstává nevyřešený 1.3/DX-06; celý setup proto není označený za plně narovnaný. Ostatní zmínky v0.2.2 mimo vyjmenovaný scope se v acceptance rozliší jako datované nebo feature-introduced; neproběhla úplná capability/runtime inventura.

## Stop a return

Stop: ověřený doc/navigation diff, pravdivá ownership mapa a tracker projekce, nezávisle schválený PR (pokud je předchozí #406 povolený a mergnutý; jinak lokální ověřená větev a explicitní HOLD této vnější hranice); 1.3 a zbývající program jsou stále otevřené. Nezačínat CP02, runtime refactor ani release v tomto slice.

Return: rozpor veřejného protokolu/recovery floor, nová toolchain/runtime změna, nedoložený stav trackeru, nesoulad skutečných příkazů či nefunkční current odkaz → zaznamenat konkrétní výsledek a vrátit se k tomuto briefu/designu. Nové produktové rozhodnutí se nejprve vrací do kanonických specs/design/tasks. Žádný checkbox done před jeho skutečnými gate výsledky. Při materiální změně briefu/diffu nové nezávislé review.
