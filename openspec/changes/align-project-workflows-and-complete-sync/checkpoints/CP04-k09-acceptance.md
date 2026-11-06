# CP04 slice 4.1–4.2 (K-09 freshness accepted attemptu) — lokální acceptance záznam

Stav: **dílčí lokální výsledek** (implementace + fast red/green + mutace + lokální `pnpm check`). Není final approval, není PR, není 21/21 current-head Quality, není branch protection, není merge ani publikace. Tasks 4.1/4.2 zůstávají nezaškrtnuté; řádek K-09 v `audit-disposition.md` je jen doložený dílčí stav. Historie (K09-research/brief/baseline, předchozí CP záznamy) se nepřepisuje.

Autor: Claude Fable 5.1, Orca task `task_a0d695425479` (dispatch `ctx_1a6a1c3909cf`), 2026-11-06. Worktree `/home/flamendrin/orca/workspaces/musubi/codex-cp04-k09-freshness`, větev `codex/cp04-k09-freshness` (jediné autorizované lokální přejmenování z `f-tuma/codex-cp04-k09-freshness`; cílová větev neexistovala).

## 1. Autoritativní vstupy a hashe

| Vstup | Cesta | SHA256 |
| --- | --- | --- |
| Přijatý brief v2 (subjekt review) | původní checkout `backups/codex-cp01-20261105/reports/K09-brief-v2.md` | `b98c95c9b532971fbfeb65b20f729d7dbfe8d6f011204bad4e252e05bab7bd0d` |
| Design review v2 (APPROVE, task `task_b96f992095b2`) | původní checkout `backups/codex-cp01-20261105/reports/K09-design-review-v2.md` | `13ff9320aa5e2bc1ff7767d08f092eef6caaccaace7b0c934d819b2d932ebded` |
| Kanonický checkpoint (hlavička/cesty + §0 přijetí) | `checkpoints/CP04-k09-freshness.md` | `9df4d1aa6b62def1b1cb37209ff72213bc7dafc5e1bcb162305d8f206f4bc694` |
| Kanonické review (+ §0 kanonické uložení) | `reviews/CP04-k09-design.md` | `f9c17575d73ac05bce3d53e49761b79abd151b376e01d0d44af0131e9430c07d` |

Base: origin/main `e6015977adba39e909a0824787ac9adcb64a8e99` = HEAD při startu, čistý strom (`git status` prázdný). Předkódový commit `48e8d4325738fc60d79c33de9cc279d3b62222e2` (jen checkpoint, review, K-09 řádek). Vstupní hashe na base shodné s review a `K09-baseline.json`:

| Soubor | SHA256 na base | SHA256 po implementaci |
| --- | --- | --- |
| scripts/quality-proof.mjs | `d287a28d816abe2df287d3a9b10e3f82632877804035f8809bc15fe0eb29bb7e` | `00324baa17c37acb38a19e2da0260d80c09a771dc0201caf7fc4579af7b48e66` |
| scripts/quality-proof.test.mjs | `1194048e1ef7aed424e8b8edb210fbccbaccdd47f35f005a29759a76622c2dd2` | `3aa88725e173b6e8fc89ec04b2a27a1e05a831e4fea22ecae8b4c547c3622750` |
| scripts/verify-publication.mjs | `6892d47bd3c96b9e4af822fea5b09ad067f4571c36d77b93555e2d1e435797db` | beze změny (`6892d47b…97db`) |
| scripts/verify-publication.test.mjs | `e3c7b77b10aaa5322efe491dea0fe84398d7efd1a1ec94467355855cd170e5ad` | `e32294aebf30a21d5ede9f7a86167c8d067424f36c35bb67740977e1597b5094` |
| docs/releases/publication.md | `dab76e265b857d4cd48ad279f67920e5e38e0e8e9df7be3cb95bddfd837d4fc0` | `48afcccb2b025ddc26ed2c5de3a676edae74de6436d1582c4ce3546f0298fddd` |
| .spec-pilot.json | `099538b422408b9ea550ff548d0478e278e1e730ffc0ec81bfe2e35d70e610ae` | obnoveno na původní bajty (`099538b4…10ae`) |

## 2. Co se změnilo (přesně dle briefu §2)

- `scripts/quality-proof.mjs`: `validateNativeSteps(steps, android, acceptedStartedAt)`; ve smyčce kroků za stávajícím `require` nová mez `Date.parse(step.startedAt) >= Date.parse(acceptedStartedAt)` s hláškou „native verification step started before the accepted attempt“. Ve smyčce jobů po stávající strukturní kontrole nejprve `validateNativeSteps(…, run.startedAt)`, teprve pak nová mez `Date.parse(job.startedAt) >= Date.parse(run.startedAt)` s hláškou „Quality job started before the accepted attempt“. Mez `>=` (výchozí fixture má `run_started_at === started_at`). Hlášky statické, bez URL/tokenů. Diff: +4/−2 řádky (`git diff --numstat`; L28 a L72 změněny, L38 a L73 přidány).
- `scripts/quality-proof.test.mjs`: helper `at`/`acceptedAttempt` (fixture K na existujícím `f.data`/`fetchImpl`, attempt 2, `created_at 10:00`, `run_started_at 10:20`, `updated_at 10:40`, joby 10:20–10:40, Android kroky 10:20–10:30 a 10:25–10:35); test A (carried-over `jobs[0]` „API container boots and serves“ 10:05–10:10 → reject; posun celého intervalu na 10:20–10:30 → resolve, `run.attempt === 2`, 21 jobů, všechny `startedAt >= run.startedAt`); test B (Android job 10:05–10:15 s kroky 10:05–10:10 a 10:10–10:15 → reject native hláškou). Názvy obou obsahují „accepted attempt“.
- `scripts/verify-publication.test.mjs`: test C na existujícím `readJSON`/`values`/`setEvidence` portu (fixture V: `qualityRun.run_started_at` a `proof.run.startedAt` 00:30, `proof.jobs[0]` 00:05–00:10 zrcadleno do `qualityJobs.jobs[0]`, `recheck.proofSha256` přímo sha256 nad `json(proof)`) → `collectPublicationProof` reject hláškou „Quality job started before the accepted attempt“ ve fázi `proofBinding`.
- `scripts/verify-publication.mjs`: **bez změny kódu** (sdílený `validateQualityProof`). `scripts/release-guard.mjs` je třetí transitivní konzument (`recheckQualityProof` → `collectQualityProof`), kód ani testy neměněny (DR-02).
- `docs/releases/publication.md`: jediná anglická věta za „…shipped DEX steps.“: *Every required Quality job and each required native verification step must also have started no earlier than the accepted attempt's `run_started_at`.*
- Nezměněno: schéma receiptu, inventář 21 jobů, tag/consumer, workflow YAML, verze, lockfile, `release-guard.mjs`, `verify-publication.mjs`. Žádný stávající test nemění očekávání (regex `/wrong-attempt/` dál platí).

## 3. Postup a skutečné výsledky (raw záznamy: `backups/spec-sessions/cp04-k09-20261106/runs/<name>.{json,stdout,stderr}`, gitignored v tomto worktree; JSON nese argv/cwd/start/end/duration/exit/counts)

Fast argv: `node --test scripts/quality-proof.test.mjs scripts/verify-publication.test.mjs`, cwd worktree (mutace: cwd kopie mimo repo i `.spec`). Node v22.23.4, pnpm 11.8.0, python3 (ZIP fixture verifieru). Síť jen pro DR-01 (§5); testy nahrazují GitHub/git/artefakty fixture porty.

| Krok | Záznam | Exit | Trvání | Výsledek |
| --- | --- | --- | --- | --- |
| Baseline na base e6015977 (před jakoukoli změnou) | `baseline-fast` | 0 | 4459 ms | 40/40 pass (23 + 17). Historický 40/40 z 5. 11. se nepřenáší. |
| Red A/B/C na starém validátoru (jen testy přidány) | `red-fast` | 1 | 4539 ms | 43 testů, 40 pass, **3 fail — všechny `error: 'Missing expected rejection.'`** (tj. `collect()`/`collectPublicationProof` resolve; žádný hash/attempt/„differ“/schema důvod). |
| Minimální fix + věta v publication.md | — | — | — | §2 |
| Green celý pár | `green-fast` | 0 | 4564 ms | 43/43 pass |
| Úzká smyčka `--test-name-pattern "accepted attempt"` | `green-narrow` | 0 | 205 ms | 3/3 pass (A, B, C) |
| M1 odstranit job mez (kopie) | `mut-M1-remove-job-bound` | 1 | 4454 ms | 41 pass / 2 fail: A `Missing expected rejection.`, **C `Missing expected rejection.` = `collectPublicationProof` skutečně resolve (DR-03: přenos do verifieru doložen, ne jiný reject)**; B ok (padá dřív na native). |
| M2 job mez vs `run.createdAt` (kopie) | `mut-M2-job-bound-vs-createdAt` | 1 | 4484 ms | 41 pass / 2 fail: A `Missing expected rejection.` (10:05 ≥ 10:00 projde); C rovněž resolve (00:05 ≥ 00:00). B ok. Odlišuje `run_started_at` od `created_at`. |
| M2b kroková mez vs `run.createdAt` (kopie) | `mut-M2b-step-bound-vs-createdAt` | 1 | 4621 ms | 42 pass / 1 fail: B — actual `Quality proof: Quality job started before the accepted attempt` (native projde, padne job mez, regex native hlášky nesedí). A, C ok. |
| M3 odstranit krokovou mez (kopie) | `mut-M3-remove-step-bound` | 1 | 4538 ms | 42 pass / 1 fail: B — actual `Quality proof: Quality job started before the accepted attempt`; receipt je dál odmítnut job guardem (netvrdí se, že projde). A, C ok. |
| Obnovený green (repo soubory mutacemi nedotčené; hashe §1) | `green-restored` | 0 | 4476 ms | 43/43 pass |
| Whitespace `git diff --check` (cached P1 / impl working tree) | `git-diff-check-p1`, `git-diff-check-impl` | 0 / 0 | 2 / 3 ms | bez nálezu |
| Source `pnpm check` (ENVIRONMENT=test, BETTER_AUTH_URL=http://localhost:7531, neprodukční DATABASE_URL `postgresql://musubi_k09:unused@127.0.0.1:59998/musubi_k09_test`; žádná DB nespuštěna, `.env` nekopírován) | `pnpm-check-final` | 0 | 225 067 ms (08:21:50–08:25:35 UTC) | exit 0: release:verify, check:contracts, peers:check, test:query-runtime, typecheck, test (root node:test 183/183 pass včetně 43 testů fast páru + workspace testy), lint, build. Stderr jen očekávané varování `email.smtp_unavailable` (SMTP timeout v test env, nefailující). Lokální běh, ne CI. |

Mutace: přesné páry a mutované hashe v `backups/spec-sessions/cp04-k09-20261106/mutations-index.json`; kopie obsahovaly 4 skripty/testy + `.github/workflows/quality.yml` (inventářový test). `>=`→`>` se záměrně neprovádělo (zpřísnění, ne weakening).

Interpretace: red ze správného důvodu (resolve), green bez změny stávajících očekávání, každá oslabující mutace zachycena přesně tou dvojicí testů, kterou brief předpověděl. Pořadí diagnostik (native před job mezí) ověřeno M2b/M3. Fixtures nejsou důkaz skutečného GitHub partial rerunu.

## 4. Kontroly, mapy a N/A

- Dočasná branch mapa `.spec-pilot.json` (`checks`: `fast` = node:test pár, `source` = `pnpm check`, `planning-whitespace` = `git diff --check`; SHA256 dočasné verze `cc3237b0f22d61d0836df92180d99fa101362e31c08200995cbb74b33539fa3d`, záznam `backups/spec-sessions/cp04-k09-20261106/spec-pilot-temp-map.json`) platila během red/green/mutací a byla před finálními kontrolami obnovena na původní bajty `099538b4…10ae`; sdílený goal/stop nezměněn; v diffu větve se neobjevuje.
- `full` se nevytváří (CP02). Gate dokončení = `pnpm check` + 21 current-head Quality jobů na PR head + branch protection: **HOLD, nikoli PASS** (žádný PR dosud neexistuje). `ui` N/A (Node release tooling, žádná UI/aplikační hranice; `pnpm test:behavior:browser` tyto skripty nepokrývá). `database` N/A (žádná DB hranice). Žádný fiktivní full/UI/DB PASS.
- JSON scénář `pnpm test:behavior`: skutečný `pnpm test:behavior --list` (`behavior-list`, exit 0, 763 scénářů ve 27 suite) neobsahuje suite pro `scripts/quality-proof`/`verify-publication` (`SUITES` v `scripts/test-behavior.mjs:8`) → **N/A inventory**, žádný scénář PASS; node:test produkční logiky na existujících portech je přijatý nejmenší scénář (DR-04). Žádný nový driver/runner.
- Instalace: `pnpm test:behavior --list` přes pnpm 11 automaticky doplnil `node_modules` z existujícího lockfile (resolution skipped, reused 1824, downloaded 0); poté explicitní `pnpm install --frozen-lockfile --prefer-offline` (`pnpm-install-frozen`, exit 0, „Already up to date“). Lockfile nezměněn. Žádný SPEC framework, globální ani nová závislost.
- OpenSpec strict (pinned `/home/flamendrin/.cache/SPEC/openspec/1.15.0/binary/openspec`, cwd worktree, SPEC framework neinstalován): `list --json`/`validate … --strict --json` před kanonikou (`openspec-list-pre`, `openspec-validate-pre`: valid, failed 0, completedTasks 0/72), po P1 (`openspec-validate-post-p1`, `openspec-list-post-p1`: valid, 0/72) a po finální kanonice (§6). `spec check --project <worktree>` (`spec-check-pre`: mechanical_result pass, semantic unknown, phase orient; `.spec` setup v tomto worktree není nainstalován, nic se neinstalovalo).
- Typecheck/lint `scripts/*.mjs` nepokrývají; `pnpm check` obsahuje `pnpm test` s oběma soubory.

## 5. DR-01: read-only kontrola reálného Quality běhu (není rerun ani runtime nové implementace)

Receipt (credential-free): `backups/spec-sessions/cp04-k09-20261106/dr01/K09-DR01-quality-run-42124082949-freshness.json` (+ raw kopie `run-42124082949.json`, `jobs-42124082949-attempt1-pages.json`). Metoda: `gh api` GET `repos/f-tuma/musubi/actions/runs/42124082949` a `…/attempts/1/jobs?per_page=100` (`--paginate --slurp`, 1 stránka, total_count 21), načteno 2026-11-06 ~08:17 UTC. Výsledek: run 42124082949, attempt 1, head `5bfb3413…`, Quality, completed/success, `run_started_at 2026-11-05T22:44:53Z`; 21/21 požadovaných jmen, unikátní ID, attempt 1, stejný SHA, všechny completed/success; **všechny joby `started_at >= run_started_at` (offset 3–145 s)**; oba povinné Android kroky přítomny jednou, seřazeny, completed/success, `started_at >= run_started_at`. Mez `>=` reálná data splňují; žádný rozpor. Meze: jeden běh, `event=pull_request` (PR #407 head), ne main push, ne partial rerun; dokládá vztah časů GitHub API, ne běh nového validátoru. V tomto skutečném attempt 1 je `created_at == run_started_at` (`2026-11-05T22:44:53Z`), takže receipt nerozlišuje mez vůči `run_started_at` od meze vůči `created_at`; diskriminaci `createdAt` vs `startedAt` dokládají pouze fixtures (M2/M2b, `created_at 10:00 < run_started_at 10:20`). Žádný rerun, `workflow_dispatch` ani zápis.

## 6. Finální stav a co zbývá

- Přiznaná hranice (final review FR-03, žádná změna časového kontraktu ani politiky): sdílený validátor platí i při nové zpětné re-verifikaci historické publikace (`verify-publication.mjs` jako dodatečný read-only verifier, `docs/releases/publication.md` L107). Případný historický Quality timestamp mimo mez nyní způsobí fail-closed odmítnutí takové re-verifikace, nikoli zpětné zneplatnění vydání. Historické releasy nebyly kontrolovány a nejsou z této hypotézy prohlášeny vadnými; při příští re-verifikaci historické publikace se vyhodnotí skutečný výsledek.
- Nezávislý final review finálního diffu `e6015977..fe55449e`: **APPROVE** bez blockerů (`reviews/CP04-k09-final.md`, manifest `reviews/CP04-k09-final-subject.json`, disposition `reviews/CP04-k09-final-disposition.md`). Tento záznam byl poté zpřesněn pouze dle výslovně povolených FR-01–FR-03 (evidence-only; kód a testy beze změny).

- Commity na `codex/cp04-k09-freshness`: `48e8d432…` (předkódový checkpoint) a implementační commit (hash v `STATUS.json` a ve worker_done). Změněné soubory: §1/§2 + tento acceptance záznam + K-09 řádek (dílčí stav).
- Finální OpenSpec strict/list a `spec check` po přidání tohoto záznamu: viz `openspec-validate-final`, `openspec-list-final`, `spec-check-final` v `runs/`.
- Neprovedeno (záměrně, mimo oprávnění): push, PR, nezávislý final review finálního diffu, 21/21 current-head Quality, branch protection, merge, release/tag/deploy/rerun. Koordinátor nejprve spustí fresh nezávislý final review.
