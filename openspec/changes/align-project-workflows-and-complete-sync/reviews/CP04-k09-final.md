# Nezávislý final review — CP04 slice 4.1–4.2 (K-09 freshness accepted attemptu), finální diff

## Subjekt a přesná revize/hashe

- Worktree `/home/flamendrin/orca/workspaces/musubi/codex-cp04-k09-freshness`, větev `codex/cp04-k09-freshness`, HEAD `fe55449e1222581bb3c9d02fa0dd550416eb1dbe`, merge-base s `e6015977adba39e909a0824787ac9adcb64a8e99` = právě tato base. `git status --porcelain` prázdný (čistý strom). Dva commity nad base: `48e8d432…` (jen docs/checkpoint/review/K-09 řádek) a `fe55449e…` (implementace + testy + publication.md + acceptance + K-09 řádek).
- Manifest `/tmp/musubi-k09-final-subject.json`, SHA256 `7a0baf814cce623159e6ca67fbd35fe6a716ed3c87f7bd3fb3c6c7b0d3f26747`; base/head/root v manifestu odpovídají skutečnosti.
- Všech 8 souborů manifestu: SHA256 pracovní kopie **i** HEAD blobu (`git cat-file -p HEAD:<path>`) shodné s manifestem:
  - `docs/releases/publication.md` `48afcccb…fddd` OK/OK
  - `…/audit-disposition.md` `5d7c0310…abae` OK/OK
  - `…/checkpoints/CP04-k09-acceptance.md` `03e1bd27…000b` OK/OK
  - `…/checkpoints/CP04-k09-freshness.md` `9df4d1aa…c694` OK/OK
  - `…/reviews/CP04-k09-design.md` `f9c17575…c07d` OK/OK
  - `scripts/quality-proof.mjs` `00324baa…be66` OK/OK
  - `scripts/quality-proof.test.mjs` `3aa88725…2750` OK/OK
  - `scripts/verify-publication.test.mjs` `e32294ae…b094` OK/OK
- `git diff --name-status base..HEAD` obsahuje přesně těchto 8 souborů (M/M/A/A/A/M/M/M); nic jiného (žádný lockfile, package.json, workflow YAML, `.spec-pilot.json`, `tasks.md`, `verify-publication.mjs`, `release-guard.mjs`).
- `.spec-pilot.json`: pracovní kopie = HEAD = base = `099538b4…10ae` (restore doložen).
- `scripts/verify-publication.mjs` na HEAD = base `6892d47b…97db` (beze změny kódu, dle kontraktu).

## Otázka a rozsah

Splňuje přesný finální diff `e6015977..fe55449e` přijatý checkpoint `checkpoints/CP04-k09-freshness.md` (včetně koordinačních rozhodnutí §0 DR-01–DR-06), PB-01, T9, tasks 4.1/4.2 a před-CP02 výjimku, a je připraven na PR s explicitním nezávislým schválením? CI/branch-protection checks, 21/21 current-head Quality a merge zůstávají samostatné budoucí gates; tento review není CI, merge ani publication povolení.

## Izolace a limity

Čerstvý Orca worker (task `task_f7194eeecb5c`), vlastní kontext. Nečetl jsem autorovu konverzaci, jiné agentní reviews ani orchestration prompty; design review `reviews/CP04-k09-design.md` jsem četl jako kanonický vstup checkpointu (je součástí subjektu), ne jako očekávaný verdikt. Žádný zápis do gitu/source/trackeru, žádný push/PR/merge/instalace/build/síť/rerun. Jediné zápisy: tento soubor a scratch kopie v session scratchpadu (`…/scratchpad/k09/{green,red,M1,M2,M2b,M3}`) pro nezávislé read-only spuštění `node --test` mimo repo.

## Skutečně čtené zdroje

AGENTS.md/CLAUDE.md; skills `spec-review`, `spec-checkpoint`, `spec-guide` (SKILL.md, `references/contracts.md`, `references/testing.md`, `assets/review.md`) z `/home/flamendrin/workspace/musubi/.agents/skills`; change `align-project-workflows-and-complete-sync`: `specs/publication-operations/spec.md` (PB-01 L9–14), `design.md` T9 (L107–109), `tasks.md` (L1–20, L72–82; 4.1/4.2 na HEAD nezaškrtnuté), `audit-disposition.md` řádek K-09, `checkpoints/CP04-k09-freshness.md` (celý), `checkpoints/CP04-k09-acceptance.md` (celý), `reviews/CP04-k09-design.md` (celý); celý diff base..HEAD; celý `scripts/quality-proof.mjs` (HEAD), celý `scripts/quality-proof.test.mjs`, `scripts/verify-publication.test.mjs` L1–130 a L195–260, `scripts/verify-publication.mjs` L130–160 a L190–310 (proofBinding, validateLinkedQuality, collectPublicationProof), zapojení `release-guard.mjs` L5/L199/L212 a `release-guard.test.mjs` (port `qualityCheck`), `docker-publish.yml` (record/prepare/release), `docs/releases/publication.md` L38–56 a L107, `docs/releases/0.2.12-readiness.md` L378–390, `scripts/test-behavior.mjs` L8; gitignorovaná evidence `backups/spec-sessions/cp04-k09-20261106/`: STATUS.json, mutations-index.json, p1-canonical-hashes.json, final-source-sha256.txt, spec-pilot-temp-map.json, všechny `runs/*.json` + relevantní `.stdout/.stderr`, `dr01/*` (receipt + raw run + raw jobs).

## Vlastní popis chování a hranic diffu

Sdílený `validateQualityProof` (quality-proof.mjs) dostává dvě spodní meze: (1) `validateNativeSteps(steps, android, acceptedStartedAt)` uvnitř smyčky kroků za stávajícím strukturálním `require` kontroluje `Date.parse(step.startedAt) >= Date.parse(acceptedStartedAt)` s hláškou „native verification step started before the accepted attempt“ (L38); (2) ve smyčce jobů po stávajícím strukturálním `require` (L67–70) se nejdřív volá `validateNativeSteps(…, run.startedAt)` (L72) a teprve pak nový `require(Date.parse(job.startedAt) >= Date.parse(run.startedAt), "Quality job started before the accepted attempt")` (L73). `run.startedAt` je sanitizovaný `run_started_at` (L175); `timestamp()` je u `run.startedAt` (L60), `job.startedAt` (L69) i `step.startedAt` (L36) ověřen dřív, takže `Date.parse` nové meze nevrací NaN na akceptované cestě. Mez `>=` kvůli výchozí fixture (`run_started_at === started_at`) a sekundové granularitě GitHub API. Pořadí diagnostik: u stale Android jobu padne native hláška dřív než job hláška; přijímaná množina receiptů se tím nemění.

Pravidlo platí bez změny kódu ve všech třech konzumentech: collector `collectQualityProof` (job `quality-proof` record, L233), recheck `recheckQualityProof` (validuje pinned receipt L209/L250 i čerstvý snapshot L233; volán z `release-guard.mjs` v jobs `prepare`/`release`), a post-publikační verifier `collectPublicationProof` → `proofBinding` (verify-publication.mjs L202), který navíc pinuje živá data rovností na receipt (L229–230, L242–248). Verifier validační chyby nebalí (try/catch jen kolem `readJSON`/`downloadArtifact`), hláška doputuje do `assert.rejects`.

Testy: A (carried-over non-Android `jobs[0]` „API container boots and serves“ 10:05–10:10 při `run_started_at` 10:20, attempt 2, `created_at` 10:00 → reject; posun celého intervalu na 10:20–10:30 → resolve, `run.attempt === 2`, 21 jobů, všechny `startedAt >= run.startedAt`), B (Android job 10:05–10:15 s kroky 10:05–10:10 a 10:10–10:15 → native hláška), C (verifier: `qualityRun.run_started_at` i `proof.run.startedAt` 00:30, `proof.jobs[0]` 00:05–00:10 zrcadleno do `qualityJobs.jobs[0]`, `recheck.proofSha256` spočten přímo přes sha256 nad `json(proof)` → reject „Quality job started before the accepted attempt“). Všechny tři názvy obsahují „accepted attempt“. Vše na existujících portech (`fetchImpl`/`git`/`readJSON`/`downloadArtifact`/`setEvidence`), bez nového runneru/driveru; žádná kopie business logiky. Jedna věta v `publication.md` za „…shipped DEX steps.“. Mimo rozsah (dle checkpointu, zde neposuzováno jako vada): horní meze vůči `run.updatedAt`, 9 publication jobů, inventář, consumer/latest/tag, skutečný GitHub partial rerun.

## Ověření kontraktu proti diffu (checkpoint §1–§7 a §0)

| Požadavek | Stav | Evidence |
| --- | --- | --- |
| §2 přesná místa a tvar změn (parametr + 2 `require`, pořadí native→job, `>=`, statické hlášky, nic jiného) | splněno | diff quality-proof.mjs +4/−2 (L28, L38, L72, L73); hlášky bez URL/tokenů; regex `/wrong-attempt/` (test L106) dál platí, hláška L70 nezměněna |
| §2 verify-publication.mjs bez změny kódu; release-guard bez změny (DR-02) | splněno | oba soubory mimo diff; hashe shodné s base |
| §3 Fixture K (A, B) a V (C) přesně dle briefu | splněno | test L117–148; L214–225; `created_at 10:00 < run_started_at 10:20` (M2 diskriminace); C zrcadlí časy do `qualityJobs.jobs[0]` (jinak „differ“ L249) a přepočítává `proofSha256` přímo (DR-03) |
| §1 výsledek: A/B reject, fully fresh attempt 2 resolve, C reject ve verifieru | splněno | nezávislý běh (níže) |
| Nezměněná stávající očekávání/schema/inventář/CI/lockfile/verze | splněno | diff obsahuje jen 8 souborů; žádný stávající test upraven (diff testů jen přidává); `QUALITY_JOB_NAMES`, schema receiptu, workflow YAML nedotčeny |
| §5 `.spec-pilot.json` obnoven; sdílený goal/stop nezměněn | splněno | hash `099538b4…10ae` = base = HEAD = pracovní kopie |
| §7/DR-05: tasks 4.1/4.2 nezaškrtnuté; K-09 řádek jen dílčí stav, ne „hotovo“ | splněno | tasks.md L76–77 `[ ]` na HEAD; K-09 řádek výslovně „final review, PR, 21/21, branch protection a merge otevřené; 4.1/4.2 nezaškrtnuté“ — odpovídá §7 „po lokálním výsledku je stav dílčí“ |
| DR-04: node:test na existujících portech je přijatý nejmenší scénář; `pnpm test:behavior --list` N/A inventář doložen | splněno | `runs/behavior-list` exit 0, 27 suite, žádná pro `scripts/quality-proof`/`verify-publication` (vlastní grep 0 shod); `SUITES` v test-behavior.mjs:8 je neobsahuje |
| DR-01: read-only kontrola reálného Quality běhu, credential-free receipt | splněno s limitem (viz FR-02) | nezávisle přepočteno z raw `run-42124082949.json` a `jobs-…-pages.json`: run 42124082949, attempt 1, head `5bfb3413…`, Quality `.github/workflows/quality.yml`, completed/success, `run_started_at 2026-11-05T22:44:53Z`; 21/21 přesná jména, 21 unikátních ID, všechny attempt 1 / stejný run_id / stejný SHA / completed+success; offset `started_at − run_started_at` 3–145 s, všechny ≥ 0; native kroky „Build native APK and AAB with system bar verification“ (#11, +86 s) a „Verify shipped DEX“ (#12, +707 s) každý právě jednou, seřazeny, completed/success. Žádný token v receiptu. |
| §6/§0: žádná instalace frameworku/nových závislostí, žádný release/deploy/tag/rerun | splněno | `pnpm-install-frozen` „Already up to date“, lockfile mimo diff; DR-01 jen GET; žádný `workflow_dispatch` |
| Strict OpenSpec + `spec check` | splněno | autorovy `openspec-validate-{pre,post-p1,final}` valid/0 failed, `spec-check-final` mechanical pass; vlastní read-only `openspec validate … --strict --json` nad HEAD: `passed 1, failed 0, issues []` |
| Whitespace | splněno | vlastní `git diff --check e6015977 HEAD` exit 0 |

## Porovnání raw execution evidence s tvrzeními acceptance (nepřebírám PASS, přepočítáno)

| Tvrzení acceptance | Raw záznam | Shoda |
| --- | --- | --- |
| Baseline na base 40/40, exit 0, 4459 ms | `runs/baseline-fast.json` counts 40/40/0, exit 0, 4459 ms, stderr 0 B | ano |
| Red 43 testů, 40 pass, 3 fail, všechny `Missing expected rejection.` | `runs/red-fast.stdout` not ok 5, 6, 35, každý `error: 'Missing expected rejection.'` | ano (red ze správného důvodu = resolve) |
| Green 43/43; úzká smyčka 3/3 | `green-fast` 43/43 exit 0; `green-narrow` argv `--test-name-pattern "accepted attempt"` 3/3 | ano |
| M1: A i C `Missing expected rejection`, B ok (41/2) | `mut-M1…stdout` not ok 5 a 35, oba `Missing expected rejection.` | ano (DR-03: C pod M1 skutečně resolve) |
| M2: A i C resolve (41/2) | not ok 5 a 35, `Missing expected rejection.` | ano |
| M2b: jen B, actual „Quality job started…“ (42/1) | not ok 6, `error: 'Quality proof: Quality job started before the accepted attempt'` | ano |
| M3: jen B, actual „Quality job started…“ (42/1) | not ok 6, tatáž hláška | ano |
| Obnovený green 43/43 | `green-restored` 43/43 exit 0 | ano |
| Mutace v kopiích mimo repo, přesné páry a hashe | `mutations-index.json`: cwd v cizím scratchpadu; mutované hashe `e7cd0761…`, `0cd30932…`, `54afe518…`, `2dad56b5…` | ano — všechny čtyři hashe jsem **reprodukoval** aplikací popsané mutace na HEAD `quality-proof.mjs` (bajtově shodné) |
| `pnpm check` exit 0, 225 067 ms, root node:test 183/183, stderr jen SMTP timeout varování | `pnpm-check-final.json` exit 0, 08:21:50–08:25:35 UTC; stdout `# tests 183 / pass 183 / fail 0`; stderr: nodemailer `Timeout` v JSON logu `email.smtp_unavailable`, žádná neúspěšná úloha | ano (lokální běh, ne CI) |
| final-source-sha256.txt = HEAD | 5 hashů shodné s HEAD bloby; mtime 09:21:32 +0100 (po green-restored 08:21:32 UTC, před pnpm check) | ano |
| DR-01 receipt | viz tabulka výše | ano |

**Nezávislé spuštění (read-only, kopie přes `git archive HEAD` v session scratchpadu, Node v22):**
- green (HEAD): exit 0, 43/43, stderr 0 B.
- red (base `quality-proof.mjs` `d287a28d…` + HEAD testy): exit 1, 40/3, not ok 5/6/35 každý `Missing expected rejection.`
- M1 (odstraněn L73; sha `e7cd0761…` = index): exit 1, 41/2, not ok 5 a 35 `Missing expected rejection.` → přenos do verifieru přes sdílený validátor doložen nezávisle.
- M2/M2b/M3: hashe mutovaných souborů reprodukovány bajtově; běhy jsem nereplikoval (autorovy raw výstupy jsou konzistentní s kódem a s M1 reprodukcí).

## Nálezy

Žádný blocker. B = blocker, R = rozhodnutí vlastníka, D = doporučení.

| ID | Třída | Očekávaný stav a zdroj | Nález a evidence | Dopad / jistota | Další krok |
| --- | --- | --- | --- | --- | --- |
| K09-FR-01 | D | acceptance §2: přesný popis diffu | Acceptance uvádí pro `scripts/quality-proof.mjs` „Diff: +3/−2 řádky“; skutečný `git diff --numstat` je **+4/−2** (L28 a L72 změněny, L38 a L73 přidány). Obsahový popis změn je jinak přesný. | Kosmetická nepřesnost záznamu; vysoká jistota. | Opravit číslo v acceptance (lze v PR nebo follow-up); nemění kód ani verdikt. |
| K09-FR-02 | D | §0 DR-01: reálná data mají doložit vztah k `run_started_at`; brief §3: fixture `created_at < run_started_at` odlišuje M2 | V reálném běhu 42124082949 je `created_at === run_started_at` (`2026-11-05T22:44:53Z`), takže tento receipt **nerozlišuje** mez vůči `run_started_at` od meze vůči `created_at`; diskriminaci dokládá pouze fixture (M2/M2b). Receipt ani acceptance §5 tento limit výslovně neuvádějí. | Nízký; DR-01 jinak splňuje přijatý účel (reálná data mez `>=` splňují, žádný rozpor). Vysoká jistota. | Doplnit do `limits` receiptu/acceptance větu, že attempt 1 má `created_at == run_started_at` a diskriminace vůči `created_at` je jen z fixtures. Žádná změna kódu. |
| K09-FR-03 | D | T9/PB-01: pravidlo ve sdíleném validátoru; audit K-09 „minulé releasy se nezneplatňují“ | `verify-publication.mjs` je dokumentovaný i jako dodatečný read-only verifier historických publikací (`docs/releases/0.2.12-readiness.md` L382, `publication.md` L107). Sdílený validátor tedy nově aplikuje mez i při re-verifikaci starších publication runů. Pokud by některý historický Quality běh měl job/krok před `run_started_at` (main partial chování je dle audit řádku neověřené), jeho zpětná re-verifikace by nyní selhala; samotné vydání se tím nezneplatňuje. Checkpoint tuto hranici nepojmenovává. | Nízký, fail-closed, bez vlivu na nové publikace; rozsah přijat design review (sdílený validátor). Střední jistota, že žádný historický běh mez neporušuje (nemám jeho data). | Zaznamenat jako přiznanou hranici (acceptance/publication kontrakt nebo follow-up); případně při příští re-verifikaci historické publikace vyhodnotit skutečný výsledek. Žádná změna v tomto slice. |

Ověřeno a bez nálezu: funkční správnost obou mezí a jejich fail-closed chování; pořadí strukturální → native → job diagnostik přesně dle §2; reuse jednoho validátoru pro collector/recheck/verifier bez duplikace; konzistence fixtures K/V (časy run/job/step uvnitř intervalů, attempt 2 v K, zrcadlení živých dat ve V); diskriminační síla A/B/C a fully-fresh varianty (red = resolve, M1–M3 chytány přesně předpovězenými testy); nezměněná původní očekávání/schema/inventář/CI/lockfile/verze; restore `.spec-pilot.json`; tasks 4.1/4.2 nezaškrtnuté; commit messages s přesným popisem; `git diff --check` čistý; strict OpenSpec valid.

## Neposouzené hranice

- Skutečné chování GitHub API při partial rerunu (hodnoty `started_at`/`run_attempt`/ID carried-over jobů) — T9 experiment zakazuje; fixtures ani DR-01 (attempt 1, `pull_request` event, ne main push, ne rerun) to nedokládají.
- Runtime nové implementace proti reálnému GitHub běhu (record/recheck v `docker-publish.yml`) — nastane až první skutečnou publikací.
- 21/21 current-head Quality na PR headu, branch protection, merge — budoucí samostatné gates; žádný PR dosud neexistuje.
- `pnpm check` jsem neopakoval (autorův raw běh exit 0 nad finálními hashi, lokálně, ne CI); M2/M2b/M3 běhy jsem nereplikoval (jen reprodukce hashů mutovaných souborů).
- Historické Quality běhy již vydaných verzí (viz FR-03) — bez síťového přístupu nehodnoceno.
- `verify-publication.mjs` L1–130 (ZIP/JSON čtečka) a `release-guard.mjs` mimo zapojení `qualityCheck` — nedotčeny diffem, čteno jen letmo.

## Disposition nálezů

FR-01 a FR-02 jsou drobné opravy/doplnění textu evidence, FR-03 je přiznání hranice; žádný z nich nemění kód, testy, rozsah ani kontrakt a žádný neblokuje otevření PR. Lze je vyřešit úpravou acceptance záznamu v téže větvi (materiálně nemění reviewovaný kód; při změně pouze dokumentace evidence není nutný nový review kódu) nebo follow-upem.

## Verdikt

**APPROVE** — pro přesně tento diff `e6015977adba39e909a0824787ac9adcb64a8e99..fe55449e1222581bb3c9d02fa0dd550416eb1dbe` (hashe 8 souborů výše) a otázku „splňuje přijatý checkpoint CP04-k09-freshness (vč. §0 DR-01–DR-06), PB-01, T9, tasks 4.1/4.2 a je připraven na PR“. Implementace je minimální a přesně odpovídá §2, testy prokazují produkční funkce na existujících portech a skutečně diskriminují (nezávisle reprodukován red/green/M1 a všechny mutační hashe), evidence je konzistentní s raw výstupy, DR-01 nezávisle přepočten z uložených polí.

Toto schválení není CI, merge ani publication povolení; neprokazuje chování skutečného GitHub partial rerunu, 21/21 current-head Quality ani branch protection. Materiální změna kódu/testů/rozsahu znovu otevírá review.

## Reviewer a kontext

Claude Fable 5.1 jako Orca worker (task `task_f7194eeecb5c`, dispatch `ctx_1753e344d00a`), čerstvý kontext, 6. 11. 2026. Read-only nad worktree; vlastní spuštění jen `node --test` v kopiích mimo repo, `git` read-only příkazy, `sha256sum`, `openspec validate --strict --json` (lokální binárka 1.15.0, bez instalace). Zápis výhradně tohoto souboru a scratch kopií v session scratchpadu.
