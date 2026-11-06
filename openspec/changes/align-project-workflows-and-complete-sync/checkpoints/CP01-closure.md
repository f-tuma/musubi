# CP01 1.1–1.4 — closure (source implementace a merge; post-merge evidence)

Stav: **source closure boxů 1.1–1.4** na základě immutable evidence sloučených PR #407 a #409. Jde o source implementaci a merge, nikoli publication/deployment; historické acceptance (`CP01-docs-acceptance.md`, `CP01-toolchain-acceptance.md`) a review (`../reviews/CP01-final-after-ci.md`, `../reviews/CP01-toolchain-final.md`) zůstávají beze změny a tento záznam se k nim jen připojuje datovanou dispozicí. Tento soubor je evidence nesená předkódovým commitem větve `codex/cp02-root-behavior-cli` (CP02 2.1a, přijatý brief v3 §8.1), ne scope slice 2.1a.

Autor: Claude Fable 5.1, Orca task `task_ea9c98e10954` (dispatch `ctx_b9bb339a9b19`), 2026-11-06. Worktree `/home/flamendrin/orca/workspaces/musubi/codex-cp02-root-behavior-cli`, base `origin/main` `7128c651bf6e0b19a777711c9608315a775db737` (tree `781cb6ee1bc75d7d269ff49e453d45b3eab92db4`).

## 1. Immutable evidence (ověřeno vlastními příkazy nad git objekty a read-only `gh`)

| PR | Reviewovaný head / verdikt | Finální head | Quality (current head) | Squash do `main` | Tree |
| --- | --- | --- | --- | --- | --- |
| [#407](https://github.com/f-tuma/musubi/pull/407) (boxy 1.1, 1.2, 1.4; base merge-base `d9ff9dce…`) | `a668814a8409bdb0e4a24bc4ca7a21769a1cd9db` — **APPROVE** (`../reviews/CP01-final-after-ci.md`, fingerprint `2fa2d4b0…`) | `5bfb3413f50c87bda5bbbf3fe00e363c65d0ec71`; `git diff --stat a668814a 5bfb3413` = jen `reviews/CP01-final-after-ci-subject.json` + `reviews/CP01-final-after-ci.md` (evidence-only, dle review bez re-review) | run 42124082949, attempt 1, 21/21 success | `e6015977adba39e909a0824787ac9adcb64a8e99` (`gh pr view 407`: MERGED, mergeCommit = e6015977) | `48a6eed809faf32b1d9057732b98c878d1fef1a8` = tree `5bfb3413` = tree `e6015977` |
| [#409](https://github.com/f-tuma/musubi/pull/409) (box 1.3; base `e6015977…`) | `ba139e83e2b3d5e9213e06f6a1bd6859eb636c4d` — **APPROVE** (`../reviews/CP01-toolchain-final.md`, 12 souborů) | `1f47561d52aff72438e9b0fb30f6c6a3ec90764c`; `git diff --stat ba139e83 1f47561d` = jen `reviews/CP01-toolchain-final-subject.json` + `.md` | run 42187097708, attempt 1, 21/21 success | `9d08c100ecd3c2f09e8c503bacb544214c870996` (`gh pr view 409`: MERGED, mergeCommit = 9d08c100) | `8635342768ca4506c016ab7b523ec4d5ad8f6897` = tree `1f47561d` = tree `9d08c100` |

Vazba boxů: 1.1 a 1.2 (docs/navigace/příkazy) a 1.4 (vlastníci a role trackeru dle D6, `design.md` D6; projekce Its a Plan v `CP01-docs-acceptance.md` §„Projekce Its a Plan“) = PR #407; 1.3 (koherence Node toolchainu) = PR #409. Dodatek `CP01-docs-acceptance.md` z 5. listopadu 2026 a `CP01-toolchain-acceptance.md` nesou lokální acceptance; tento closure doplňuje jen merge a current-head Quality.

## 2. Co zaškrtnutí znamená a co ne

- Zaškrtnutý box = implementace, nezávislý review, squash merge po zelené current-head Quality (21/21, attempt 1) a tento odkaz na immutable evidenci (definice v `../tasks.md`, řádek „Stav“).
- **Source implementace a merge, nikoli publication/deployment; historické acceptance/review beze změny.** Žádný docs web, store, image ani release se tímto nepublikuje.
- Navazující boxy, které CP01 acceptance jen jmenují (2.5, 5.1, 11.2, 11.4), nejsou provedené; jejich řádky v `../audit-disposition.md` si ponechávají původní „lokálně…“ formulaci a mění se jen poslední věta na „Přijato v PR …“.

## 3. Limity převzaté z historických acceptance (R-02 design review 2.1a v3)

Z `CP01-docs-acceptance.md` (boxy 1.1, 1.2, 1.4):
- Link ledger: 178 lokálních cílů/anchorů pass; **36 historických/permalink odkazů neověřeno** na jejich původní revizi a **44 externích cílů nepozorováno**; dodatek po merge #406/#408 je nepovýšil na PASS. Veřejné HTTP vykreslení GitHub anchorů se neověřovalo.
- Repository record nepotvrzuje hosted Google OAuth verification; REL-07 store stav zůstává unknown do inventury.
- Běžící docs ověřeny jen lokálně (produkční node entry z čerstvého dist, desktop i narrow viewport), ne na veřejném webu.

Z `CP01-toolchain-acceptance.md` a řádku DX-06 (box 1.3):
- Runtime dopad původního nesouladu (lokální Node 24) zůstává **neověřený**; deklarace jsou sjednocené na `.nvmrc` 22.23.4 a strojově hlídané.
- CI patch **plave** (`node-version: 22`), validátor porovnává soubory a **nevynucuje `process.version`**, **EAS/native Node neověřen** a z repa neurčený; sync-reference image Quality nestaví; `COPY --from=<externí image>` nehlídán; hláška `package-sync-alpha.mjs:99` zůstává hardcoded; docs ochrana je literálová.
- Dependency floor (`undici >=22.19.0`) se neuvádí jako support claim.

## 4. Stavy full gate (`../tasks.md:16`), hlášeno odděleně

- (a) `pnpm check` a procesní brána 21 current-head Quality jobů: pro #407 a #409 **PASS podle skutečných runů** uvedených v §1 (attempt 1, 21/21 na finálním headu). Pro nosný CP02 PR se hlásí znovu podle jeho vlastního headu, ne převzetím.
- (b) GitHub required checks / branch protection: **not-configured/unknown** (k 2026-11-06: classic protection 404, `rules/branches/main` `[]`, ruleset 19609735 „Main Protect“ active s prázdným `include`). Nehlásí se jako PASS ani FAIL.
- (c) Vynucení pravidel: follow-up pod stávajícím 2.5; v tomto commitu se žádné settings nemění.

## 5. Čerstvé mechanické kontroly na větvi (po tomto commitu, cwd = worktree)

- `openspec validate align-project-workflows-and-complete-sync --strict` (OpenSpec 1.15.0): valid.
- `spec check --project . --phase orient` a `--phase design` (SPEC 0.4.0): `mechanical_result: pass`, `semantic_result: unknown`, bez findings. Mechanický průchod není sémantické schválení.
- `git diff --check`: čistý.
Raw výstupy: gitignored `backups/spec-sessions/cp02-root-behavior-cli-20261106/runs/` (jen v tomto worktree).

## 6. Nosný PR a provenance

- Nosný PR: PR slice CP02 2.1a z větve `codex/cp02-root-behavior-cli` do `main` (číslo se doplní při otevření; tento commit prochází jeho finálním nezávislým review a 21 current-head Quality joby).
- Zdroj tohoto closure: přijatý brief CP02 2.1a v3 §8.1 (SHA256 `d0a102384eff15e208147031823a99828be22843b111123ef0dc68d3eb030298`, kanonicky `CP02-2.1a-root-cli.md`), design review v3 §6 (`../reviews/CP02-2.1a-root-cli-design.md`) a vlastní ověření autora: `git rev-parse <commit>^{tree}` pro `e6015977`, `5bfb3413`, `9d08c100`, `1f47561d`; `git diff --stat` reviewed→final head; `gh pr view 407/409 --json state,mergeCommit` (read-only, 2026-11-06). Quality run ID/attempt/počty převzaty z historických review/acceptance a potvrzeny design review v3 §6 (`gh run view`); autor je znovu nedotazoval.
- Nepřepisuje se žádný historický záznam; checkbox 1.x se nesmí číst jako důkaz publikace docs webu, store buildů ani deploymentu.
