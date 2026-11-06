# CP10 slice 10.3 + 10.3-T — closure (post-merge source acceptance PR #411)

Stav: **source acceptance po merge** boxu 10.3 a testovacího sub-slice 10.3-T. Implementace je reviewovaná a sloučená jako source; tento záznam jen ukládá post-merge evidenci. Bezpečnostní kód se znovu neotevírá. **Žádná publikace advisory, kontakt reportéra ani deployment.** Historické záznamy (`CP10-federation-transport.md`, `CP10-federation-transport-acceptance.md` §1–§7, `../reviews/CP10-federation-transport-design.md`, `../reviews/CP10-federation-transport-final.md` §1–§3) zůstávají beze změny; připojují se jen datované dispozice (acceptance §8, final review §4). Tento soubor je evidence nesená předkódovým commitem větve `codex/cp02-root-behavior-cli` (CP02 2.1a, přijatý brief v3 §8.2), ne scope slice 2.1a. Neobsahuje žádný soukromý identifikátor ani cestu nesoucí identifikátor.

Autor: Claude Fable 5.1, Orca task `task_ea9c98e10954` (dispatch `ctx_b9bb339a9b19`), 2026-11-06. Worktree `/home/flamendrin/orca/workspaces/musubi/codex-cp02-root-behavior-cli`, base `origin/main` `7128c651bf6e0b19a777711c9608315a775db737` (tree `781cb6ee1bc75d7d269ff49e453d45b3eab92db4`) = squash commit tohoto slice.

## 1. Immutable evidence

| Fakt | Hodnota | Zdroj (ověření) |
| --- | --- | --- |
| PR | [#411](https://github.com/f-tuma/musubi/pull/411), MERGED 2026-11-06T12:12:06Z, base `main` | `gh pr view 411 --json state,mergedAt,mergeCommit,headRefOid` (read-only, 2026-11-06, autor) |
| Base → schválený head | `047779c20adb53f52575876aa8b0c340539fb583` (tree `47f7146140bb8db1cc01690c269ad515a11217f0`) → `194aaa66a2643ed11871d66735f8520e31e2d185` (tree `781cb6ee…`) | `git rev-parse <commit>^{tree}` (autor) |
| Final review v2 | **APPROVE, pouze code-review**, pro přesný diff `047779c → 194aaa66` (tree `781cb6ee`); reviewer Claude Fable 5.1, Orca worker `task_6029a3cfb41b`, 2026-11-06 | ignored `backups/codex-cp01-20261105/reports/CP10.3-final-review-194aaa66.md` v původním checkoutu, SHA256 `f5c159caf5ae3d6287c9c504451852020c81e585187756a699b7027d76471e97` (hash ověřen autorem) |
| Final review v1 | APPROVE code-only pro `047779c → 13d00d3e` | ignored `CP10.3-final-review-13d00d3.md`, SHA256 `b2b1b6f7c34e33e12503bb388f76857ccd410bc67b3cd8a5bc84c5522b4e5912` (už v `../reviews/CP10-federation-transport-final.md` §1) |
| Doplňkový pr-review | nástrojový, není důkaz bezvadnosti | ignored `CP10.3-supplementary-pr-review.md`, SHA256 `5c236f6951672fd5c540c4cfa13eabee8e6eebb17f0dd3fcc5d9d70424e6b675` (kanonicky final review §2) |
| Quality | run 42213525733, attempt 1, event `pull_request`, head `194aaa66`, **21/21 success** (žádný skipped/cancelled/timed out); job „Typecheck, test, lint, docs, and migrations“ = `pnpm check` success, v něm JSON suite `federation-transport` 14/14 (314 ms), `federation transport socket/TLS self-check: OK (v22.23.4, OpenSSL 3.5.5, linux)`, security/gateway/stream self-checks OK; CI merge checkout `160127a16cdf06e21f95a8fa20839e3599726379` (rodiče `047779c2` + `194aaa66`), tree `781cb6ee…` | ignored `CP10.3-Quality868.md` (SHA256 `278408f9930f57931c73da46a48eaccde33406eb1eb99ae132cd56219849674d`) a `CP10.3-Quality868.json` (SHA256 `be0b7145bf5a67fb14cb736a4e662b35c57f09646dd415dfeaf614c1cf0eed82`); nezávislý `gh run view` v design review 2.1a v3 §6 |
| Squash | `7128c651bf6e0b19a777711c9608315a775db737`, tree `781cb6ee…` = tree schváleného headu = tree CI merge checkoutu | ignored `CP10.3-merge-receipt.json`, SHA256 `19be0d05dcd8d44c4226c51020043e7a29e182482079d6342f04eb897518419c` (`equality_verified`, `quality_jobs_success: 21`, `deployment: false`); `git rev-parse 7128c651^{tree}` a `194aaa66^{tree}` (autor) |
| Vynucení | GitHub required checks / branch protection **not-configured/unknown** (classic protection 404, `rules/branches/main` `[]`, ruleset 19609735 active s prázdným `include`); procesní brána 21/21 dodržena; settings beze změny | `CP10.3-Quality868.md` §„Branch protection a pravidla“, design review 2.1a v3 §6 |
| Publikace/deploy | advisory nepublikováno, reportér nekontaktován, žádný deployment (`deployment: false`) | merge receipt |

Vazba stromů: tree `781cb6ee1bc75d7d269ff49e453d45b3eab92db4` je shodný pro schválený head `194aaa66`, CI merge checkout `160127a1` i squash `7128c651`; současný `origin/main` i base CP02 větve ukazují na `7128c651`.

## 2. Proč je `10.3 [x]` oprávněné

Text boxu: „Sjednotit outbound guard skutečného připojení a redirectu pro federační cesty; ověřit kontrolovaný DNS rebinding/redirect port, native TLS chování a povolené privátní profily bez živého útoku.“ Kanonický checkpoint a acceptance (§2–§4) dokládají všechny části:
- šest federačních callsites jde přes `federationFetch`, který je připnutý na přijatou adresní sadu a má `redirect: "manual"`;
- JSON suite `federation-transport` 14/14 s kontrolovaným DNS portem (injektovaný lookup, ne živý útok);
- loopback socket/TLS test (vlastní CA, SNI, altname, redirect vrácen a nenásledován, druhý listener dostal 0 requestů);
- privátní profil zapnutý i vypnutý v běžící aplikaci;
- mutace (M-leaf, M-wrapper) zachyceny;
- vlastní DB integrace a běžící aplikace na loopbacku;
- žádný živý útok.

Stop checkpointu (`CP10-federation-transport.md` §9: „10.3 unchecked do merge+acceptance“) je po merge `7128c651` a této post-merge acceptance splněn. 10.3-T: podmínka „box 10.3 zůstává nezaškrtnutý do merge a acceptance“ (`../tasks.md`) je splněna po merge PR #411.

## 3. Limity, které closure přebírá

- doloženo jen na Linux x86_64 / Node 22.23.4 (lokálně OpenSSL 3.6.5, CI OpenSSL 3.5.5);
- bez externího DNS/TTL, produkce a živého útoku; fixture peer a Postgres jen na vlastním loopbacku;
- gateway 500 při vypnutém flagu je pre-existing chybová plocha a mimo scope (final review R-03);
- „native TLS“ znamená TLS stack Node, ne mobilní klienty;
- `reviewDecision` PR je prázdný (žádná GitHub review policy); nezávislý review je reportem, v souladu s AGENTS;
- branch protection není PASS (viz §1 Vynucení).

## 4. Co se neuzavírá

Neuzavírá se 10.1, 10.2, 10.4, 10.5 ani celý CP10. Žádné CP04 boxy: K-09 je v `main` jako `047779c2` (PR #410), ale jeho closure není v tomto scope. Better Auth, publikace advisory, odpověď reportérovi a deployment zůstávají mimo.

## 5. Hranice a nosný PR

- **Source acceptance po merge; žádná publikace advisory, kontakt reportéra ani deployment.**
- Nosný PR: PR slice CP02 2.1a z větve `codex/cp02-root-behavior-cli` (číslo se doplní při otevření). Bez samostatného bookkeeping PR ani CI cyklu; commit prochází finálním nezávislým review a 21 current-head Quality joby nosného PR.
- Privacy: před commitem autor prohledal nové a změněné soubory vzorem identifikátoru advisory a vypsal jen počty (0 výskytů); soukromý advisory ani report nečetl.
- Čerstvé mechanické kontroly na větvi po tomto commitu: strict OpenSpec validate valid; `spec check --phase orient/design` `mechanical_result: pass`, `semantic_result: unknown`; `git diff --check` čistý (raw v gitignored `backups/spec-sessions/cp02-root-behavior-cli-20261106/runs/`).
