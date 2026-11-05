# Bounded brief: CI brand fixtures (prerekvizitní testová oprava pro blokovaný CP01)

Stav: **přijatý brief** (nezávislé design review APPROVE, `reviews/CI-brand-fixtures-design.md`). **[U0]**
Autor: Claude Opus 5.5, Orca task task_d1c57c84bb27, 2026-11-05.
Kanonické umístění: `openspec/changes/align-project-workflows-and-complete-sync/checkpoints/CI-brand-fixtures.md` (větev `codex/ci-brand-fixtures` z `585dd231`, ne PR407).

## 0. Přijetí a nemateriální upřesnění

- Přijatý subjekt: `/tmp/musubi-ci-brand-fixtures-brief.md`, 167 řádků, SHA256 `961943955f7282e5d740ac3aeb388fcdeb7da5ecd511a2d157bbc55dfac278f2`.
- Design review: Claude Fable 5.1, Orca task `task_815abb18fc3c`, verdikt APPROVE s doporučeními R-01–R-07 (kopie `reviews/CI-brand-fixtures-design.md`).
- Koordinátor (Orca task `task_58e488d4c966`) přijal R-01–R-07 jako dokumentační upřesnění. Mechanismus fixture, allowlist, rozsah kódu, hosty ani kontroly se nemění. Nový lokální hash tohoto souboru je v `CI-brand-fixtures-acceptance.md`.
- Výslovný seznam upřesnění (v textu označeno **[Un]**):
  - **U0:** stav dokumentu, kanonické umístění, tato sekce; worktree vytvořil Orca (§6).
  - **U1 (R-01):** odůvodnění context-level route opraveno (§5.1).
  - **U2 (R-02):** URL pevně z `BRAND_ASSETS` bez literálové kopie; důvod `fulfill` místo `abort` (§5.1).
  - **U3 (R-03):** dočasná branch mapa `.spec-pilot.json` v rozsahu a přesné argv (§4, §6.1).
  - **U4 (R-04):** kanonická výjimka pořadí jen pro tento slice (TEST-08), ne obecná třída (§2, §3).
  - **U5 (R-05):** kontrolní režim headless; headed favicon jako reziduum (§5.1, §10).
  - **U6 (R-06):** skutečná invokace SPEC/OpenSpec validace (§3, §6).
  - **U7 (R-07):** first-paint kontexty bez JS vardum nevolají; fixture je tam obranná (§4, §5.4).
  - **U8:** pokrytí dvou ručních `browser.newContext()` v `month-read.spec.ts` (tři testové případy) stejným helperem (§4, §5.4, §10). Doplněk `/tmp/musubi-ci-brand-context-coverage.md` (SHA256 `0197fe6693db344ded69246a019c2d6549af6433f27ab5e76c426e6014a47806`; původní subjekt review `-v1.md` `89e2ab8227693b1c062ef3c0fa88ae48c2bfd9c8ab7fa9b2e22a8c9d4898091f`), nezávislé review `/tmp/musubi-ci-brand-context-design-review.md` (Claude Fable 5.1, task `task_2440402e9fcb`; REQUEST_CHANGES jen pro B-01, po textové opravě B-01 a R-01/R-02 apply bez dalšího kola). Mechanismus, allowlist ani helper se nemění.

Podklady: `/tmp/musubi-cp01-pr407-ci-diagnosis.md`, `/tmp/musubi-cp01-vardum-probe.json`
(obě role `mark-neutral`/`mark-accent` vrátily HTTP 403 za 590/64 ms; to nedokládá globální výpadek ani obnovenou dostupnost).

## 1. Problém a cíl

**Fakt (pozorováno):** Povinné Quality joby závisí na živé třetí straně.
- Web e2e shardy 1–4 a „Web production container boots in Chromium“ selhaly na PR407 (`42104615417`) i na `main` 585dd23 (`42103645274`).
- Mechanismus: `BrandMark` načítá `https://vardum.com/w/musubi/brand/web-app/{mark-neutral,mark-accent}` (`apps/web/src/brand.ts:2,8-9`, `apps/web/src/components/BrandMark.tsx:28,31`). Ty vrací 302 na podepsaný render endpoint, který v CI neodpověděl, a `waitForLoadState("networkidle")` proto vypršel.
- Dnešní sonda dostala 403. Výsledek tedy závisí na nekontrolovaném chování externí služby (hang / 403 / 200).

**Cíl (jediný pozorovatelný výsledek):** Web e2e a production smoke dál procházejí přímou produkční UI/server cestou (dev server, resp. skutečně spuštěný produkční kontejner). Jediné, co se nahradí, jsou externí brand obrázky z `vardum.com`, a to na reálném Playwright network portu (`BrowserContext.route`). Žádný test tak nesahá na upstream `vardum.com`.

**Není cílem:** změna produktu (`brand.ts`, `BrandMark.tsx`, SSR, worker), dokončení CP02/CP03, oprava flaky dynamic importu, ověření live dostupnosti Vardum brand URL, Radicale lane.

## 2. Požadavky a audit

- **AGENTS.md / CLAUDE.md:** produkční komponenty a server se cvičí přímo; závislost se nahrazuje na existujícím portu. Fixture API nedokládá DB/auth/provider. Required checks se neobcházejí.
- **VT-01:** nahrazená hranice je pojmenovaná a nespotřebovaná nebo neznámá fixture skončí neúspěchem.
- **VT-03:** report přizná mockovanou hranici. Externí brand host se tímto slicem neověřuje.
- **VT-04:** prostředí testu je reprodukovatelné a vlastněné; nesplněný předpoklad (živý Vardum) se nesmí tiše měnit v pass ani v fail.
- **VT-05:** full gate = `pnpm check` + všech 21 current-head Quality jobů.
- **Audit:** nový nález dostává ID **TEST-08** **[U4]**; původní návrh: „Povinné browser gates závisí na živém externím brand hostu (vardum.com)“: staticky doložený a reprodukovaný v CI 42103645274/42104615417, VT-03/VT-04, slice CI-brand-fixtures. Související a neuzavíraný je TEST-05 (dev server, regex selekce, flaky; zůstává CP02 2.4) a TEST-04 (ručně psané fixtures; zůstává CP03 3.2).

## 3. Minimální upřesnění kanonického designu (předpoklad apply)

`tasks.md` řádek „Závislosti: CP01→CP02→CP03; …“ nedovoluje testovou úpravu před CP02, přestože CP01 bez ní nemůže dostat green Quality.
Celé pořadí programu se nemění. Doplnění je analogické existující výjimce „CP04.1–4.2 (K-09) mohou předběhnout CP02“, ale **[U4]** platí výhradně pro tento konkrétní slice, žádnou obecnou třídu výjimek nezavádí. Do věty „Závislosti“ v `tasks.md` se doplní:

> „prerekvizitní slice CI-brand-fixtures (TEST-08, checkpoints/CI-brand-fixtures.md) odblokuje current-head Quality pro CP01 a smí proběhnout před dokončením CP01 i CP02–CP03; neuzavírá žádný CP02/CP03 box“

K tomu jeden řádek TEST-08 v `audit-disposition.md` s odkazem na tento brief jako „Konkrétní task“. Klasifikace ostatních nálezů (TEST-04, TEST-05 a další) se nemění.
- Obojí jde do tohoto slice (ne do PR407). Strict validace se spustí před kanonickým upřesněním i po něm a před kódem **[U6]**: `/home/flamendrin/.local/bin/spec openspec --project <ABS_WORKTREE> -- validate align-project-workflows-and-complete-sync --strict --json`, s předchozím `spec openspec --project <ABS_WORKTREE> -- list --json` pro ověření rootu. Pokud SPEC v novém worktree není nainstalovaný, instalace ani rules se nemění; zapíše se konkrétní chyba a lze použít přímo pinovaný OpenSpec binár, na který odkazuje SPEC instalace (výsledek se zapíše jako takový).
- PR407 mění `audit-disposition.md` také. Kdo se mergne druhý, rebasuje a výsledek ověří diffem. Neřešitelný sémantický konflikt = return.

## 4. Rozsah souborů (přesně)

| Soubor | Změna |
|---|---|
| `apps/web/e2e/external-brand.ts` (nový, jediný helper) | `installExternalBrandFixture(context)` + `test`/`expect` rozšířené o auto fixture nad `context` (viz §5). |
| `apps/web/e2e/dst-grid.spec.ts`, `news.spec.ts`, `behavior.spec.ts`, `theme-bootstrap.spec.ts`, `worker-cache.spec.ts` | Jen import `test`/`expect` z `./external-brand` místo `@playwright/test` (typy dál z `@playwright/test`). Žádná jiná změna. |
| `apps/web/e2e/month-read.spec.ts` | Import `expect`/`installExternalBrandFixture`/`test` z `./external-brand`. **[U8]** U dvou ručních `browser.newContext()` (test „carries one session's edit into the other over the stream“ a obě varianty „K06 two real {full,handoff} drafts …“) hned po `newContext` `installExternalBrandFixture(context)`, callback přebírá `testInfo`, a vzor shodný s `assets.spec.ts`: `try { …stávající tělo…; await externalBrand.finish(testInfo, "<název>"); } finally { await context.close(); }`; koncové `context.close()` z těla odpadá. Akce, aserce a výběr případů se nemění. |
| `apps/web/production-e2e/assets.spec.ts` | Import z `../e2e/external-brand`. Ručně vytvořené first-paint kontexty (ř. 35) dostanou `installExternalBrandFixture(context)` (obranně, viz §5.4 **[U7]**). Na ř. 38 `route.continue()` → `route.fallback()` pro ne-stylesheet požadavky, viz §5.4. Komentář ř. 54-55 doplní externí brand host jako nahrazenou hranici. |
| `openspec/.../tasks.md` (1 věta), `audit-disposition.md` (řádek TEST-08), `checkpoints/CI-brand-fixtures.md` (tento brief), `reviews/CI-brand-fixtures-design.md` a acceptance záznam | Viz §3 a §8. |
| `.spec-pilot.json` **[U3]** | Dočasná branch mapa kontrol (§6.1). Původní bajty se uloží mimo repo a před finálním review se přesně vrátí; `goal`/`stop_condition` se nemění. Ve finálním diffu se soubor nemění. |

**Mimo rozsah:**
- `apps/web/e2e/task-radicale.spec.ts`: v CI se nespouští (`RADICALE_E2E` gate, ř. 8) a pro odblokování CI není nutný. Jeho `networkidle` na ř. 81 zůstává závislé na Vardum; zapíše se jako známé reziduum.
- `playwright.config.ts`, `playwright.production.config.ts`, `scripts/ci-shards.mjs`, `.github/workflows/*`, `apps/web/src/**` a vše v `packages/**` se nemění.

Neměnit: SSR/CSS/font/chunk/worker aserce, console/pageerror kontroly, `networkidle` čekání, `expect`/test timeouty, `retries`, screenshot přílohy a jejich očekávání, `grep` výběr produkčního smoke ani počet Quality jobů. Žádný nový obecný runner, registr ani UI/stylová závislost; musubi-ui skill se netýká (UI se nemění).

## 5. Fixture: přesná specifikace

### 5.1 Zachycené URL (allowlist)
Port: `BrowserContext.route("https://vardum.com/**", handler)`. **[U1]** Kontextová úroveň se volí kvůli jednotnému pokrytí výchozího `context` i ručně vytvořených `browser.newContext` kontextů. Playwright route nezachytí požadavky, které odbaví service worker (`types.d.ts`, issue 1090); zde to nevadí, protože `service-worker.js` nemá fetch handler a jediný jeho vlastní fetch (notifikační ikona) nastává jen při push události, kterou žádný test nevyvolá. Globální pokrytí service workeru se netvrdí. Jiné hosty se nezachytávají ani nemaskují.

| Request | Odpověď |
|---|---|
| `GET https://vardum.com/w/musubi/brand/web-app/mark-neutral` | `200`, `content-type: image/svg+xml`, SVG s geometrií ink ramene |
| `GET https://vardum.com/w/musubi/brand/web-app/mark-accent` | `200`, `image/svg+xml`, SVG s geometrií accent ramene |
| jakákoli jiná cesta/metoda na `vardum.com` | `route.abort("blockedbyclient")`, zápis do seznamu `unexpected` a **fail** v teardownu fixture (`expect(unexpected).toEqual([])`) |

**[U2]** URL se berou přímo z importu `BRAND_ASSETS.logoInk`/`logoAccent` z `apps/web/src/brand.ts` (čistý konstantní modul bez importů a side effectů); žádná literálová kopie ani druhý zdroj URL nevzniká. Známé role se odbavují `route.fulfill`, ne `abort`: abort nebo 403 vyvolá console error a `assets.spec.ts` i `worker-cache.spec.ts` sbírají console errors do aserce. `tab-icon`, `touch-icon`, `og` a notification ikona se do allowlistu nepřidávají preventivně. Pokud se v green běhu objeví, fixture fail → **return k briefu** (rozšíření musí projít review). **[U5]** Kontrolním režimem je headless (headless shell jako v CI). V headed/`--ui` režimu může Chromium načíst `<link rel=icon>` (`tab-icon`) a fixture pak selže na `unexpected`; to je přiznané reziduum lokálního ladění, allowlist se kvůli němu nerozšiřuje.

### 5.2 Geometrie (bez nového branding zdroje)
- V repu není žádný frozen SVG jednotlivých ramen. `apps/web/public/favicon.svg` je celá značka (obě ramena v jednom), takže pro alfa masku ramene věrná není. `apps/client/assets/.vardum.lock` obsahuje jen PNG ikony.
- Jediným zdrojem geometrie ramen v repu jsou konstanty `inkPath`/`accentPath` v `apps/web/src/components/BrandMark.tsx:5-6`. Server je vykresluje jako SSR fallback (`BrandMark.test.tsx:9-15`).
- Fixture je při načtení modulu přečte z tohoto souboru (`readFileSync(new URL("../src/components/BrandMark.tsx", import.meta.url))`; stejný vzor používá `behavior.spec.ts:10`) regexem `const (inkPath|accentPath) = "([^"]+)";`. Jinde než přesně jeden match každého = throw.
- Odpověď: `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><path d="…"/></svg>`. Maska `mask-type-alpha` 48×48 tak dá tutéž geometrii jako fallback, bez kopie dat a bez nové brand ikony.
- Mapování (`brand.ts:8-9`): `mark-neutral` → `inkPath`, `mark-accent` → `accentPath`.
- Nejistota: skutečný upstream SVG (`layer=neutral-arm`) může mít jiné rozměry nebo canvas. Fixture dokládá funkci masky, ne pixelovou shodu s Vardum.

### 5.3 Rozlišení zachyceného a upstream requestu
- Trace/HAR zachycený a `fulfill`-nutý požadavek dál zobrazuje jako request na `https://vardum.com/...` se statusem 200. To **není** důkaz upstream přístupu ani jeho absence.
- Důkaz bez upstreamu: handler nikdy nevolá `route.continue()`/`route.fetch()`/`fallback()`. Fixture počítá `fulfilled` a `aborted` per URL a na konci testu připojí attachment `external-brand-routes` (JSON: URL, počet, akce).
- Pro acceptance navíc jeden ověřovací běh, kde je upstream fyzicky nedosažitelný (§7, G3). Projde-li, žádný úspěch nezávisí na upstreamu.

### 5.4 Pokrytí všech browser contexts
- Výchozí `context` každého testu: auto fixture (`{ auto: true }`) v `external-brand.ts` volá `installExternalBrandFixture(context)` před `use()`.
- `assets.spec.ts` first-paint kontexty z `browser.newContext` (ř. 35) dostanou explicitní `installExternalBrandFixture(context)` a teardown kontrolu před `context.close()`. **[U7]** Tyto kontexty mají `javaScriptEnabled: false` a SSR neobsahuje `<image>` (`BrandMark.test.tsx:12`), takže vardum dnes reálně nevolají; fixture je tam obranná. Stávající SSR/style aserce se nemění.
- Page-level route má přednost před context route. Existující `firstPaint.route("**/*", … route.continue())` (ř. 38) by vardum požadavek poslal upstream, takže se mění na `route.fallback()`. Pro ne-stylesheet požadavky je to sémanticky totéž, protože bez context route jde fallback na síť. Abort stylesheetu zůstává.
- **[U8]** Dva ruční kontexty v `month-read.spec.ts` (tři případy) navigují na `/app/p/…/month`, kde `Sidebar` vykresluje `BrandMark`; bez obalení by mohly posílat brand požadavky upstream. Dostanou `installExternalBrandFixture(context)` hned po `newContext` (před mock API a navigací) a `finish` jako poslední příkaz `try`, `context.close()` ve `finally`. Při dřívějším selhání aserce se příloha fixture nevytvoří (původní chyba se nepřepíše, zůstává trace); při selhání `finish` se kontext přesto zavře. Příloha nese odlišný název ručního kontextu; auto fixture nad nevyužitým výchozím `context` dál připojí `external-brand-routes`.
- `request` fixture (APIRequestContext) brand obrázky nenačítá; neřeší se.

## 6. Kontroly a příkazy

Pracovní kopie: samostatný worktree z **skutečného** `main` 585dd23, aby PR407 checkout a jeho schválené bajty zůstaly beze změny (**[U0]** worktree vytvořil Orca; větev přejmenována lokálně na `codex/ci-brand-fixtures`, base ověřena):
```sh
git worktree add ../musubi-ci-brand -b codex/ci-brand-fixtures 585dd231c3126ddc51a6ee5972c96bea95cfb15a
cd ../musubi-ci-brand && pnpm install --frozen-lockfile
```
(Install až v apply fázi, ne v tomto briefu.)

**Static / fast:**
- `git diff --check`; strict OpenSpec validace podle §3 **[U6]**.
- `pnpm --filter @musubi/web exec playwright test --list` (kompilace e2e; tsconfig `apps/web` e2e netypuje).
- Discovery beze změny:
  - `node scripts/ci-shards.mjs web 1/4 --list` … `4/4 --list` před a po změně → identické seznamy ID a počty;
  - `pnpm --filter @musubi/web exec playwright test --config=playwright.production.config.ts --list` → stejných 5 testů.
- JSON baseline z inventáře: žádný node-side behavior scénář hranici „externí brand obrázek v prohlížeči“ nepokrývá (`pnpm test:behavior --list`; nejbližší `web-edge` testuje worker/edge cache). Proto **N/A**, nový scénář ani kopie logiky nevzniká. Relevantní JSON replay je browserový `pnpm test:behavior:browser`: spouští `behavior.spec.ts` s task-inspector JSON a mění se mu import, takže musí projít beze změny počtu případů.
- `pnpm --filter @musubi/web lint` a `pnpm --filter @musubi/web typecheck` (regrese; src se nemění).

**Cílené e2e (dev server):**
```sh
pnpm --filter @musubi/web exec playwright test month-read.spec.ts -g "says so when a provider sign-in does not come back|shows only the passphrase form on a server with no OAuth"
pnpm --filter @musubi/web exec playwright test worker-cache.spec.ts theme-bootstrap.spec.ts
```

**Produkční server (skutečně spuštěný kontejner, stejně jako Quality web-smoke):**
```sh
docker build -f apps/web/Dockerfile -t musubi-web:smoke .
docker run -d --name musubi-web-smoke-cibrand -p 127.0.0.1:4330:3000 musubi-web:smoke
PLAYWRIGHT_ORIGIN=http://127.0.0.1:4330 pnpm --filter @musubi/web test:e2e:production
docker rm -f musubi-web-smoke-cibrand   # jen vlastní, pojmenovaný kontejner
```

**Full:** `pnpm check` (lokálně, s přiznaným env) a všech 21 current-head Quality jobů na vlastním PR + branch-protection checks.

### 6.1 Dočasná branch mapa `.spec-pilot.json` **[U3]**

Klíče `checks` (argv) po dobu implementace; `goal`, `stop_condition`, `documents` a klíč `database` zůstávají:

```json
{
  "fast": ["pnpm", "--filter", "@musubi/web", "exec", "playwright", "test", "month-read.spec.ts", "-g", "says so when a provider sign-in does not come back|shows only the passphrase form on a server with no OAuth"],
  "ui": ["pnpm", "test:behavior:browser"],
  "source": ["pnpm", "check"],
  "planning-whitespace": ["git", "diff", "--check"],
  "discovery": ["pnpm", "--filter", "@musubi/web", "exec", "playwright", "test", "--config=playwright.production.config.ts", "--list"]
}
```

`fast` a `ui` vyžadují běžící vlastní dev server (`PLAYWRIGHT_ORIGIN`). Shard discovery (`node scripts/ci-shards.mjs web N/4 --list`, N=1..4) se spouští zvlášť podle §6. `full` se nevytváří: neexistuje jeden lokální příkaz; full = `pnpm check` + 21 current-head Quality jobů + branch-protection checks. Absence `full` v mapě není PASS. Před finálním review se `.spec-pilot.json` vrátí na přesné původní bajty.

## 7. Red / green / vadný port

- **R0 — skutečný red (už doložený):** CI 42103645274 (main) a 42104615417 (PR407): networkidle timeouty, trace `status -1` na vardum redirect targetu. Lokálně navíc spustit stejné dva testy z §6 na nezměněném 585dd23 a zapsat skutečný výsledek. Vardum dnes může vrátit 403 (console error → `assets.spec.ts` selže na `errors`), hang (timeout) i 200 (pass). Proto R0 jen dokládá nedeterministickou závislost; deterministický red dává R1.
- **R1 — deterministický red bez fixture:** dočasný neukládaný lokální zásah, např. v jednom ověřovacím běhu `context.route("https://vardum.com/**", () => new Promise(() => {}))` bez fulfill. Oba login testy i `assets.spec.ts:62` musí selhat na networkidle timeout. Tím se reprodukuje CI mechanismus bez sítě. Diff zásahu jde do acceptance a nesmí se commitnout.
- **G1 — green:** s fixture projdou cílené e2e, `test:behavior:browser` i production smoke. Attachment `external-brand-routes` ukazuje fulfill obou rolí a `unexpected = []`.
- **G2 — plný web e2e lokálně:** `pnpm --filter @musubi/web test:e2e`. Zapsat počty passed/flaky; flaky se vykazuje zvlášť, ne jako pass bez poznámky.
- **G3 — nezávislost na upstreamu:** jeden ověřovací běh G1 s Chromiem, kde je `vardum.com` nedosažitelný. Jen lokálně a dočasně, např. `launchOptions.args: ["--host-resolver-rules=MAP vardum.com ~NOTFOUND"]` v necommitnuté kopii configu, nebo síťově izolovaný runner. Musí projít stejně jako G1.
- **D1 — kontrolovaný vadný port:** dočasně (necommitnuto) upravit handler tak, aby jednu roli neodbavil. Musí selhat na networkidle. Druhá varianta: přidat do stránky nebo testu request na `https://vardum.com/w/musubi/brand/web-app/unknown`. Musí selhat teardown s `unexpected` výpisem. Obojí dokládá, že fixture neskrývá chybu.
- **D2 — geometrie:** z G1 production smoke přílohy `production-sign-up` ověřit pohledem, že značka po načtení masek odpovídá SSR fallbacku (ne čtverec ani prázdno). Nová screenshot aserce se nepřidává.

## 8. Evidence (acceptance záznam)

- Base SHA 585dd23, head SHA a `git diff --stat` (jen soubory z §4).
- Výstupy R0/R1/G1/G2/G3/D1/D2 s přesnými příkazy, časy, počty a Node/pnpm verzemi.
- Před/po diff `ci-shards --list` (4 shardy) a production `--list`: identické.
- Attachment `external-brand-routes` z G1.
- Přiznané hranice: Vardum live dostupnost neověřena; fixture API (`/api/*`) nedokládá DB/auth/provider; dev-server e2e není produkční server; production smoke ano; Radicale reziduum; flaky dynamic import je mimo scope (TEST-05, CP02 2.4).
- Odkazy na nezávislé design review (před apply) a finální review (před PR).

## 9. Prerekvizity a pořadí

1. Přijetí §3 upřesnění a tohoto briefu nezávislým design review (čerstvý reviewer).
2. Implementace v `codex/ci-brand-fixtures` z 585dd23; PR407 a jeho bajty se nemění.
3. Finální nezávislé review přesného diffu → vlastní PR → 21 current-head Quality green → squash merge.
4. **Důsledek pro PR407:** re-run starého PR407 runu použije původní merge ref bez opravy a nepomůže. Po merge opravy je potřeba nový PR407 head nad novým `main` (update/rebase), při kterém **obsahový diff PR407 zůstane totožný**. Ověří se `git range-diff` nebo shodou `git diff <new-main>...<new-head>` se schváleným diffem. Pak nový Quality běh. Jde o mutaci PR407 větve, kterou musí schválit koordinátor nebo vlastník; tento brief ji neprovádí.

## 10. Stop a return

**Stop:** web e2e a production smoke na current head projdou bez upstream `vardum.com`. Jsou splněné G1–G3, D1, D2 a discovery je identická; 21 Quality jobů je green; žádný runtime soubor se nezměnil.

**Return k briefu/designu (box nehotový, zapsat přesný výsledek nebo HOLD), pokud:**
- je nutná změna `apps/web/src/**`, workflow, Playwright configu, timeoutů, retry nebo aserce (**[U8]** vlastní teardown kontrola fixture `finish` v ručních kontextech, shodná s `assets.spec.ts`, není změnou existujících asercí a tuto podmínku nespouští; změna helperu, např. příloha i při dřívějším selhání, by byla return);
- objeví se další vardum cesta nebo jiný externí host jako blokující (v headless kontrolním režimu; headed favicon viz §5.1 **[U5]**);
- `ci-shards --list` nebo production `--list` se změní;
- G3 neprojde (zbytková upstream závislost);
- regex geometrie nenajde přesně dva zdroje;
- `openspec validate --strict` selže nebo §3 upřesnění reviewer nepřijme;
- vznikne konflikt s PR407 v `audit-disposition.md`, který nelze vyřešit bez změny jeho schváleného obsahu.

Flaky dynamic import se v tomto slice neopravuje. Pokud se objeví, zaznamená se jako flaky (TEST-05).

## 11. Otevřené body pro reviewera / koordinátora

- Schválit §3 jako minimální upřesnění (místo změny pořadí programu) a ID TEST-08.
- Čtení geometrie z `BrandMark.tsx` regexem (§5.2) vs. alternativa odvodit ji z SSR `/login` testovaného serveru. Regex je jednodušší a deterministický; SSR varianta více odpovídá výstupu buildu, ale přidá request a parsování. Doporučuji regex.
- Mutace PR407 headu po merge opravy (§9.4) vyžaduje koordinátora nebo vlastníka.
