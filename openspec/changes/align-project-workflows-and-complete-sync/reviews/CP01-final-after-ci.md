# CP01 docs — nezávislý úzký finální re-review po merge CI prerekvizity (v2)

Datum: 5. listopadu 2026. Reviewer: čerstvý kontext (Orca worker, task `task_11834a538a10`), bez autorovy konverzace, bez čtení `reviews/CP01-final.md`, `reviews/CP01-design.md` ani jiných final/design review reportů. Projekt hlásí `review.mode: spec`, `document_language` prázdný; report je česky podle zadání. Read-only: žádná síť, testy, instalace, build, git/tracker mutace ani čtení `.env`.

## Subjekt a otázka

| Položka | Hodnota |
| --- | --- |
| Repo | `/home/flamendrin/workspace/musubi`, větev `codex/cp01-docs-authorities` |
| HEAD (ověřeno `git rev-parse`) | `a668814a8409bdb0e4a24bc4ca7a21769a1cd9db` |
| Base / merge-base s `origin/main` | `d9ff9dce5233aa28d25f1592e5f588b96087f09c` (PR #408 squash; `585dd23` = #406 je jeho rodič) |
| Manifest | `/tmp/musubi-cp01-after-ci-final-subject-v2.json`, 16 primárních SHA256 |
| Fingerprint | `2fa2d4b03d06af64354809f26edfbdec0c48422c264e50fee0b0949d7135574f` |
| Předchozí plně revidovaný head | `8010531d1e18622949de79357471f96561fe2f84`, fingerprint `9c384a516656b3c42e4856633d751579ef64b6b0624c781fdf71e17b72295bc7` (`/tmp/…-v1.json`) |

Otázka: jsou `checkpoints/CP01-docs-acceptance.md` a její vazba na `audit-disposition.md`, skutečný merge-base a přesný finální docs diff konzistentní a obsahově připravené k aktualizaci PR407? Nejde o nové test PASS, CI, merge ani release approval.

## Mechanické ověření (provedeno tímto reviewerem)

| Kontrola | Výsledek |
| --- | --- |
| HEAD = `a668814a…` | shoda |
| 16 primárních SHA256 z manifestu v2 proti `git show <head>:<path>` | 16/16 shoda; working tree bajtově shodný s HEAD u všech 16 |
| Fingerprint v2 (SHA256 kompaktního seřazeného JSON) | přepočten, shoda `2fa2d4b0…` |
| Manifest v1 proti `8010531`: 16 hashů + fingerprint `9c384a51…` | shoda |
| Rozdíl v1→v2 | jediný změněný primární soubor `checkpoints/CP01-docs-acceptance.md`; zbývajících 15 bajtově identických |
| `git diff 8010531 a668814` | pouze acceptance, +17 řádků (disclaimer nahoře + „Dodatek“) |
| Merge-base HEAD s `origin/main` | `d9ff9dc` = deklarovaná base; `d9ff9dc` je předek HEAD |
| Strom `585dd23` (#406 squash) = strom `1bf82a8` | shoda (`fd327d75…`) |
| Strom `d9ff9dc` (#408 squash) = strom `a88e8d7` | shoda (`4a2069b6…`) |
| Počet přehraných commitů `d9ff9dc..0e8541c` | 6 (`d479707`, `4772991`, `95c237b`, `0ed1aa0`, `7e3ae7a`, `0e8541c`); pak 2 evidence commity `8010531`, `a668814` |
| Obsahový diff starého PR407 headu `5261c2b` vs `585dd23` proti `0e8541c` vs `d9ff9dc` (mimo audit soubor) | bajtově IDENTICKÝ; u `audit-disposition.md` jsou +/- řádky obou diffů identické (liší se jen kontext TEST-08 z nové base) |
| 15 primárních souborů mimo audit/acceptance proti `5261c2b` | identické; `audit-disposition.md` a acceptance se liší jen o TEST-08 row (8010531) a dodatek (a668814) |
| Fingerprint primární sady na `d72c25a`, `07320d9`, `5261c2b` | všechny `78dbe9f9…` = `approvedPrimaryFingerprint` v `CP01-main-base-validation.json` |
| `audit-disposition.md` base..HEAD | změněné řádky jen ARCH-03, DX-01, DX-02, OPS-06, REL-02, REL-07, TEST-01, TEST-08, WHOLE-01, WHOLE-05 — přesně ID z briefu + TEST-08 |
| #408 změnil v audit souboru jen vložení TEST-08; v `tasks.md` jen větu „Závislosti“ | ověřeno; `tasks.md` base..HEAD beze změny, 0/72 checked |
| `.spec-pilot.json` base..HEAD | beze změny (T1: žádné zbylé slice overrides) |
| Brief `CP01-docs-authorities.md` na `041774e` vs HEAD | identický |
| `docs/project/brief.md` na base `d9ff9dc` | obsahuje `## Vlastnictví dokumentů` (řádek 55); cíle dvou dříve pending `blob/main` odkazů (contributing.mdx:56, commands.mdx:17) existují |
| Odkazy dodatku `../reviews/CP01-main-base-validation.json`, `../reviews/CP01-ci-base-validation.json`; cíle TEST-08 row `checkpoints/CI-brand-fixtures.md`, `checkpoints/CI-brand-fixtures-acceptance.md` | existují v HEAD |
| `CI-brand-fixtures-acceptance.md` | skutečně říká „slice NENÍ hotový… chybí finální review, PR, 21 jobů“ = historický záznam lokální fáze, jak dodatek tvrdí |

## Co bylo úzce revidováno a co přijato shodou bajtů

Obsahově přečteno a posouzeno: celý `CP01-docs-acceptance.md` (historická část i dodatek), dotčené řádky `audit-disposition.md` (vč. historie TEST-08 row na `585dd23`/`d9ff9dc`/`8010531`/HEAD), bounded brief `CP01-docs-authorities.md`, `AGENTS.md`/`CLAUDE.md`, design T1/T2/D6, specs WF-01–WF-04 a VT-05, research „Project checks index“, oba mechanické receipts, relevantní řádky `CI-brand-fixtures.md` (§9.4 požadavek totožného obsahového diffu) a hlavička `CI-brand-fixtures-acceptance.md`. Ostatních 14 primárních souborů (README, docs README, roadmap, brief.md, releasing.md, authorities brief, design, research, 6× MDX) nebylo znovu obsahově čteno: jsou bajtově shodné s headem `8010531`, který byl dříve plně revidován, a shodné i s dříve schváleným PR407 headem `5261c2b`.

## Posouzení konzistence

- **Časový rámec a zdrojové revize.** Historická část nese timestamp `2026-11-05T16:44:51Z` a stav „#406 dosud ne v main“; nový disclaimer nahoře (ř. 3) ji výslovně označuje za historii a odkazuje na dodatek. Dodatek nese datum 5. 11. 2026, uvádí `585dd23`, `d9ff9dc`, `5261c2b`, `0e8541c`, `a88e8d7` — všechny existují a jejich vztahy (rodič, stromy, předek) sedí s git objekty. Receipt `CP01-ci-base-validation.json` je z 22:28:16Z, commit `a668814` z 22:37:41Z; pořadí je konzistentní. Historie není přepsána, jen doplněna.
- **Vazba na audit-disposition.** Dodatek (ř. 64, 68) přesně popisuje, že jediná změna auditu po rebase je TEST-08 (převzatý z base a doplněný o skutečný merge/CI #408); ověřeno diffem. Ostatních 9 dotčených řádků dál říká „finální přijetí CP01/PR/CI zůstává otevřené“; žádný není uzavřen. TEST-08 row sama říká „přijetí tohoto slice, nikoli CP02/CP03 nebo nový PASS pro PR407“ a nechává TEST-04/05 otevřené. Odpovídá WF-04 (rozlišený status) a briefu („aktualizovat jen doloženou část“). Rozhodnutí o rozsahu evidenční aktualizace je explicitně přiznáno jako koordinátorské, bez změny produktu či návrhu.
- **Skutečný merge-base a finální docs diff.** Dodatek uvádí base `d9ff9dc`, 6 přehraných commitů bez konfliktů, rebased head `0e8541c` a nezměněný živý docs obsah — vše ověřeno. Splňuje §9.4 prerekvizitního briefu (obsahový diff PR407 zůstal totožný, ověřitelné range-diffem/diffem) i brief CP01 („kontroly finálního diffu použijí skutečný merge-base a head“).
- **Nesměšování cizích CI výsledků a pending gates.** Dodatek odděluje: 21/21 run patří #408 (jen CI-brand slice), starý PR407 run 16/5 není důkaz, nový current-head Quality pro PR407 chybí, stejně jako schválení bajtů, publikace do větve a merge. Mechanické receipts jsou označeny jako mechanické. Odpovídá VT-05, T1/research (full gate = pnpm check + 21 current-head jobů) a AGENTS git workflow (squash až po zelených checks pro current head).
- **Žádné nepravdivé dokončení.** `tasks.md` 0/72; dodatek říká totéž; Node 1.3/DX-06 zůstává otevřený; tracker označen jako projekce. Brief nikdy nevyžadoval zaškrtnutí před gate výsledky.

## Nálezy

Blockery: **žádné.**

Doporučení (nebrání aktualizaci PR407; lze vyřešit později nebo nechat):

- **R-01 — nejednoznačný label „D-01“** (`CP01-docs-acceptance.md:68`). Věta „Jde o rozhodnutí D-01 k rozsahu evidence“ neříká, čího číslování je D-01. Design používá D1–D6 (D1 = Home/creator removal), review reporty používají vlastní „D-01“ položky. Samotná acceptance to nerozliší. Dopad: nízký (věta dál jasně říká, o jaké rozhodnutí jde). Návrh: při příští evidenční úpravě doplnit „D-01 (položka review reportu, nikoli design D1)“ nebo label vypustit. Nemění primární obsah slice.
- **R-02 — „šest dokumentačních commitů“** (`:64`). Šestý přehraný commit `0e8541c` přidává jen receipt `CP01-main-base-validation.json`, nikoli docs obsah; formulace je volná, věcně ale sedí (všech 6 má prefix `docs:` a range-diff je sedí). Dopad: zanedbatelný; nic není třeba měnit.
- **R-03 — TEST-08 row odkazuje na historickou acceptance bez označení** (`audit-disposition.md`, řádek TEST-08, bajty z `8010531`, mimo úzce změněný soubor). Row tvrdí merge + 21/21 a vedle toho odkazuje „[acceptance](checkpoints/CI-brand-fixtures-acceptance.md)“, jejíž text říká „slice NENÍ hotový“. Čtenář jen auditu nevidí, že jde o záznam lokální fáze před PR/CI/mergem; vysvětluje to až dodatek acceptance (ř. 63). Dopad: nízký, přes dva dokumenty konzistentní. Návrh: volitelně v příští úpravě auditu dopsat „(historický záznam lokální fáze)“; ne nyní, zachovalo by se tím revidované bajty.
- **R-04 — provozní poznámka k lokálnímu checkoutu.** Lokální větev `main` je na `b138056` (behind 2 za `origin/main`). Diff/merge-base kontroly při updatu PR407 je nutné dělat proti `origin/main`/`d9ff9dc`, ne proti lokální `main`. Netýká se obsahu dokumentů.

## Skutečně neověřené oblasti

- Výsledky GitHub Actions runů 42118340370 (21/21 na `a88e8d7`) a 42104615417 (16 success / 5 failure na `5261c2b`), existence a stav PR #406/#407/#408 na GitHubu, veřejné vykreslení anchoru `#vlastnictví-dokumentů`: bez sítě; lokálně ověřeno jen to, co lze z git objektů (rovnost stromů, existence commitů/souborů/nadpisu).
- Stavy trackeru MUSU-70/71/72 a iniciativy 32: netestováno (bez tracker přístupu v tomto review); v dokumentu správně označeno jako projekce.
- Výrok „vlastník výslovně povolil merge #406“: opřen jen o receipt (`authorization` pole); neautentizováno.
- Původní lokální kontroly (pnpm check, docs:build, browser proklik, link ledger) se nespouštěly a dodatek je nepředstírá jako znovu provedené; jejich vstupy (14 content souborů) jsou bajtově shodné s dříve revidovaným stavem.
- Grep na label „D-01“ zasáhl i řádky v `reviews/final.md` a `reviews/CP01-design.md`; jejich obsah nebyl čten ani použit k posouzení.

## Verdikt

**APPROVE** pro položenou otázku: acceptance `CP01-docs-acceptance.md` (dodatek i zachovaná historická část) a její vazba na `audit-disposition.md`, skutečný merge-base `d9ff9dc` a bajtově totožný finální docs diff jsou konzistentní a obsahově připravené k aktualizaci PR407 na head `a668814a8409bdb0e4a24bc4ca7a21769a1cd9db`, fingerprint `2fa2d4b03d06af64354809f26edfbdec0c48422c264e50fee0b0949d7135574f`, 16 primárních hashů dle manifestu v2.

Platí jen pro tyto přesné bajty a tuto otázku. Není to test PASS, Quality/CI, merge ani release approval; nový current-head Quality (21 jobů), branch protection a skutečný merge PR407 zůstávají otevřené gates, jak dodatek sám uvádí.

**Evidence-only charakter dalšího kroku:** pokud se po tomto APPROVE do větve přidá pouze tento report a manifest pod `reviews/` (bez změny kterýchkoli z 16 primárních souborů), primární bajty i fingerprint `2fa2d4b0…` zůstávají přesně ty schválené a nové obsahové review není potřeba; změna kteréhokoli primárního bajtu vyžaduje re-review.
