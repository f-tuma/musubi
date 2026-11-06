# Final review — CP10 slice 10.3 + 10.3-T (federační outbound transport svázaný se schválenými DNS adresami): kanonický záznam

Stav: záznam autora (Claude Fable 5.1, Orca task `task_48acb364b519`) o nezávislém final review a doplňkovém nástrojovém review. Není to kopie soukromého reportu (ten zůstává mimo git; obsahuje v R-02 identifikátor soukromého advisory, který se do tracked obsahu nepřenáší) a není to schválení aktuálního headu po korekcích.

## 1. Nezávislý final review (Claude Fable 5.1, Orca worker `task_6d40b50b3707`, čerstvý kontext, read-only, 2026-11-06)

| Položka | Hodnota |
| --- | --- |
| Report (mimo git, soukromý) | `/tmp/musubi-cp10-federation-final-review.md`, SHA256 `b2b1b6f7c34e33e12503bb388f76857ccd410bc67b3cd8a5bc84c5522b4e5912` (82 řádků) |
| Reviewovaný subjekt | base `047779c20adb53f52575876aa8b0c340539fb583` = origin/main (tree `47f7146140bb8db1cc01690c269ad515a11217f0`) → head `13d00d3e66a144219aaac296210dbdcd7dd78cd0` (tree `da1ae7aa2c9360185d7ce570905c0aa036244b16`), commity `1d1cc95` (docs) + `13d00d3` (fix); 23 souborů, +1276/−28; čistý strom; `.spec-pilot.json` = původní bajty |
| Verdikt | **APPROVE** pro přesný diff `047779c… → 13d00d3e…` — **pouze code-review schválení**; výslovně není test PASS pro CI, inspekce current-head Quality, branch protection, merge, publikace advisory ani deployment |
| Runtime review | Node v22.23.4 (= `.nvmrc`), OpenSSL 3.6.5, Linux x86_64; lokální ref `main` ve worktree zastaralý, směrodatný origin/main = base |

Rozsah: celé zdrojové soubory `federation_origin.ts`, šest callsites, `provider-caldav/network.ts`, `network-origin.ts`, `types.ts`, exports, inventář všech volajících `fetchPinned`/`createPinnedCaldavFetch`/`createGuardedCaldavFetch`, `packages/config`; testy `federation_transport.test.ts`, JSON suite driver/CLI/manifest, `federation.test.ts`, `federation_gateway.test.ts`, `provider-caldav/src/index.test.ts`, runner a jeho self-test, `apps/api/package.json`, `quality.yml`; kanon (checkpoint v3 + §0, design review + disposition + adoption, acceptance jako tvrzení, tasks/audit/ADR/docs). Reviewer vlastními běhy: JSON suite 14/14 (392 ms), socket/TLS test OK, provider-caldav 37/37, fourth clock OK, API `tsc` exit 0, runner self-test 27/27, vlastní loopback probe pořadí happy-eyeballs, `git grep` identifikátoru nad HEAD/base, kontrola úklidu. Neopakováno: lokální `pnpm check`, mutace (záznamy posouzeny jako konzistentní s kódem), DB integrace a běžící aplikace (autorova evidence). Soukromý advisory nečten.

Limity dle reviewera: žádné CI pro tento head, žádný PR, branch protection neověřena (není PASS); doloženo jen na Linuxu; žádný externí DNS/TTL, produkce ani živý útok; UI N/A.

### Nálezy a disposition (žádný blocker)

| ID | Typ | Nález (vlastními slovy) | Disposition autora/koordinátora |
| --- | --- | --- | --- |
| R-01 | Doporučení, přesnost kanonu | Vlastní loopback probe reviewera (listenery `127.0.0.1` a `::1` na stejném portu, undici 7.30.1 Agent s `lookup` vracejícím sadu, Node 22.23.4): `[::1,127.0.0.1]` obsloužena v6, `[127.0.0.1,::1]` v4 → happy-eyeballs začíná rodinou **první adresy sady**, ne vždy IPv6. Invariant „jen přijaté adresy“ nedotčen; test `accepted-set-fallback` dává `::1` první, očekávání platí. | **Přijato, opraveno** 2026-11-06: checkpoint §3.1/§4.2 + datovaný dodatek v jeho §0; design review §0 disposition (F-11 řádky zůstávají historické). Nemateriální; požadavky (stejná přijatá sada, nativní výběr uvnitř ní) beze změny; kód/testy beze změny. |
| R-02 | Rozhodnutí před publikací PR | Tracked checkpoint (na base chybí) obsahoval v odkazu na scratch reprodukci gitignored cestu s identifikátorem nepublikovaného soukromého advisory; samotný report tracked není. | **Přijato, provedeno**: identifikátor nahrazen neutrálním popisem; protože veřejný PR nese i dřívější commity, byla nepublikovaná vlastní historie přepsána (původní revize zachovány jen v lokálním privátním backup refu); viz acceptance §7. Netýká se APPROVE kódu. |
| R-03 | Informace, pre-existing | `handlers/federation_proxy.ts:71` `assertPublicOrigin` mimo `try` → s vypnutým privátním profilem a loopback originem z DB vznikne 500 (autor zaznamenal); na base totožné; chybová plocha, ne bezpečnostní mezera. | Beze změny; mimo §3 tohoto slice; případná změna = vlastní rozhodnutí. |
| R-04 | Informace, CI prerekvizity | `federation_transport.test.ts` vyžaduje `openssl` ≥ 3, Node ≥ 22.19, loopback `::1`; `ubuntu-latest` + `node-version: 22` podle čtení splňuje; jinak explicitní fail/HOLD, ne skip. | Beze změny; ověří se až v PR CI (samostatný gate). |

Hledané a nenalezené defekty (reviewer): přepsání `dispatcher` volajícím; následování redirectu; únik na systémové DNS při použití dispatcheru (0 systémových lookupů i při mixu bundled undici 6.29.1 / workspace 7.30.1); změna SNI/Host; `rejectUnauthorized:false`/`NODE_EXTRA_CA_CERTS`/`setGlobalDispatcher`; neošetřená pozdní DNS chyba po abortu; dispatch po abortu ve stejném ticku; regrese CalDAV volajících; změna existujících assertions; nové závislosti; neregistrovaná CLI cesta; error codes mimo whitelist runneru.

## 2. Doplňkový nástrojový review (generický externí `pr-review`, mimo repozitář)

| Položka | Hodnota |
| --- | --- |
| Výstupy (mimo git) | `/tmp/musubi-cp10-pr-review.md` SHA256 `5c236f6951672fd5c540c4cfa13eabee8e6eebb17f0dd3fcc5d9d70424e6b675`; `/tmp/musubi-cp10-pr-review.json` SHA256 `77b9f5c89dc2a0379764c10d4275bb506546fa1480f90a15293a78d9c85fe42e` |
| Běh | model `claude-fable-5-1`, 1 AI volání, 167,5 s, 91 541 in / 11 095 out tokenů |
| Pokrytí | úplné: `files_not_reviewed: []`, `files_partially_reviewed: []` |
| Výstup | odhad náročnosti 4/5; „PR contains tests“: Yes; „No security concerns identified“; jedna doporučená oblast: **Agent cache churn** (`packages/provider-caldav/src/network.ts` L23–25) |

Význam: PASS nástroje znamená, že nástroj, schéma výstupu a pokrytí souborů proběhly úspěšně; **není to důkaz bezezávadnosti** ani náhrada nezávislého review výše.

Disposition návrhu „cache churn“ (seřadit/kanonizovat sadu před stavbou klíče, aby round-robin pořadí DNS odpovědí nevytvářelo nové Agenty): **nepřijato pro tento bezpečnostní fix, ponecháno jako nonblocking úvaha o efektivitě mimo scope.** Důvody: (a) nástroj tvrdí, že „Node's own address selection does not depend on the set's order“ — nezávislé měření R-01 to vyvrací: pořadí sady určuje první zkoušenou rodinu, takže seřazení sady by změnilo preferenci připojení; (b) kanonizovat pouze klíč cache a přitom Agentu předat původní pořadí by znamenalo, že reusovaný Agent připojuje podle pořadí z **dřívějšího** resolve, ne z aktuálního; (c) cache je ohraničená (256 klíčů, `close()` nejstaršího) a klíč nese jen adresy, které prošly policy v aktuálním resolve, takže invariant platí; (d) uspořádaný klíč přijaté sady je přijatý návrh (brief v3 §3.1, D-C). Případná optimalizace je samostatné rozhodnutí s vlastním měřením.

## 3. Vazba na aktuální historii větve

Review se vztahuje k původnímu headu `13d00d3e…`. Po něm proběhla pouze dokumentační/privacy korekce (R-01, R-02) s přepisem nepublikované historie; strom mimo `openspec/` zůstal bajtově shodný s reviewovaným headem (ověřeno `git diff 13d00d3 <nový head> -- . ':!openspec'` prázdný). Aktuální head dosud nezávisle neposouzen; koordinátor si vyžádá úzký review těchto korekcí a nezměněného zdroje. Hashe nové historie: acceptance §7, `STATUS.json` (gitignored) a report koordinátora.

## 4. Final review v2 a merge (dodatek, 2026-11-06; připojeno předkódovým commitem CP02 2.1a, §1–§3 beze změny)

| Položka | Hodnota |
| --- | --- |
| Reviewer | Claude Fable 5.1, Orca worker `task_6029a3cfb41b` (dispatch `ctx_988ed215666f`), nezávislý read-only review v čerstvém kontextu, 2026-11-06 |
| Report (mimo git, soukromý) | ignored `backups/codex-cp01-20261105/reports/CP10.3-final-review-194aaa66.md` v původním checkoutu, SHA256 `f5c159caf5ae3d6287c9c504451852020c81e585187756a699b7027d76471e97`; identifikátor soukromého advisory v něm není (hledán jen vzorem, vypisovány počty) |
| Subjekt | přesný diff `047779c20adb53f52575876aa8b0c340539fb583 → 194aaa66a2643ed11871d66735f8520e31e2d185` (tree `781cb6ee1bc75d7d269ff49e453d45b3eab92db4`), tj. aktuální head po dokumentační/privacy korekci §3 |
| Verdikt | **APPROVE, pouze code-review**, výslovně pro nový head `194aaa66`, ne jen historický `13d00d3e`: zdrojové, testovací, runnerové, závislostní a CI bajty hashově totožné se schváleným headem v1; pět změněných dokumentů řeší R-01 a R-02; žádný publikovatelný commit ani message nenese soukromý identifikátor; provenance přepisu nepublikované historie koherentní. Není to CI PASS, inspekce Quality, branch protection, merge, publikace advisory ani deployment. |
| V2-R-01 (doporučení, úplnost tohoto záznamu) | §1 „Limity dle reviewera“ nevyjmenoval limit z reportu v1 §2: skill `.agents/skills/spec-review/SKILL.md` ve worktree `codex-federation-transport-pinning` **neexistoval**, review v1 se proto řídilo zadáním koordinátora a briefem §8; review v2 už postupoval podle skillu čteného z původního checkoutu `/home/flamendrin/workspace/musubi`. Tímto odstavcem doplněno; na verdikt ani kód bez vlivu. |

Merge a post-merge evidence: Quality run 42213525733 attempt 1 21/21 na `194aaa66`, squash `7128c651bf6e0b19a777711c9608315a775db737` (tree `781cb6ee…` = tree schváleného headu = tree CI merge checkoutu `160127a1…`), merge receipt ignored `CP10.3-merge-receipt.json` SHA256 `19be0d05dcd8d44c4226c51020043e7a29e182482079d6342f04eb897518419c`; GitHub required checks not-configured/unknown (ne PASS); advisory nepublikováno, deployment žádný. Souhrn a limity: `../checkpoints/CP10-federation-transport-closure.md`.
