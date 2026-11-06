# Nezávislý design review — CP04 slice 4.1–4.2 (K-09 freshness accepted attemptu), brief v2

## 0. Kanonické uložení (2026-11-06; pouze hlavička/cesty)

- Původní soubor review: `backups/codex-cp01-20261105/reports/K09-design-review-v2.md` (původní checkout), SHA256 `13ff9320aa5e2bc1ff7767d08f092eef6caaccaace7b0c934d819b2d932ebded`. Tělo níže je převzato beze změny; jediná změna je tato sekce §0.
- Subjekt review `/tmp/musubi-k09-brief-v2.md` (SHA256 `b98c95c9…4bd0d`) je nyní kanonicky uložen jako `checkpoints/CP04-k09-freshness.md` s hlavičkovými/cestovými úpravami a dodatkem přijetí §0 popsanými v tom souboru; verdikt níže se vztahuje k původnímu subjektu, ne k novému hashi.
- Přijetí nálezů DR-01–DR-06 koordinátorem je zaznamenáno v `checkpoints/CP04-k09-freshness.md` §0. Kanonická větev `codex/cp04-k09-freshness` z `e6015977adba39e909a0824787ac9adcb64a8e99` (totožný tree s HEAD `5bfb3413…` uvedeným níže).

## Subjekt a přesná revize/hashe

- Subjekt: `/tmp/musubi-k09-brief-v2.md`, SHA256 `b98c95c9b532971fbfeb65b20f729d7dbfe8d6f011204bad4e252e05bab7bd0d` (ověřeno `sha256sum` před čtením; shodný obsah leží také v gitignorované kopii `backups/codex-cp01-20261105/reports/K09-brief-v2.md`).
- Repo `/home/flamendrin/workspace/musubi`, HEAD `5bfb3413f50c87bda5bbbf3fe00e363c65d0ec71` (`codex/cp01-docs-authorities`), `origin/main` `e6015977adba39e909a0824787ac9adcb64a8e99`. Oba commity mají **totožný tree** `48a6eed809faf32b1d9057732b98c878d1fef1a8` (`git diff --stat` prázdný); main vznikl squash-merge #407 z této větve.
- Hashe dotčených vstupů na HEAD i main (bajtově shodné, ověřeno `git rev-parse <rev>:<path>` i `sha256sum`):
  - `scripts/quality-proof.mjs` `d287a28d…bb7e`
  - `scripts/quality-proof.test.mjs` `1194048e…2dd2`
  - `scripts/verify-publication.mjs` `6892d47b…97db`
  - `scripts/verify-publication.test.mjs` `e3c7b77b…e5ad`
  - `docs/releases/publication.md` `dab76e26…4fc0`, `.spec-pilot.json` `099538b4…10ae`
  - Odpovídá `inputs_sha256` v `K09-baseline.json`; ten jsem četl pouze jako autorem hlášenou historickou execution evidenci (40/40 z 5. 11. nad tehdejším main d9ff9dce), nikoli jako nový PASS.
- Pracovní strom: žádné tracked změny, jen untracked `.agents/skills/*`; nic jsem v rootu neměnil. Jediný zápis je tento soubor.

## Otázka a rozsah review

Je návrh CP04 4.1–4.2 (brief v2) připraven k apply na skutečné main base v samostatné `codex/` větvi se zachováním přijatého kontraktu (PB-01, T9, tasks 4.1–4.2)? Není to final review kódu ani merge/release schválení; implementace K-09 dosud neexistuje.

## Izolace

Čerstvý nezávislý kontext (Orca worker, vlastní session). Nečetl jsem autorovu konverzaci, K09-research/brief v1/revision reporty, jiné agentní reporty ani backups prompty. Omezení: žádné spouštění testů, sítě, buildů, `openspec validate`, `spec check`, git/tracker mutací. Všechna tvrzení ověřena statickým čtením kódu.

## Skutečně přečtené zdroje

AGENTS.md/CLAUDE.md; `.agents/skills/spec-review/SKILL.md` (identické s `.spec/marketplace/...`); spec-guide `contracts.md`, `testing.md`, `workflow.md`, `assets/review.md`, `assets/verification.md`; `.spec-pilot.json`; change `align-project-workflows-and-complete-sync`: `specs/publication-operations/spec.md` (PB-01 L9–14), `design.md` T1 (L17–23) a T9 (L107–109), `tasks.md` L1–30 a L72–81, `audit-disposition.md` řádek K-09 (L89), `checkpoints/CP01-docs-authorities.md` jako precedens tvaru briefu; celé `scripts/quality-proof.mjs`, `scripts/quality-proof.test.mjs`, `scripts/verify-publication.mjs`, `scripts/verify-publication.test.mjs`; `docs/releases/publication.md` L30–70 a L105; zapojení v `.github/workflows/docker-publish.yml` (job `quality-proof` record L52, `prepare`/`release` recheck L80–90, L227–242), `scripts/release-guard.mjs` L5, L195–215; `scripts/release-guard.test.mjs` (port `qualityCheck`); `package.json` scripts `test`, `check`, `typecheck`, `lint`; `scripts/test-behavior.mjs` L8 (`SUITES`); existence `~/.cache/SPEC/openspec/1.15.0/binary/openspec` a `spec`.

## Vlastní popis navrženého chování a hranic

Návrh přidává do sdíleného validátoru `validateQualityProof` dvě spodní časové meze: každý z 21 Quality jobů musí mít `startedAt >= run.startedAt` (accepted `run_started_at`) a každý ze dvou povinných native kroků Android jobu totéž přes nový třetí parametr `validateNativeSteps`. Hlášky jsou statické a odlišné pro job a krok; native mez se hodnotí před job mezí (pořadí diagnostik, ne změna přijímané množiny). Collector (`collectQualityProof`, workflow `record`) a recheck (`recheckQualityProof`, jobs `prepare`/`release` přes `release-guard.mjs`) i post-publikační verifier (`collectPublicationProof` → `proofBinding` L202) sdílejí tentýž validátor, takže pravidlo platí ve všech třech cestách bez změny kódu verifieru; živá data verifier dál pinuje na hodnoty receiptu rovností (L229–230, L242–248). Tři nové testy: A (non-Android carried-over job + pozitivní plně čerstvá varianta attempt 2), B (Android job s kroky před startem attemptu), C (verifier odmítne receipt stejného tvaru ve fázi `proofBinding`). Jedna věta v `publication.md`. Mimo rozsah: horní mez vůči `run.updatedAt`, vazba 9 publication jobů, inventář, consumer/latest/tag, skutečný GitHub rerun. Výsledek je fail-closed: při porušení meze se receipt nevytvoří a publikace se zastaví; nic se nevydá, nic se nererunuje.

## Ověření technických tvrzení proti kódu

| Tvrzení briefu | Stav | Evidence |
| --- | --- | --- |
| Místa vložení L28–41, L35–37, L63–72, L66–69, L71 | sedí | `quality-proof.mjs` přesně odpovídá; `timestamp(step.startedAt)` a `timestamp(run.startedAt)` jsou validovány dřív (L36, L59), takže `Date.parse` nové meze je bezpečné |
| `>=` nutné kvůli výchozí fixture `run_started_at === started_at` | sedí | test L12, L32, L34, L36 (`time` všude) |
| `sanitizeJobs`/`runIdentity`/`discover` nekontrolují časy, collect dojde na L231 | sedí | L164–201, L223, L231 |
| Verifier nebalí validační chyby, hláška doputuje do `assert.rejects` | sedí | try/catch jen L260–264 a L284–285; `proofBinding` L293 mimo try |
| `jobs[0]` = „API container boots and serves“ (non-Android), index 1 Android | sedí | `QUALITY_JOB_NAMES` je `.sort()` podle UTF-16; „AP“ < „An“ |
| Jobs endpoint fixture odvozen z `run.run_attempt` při volání | sedí | test L53; `data.run` je tentýž objekt jako `run` a `listing.workflow_runs[0]` |
| Test C: `qualityRun` sdílený ve `values` i discovery, rovnost L229–230, zrcadlení L242 | sedí | test L95–97, L101 kopíruje až při čtení; verifier L228–231, L237–249 |
| `json` v testu ≡ `serialize`; přímý sha256 nutný, protože `hashQualityProof` validuje | sedí | test L16, `quality-proof.mjs` L81–85 |
| Horní meze L298–301 zůstávají splněny (02:00 ≤ 10:00, 00:10 ≤ 09:30) | sedí | L298–301, fixture L45, L65, L72 |
| Red A/B/C na staré implementaci = resolve; green po fixu; M1/M2/M2b/M3 chování | sedí (statická analýza toku) | viz popis výše; M1: A i C resolve → selžou, B dál padá na native; M2: 10:05 ≥ 10:00 projde; M2b: native projde, job hláška, regex nesedí; M3: job hláška, regex nesedí |
| Existující regex `/wrong-attempt/` L106 dál platí | sedí | hláška L69 nezměněna |
| Žádný stávající test nemění očekávání | sedí | všechny fixtures mají `started_at === run_started_at` (quality-proof) nebo 01:00 ≥ 00:01 (verify-publication); `release-guard.test.mjs` proof nekonstruuje (injektuje `qualityCheck`) |
| `typecheck`/`lint` nepokrývají `scripts/`; `SUITES` neobsahuje tyto skripty | sedí | package.json L23, L42; `test-behavior.mjs` L8 |
| `pnpm check` obsahuje `pnpm test` s oběma soubory | sedí | package.json L24, L36 |
| Odkazy spec.md:9–14, design.md:107–109, tasks.md:8/10–16/76/77, verify-publication.mjs:142–156 | sedí | ověřeno řádek po řádku |
| Věta za `publication.md` L45 („…shipped DEX steps.“) | sedí | L44–45; navazuje na L50–53 o partial rerunu |

Nenašel jsem žádné tvrzení briefu, které by kód vyvracel.

## Nálezy

Žádný blocker. Klasifikace: B = blocker, R = rozhodnutí vlastníka/koordinátora, D = doporučení.

| ID | Třída | Očekávaný stav a zdroj | Nález a evidence | Dopad / jistota | Další krok |
| --- | --- | --- | --- | --- | --- |
| K09-DR-01 | R | PB-01/T9: mez platí pro každý přijatý attempt; testing.md: fixture ≠ živý důkaz | Nové meze se uplatní i na běžný attempt 1 každé budoucí publikace. V repu není žádný skutečný receipt s reálnými `run_started_at`/`started_at` (docs/releases obsahuje jen .md; receipty jsou CI artefakty), takže vztah `job.started_at >= run_started_at` na reálných GitHub datech je podložen jen sémantikou API a fixtures. Brief to u rerunu přiznává (§1 „skutečný GitHub rerun“), u attempt 1 explicitně ne. | Riziko je fail-closed: případná odchylka by zablokovala publikaci na kroku `record`, nevydala by nic špatně. Střední jistota, že reálná data mez splňují. | Před merge (ne v apply) buď doložit read-only nad posledním skutečným Quality během, že všech 21 jobů a 2 kroky mez splňují, nebo v acceptance výslovně přijmout jako přiznanou hranici „ověřeno až první reálnou publikací“. Rozhoduje vlastník; na apply nemá vliv. |
| K09-DR-02 | D | Brief §2: sdílený přenos jen do verifieru | Třetí konzument je `scripts/release-guard.mjs` (L5, L199, L212): `recheckQualityProof` → `collectQualityProof({pinnedProof})` validuje pinned receipt (L207) i čerstvý snapshot (L231). Brief jej nejmenuje. `release-guard.test.mjs` port `qualityCheck` injektuje, fixtures proof nestaví → nic se nerozbije. | Bez dopadu na kód; jen úplnost popisu cest, kde pravidlo platí (prepare/release joby v `docker-publish.yml` L80–90, L227–242). Vysoká jistota. | V checkpoint souboru a evidence uvést release-guard jako transitivní konzument; žádná změna kódu ani testů. |
| K09-DR-03 | D | §3 Fixture V: „jinak by pod M1 padl differ a C by nedokazoval přenos“ | Přesněji: bez zrcadlení by C pod M1 selhal také (reject „differ“ L249 neodpovídá regexu), jen ze špatného důvodu; zrcadlení je správné kvůli T9 konzistenci. Skutečný důkaz přenosu pod M1 je, že `collectPublicationProof` **resolve**. | Nízký; formulace, ne vada návrhu. | V mutační evidenci u M1/C zapsat pozorovaný výsledek „resolve“ (ne „jiný reject“). |
| K09-DR-04 | R | T1 L21 a tasks.md:12/20: fast obsahuje nejmenší JSON scénář a relevantní types/lint; chybějící driver = vlastní slice | Brief obojí přiznává N/A s ověřenými důvody. Posuzuji jako slučitelné s AGENTS (produkční funkce, dependency nahrazené na existujících portech `fetchImpl`/`git`/`readJSON`/`downloadArtifact`/`extractJSON`, žádná kopie business logiky; serializace volitelná dle testing.md). Precedens CP01 postupoval stejně. | Nízký; vyžaduje jen potvrzení koordinátora, že node:test fixture na existujících portech je přijatý tvar „nejmenšího scénáře“ pro `scripts/`. | Potvrdit v přijetí briefu; v acceptance zaznamenat skutečný výstup `pnpm test:behavior --list` jako doklad absence suite (tasks.md:20), bez spouštění scénáře. |
| K09-DR-05 | D | tasks.md:12: brief obsahuje aktualizaci stavu/odkazů dotčených audit ID; T1: STATUS.json odkazuje na brief cestou/hashem | Brief §7 správně zakazuje uzavřít K-09 a zaškrtnout 4.1/4.2, ale neříká, zda K-09 řádek při P1 dostane odkaz na `checkpoints/CP04-k09-freshness.md`, a nezmiňuje `backups/spec-sessions/<id>/STATUS.json`. | Nízký; dohledatelnost. | Při P1 doplnit do K-09 řádku pouze odkaz na checkpoint se stavem „brief přijat, implementace neprovedena“; založit STATUS.json s cestou/hashem briefu. |
| K09-DR-06 | D | P2: base = skutečný main v době apply | HEAD a main mají dnes totožný tree, takže všechny řádkové odkazy a hashe platí i pro větev z `e6015977`. Pokud main před apply postoupí, odkazy/hashe se musí znovu ověřit. | Informativní. | Před prvním commitem nové větve znovu porovnat hashe čtyř souborů s briefem (brief P2 to již vyžaduje). |

## Neposouzené oblasti

- Skutečné chování GitHub API při partial rerunu (jaké `started_at`/`run_attempt` dostanou carried-over joby) — T9 experiment zakazuje; fixture není důkaz skutečného rerunu.
- Žádné spuštění: baseline, red/green, mutace, `pnpm check`, `openspec validate --strict`, `spec check`, `git diff --check`. Binárka `openspec` 1.15.0 a `spec` existují; funkčnost nespuštěna.
- `verify-publication.mjs` L37–100 (ZIP/JSON čtečka) a `release-guard.mjs` mimo L195–215 jen letmo; nejsou dotčeny návrhem.
- Branch-protection a 21 current-head Quality jobů na budoucí PR — budoucí full gate, mimo tento review.

## Disposition nálezů

Žádný nález nevyžaduje změnu návrhu před apply. DR-01 a DR-04 jsou rozhodnutí vlastníka/koordinátora, která lze zapsat do přijetí briefu nebo acceptance; DR-02/03/05/06 jsou doplnění evidence a checkpoint souboru, ne změna rozsahu, kódu ani kontraktu. Materiální změna briefu (jiné meze, jiný rozsah souborů, nový driver, změna politiky) by znovu otevřela review.

## Verdikt

**APPROVE** — pro přesně tento subjekt (SHA256 `b98c95c9…4bd0d`) a otázku „připraven k apply na skutečné main base v samostatné `codex/` větvi se zachováním přijatého kontraktu“. Návrh je minimální (dvě `require` + parametr), přesně zužuje PB-01/T9/tasks 4.1–4.2 bez nového požadavku, používá jen existující porty, fixtures jsou vnitřně konzistentní a realistické, red/green/mutační postup je proveditelný a správně rozlišuje důvody selhání, full/live/platform gates jsou přiznané jako HOLD, ne PASS.

Toto schválení není test PASS, neprokazuje chování skutečného GitHub partial rerunu a neopravňuje merge, release, tag ani deployment. Po implementaci je nutný nezávislý spec-review finálního diffu.

## Reviewer a kontext

Claude Fable 5.1 jako Orca worker (task `task_b96f992095b2`, dispatch `ctx_0edaedca3d74`), čerstvý kontext, 6. 11. 2026, pouze čtení; zápis výhradně tohoto souboru.
