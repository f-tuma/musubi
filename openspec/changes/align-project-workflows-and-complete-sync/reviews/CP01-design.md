# Review: CP01 pre-apply design subjekt (docs autority 1.1/1.2/1.4)

**Verdikt: APPROVE** pro přesný pre-apply subjekt níže. Jde o design review briefu před editací návodů; není to implementační PASS, souhlas s mergem, publikací, deploymentem ani důkaz spuštění jakéhokoli testu. Materiální změna briefu, design.md nebo research.md znovu otevírá review.

## Subjekt a revize

- Repo `/home/flamendrin/workspace/musubi`, branch `codex/cp01-docs-authorities`, HEAD = `1bf82a8985113f8c6f3165c2c127aa831326eea4` (= base zděděného programu, PR #406 neslouč., `main` = `b138056`).
- Manifest `backups/codex-cp01-20261105/brief-subject.json` (jediný čtený soubor z `backups/`): base `1bf82a8…`, scope „CP01 1.1/1.2/1.4 design before guide edits; user confirmed D6; no runtime/toolchain“.
- Ověřené SHA-256 pracovního stromu (shoda s manifestem):
  - `checkpoints/CP01-docs-authorities.md` = `33aaf9d0…cba76f6b7` (untracked, necommitnutý)
  - `design.md` = `c8bdc74d…582d880a` (modifikovaný vůči 1bf82a8)
  - `research.md` = `13d2ada4…e427cb611c2003ea44f5e4dfcbd3a5f5e1fd` (modifikovaný vůči 1bf82a8)
- Fingerprint přepočítaný deklarovaným algoritmem (sorted `[path, sha256]`, kompaktní JSON, bez newline) = `a070db56170dab4427d5c5d5e2fcfa642705544ce780f359a0b83c01fef34e21` (shoda).
- Delta design.md vs 1bf82a8 (`git diff HEAD`): T1 doplněna věta o dočasné branch mapě checks a jejím návratu před finálním review/mergem; T2 nový řádek „Capability/support důkazy“ (capabilities.mdx = datovaný přehled, CP01 jen banner/odkaz); D6 přepsáno z „otevřené rozhodnutí“ na „rozhodnuto vlastníkem 5. 11. 2026“. Delta research.md: jedna věta v „Project checks index“ o návratu slice overrides. Tasks.md, specs, proposal, audit-disposition jsou beze změny vůči 1bf82a8 a vůči dříve schválenému plánovacímu subjektu (40ef420 + záznamy).

## Izolace a limity

- Nový kontext (Claude Fable 5.1, Orca dispatch `task_a603724f7d8c`). Nečetl jsem konverzaci autora, prompty ani žádný soubor v `backups/` kromě manifestu. Přiznaná odchylka od zadání: při čtení repa jsem otevřel committed `reviews/final.md` a `reviews/validation.md` (součást baseline 1bf82a8, schválení staršího plánovacího subjektu 40ef420); nepřebírám z nich verdikt, nálezy níže jsou vlastní a ověřené proti zdrojům. Nic jiného z `reviews/` jsem nečetl.
- Nespouštěl jsem pnpm, build, spec/openspec, testy, DB ani síť. Pouze git, sha256/python hashing a čtení souborů (včetně `node_modules/@astrojs/node` pro ověření podpory `astro preview`).
- Neověřeno: skutečná branch protection na GitHubu, stav PR #406, existence a id projektu frgtn.MUSU a konkrétních issue MUSU-3/14/15/21/54/40/41/42 v Its a Plan, HTTP dostupnost externích odkazů, výstup `openspec validate --strict`/`spec check` pro změněný design.md.

## Přečtené zdroje

AGENTS.md; `.spec/marketplace/.../spec-review/SKILL.md`, `spec-checkpoint/SKILL.md` (identické s `.agents/skills` kopiemi), `spec-guide/assets/review.md`, `references/testing.md`, `references/contracts.md`; celý subjekt (brief, design.md, research.md) + proposal.md, tasks.md (celé), audit-disposition.md (dotčené řádky), specs `project-workflow` (WF-01…04) a `verification-workflow` (VT-05/06); `.spec-pilot.json`; `docs/project/brief.md`; `package.json` scripts, `turbo.json`, `.nvmrc`, `.gitignore`; `.github/workflows/quality.yml` (triggery, joby, verify job env); `scripts/quality-proof.mjs` (QUALITY_JOB_NAMES); `scripts/test-behavior.mjs` (SUITES) a `apps/web/src/tests/behavior/task-inspector.json`; `docs/testing/behavior-scenarios.md`; `packages/docs/package.json`, `astro.config.mjs`, `Dockerfile`; `packages/config/src/index.ts` (env načítání); `docs/releasing.md`, `docs/README.md`, `README.md`, `docs/observability.md`, `docs/releases/publication.md` (hlavička), `docs/planning/sync-refactor-roadmap.md` (hlavička); Starlight `guides/contributing.mdx`, `running-locally.mdx`, `onboarding.mdx`, `reference/commands.mdx`, `operations/releases.mdx`, `operations/capabilities.mdx`.

## Vlastními slovy: co brief dělá a kde končí

Brief zužuje přijatý program na čistě dokumentační slice CP01 (tasks 1.1, 1.2, 1.4; 1.3 toolchain zůstává samostatný a otevřený). Výsledek: README/docs/README/Starlight contributing, running-locally, onboarding, commands, releases a capabilities odkazují na jediné existující autority (docs/releasing.md pro current release, package.json + quality.yml pro příkazy/CI, behavior-scenarios.md pro JSON selekci), datované záznamy zůstávají historií s označením, roadmapa C01–C10 dostane jen historický banner, trvalá mapa autorit vznikne v existující sekci „Vlastnictví dokumentů“ v docs/project/brief.md. Žádný nový runbook/index/quickstart, žádná změna aplikace, skriptů, lockfile, workflow, `.nvmrc`, Dockerfiles, protokolů ani flagů.

Kontroly: dočasná branch mapa `fast` (task-inspector `conflict-keeps-draft --json`), `planning-whitespace`, `docs-build`, `source` (`pnpm check` s explicitními veřejnými test env hodnotami); `full` se záměrně nevytváří a je nahrazena výslovně pojmenovanými gates (`pnpm check` + 21 current-head Quality jobů + branch protection); `ui` je ruční proklik koordinátora nad build preview nebo produkčním node entry. Tracker Its a Plan (D6, rozhodnuto vlastníkem): read-only inventura → duplicity → privátní mapa → minimální zápisy jen koordinátorem (popis projektu, 1 iniciativa, ≤1 pointer issue na CP, 2 child issues CP01) → re-read; bez mazání/uzavírání starých issue, bez termínů, mentions, nových struktur. Vůči PR #406: lokální implementace a tracker projekce ano; CP01 PR do main, merge nebo přenos plánovacích commitů jinou cestou ne, dokud není #406 výslovně povolen a mergnut.

## Ověření tvrzení briefu proti zdrojům

| Tvrzení | Výsledek |
| --- | --- |
| Suite `task-inspector` a scénář `conflict-keeps-draft` existují | Potvrzeno: `scripts/test-behavior.mjs:35`, ids v `task-inspector.json` = edit-preserves-content, conflict-keeps-draft, mirror-is-readonly, cancel-delete-keeps-task; příklad už je v `docs/testing/behavior-scenarios.md` |
| `pnpm docs:build`, `pnpm check`, `git diff --check` existují; `pnpm check` zahrnuje types/lint i docs build | Potvrzeno: `docs:build` = `pnpm --filter @musubi/docs build`; `check` = release:verify → check:contracts → peers → test:query-runtime → typecheck → test → lint → build (turbo build zahrnuje `@musubi/docs` `astro build`) |
| 21 Quality jobů, verify job env `ENVIRONMENT=test`, `BETTER_AUTH_URL=http://localhost:7531`, bez DB služby | Potvrzeno: `quality-proof.mjs:17-23,61`; `quality.yml:279-307` (verify job nemá postgres service, env jen pro `@musubi/config` import). Vlastní neprodukční `DATABASE_URL` v briefu je tedy konzistentní s tím, že check DB nekontaktuje |
| `@musubi/config` čte root `.env` při importu; process env přepíše | Potvrzeno `packages/config/src/index.ts:21-28,246-250` |
| `astro preview` nad standalone node adapterem; produkční ekvivalent `node dist/server/entry.mjs` s HOST/PORT/ASTRO_NODE_LOGGING | Potvrzeno: `astro.config.mjs` adapter node `standalone`; `@astrojs/node@11.1.3` má `previewEntrypoint`; `packages/docs/Dockerfile` používá přesně tyto env a `CMD node ./dist/server/entry.mjs` |
| Starlight cesty `/docs/guides/contributing/`, `/docs/guides/running-locally/`, `/docs/guides/onboarding/`, `/docs/reference/commands/`, `/docs/operations/releases/` | Potvrzeno: `base: "/docs"`, slugs v sidebaru, soubory existují |
| Drift, který CP01 opravuje, skutečně existuje | Potvrzeno: README:63 „current API/web release is 0.2.2“; docs/README „Published artifacts remain v0.2.2“ + 0.2.2/0.2.3 runbook odkazy; capabilities.mdx „current capability summary for v0.2.2, reviewed 5 October 2026“; docs/releasing.md „Follow the [current runbook](releases/0.2.12-readiness.md)“; releases.mdx:270 „current production runbook“ → 0.2.12-readiness; commands.mdx description „The canonical command reference“; contributing.mdx „twelve self-checks“, „build the API Docker image“, workspace tabulka bez `apps/web`; onboarding.mdx „twelve self-checks“ |
| docs/releasing.md je současný current pointer | Potvrzeno: „Current published release: 0.2.16 (5 November 2026)“ |
| Node nesoulad je mimo scope (1.3/DX-06) | Potvrzeno rozpor: `.nvmrc` 24.15.0, README/running-locally „22.12+“, CI `node-version: 22`, docs Dockerfile 22.23.4. Brief jej správně nechává otevřený |
| `backups/` je git-ignorované | Potvrzeno `.gitignore` `/backups/` |
| Quality běží pro branch | Částečně: `quality.yml` trigger = `pull_request` + `push` pouze `main`. Pro codex branch bez PR tedy žádná Quality evidence nevznikne (viz R-03) |
| Audit ID v briefu odpovídají disposition | Potvrzeno: ARCH-03 (1.1), ARCH-06 (1.4, jen pojmenování), TEST-01 (1.2), REL-02 (1.1–1.2), REL-07 (1.2 doc část), DX-01/02 (1.2/1.1), OPS-06 (1.2 autority), WHOLE-01/05, DX-06 → 1.3 otevřený |

## Posouzení podle otázek zadání

- **User scope vs. kanonické autority:** brief jen zužuje tasks 1.1/1.2/1.4 a T2; nepřidává požadavek. Delta design.md (T1 návrat overrides, T2 capabilities řádek, D6) je v souladu s WF-01/WF-03 a uzavírá dřívější otevřenou otázku R-01 plánovacího review variantou „návrat před mergem“. Capabilities řádek je konzistentní s tím, že nová inventura zůstává CP05/MUSU-21.
- **Malá vykonatelnost:** vyjmenované soubory existují, příkazy existují, každý editovaný povrch má jednu cílovou autoritu, write scope trackeru je spočitatelný (1 popis, 1 iniciativa, ≤12 pointerů, 2 child issues, relates jen k jmenovaným starým issue).
- **Fast/full honestly:** `fast` je skutečný produkční JSON scénář; brief sám přiznává, že neprokazuje změněnou business logiku. `full` se nevydává za `pnpm check`; 21 jobů + branch protection jsou pojmenované externí gates (VT-05). Whitespace a docs-build jsou správně označené jako ne-behavior.
- **Manuální docs UI hranice:** poctivá — browser replay task-inspector je pro docs neaplikovatelný, nikoli zelený; preview nebo produkční entry nad čerstvým buildem, dev server se nevydává za produkci, žádný nový runner.
- **Tracker write scope:** konkrétní, autorizovaný D6, read-only nejdřív, read-only workery, explicitní zákazy (mazání, completed, assignees, termíny, mentions, struktury, jiné projekty), truthful stavy (backlog default, started jen aktivní slice, completed jen po merge s green checks).
- **Kontroly/stop/return:** stop je přesný včetně HOLD vnější hranice #406; return pokrývá rozpor protokolu, toolchain/runtime změnu, nedoložený tracker stav, nesoulad příkazů, nefunkční odkaz, nové produktové rozhodnutí.
- **Ochrana historie/kompatibility:** datované receipts/acceptance beze změny, recovery floors zachované, roadmapa jen banner, staré C01–C10 a live/store/OAuth issue nedotčené, žádná runtime/config/flag změna.

## Nálezy

Žádný blocker. R = doporučení (nemění bajty subjektu; jde o podmínky provedení nebo záznamu v acceptance), D = rozhodnutí vlastníka/koordinátora, které má být zapsané před dotčeným krokem.

| ID | Typ | Očekávaný stav a zdroj | Nález a důkaz | Dopad / jistota | Další krok |
| --- | --- | --- | --- | --- | --- |
| R-01 | Doporučení | tasks.md:12 a design T1: před apply se nastaví `checks.fast/full/ui` dle briefu a před finálním review/mergem se slice overrides vrátí ke sdílenému indexu; brief uvádí `.spec-pilot.json` ve scope koordinátora „(navigace/checks, bez přidání funkce)“ | Brief dává kompletní dočasný objekt `{fast, planning-whitespace, docs-build, source}` bez dnešních sdílených klíčů `database` a `ui`. Není řečeno, zda jde o náhradu celého `checks` (klíče `database`/`ui` na větvi zmizí) nebo o override jmenovaných klíčů, ani zda má finální PR nést nějaký trvalý diff `.spec-pilot.json` (např. navigaci na `checkpoints/`/`reviews/`) | Střední pro čitelnost workflow a pro mechanický `spec check`; nízké riziko pro produkt. Jistota vysoká, že je to nejednoznačné | Před apply zapsat do STATUS/acceptance: (a) dočasná mapa = override jmenovaných klíčů, `database`/`ui` se na větvi ponechají nebo výslovně vynechají s důvodem; (b) před finálním review se `.spec-pilot.json` porovná hashem s verzí v 1bf82a8 a trvalý diff je buď žádný, nebo výslovně vyjmenovaný |
| R-02 | Doporučení (podmínka před tracker zápisy) | Brief: tracker odkazy jen na immutable permalink commitu obsahujícího soubor; necommitnutý brief se nepředstírá jako URL | D6 „rozhodnuto“ existuje pouze v necommitnutém design.md; v 1bf82a8 (jediný dostupný permalink) je D6 ještě otevřené. Popis issue citující D6 nebo tento brief by odkazoval na commit s opačným stavem. Zároveň CP01 PR tím ponese i editaci kanonických design.md/research.md (vlastník si to má uvědomit; tasks.md to pro odchylku předpokládá) | Střední pro pravdivost trackeru; jistota vysoká | Před prvním zápisem commitnout na codex branch společně brief + design.md + research.md + tento review a odkazovat na tento commit s výslovným stavem „přijatý plánovací obsah + D6, PR #406 otevřený; není v main“. V CP01 PR popisu uvést, že nese kanonickou delta (T1/T2/D6) |
| R-03 | Doporučení | Brief: full gate = `pnpm check` + 21 current-head Quality jobů + branch protection; stop bez #406 = lokální ověřená větev + explicitní HOLD | `quality.yml` spouští Quality jen pro `pull_request` a `push` na `main`. Pro codex branch bez PR tedy 21-job evidence nemůže vzniknout vůbec; HOLD je v briefu správně, ale nevyjadřuje, že jde o nemožnost, a nevylučuje „PR proti plánovací větvi“ jako obcházku (pull_request trigger nemá filtr base) | Nízký; jistota vysoká | V acceptance zapsat „Quality pro tuto větev neexistuje (trigger PR/main)“ jako HOLD důvod; výslovně nepoužít PR proti jiné base jen kvůli vyvolání Quality |
| R-04 | Doporučení | Brief: capabilities.mdx se edituje (banner, frontmatter, release odkaz); UI proklik má 5 cest | Seznam proklikaných cest neobsahuje `/docs/operations/capabilities/`, přestože je stránka editovaná a je cílem odkazů z README/docs/README/releasing | Nízký; jistota vysoká | Přidat `/docs/operations/capabilities/` do proklikaných cest a link ledgeru |
| R-05 | Doporučení | tasks.md:12 „Před prvním briefem i po odchylce projde strict OpenSpec validace“; brief uvádí validate/spec check až po úpravách | design.md se po validaci v `reviews/validation.md` (40ef420) změnil (D6, T1, T2). Záznam validace nového design.md před apply chybí | Nízký (formát), jistota střední | Spustit `openspec validate … --strict` a `spec check --phase design` s absolutním rootem nad commitem z R-02 ještě před editací návodů a zapsat výsledek |
| R-06 | Doporučení | Brief: `pnpm check` lokálně jako source výsledek; 1.3 otevřený | Lokální Node (`.nvmrc` 24.15.0 vs CI 22; v tomto checkoutu `node --version` = 22.23.4) není součástí deklarace. Lokální `pnpm check` tak může běžet pod jiným majorem než CI | Nízký; jistota vysoká | Do acceptance zapsat skutečnou Node/pnpm verzi lokálního `pnpm check` a neoznačovat jej za CI-ekvivalent; CI job zůstává gate |
| D-01 | Rozhodnutí (zapsat, nikoli měnit) | design T1: „Fast musí zahrnovat nejmenší relevantní produkční JSON scénář … a relevantní types/lint“ | Brief vědomě nezahrnuje types/lint do `fast` (docs-only; MDX kompiluje docs-build, finální check má lint). Čtení „relevantní = žádné“ je obhajitelné, ale je to výklad T1, ne doslovné naplnění | Nízký | Koordinátor/vlastník potvrdí tento výklad v acceptance jedním řádkem; bez změny briefu |
| D-02 | Rozhodnutí (existuje, potvrdit při inventuře) | Brief: jediný cílový projekt frgtn.MUSU (id 1), relates MUSU-21→CP01, 14/15→CP11, 54→CP02/CP01.3, 40/41/42→CP05/06/07/12 | Id a obsah issue jsou z briefu, nebyly v tomto review ověřitelné (bez sítě). Brief správně vyžaduje read-only inventuru včetně celých acceptance před zápisem | Nízký, jistota: nelze posoudit | Read-only inventura potvrdí ref/id a každé relates jen po přečtení celého issue; nejistota = ponechat bez vazby a zapsat hranici |

## Neposouzené oblasti

Skutečné provedení jakéhokoli příkazu; obsah live tracker projektu; GitHub branch protection a stav/merge #406; HTTP dostupnost externích odkazů v editovaných stránkách; úplná inventura všech zmínek v0.2.2 mimo vyjmenovaný scope (brief ji výslovně nenárokuje); obsah 11 privátních auditních reportů.

## Vypořádání

Nálezy R-01…R-06 a D-01/D-02 nevyžadují změnu bajtů subjektu; jsou to podmínky zápisu/pořadí provedení, které koordinátor doloží v STATUS.json a v acceptance CP01. Pokud by jejich řešení vedlo ke změně briefu, design.md nebo research.md, platí WF-03: nové review nového fingerprintu.

## Verdikt

**APPROVE** pro fingerprint `a070db56170dab4427d5c5d5e2fcfa642705544ce780f359a0b83c01fef34e21` (brief `33aaf9d0…`, design.md `c8bdc74d…`, research.md `13d2ada4…`) nad base `1bf82a8`. Brief je konzistentní s přijatým designem a WF-01…04/VT-05, používá jen existující autority a příkazy, přiznává chybějící full orchestraci a manuální UI hranici, vymezuje tracker zápisy úzce a chrání historii i kompatibilitu. Toto schválení se týká pouze návrhu před editací návodů; final content diff vyžaduje samostatné fresh-context review, CP01 PR do main čeká na výslovně povolený merge #406 bez obcházky a žádný checkbox 1.1/1.2/1.4 není tímto review hotový.

Reviewer: Claude Fable 5.1 (fresh-context, Orca worker `task_a603724f7d8c`, 5. listopadu 2026).
