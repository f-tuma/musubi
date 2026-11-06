# CP04 slice 4.1–4.2 — K-09 freshness accepted attemptu (přijatý brief v2)

Stav: **přijatý brief** (nezávislé design review APPROVE 2026-11-06, `reviews/CP04-k09-design.md`; přijetí koordinátorem viz §0). Není final review; implementace k okamžiku uložení tohoto checkpointu neprovedena. Kanonické umístění: `openspec/changes/align-project-workflows-and-complete-sync/checkpoints/CP04-k09-freshness.md` (větev `codex/cp04-k09-freshness` z origin/main `e6015977adba39e909a0824787ac9adcb64a8e99`, Orca worktree, task `task_a0d695425479`). Zkoumáno 6. 11. 2026 nad sdíleným checkoutem `codex/cp01-docs-authorities` HEAD 5bfb341 (čistý v tracked souborech) proti aktuálnímu `main` e6015977adba39e909a0824787ac9adcb64a8e99. Čtyři dotčené skripty/testy a `docs/releases/publication.md` jsou bajtově shodné na HEAD i main (SHA256 viz K09-baseline.json `inputs_sha256`; publication.md `dab76e26…4fc0`, `.spec-pilot.json` `099538b4…10ae`). Program: align-project-workflows-and-complete-sync. Brief jen zužuje tasks 4.1–4.2, design T9 a PB-01; žádný nový požadavek, policy, schema, runner ani live experiment. Nahrazuje `backups/codex-cp01-20261105/reports/K09-brief.md`, který zůstává historický a nepřepisuje se.

## 0. Záznam uložení a přijetí (2026-11-06, dodatek; nemění mechanismus)

Tato sekce je datovaný dodatek přijetí. Tělo kontraktu v §1–§7 je převzato beze změny z přijatého subjektu review.

- Přijatý subjekt: `backups/codex-cp01-20261105/reports/K09-brief-v2.md` (původní checkout), SHA256 `b98c95c9b532971fbfeb65b20f729d7dbfe8d6f011204bad4e252e05bab7bd0d`.
- Design review: `reviews/CP04-k09-design.md` (Claude Fable 5.1, Orca task `task_b96f992095b2`, verdikt APPROVE pro tento subjekt). Původní soubor `backups/codex-cp01-20261105/reports/K09-design-review-v2.md`, SHA256 `13ff9320aa5e2bc1ff7767d08f092eef6caaccaace7b0c934d819b2d932ebded`.
- Přesné změny oproti subjektu (pouze hlavička/cesty; SHA256 tohoto souboru je zapsán v `backups/spec-sessions/cp04-k09-20261106/STATUS.json` a v acceptance záznamu):
  - H1: nadpis „(návrh briefu v2)“ → „(přijatý brief v2)“.
  - H2: stavová věta „opravený návrh pro nezávislé pre-apply review; není APPROVE, není apply, není final review“ → „přijatý brief …“ s kanonickým umístěním, větví a skutečnou base.
  - H3: tato sekce §0 vložena před §1. Žádná jiná změna textu §1–§7.
- Ověření vstupů před uložením (DR-06, brief P2): větev `codex/cp04-k09-freshness`, HEAD = origin/main = `e6015977adba39e909a0824787ac9adcb64a8e99`, čistý strom; SHA256 čtyř skriptů/testů shodné s review a `K09-baseline.json` (`d287a28d…bb7e`, `1194048e…2dd2`, `6892d47b…97db`, `e3c7b77b…e5ad`), `docs/releases/publication.md` `dab76e26…4fc0`, `.spec-pilot.json` `099538b4…10ae`. Řádkové odkazy briefu proto platí beze změny.
- Přijetí nálezů design review koordinátorem (žádná změna mechanismu, rozsahu souborů, mezí ani kontroly):
  - **DR-01:** před merge zvolena READ-ONLY kontrola reálného dokončeného Quality běhu (ne odklad na první publikaci). Root GitHub konektor nevrací `started_at`/`run_started_at`, proto jen pro tento údaj existující `gh api` read-only GET nad Quality run `42124082949` (PR #407, head `5bfb3413f50c87bda5bbbf3fe00e363c65d0ec71`, attempt 1): metadata běhu a všechny jobs stránkovaně; kontrola run identity/attempt/21 jobs a obou povinných Android kroků proti `run_started_at`. Credential-free JSON receipt s URL, přesnými poli, časem načtení a výsledkem patří do acceptance. Není to důkaz rerunu ani runtime nové implementace; žádný rerun ani `workflow_dispatch`. Nedostupnost dat je samostatný HOLD před merge, ne důvod blokovat lokální implementaci ani předstírat PASS; rozpor s novou mezí = return s evidencí před změnou kontraktu.
  - **DR-02:** `scripts/release-guard.mjs` je třetí, transitivní konzument sdíleného `collectQualityProof`/`recheckQualityProof` (jobs `prepare`/`release` v `docker-publish.yml`); pravidlo tam platí bez změny jeho kódu i testů (`release-guard.test.mjs` port `qualityCheck` injektuje). Nemění se bez konkrétní nové potřeby.
  - **DR-03:** u mutace M1 musí `collectPublicationProof` (test C) skutečně **resolve**, ne padnout jiným rejectem (hash/„differ“); do evidence se zapisuje přesný pozorovaný výsledek.
  - **DR-04:** node:test skutečné produkční logiky s fixture na existujících portech (`fetchImpl`/`git`/`readJSON`/`downloadArtifact`) je přijatý tvar „nejmenšího scénáře“ pro tuto hranici `scripts/`; žádný nový JSON driver ani runner. Skutečný výstup `pnpm test:behavior --list` se zaznamená jako doklad N/A inventáře (žádný scénář PASS).
  - **DR-05:** řádek K-09 v `audit-disposition.md` dostává při P1 jen odkaz na tento checkpoint se stavem „brief přijat, implementace neprovedena“; tasks 4.1/4.2 zůstávají nezaškrtnuté až do doložených full gates a merge. `backups/spec-sessions/cp04-k09-20261106/STATUS.json` (gitignored) odkazuje na brief cestou a hashem.
  - **DR-06:** hashe vstupů a skutečná base znovu ověřeny před prvním commitem (viz výše). Přímá P3 nezávislost na CP01 se týká pouze obsahu tohoto slice a nevyřazuje jinou kanonickou závislost.
- Interpretace „žádná instalace“ (§6): zákaz instalace SPEC frameworku, globálních a nových závislostí; běžné `pnpm install --frozen-lockfile --prefer-offline` existujícího lockfile je pro `pnpm check` potřebné a dovolené. `pnpm check` běží s testovacím env (`ENVIRONMENT=test`, `BETTER_AUTH_URL=http://localhost:7531`, neprodukční `DATABASE_URL`), bez kopírování `.env`/tajemství a bez startu DB.

## 1. Požadavky a jeden pozorovatelný výsledek

- PB-01 (specs/publication-operations/spec.md:9–14): joby a povinné native kroky MUST časově patřit do přijatého attemptu; scénář „Partial rerun přebere staré úspěchy“.
- T9 (design.md:107–109): job i povinný Android krok začínají nejdříve na accepted `run_started_at`; verifier má stejnou mez; fixtures konzistentní; žádný rerun vydaného main běhu.
- tasks.md:76 (4.1), :77 (4.2); tasks.md:8 (4.1–4.2 smí předběhnout CP02); tasks.md:10–16 (brief → review → apply; full gate před CP02).

**Výsledek:** `collectQualityProof` nad fixture, kde API vrátí 21 jobů s attempt labelem 2, ale jeden non-Android job (test A) nebo Android job se svými kroky (test B) má `started_at` před `run_started_at` attemptu 2, odmítne receipt statickou hláškou pro časové pravidlo. Tatáž fixture s carried-over jobem přesunutým celým intervalem do attemptu 2 projde s `run.attempt === 2`. `collectPublicationProof` nad receiptem stejného tvaru odmítne publikaci ve fázi `proofBinding` jen díky sdílenému validátoru (test C). Dosavadní odmítání chybějících/duplicitních/skipped/wrong-attempt/wrong-SHA jobů a original pin zůstává beze změny očekávání.

Mimo rozsah (follow-up, ne blokující otázka vlastníka): horní mez `job.completedAt <= run.updatedAt` ve sdíleném validátoru, vazba 9 vlastních publication jobů na publication `run_started_at` (verify-publication.mjs:142–156), politika inventáře 21 jobů, consumer/latest/tag/deploy, skutečný GitHub rerun.

## 2. Přesný rozsah: dvě spodní meze ve sdíleném validátoru

| Soubor | Změna |
| --- | --- |
| scripts/quality-proof.mjs | `validateNativeSteps(steps, android, acceptedStartedAt)` (L28–41): uvnitř smyčky za stávající `require` (L35–37) nová `require(Date.parse(step.startedAt) >= Date.parse(acceptedStartedAt), "native verification step started before the accepted attempt")`. Ve smyčce jobů `validateQualityProof` (L63–72): stávající strukturální `require` (L66–69) beze změny, pak `validateNativeSteps(job.nativeSteps, job.name === "Android system bars", run.startedAt)` (L71), **teprve pak** nová `require(Date.parse(job.startedAt) >= Date.parse(run.startedAt), "Quality job started before the accepted attempt")`. Mez `>=`, protože výchozí fixture má `run_started_at === started_at` (test L12, L32–36). Nic jiného. |
| scripts/quality-proof.test.mjs | testy A, B a pozitivní varianta na existující fixture (`fetchImpl` L41–57, `f.data` L28–38, `f.respond`); bez nového runneru/registru |
| scripts/verify-publication.mjs | **bez změny kódu**; přenos přes `proofBinding` L202 (sdílený `validateQualityProof`) a pin živých dat L229–230, L242–248 |
| scripts/verify-publication.test.mjs | test C na existujícím `readJSON`/`values` portu (L91–102) a `setEvidence` (L77–85) |
| docs/releases/publication.md | jedna anglická věta za L45 („…shipped DEX steps.“): *Every required Quality job and each required native verification step must also have started no earlier than the accepted attempt's `run_started_at`.* Upřesňuje již přijatý kontrakt; žádný nový approval gate. |
| openspec …/checkpoints/CP04-k09-freshness.md, reviews/ | přijatý brief a review záznamy před kódem; tasks.md 4.1/4.2 a audit-disposition.md K-09 řádek **nezaškrtnout/neuzavřít při zahájení apply** (§7) |

Hlášky jsou statické, bez URL/tokenů, odlišné pro job a krok (implementační volba); zůstávají konzistentní s CLI L271–274 a testy L209–278. Stávající regex `/wrong-attempt/` (test L106) zůstává platný, protože hláška L69 se nemění.

Pořadí diagnostik je záměrné: u Android jobu, který je sám stale, se nejdřív hlásí native mez, až pak job mez. Přijímaná množina receiptů se tím nemění (obě `require` platí), mění se jen která z nových hlášek padne první. Ověřeno proti skutečnému toku: `sanitizeJobs` (L183–201) ani `runIdentity`/`discover` časy nekontrolují, takže collect dojde až k `validateQualityProof` na L231 a tam selže. Verifier `collectPublicationProof` validační chyby nebalí (balí jen `readJSON`/`downloadArtifact`, L260–264, L284–285), hláška „Quality proof: …“ tedy doputuje do `assert.rejects`.

## 3. Fixtures

**Fixture K (collector, test A i B).** Lokální helper v testu, jen nastavení časů na existujícím `f.data`: `created_at T0=10:00`, `run_started_at T1=10:20`, `updated_at 10:40`, `run_attempt 2`, všech 21 jobů `run_attempt 2` (fixture `fetchImpl` odvozuje jobs endpoint z `run.run_attempt` při volání, L53; stejný postup jako test L100–107). Výchozí fresh joby `10:20–10:40`, Android kroky `10:20–10:30` a `10:25–10:35` (čísla 7, 8; uvnitř intervalu jobu). ID jobů mohou zůstat `1000+index` (collector nemá pin; nová ID nejsou pro pravidlo relevantní). `created_at < T1` je záměrné: mez proti `createdAt` by fixture přijala (M2).

- Test A (4.1 + job mez): carried-over = `f.data.jobs.jobs[0]` = „API container boots and serves“ (sorted index 0, non-Android; index 1 je Android), `started_at 10:05`, `completed_at 10:10`. Očekávání `assert.rejects(f.collect(), /Quality job started before the accepted attempt/)`. **Pozitivní fully fresh varianta:** tentýž job posunout celým intervalem na `10:20–10:30` (start i completion; posun jen startu za původní completion 10:10 by padl na `completedAt >= startedAt`, tedy ze špatného důvodu), pak `collect()` resolve, `run.attempt === 2`, 21 jobů. Doklad „pass pro úplný nový attempt bez GitHub rerunu“.
- Test B (4.2 krok): Android job `10:05–10:15` s kroky `10:05–10:10` a `10:10–10:15` — job i kroky konzistentně před T1 (realistický carried-over Android job podle T9), ostatní joby fresh. Očekávání `assert.rejects(f.collect(), /native verification step started before the accepted attempt/)`. Nepoužívá se uměle fresh job se starým krokem.

**Fixture V (verifier, test C).** Na vráceném `f` z `fixture()`: `f.qualityRun.run_started_at = iso("00:30")` a `f.proof.run.startedAt = iso("00:30")` (stejný objekt `qualityRun` je ve `values` i v discovery listing, L95–97; `validateLinkedQuality` L229–230 vyžaduje rovnost). `f.proof.jobs[0]` (non-Android) `startedAt iso("00:05")`, `completedAt iso("00:10")`; totéž zrcadlit do `f.qualityJobs.jobs[0].started_at/completed_at` (jinak by pod M1 padl „differ“ na L242 a C by nedokazoval přenos). `f.recheck.proofSha256 = createHash("sha256").update(json(f.proof)).digest("hex")`: `json` v testu (L16) je `${JSON.stringify(v, null, 2)}\n`, totožné s produkčním `serialize` (quality-proof.mjs:81), a `hashQualityProof` je právě sha256 hex nad tímto serialize (L82–85); přímý výpočet je nutný, protože `hashQualityProof` po fixu neplatný receipt odmítne. Pak `f.setEvidence(0, f.proof); f.setEvidence(1, f.recheck)`. Attempt zůstává 1: pravidlo porovnává jen `job.startedAt` s `run.startedAt`, attempt 2 je doložen testem A; modelovat attempt 2 ve V by vyžadovalo sladit `proof.run.attempt`, všech 21 `runAttempt`, `qualityRun.run_attempt`, `qualityJobs[].run_attempt`, `recheck.qualityAttempt` i klíč `attempts/2/jobs` ve `values` bez přínosu pro ověřované pravidlo. Očekávání `assert.rejects(collectPublicationProof(f.options), /Quality job started before the accepted attempt/)`. Horní meze (L298–301) zůstávají splněné (`02:00 <= 10:00`, `00:10 <= 09:30`).

## 4. Pořadí: baseline → red → fix → green → oslabující mutace → green → full

1. **Baseline** na skutečné main base nové codex větve: `node --test scripts/quality-proof.test.mjs scripts/verify-publication.test.mjs`; zapsat exit, counts, čas. Historický 40/40 z 5. 11. (K09-baseline.json) je skutečný běh, nikoli nový PASS a nepřenáší se.
2. **Red A, B, C na staré implementaci:** všechny tři dnes selžou proto, že `collect()`/`collectPublicationProof` resolve (žádné rejects). Red z jiného důvodu (hash, attempt, „differ“, schema) = return k fixture, ne pokračování.
3. **Minimální fix:** dvě `require` + parametr `validateNativeSteps` (§2).
4. **Green:** A, B, C a celá dvojice souborů; žádný stávající test nemění očekávání.
5. **Oslabující mutace (každá validátor oslabuje, dočasně nebo v kopii mimo repo, pak restore):**
   - M1 odstranit job mez → A a C musí selhat (C = důkaz transitivního přenosu do verifieru); B zůstává zelený (padá dřív na native).
   - M2 `run.startedAt` → `run.createdAt` v job mezi → A musí selhat (odliší `run_started_at` od `created_at`); varianta M2b totéž v krokové mezi → B musí selhat (native projde, padne job hláška, regex nesedí).
   - M3 odstranit krokovou mez → B musí selhat na očekávání: receipt je dál odmítnut job guardem s hláškou „Quality job started…“, regex native hlášky nesedí. **Netvrdit, že takový receipt začne celkově procházet.** A i C zůstávají zelené (non-Android carried-over job).
   - Nepoužívat `>=`→`>`: zpřísňuje, shodí baseline fixture, není důkaz nového pravidla.
   Pokud C pod M1 neselže, je to návrat k diagnóze přenosu, ne automatický duplikát pravidla ve verifieru.
6. **Obnovený green** po restore, pak §5 kontroly a finální nástrojové ověření (strict OpenSpec, `spec check`, whitespace).

## 5. Dočasná branch mapa kontrol (argv arrays)

```json
{
  "fast": ["node", "--test", "scripts/quality-proof.test.mjs", "scripts/verify-publication.test.mjs"],
  "source": ["pnpm", "check"],
  "planning-whitespace": ["git", "diff", "--check"]
}
```

Úzká smyčka mimo mapu: `node --test --test-name-pattern "accepted attempt" scripts/quality-proof.test.mjs` (názvy nových testů musí frázi obsahovat). Fast je node:test produkční logiky; nepatří do TS/UI lint a cílený types/lint pro tyto `.mjs` neexistuje (`pnpm typecheck` ani `pnpm lint` scripts/ nepokrývají). Finální `pnpm check` obsahuje dosavadní kontroly včetně `pnpm test` s oběma soubory (package.json `test`, `check`), s testovacími env hodnotami podle CP01 (ENVIRONMENT=test, BETTER_AUTH_URL, neprodukční DATABASE_URL; .env se nevypisuje).

Dočasně vynecháno a proč: `full` se nevytváří (CP02); gate dokončení je `pnpm check` + 21 current-head Quality jobů na PR head + branch protection jako samostatný pojmenovaný full gate, absence v mapě je přiznaný HOLD, ne PASS. `ui` N/A: release tooling v Node, žádné UI; `pnpm test:behavior:browser` tyto skripty nepokrývá. `database` N/A: žádná DB hranice se nemění. JSON scénář `pnpm test:behavior` N/A: skripty nejsou v inventáři `SUITES` (scripts/test-behavior.mjs:8); fixture funkce v `*.test.mjs` plní roli stav/akce/výsledek na existujících portech, nový driver se nezavádí (kdyby review trval, je to vlastní slice, tasks.md:12). Live/skutečná publikace se nespouští a nevydává za app check. `.spec-pilot.json` se před final review vrací na původní bajty (`099538b4…10ae`); sdílený goal/stop se nemění.

## 6. Prerequisites a pořadí před kódem

- P1: tento brief uložit jako `openspec/changes/align-project-workflows-and-complete-sync/checkpoints/CP04-k09-freshness.md`; strict OpenSpec na skutečné base: `/home/flamendrin/.cache/SPEC/openspec/1.15.0/binary/openspec validate align-project-workflows-and-complete-sync --strict --json` s cwd = worktree (SPEC může být v novém worktree not-installed; pin 1.15.0 funguje bez instalace frameworku); fresh-context design review (spec-review) a explicitní přijetí před prvním řádkem kódu.
- P2: implementace v samostatné `codex/` větvi z tehdy skutečného `main` (nyní e6015977; nová PR může main posunout → baseline, diffy a `git diff --check <merge-base> HEAD` se vážou k reálné merge-base). Výzkum na rootu neopravňuje měnit sdílený checkout `codex/cp01-docs-authorities`.
- P3: nezávisí na CP01 obsahu ani CP02 (tasks.md:8); nepřebírá CP01 branch mapu.
- Žádný release/deploy/tag/promotion, žádná instalace, GitHub rerun ani dotek vydaného main běhu.

## 7. Evidence, stav a stop/return

Evidence podle spec-guide/assets/verification.md: revize/merge-base, přesné příkazy, red/green/mutation výstupy před/po, hashe dotčených souborů, baseline nové base; implementace oddělená od publikace/deploymentu (AGENTS). Nezávislý spec-review finálního diffu s explicitním approve; při materiální změně znovu.

Stav: při zahájení apply se 4.1/4.2 nezaškrtávají a K-09 se nehlásí hotové. Po skutečném lokálním výsledku je stav **dílčí** (lokální green + mutace); řádek K-09 a tasks se aktualizují až podle skutečně proběhlých full gates (pnpm check, 21/21 current-head Quality, branch protection) a merge, každý s vlastním záznamem. Historické receipts (K09-research/brief/baseline, předchozí CP záznamy) se zachovávají.

Stop: dvě `require` + testy A/B/C zelené, mutační páry doložené, obnovený green, `pnpm check` lokálně, PR s current-head Quality 21/21 a branch gates, aktualizovaná publication.md věta; žádný tag, release, aktivace ani rerun. Return: red z neočekávaného důvodu, baseline test měnící očekávání, C neselhávající pod M1, potřeba scénářového driveru nebo změny politiky/inventáře, skutečný kontraktní rozpor mezi pořadím diagnostik a T9 → zpět k briefu/kanonice, výslovně popsat, nepřikrývat tvrzením PASS.
