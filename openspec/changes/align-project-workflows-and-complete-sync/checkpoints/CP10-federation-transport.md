# CP10-10.3 — federační outbound transport svázaný se schválenými DNS adresami (přijatý brief v3)

Stav: **přijatý brief v3** (design review v2 REQUEST_CHANGES s výslovným dovolením přijmout v3 po přesných nemateriálních korekcích F-01(a)/F-02 a F-03…F-12; přijetí koordinátorem 2026-11-06T10:48:23Z srovnáním korekcí a disposition — **není** nepodmíněné APPROVE, není final review, není test PASS). Implementace k okamžiku uložení tohoto checkpointu neprovedena. Kanonické umístění: `openspec/changes/align-project-workflows-and-complete-sync/checkpoints/CP10-federation-transport.md` (větev `codex/federation-transport-pinning` z origin/main `047779c20adb53f52575876aa8b0c340539fb583`, Orca worktree, task `task_1060351fa834`). Přijatý subjekt: `backups/codex-cp01-20261105/reports/CP10.3-brief-v3.md` (původní checkout), SHA256 `5ca775bdd2bf6a1d8550fdfcae28218a297e05103be3b681aa2544799c6eac3a`. Design review: `reviews/CP10-federation-transport-design.md` (původní `CP10.3-design-review-v2.md`, SHA256 `9670bcd15499cad80b0d220342d6b95191e0e1995541c0c2cfbb656f6e60eb31`); disposition a přesný diff v2→v3: `CP10.3-revision-v3.md` (SHA256 `9fd2ea110940a2fc10fa4811426f800afd92626475f3a8eb1c8045bc3a489868`); přijetí koordinátorem: `CP10.3-coordinator-adoption-v3.json` (SHA256 `0ba7c26813a5c1b77318bf1529b88115e8f293c3933831114cbf9bffbb21a318`). Historické zdroje (brief v1/v2, revision v2, research v1, baseline v1 SHA256 `3baf8fd5eb3b08b083d13f089a7a39e25b6565f1a8e588ad71101ec76149c474`, raw spiky) zůstávají v původním checkoutu gitignored a nepřepisují se; soukromý advisory report není tracked obsah.

Zdrojová base: `origin/main` `047779c20adb53f52575876aa8b0c340539fb583` (tree `47f7146140bb8db1cc01690c269ad515a11217f0`), `.nvmrc` na main = `22.23.4` (lokální starý root má 24.15.0; nepřenášet). Lokální root `/home/flamendrin/workspace/musubi` (HEAD `5bfb341`) se nemění; implementace v novém izolovaném codex worktree z tohoto main, bez kopie `.env`.

## 0. Záznam uložení a přijetí (2026-11-06, dodatek; nemění mechanismus)

Tato sekce je datovaný dodatek přijetí. Tělo kontraktu v §1–§9 je převzato z přijatého subjektu (brief v3) s jedinou privacy redakcí v §1 (H4 níže); mechanismus, rozsah, kontrakt helperu, testovací hranice ani stop/return se nemění.

- Přijatý subjekt: `backups/codex-cp01-20261105/reports/CP10.3-brief-v3.md` (původní checkout, gitignored), SHA256 `5ca775bdd2bf6a1d8550fdfcae28218a297e05103be3b681aa2544799c6eac3a`.
- Design review (subjekt brief v2, SHA256 `412249269c0cd83d8a314e200f1b3fb21fdfb396e8a46a27add89fdc3a40107c`): `reviews/CP10-federation-transport-design.md` (Claude Fable 5.1, Orca worker, čerstvý kontext, 6. 11. 2026); původní soubor `CP10.3-design-review-v2.md`, SHA256 `9670bcd15499cad80b0d220342d6b95191e0e1995541c0c2cfbb656f6e60eb31`. Verdikt **REQUEST_CHANGES** k v2 (blockery F-01, F-02) s výslovným dovolením přijmout v3 bez opakování celého review, pokud zapracuje F-01 variantou (a)/(b) a F-02 a nemateriální F-03…F-12.
- Revize v3 (disposition všech nálezů + přesný `diff -u` v2→v3): `CP10.3-revision-v3.md`, SHA256 `9fd2ea110940a2fc10fa4811426f800afd92626475f3a8eb1c8045bc3a489868`; její disposition tabulka je zkopírována do `reviews/CP10-federation-transport-design.md` §0.
- Přijetí koordinátorem: `CP10.3-coordinator-adoption-v3.json`, SHA256 `0ba7c26813a5c1b77318bf1529b88115e8f293c3933831114cbf9bffbb21a318` (`at` 2026-11-06T10:48:23Z; status „accepted for bounded implementation by coordinator after reviewer-permitted corrections“). Ověřeno: F-01 varianta (a) (`Omit<RequestInit,"redirect"> & { redirect?: "manual" }`, wrapper vynucuje `manual`, šest callsites jinak beze změny); F-02 (`fast` = nejmenší JSON scénář + skutečný API `tsc`, lint API N/A, žádný falešný `full`); disposition F-03…F-12 zachovává normativní ID-06 a localhost-only testování (allowlist obou nativních TLS hostnames, post-await abort guard); přenositelné adresní fixtures; `.nvmrc` na main 22.23.4; žádná nová produktová policy ani jiný CP scope.
- Implementační poznámky koordinátora (adoption `implementationNotes`, závazné pro implementaci):
  - Minimální legacy stub (§5 krok 2) **zachovává** původní URL i DNS/policy validaci analogickou dnešnímu `assertPublicOrigin` přes prosté `await resolveHttpAddresses(...)` a teprve potom volá ambientní `fetch` bez pinu a bez abort race; číselný odkaz „kroky 1–2“ v §5 neznamená vypuštění DNS guardu. Red tak reprodukuje původní zranitelnou check-then-fetch sémantiku; DNS abort race a pinning přibývají až s fixem. Bezpečné guardy driveru (fail-closed ambientní fetch, patchnuté DNS) platí v každém stavu.
  - Očekávané red počty/diagnostiky v §5.3 jsou predikce; zapisují se skutečné výsledky. Žádný PASS z kompilační chyby nebo neočekávaného selhání fixture. Scénář `abort-then-lookup-rejects` může se stubem bez race selhat na nesprávném `reason` místo leaf/unhandled; cílem je totožný `signal.reason`.
  - Čerstvý nezávislý final review finálního diffu a 21 current-head Quality jobů zůstávají povinné; žádná publikace/deploy/advisory zápis.
- Přesné změny oproti subjektu (hlavička/cesty + jedna privacy redakce; SHA256 tohoto souboru je zapsán v gitignored `backups/spec-sessions/cp10-federation-transport-20261106/STATUS.json` a v acceptance záznamu):
  - H1: nadpis „(brief v3 po design review, PŘED apply)“ → „(přijatý brief v3)“.
  - H2: stavový odstavec „Stav: v3 = brief v2 …“ (odkazy na `/tmp/...`) → „Stav: **přijatý brief v3** …“ s kanonickým umístěním, větví, skutečnou base a hashi durable kopií v `backups/codex-cp01-20261105/reports/`.
  - H3: tato sekce §0 vložena před §1.
  - H4 (privacy): v §1 je odkaz na scratch reprodukci (gitignored cesta nesoucí identifikátor soukromého advisory) nahrazen neutrálním popisem bez cesty a identifikátoru; identifikátor nepublikovaného advisory se do tracked obsahu nepřenáší. Původní subjekt (brief v3, SHA256 výše) zůstává historickým originálem v gitignored durable kopii. Žádná jiná změna textu §1–§9; odkazy `/tmp/musubi-cp10-federation-*` v těle označují tytéž soubory, jejichž durable kopie a hashe jsou výše.
- Ověření vstupů před uložením: větev `codex/federation-transport-pinning` (jediné autorizované lokální přejmenování z Orca názvu `f-tuma/codex-federation-transport-pinning`; cílová větev neexistovala), HEAD = origin/main = `047779c20adb53f52575876aa8b0c340539fb583` (tree `47f7146140bb8db1cc01690c269ad515a11217f0`), čistý strom, `.nvmrc` 22.23.4, `.env` neexistuje, `.spec-pilot.json` SHA256 `099538b422408b9ea550ff548d0478e278e1e730ffc0ec81bfe2e35d70e610ae`. Řádkové odkazy briefu (callsites :95/:186/:241/:17/:38/:69, `federation.test.ts` fourth clock) proto platí beze změny.
- Baseline §5.1 zopakovaná v tomto worktree 2026-11-06 (raw záznamy gitignored `backups/spec-sessions/cp10-federation-transport-20261106/runs/baseline-*`): `pnpm test:behavior --list` 758 scénářů, žádná federační suite; `dav-response/bounded-multiget` exit 0; `federation_gateway.test.ts`, `federation.test.ts`, `caldav_shared_transport.test.ts` exit 0; provider-caldav 36/36. Historický baseline z původního checkoutu se nepřenáší jako nový PASS.
- Interpretace „žádná instalace“: zákaz instalace SPEC frameworku, globálních a nových závislostí; běžné `pnpm install --frozen-lockfile --prefer-offline` existujícího lockfile je dovolené (provedeno, lockfile nezměněn).
- **Korekce po nezávislém final review (2026-11-06, datovaný dodatek; nemateriální, mechanismus a kontrakt beze změny):** R-01 — formulace v §3.1 a §4.2 „IPv6 první bez ohledu na pořadí sady“ nahrazena změřeným chováním (happy-eyeballs začíná rodinou první adresy přijaté sady a dále prokládá); R-02 — privacy redakce H4 výše. Tělo §1–§9 proto **není** bajtově shodné s přijatým subjektem; SHA256 briefu v3 výše zůstává hashem historického originálu (gitignored durable kopie). Požadavky se nemění: leaf dostává tutéž přijatou sadu v přijatém pořadí a nativní výběr Node probíhá jen uvnitř ní. Záznam review a disposition: `reviews/CP10-federation-transport-final.md`.

## 1. Problém a autorita

Gateway, preview, connect, `readPeer`, `connectionMemberToken` a `streamOne` validují origin přes `assertPublicOrigin` (`apps/api/src/federation_origin.ts`), adresy zahodí a následný ambientní `fetch` hostname překládá znovu → DNS rebinding obejde SSRF guard (CWE-367/918). Reprodukováno na vlastních loopback listenerech (vlastní scratch reprodukce 6. 11. 2026, exit 0; soukromá gitignored bezpečnostní evidence mimo tracked obsah, cesta ani identifikátor se neuvádějí). CalDAV cesta (`packages/provider-caldav/src/network.ts`) socket už připíná.

Autorita: změna `align-project-workflows-and-complete-sync`, task 10.3 (zůstává unchecked), ID-06 (guard svázaný se skutečným připojením a redirect policy; scénář „DNS cíl se změní mezi kontrolou a fetch … kontrolovaný port, nikoli živý útok“), TRUST-03, design T8, CP10 řádek kontraktů/return. Zadání vlastníka („Ok, tak se na to podívej“) autorizuje opravu s prioritou před CP02 narovnáváním; nepublikuje advisory, neodpovídá autorovi, nenasazuje. Soukromý report není tracked obsah. CP02.1a/CP01 closure se nekombinují; ostatní CP se neuzavírají.

Rozhodnutí D-A až D-E jsou běžné technické volby v autorizovaném scope, zvolené koordinátorem a reviewem posouzené jako správné a proveditelné:
- D-A JSON suite `federation-transport` výslovně vymezená jako testovací sub-slice 10.3-T;
- D-B existující `assertPublicOrigin` pre-checky zůstávají;
- D-C připojení dostane celou přijatou adresní sadu (zachování dnešního fallbacku);
- D-D datovaný dodatek v ADR-005;
- D-E TLS fixture generovaná `openssl` za běhu v izolovaném test procesu.

## 2. Jeden pozorovatelný invariant

Každý federační odchozí požadavek (gateway, preview, connect, peer probe, token rotace, SSE stream včetně reconnectu) se připojí pouze na adresy, které prošly `isBlockedAddress`/`allowPrivate` policy ve **stejném resolve**, ze kterého připojení vzniklo; hostname v URL, `Host`, SNI a nativní ověření certifikátu zůstávají původní; socket hostname znovu nepřekládá; redirect zůstává `manual`; abort/timeout platí i během čekání na DNS a zachovávají původní reason; po abortu se leaf nikdy nezavolá.

## 3. Přesný rozsah souborů, kontrakt helperu a povolené změny

### 3.1 Sdílený pinned leaf (`packages/provider-caldav/src/network.ts`)

`createPinnedCaldavFetch(fetchImpl)` → `fetchPinned(url, init, pin)` kde `pin: LookupAddress | readonly LookupAddress[]`:
- jedna adresa: beze změny (klíč `origin|address|family`, `connect: { autoSelectFamily: false, lookup → (address, family) }`) — CalDAV volající (`index.ts`, `create.ts`, `caldav_client.ts`, `sync-reference/cli.ts`) nedotčeni (widening parametru);
- pole (≥1): klíč `origin|a1/f1,a2/f2,…` v pořadí přijaté sady (pořadí určuje jen klíč Agenta a pin předaný leafu); `lookup(_h, options, cb)`: při `options.all` → `cb(null, sada)`, jinak → první; `autoSelectFamily` se nepřepisuje. Pořadí **pokusů o připojení** určuje Node happy-eyeballs (prokládání rodin, `autoSelectFamilyAttemptTimeout`), které podle nezávislého měření začíná rodinou **první adresy v přijaté sadě** a dále rodiny prokládá (final review R-01, 2026-11-06: Node 22.23.4, undici 7.30.1, vlastní listenery `127.0.0.1` i `::1` na témže portu — sada `[::1,127.0.0.1]` obsloužena v6, `[127.0.0.1,::1]` v4; dřívější formulace „IPv6 první bez ohledu na pořadí sady“ byla nepřesná); invariant „jen přijaté adresy“ ani předaná přijatá sada tím nejsou dotčeny (spike `multi-spike`, `v6-fallback-spike`); prázdné pole → throw před vytvořením Agenta;
- cache 256 klíčů a `close()` nejstaršího beze změny; žádné shutdown API (CalDAV precedens, proces exit); `dispatcher` se vždy předává leafu.

### 3.2 Federační factory (`apps/api/src/federation_origin.ts`)

```ts
export type FederationFetchInit = Omit<RequestInit, "redirect"> & { redirect?: "manual" }; // F-01 varianta (a)
export function createFederationFetch(ports?: {
  allowPrivate?: boolean;            // default: čteno PŘI KAŽDÉM volání z config.security.federationAllowPrivateHosts
  lookupImpl?: LookupAll;            // default: node:dns/promises.lookup
  fetchPinnedImpl?: (url: URL, init: RequestInit, pin: readonly LookupAddress[]) => Promise<Response>; // default: createPinnedCaldavFetch((i, init) => globalThis.fetch(i, init)), vytvořený jednou na modul
}): (input: string | URL, init?: FederationFetchInit) => Promise<Response>;
export const federationFetch = createFederationFetch();
```

Nejmenší pravdivý kontrakt: vstup `string | URL` + init; `redirect` smí být jen `"manual"` (callsites dnes `redirect: "manual"` v objektovém literálu předávají a zůstávají beze změny), wrapper přesto `redirect: "manual"` vynucuje natvrdo; `Request` se nepodporuje (typ ho vylučuje; runtime `instanceof Request` → `TypeError`, scénář to pokrývá). Průběh volání:
1. `init.signal?.throwIfAborted()`;
2. `url = new URL(input)` (neplatné → `Error("Federation URL must be absolute.")`); `if (url.username || url.password) throw Error("Federation URL must not carry credentials.")`; `if (!canonicalHttpOrigin(url.origin)) throw Error("Federation URL must use http(s).")` (origin ne-http schémat je `"null"`) — zachovává existující zákaz userinfo a schémat **před** leafem;
3. `addresses = await raceAbort(signal, resolveHttpAddresses(url.origin, { allowPrivate, lookupImpl }))` — literal IP bez lookupu; všechny adresy musí projít; `raceAbort` při abortu během čekání odmítne **stejným objektem** `signal.reason`, odebere svůj abort listener v obou větvích; opuštěný lookup promise má **připojený no-op rejection handler** (pozdní zamítnutí po abortu nesmí vyvolat `unhandledRejection`; getaddrinfo nelze zrušit, stejně jako dnešní opuštění connectu v undici);
4. po návratu z await znovu `signal?.throwIfAborted()` před leafem (doložení původního invariantu „po abortu žádný dispatch“ i pro abort, který přišel ve stejném ticku jako vyřešení lookupu);
5. `fetchPinnedImpl(url, { ...init, redirect: "manual", signal }, addresses)` — 3xx se vrací beze změny; leaf dostává tentýž signal (in-flight abort/timeout jako dnes; změřeno 100 ms přes dispatcher).

Timeouts a policy se nemění: `AbortSignal.timeout` 20 s (gateway/preview/connect), 8 s (peer), 10 s (rotace), `abort.signal` streamu; `allowPrivate` profil (`FEDERATION_ALLOW_PRIVATE_HOSTS=true` nebo `ENVIRONMENT=dev`) beze změny.

### 3.3 Callsites (jen záměna volání a import)

`apps/api/src/handlers/federation_proxy.ts:95`, `apps/api/src/handlers/federation.ts:186` a `:241`, `apps/api/src/federation_peer.ts:17`, `apps/api/src/federation_connections.ts:38`, `apps/api/src/federation_stream.ts:69`: `fetch(` → `federationFetch(`; objektové literály init včetně `redirect: "manual"` zůstávají beze změny (typ v §3.2 je přijímá; žádná jiná editace callsites). Existující pre-checky `assertPublicOrigin` (proxy :71, stream :66, `safeRemoteOrigin`) zůstávají (D-B) — chybové plochy a pořadí (guard před peer probe) beze změny; pinned fetch přidává svázané připojení a další denial. Na gateway request tak proběhnou až **čtyři** nezávislé resolve (pre-check `assertPublicOrigin`, peer probe, případná rotace, hlavní fetch), z nichž tři jsou svázané s vlastním připojením; rebinding mezi nimi mění cíl jen na jinou přijatou adresu.

### 3.4 Kompatibilita a zákazy

Zachovat `/api/v1` cesty, `gatewayTarget`, requireAuth/ownership, pevnou preview cestu, hlavičky/credential handling, metody/body/query/path limity, error mapování (502/400/426/tolerantní rotace/log+reconnect), keep-alive (pinned Agent per přijatá sada), peer-version precondition (probe pinned), SSE (`bodyTimeout` 300 s Agent default vs heartbeat 25 s beze změny). Nezavádět HTTPS-only pro federaci, nerozšiřovat CalDAV plaintext/private výjimku (10.2), nikdy `rejectUnauthorized:false`, `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_EXTRA_CA_CERTS`, `setGlobalDispatcher`, systémový CA store. Žádné změny auth/signup/CORS/DB/schema/store/mobile UI/CI job inventáře/Better Auth.

### 3.5 Dokumentace a plánování

Datovaný dodatek ADR-005 řádku „DNS rebinding“ (D-D; zbytkové riziko „pinnutí IP by rozbilo TLS SNI“ neplatí — připojení je připnuté v `lookup`, ne v URL, SNI zachováno, viz spike); `tasks.md` §10 jedna věta vymezující 10.3-T (checkbox 10.3 unchecked); `audit-disposition.md` TRUST-03 dílčí evidence; `checkpoints/CP10-federation-transport.md` (= přijatý brief), `reviews/CP10-federation-transport-design.md` (= přijatý design report + záznam v3 hash a srovnání koordinátorem) / `-final.md`, `docs/testing/behavior-scenarios.md` řádek suite. Žádný jiný textový update pořadí.

## 4. Testovací hranice definovaná PŘED kódem (sub-slice 10.3-T) a izolace localhost-only

Pravidla izolace platná pro **všechny** stavy (baseline, stub, red, green, každý mutant): žádný proces nesmí při rozbití guardu propadnout k veřejnému socketu. Veřejné/mixed adresy (`203.0.113.x`) existují výhradně za injektovaným fake leafem v izolovaném driver procesu s fail-closed ambientním fetchem; nativní socket testy používají jen vlastní loopback adresy (`127.0.0.1`, `::1`) a vlastní listenery na dočasných portech; `node:dns` je v test procesech patchnuté tak, aby jakýkoli hostname lookup selhal (literal IP nikdy do DNS nejde). Mechanismus patche (F-06): v `apps/api` testech (tsx → CJS) se přepíše property `dns.promises.lookup` i `dns.lookup` na objektu `node:dns` a po testu obnoví; v ESM balíčku `provider-caldav` (`"type": "module"`) navíc `module.syncBuiltinESMExports()` po patchi i po restore. Patch je pojistka — všechny scénáře injektují `lookupImpl`. Žádný zásah do systémového DNS/firewall/CA/net namespace, žádné cizí listenery, žádná tajemství.

### 4.1 JSON suite `federation-transport` (fixture, bez socketu, Services needed: none)

Soubory: `apps/api/src/behavior/federation-transport.json`, `federation-transport-driver.ts` (vzor `dav-response-driver`), `federation-transport-cli.ts` (vzor `api-json-body-cli`); registrace v `scripts/test-behavior.mjs` (`SUITES` + existující větev `["project-news","api-json-body","app-links"]`; žádný druhý registry/runner), `scripts/test-behavior.test.mjs`: `manifests` **a** položka `["federation-transport", ["--import", "tsx"], "apps/api/src/behavior/federation-transport-cli.ts"]` v testu „release boundaries use fixed CLIs“ (F-07), `apps/api/package.json` test skript (`tsx src/behavior/federation-transport-cli.ts --json`), docs řádek. Schéma fixture (F-08): zod `.strict()` jako `dav-response-driver` — `schemaVersion: z.literal(1)`, `suite: z.literal("federation-transport")`, unikátní `id` `^[a-z][a-z0-9-]{0,79}$`, per-scénář pole `input`, `allowPrivate`, `lookup` (`{ addresses | error | never }`), `leaf` (`{ status, headers }` nebo absent), `signal` (`{ abortedBefore | abortAfterMs | timeoutMs }`), `expect`; každé plánované `lookup`/`leaf` pole musí být spotřebováno (jinak `unconsumed-port`), nespotřebovaný výsledek je fail. Driver volá pouze produkční `createFederationFetch`; guard se nekopíruje. Driver proces při startu: `globalThis.fetch = () => { throw new FederationTransportScenarioFailure("unexpected-port", "Ambient fetch reached the driver process.") }`; `dns.lookup`/`dns.promises.lookup` nahrazené funkcí vracející `unexpected-port` pro jakýkoli hostname; `process.on("unhandledRejection")` registrovaný driverem → scénář `expectation-mismatch`; fake leaf jen zaznamenává `{ url, init.redirect, init.headers, init.signal, pin }` a vrací skriptovanou `Response`; každý scénář má watchdog 1 000 ms (`expectation-mismatch` místo visení; runner má navíc 120 s). Scénáře (ID frozen reviewem):

| ID | Vstup | Očekávání |
| --- | --- | --- |
| `literal-private-denied` | `http://169.254.169.254/api/v1/server`, allowPrivate=false | reject `/internal address/`; lookup 0; leaf 0 |
| `mixed-answer-denied` | lookup `[203.0.113.10, 127.0.0.1]`, allowPrivate=false | reject; leaf 0 |
| `public-answer-pinned` | lookup `[203.0.113.10]` | leaf 1× s `pin=[203.0.113.10/4]`, URL/hostname beze změny, `authorization` beze změny, `redirect:"manual"` |
| `multi-answer-accepted-set` | lookup `[203.0.113.10, 203.0.113.11]` | leaf dostal celou sadu v pořadí |
| `redirect-returned-not-followed` | leaf vrátí 302 `Location: http://127.0.0.1/x` | status 302 vrácen; leaf 1; lookup 1 (žádný pro Location) |
| `aborted-before-lookup` | předem abortovaný signal (custom reason) | reject stejným reason; lookup 0; leaf 0 |
| `abort-during-lookup` | lookup nikdy neskončí; `controller.abort(reason)` po 20 ms | reject **stejným objektem** reason; leaf 0; listener odebrán |
| `abort-then-lookup-rejects` | `controller.abort(reason)` po 10 ms, lookup **zamítne** 20 ms po abortu | reject stejným reason; leaf 0; žádný `unhandledRejection` (F-03) |
| `timeout-during-lookup` | lookup nikdy neskončí; `AbortSignal.timeout(30)` | reject `TimeoutError` do watchdogu; leaf 0 |
| `userinfo-rejected` | `https://u:p@peer.invalid/api/v1/server` | reject před lookupem; lookup 0; leaf 0 |
| `scheme-rejected` | `ftp://peer.invalid/` | reject před lookupem |
| `request-input-rejected` | `new Request(...)` | `TypeError`; lookup 0; leaf 0 |
| `private-profile-accepts-loopback` | allowPrivate=true, lookup `[127.0.0.1]` | leaf 1× s `[127.0.0.1/4]` |
| `private-profile-off-denies-loopback` | stejná fixture, allowPrivate=false | reject; leaf 0 |

### 4.2 Reálný Agent/lookup: shared leaf (`packages/provider-caldav/src/index.test.ts`, node:test)

Vlastní HTTP listener `127.0.0.1:0`; `dns.lookup`/`dns.promises.lookup` patchnuté + `syncBuiltinESMExports()`; leaf předaný testem = strukturální guard (F-05) `(u, i) => { assert("dispatcher" in i && typeof i.dispatcher.dispatch === "function"); assert(new URL(u).port === ownPort); return globalThis.fetch(u, i); }`:
- `accepted-set-fallback` (D-C regresní test, přenositelná varianta F-09): `pinned(new URL("http://multi-fixture.invalid:<port>/"), {}, [{ "::1", 6 }, { "127.0.0.1", 4 }])` → 200, server viděl `Host: multi-fixture.invalid:<port>`, 0 systémových lookupů (`::1` je první adresa sady a na tom portu nic neposlouchá → ECONNREFUSED → fallback na 127.0.0.1 uvnitř sady; happy-eyeballs začíná rodinou první adresy sady — upřesnění R-01, 2026-11-06). Ověřeno 6. 11. 2026 **jen na Linuxu** (Node 22.23.4: obě pořadí 200, 13 ms / 1 ms; `127.0.0.2` varianta ze spiku je Linux-only a nepoužije se). Pokud hostitel nemá `::1` (EAFNOSUPPORT/ENETUNREACH), fallback stále vede na 127.0.0.1; jiné OS nejsou doloženy a nebudou vykazovány;
- `single-address-no-fallback` (starý CalDAV kontrakt doložen): `pinned(url na zavřený port 127.0.0.1, {}, { "127.0.0.1", 4 })` → reject `cause.code === "ECONNREFUSED"` (přenositelné; žádná druhá loopback IP);
- existující fixture test (`"dispatcher" in init`, redirect loop) zůstává. Purity test zdrojů nedotčen (změny jen v testu).

### 4.3 Reálný socket/TLS a wiring přes factory (`apps/api/src/federation_transport.test.ts`, vlastní proces v `apps/api` test chainu)

Produkční `createFederationFetch` s produkčním leafem, `allowPrivate: true`, `lookupImpl → [{127.0.0.1,4}]`; hostnames `federation-fixture.invalid` (pozitivní) a `federation-other.invalid` (wrong-hostname negativní), oba pinned na vlastní loopback; `dns.lookup`/`dns.promises.lookup` patchnuté (každý hostname → chyba); `globalThis.fetch` obalený guardem (vyžaduje `"dispatcher" in init && typeof init.dispatcher.dispatch === "function"`, hostname ∈ {`federation-fixture.invalid`, `federation-other.invalid`} nebo literal loopback, port ∈ vlastní listenery; jinak throw bez socketu — guard tedy wrong-hostname test propustí až k TLS, kde má selhat). Listenery `127.0.0.1:0`: http, https (`cert` = **pouze leaf** bez CA řetězce, `key`; F-04), „hang“, „second“. Assertions TLS chyb čtou `error.cause.code` (`fetch` obaluje `TypeError: fetch failed`).
- http 200 + `Host` zachován; 0 systémových lookupů;
- https s test CA: 200 + `req.socket.servername === "federation-fixture.invalid"`;
- https `federation-other.invalid` (lookup → 127.0.0.1): reject `cause.code === "ERR_TLS_CERT_ALTNAME_INVALID"`;
- https bez test CA (leaf-only listener): reject `cause.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"`;
- `AbortSignal.timeout(100)` proti hang listeneru: `TimeoutError` ≤ 1 s;
- 302 z http listeneru na `http://127.0.0.1:<second>/`: status 302 vrácen, second listener bez requestu;
- SSE-shaped: listener píše `: ping` frames; `response.body` čtení + `AbortController.abort()` → reader reject;
- policy-deny nativně: `allowPrivate: false`, lookup `[127.0.0.1]` (vlastní loopback) → reject, listener bez requestu, 0 pinned lookupů. **Žádná veřejná adresa v tomto souboru.**
- static wiring: šest federačních zdrojů bez holého `fetch(` mimo `federation_origin.ts`; ten používá `globalThis.fetch` jen uvnitř leafu předaného `createPinnedCaldavFetch`.

TLS fixture (D-E): CA + leaf (SAN `federation-fixture.invalid`) generované `openssl` (≥ 3.0, `-copy_extensions copy`; lokálně 3.6.5) do `mkdtemp`, smazány ve `finally`; důvěra pouze `tls.setDefaultCACertificates([...default, ca])` v tomto odděleném test procesu, obnovena ve `finally` i při chybě; nikdy `NODE_EXTRA_CA_CERTS`, systémový store ani produkční knob. Runtime prerekvizity (F-09): Node ≥ 22.19 (`tls.setDefaultCACertificates`; lokálně 22.23.4, `.nvmrc` main 22.23.4, CI `node-version: 22`), OpenSSL ≥ 3.0, loopback `127.0.0.1` + `::1`; chybějící `openssl`/nepodporovaný Node = explicitní fail/HOLD, ne skip.

### 4.4 Existující network fixtures (minimální úprava na existujících portech, assertions beze změny)

- `apps/api/src/federation.test.ts` blok „fourth clock“ (`peerTooOld` přes `globalThis.fetch` stub, origins `https://old.example` …): nový guard by před stubem spustil skutečný lookup. Úprava: `config.security.federationAllowPrivateHosts = true` (uloženo/obnoveno) a origins na literal loopback `http://127.0.0.1:65501`…`65505` (literal IP → bez DNS; stub zůstává leafem a dostane `dispatcher`, který ignoruje). Všech **šest** původních assertions (`runs Musubi 0.0.9`, `has to update it first`, `null` pro 9.9.9, `could not be verified` pro unversioned, broken i down) beze změny.
- Inventář ostatních: `federation_stream.test.ts` (jen parser) a `federation.integration.test.ts` (inbound accept) nedotčeny; `federation_gateway.test.ts` nedotčen (jeho `no-such-host.invalid` resolver dotaz je pre-existující); `federation_gateway.integration.test.ts` (literal `127.0.0.1`, env flag true) nedotčen — po změně jde skutečným pinned socketem k fake peeru, očekávání stejná; pro `connectionMemberToken`, preview/connect handlery a `streamOne` **žádné** existující testy neexistují (pokrytí = static wiring + JSON helper + DB/app ověření). Scratch repro je mimo repo (§5.6).

Co je fixture vs socket: §4.1 fixture (včetně všech veřejných adres); §4.2/4.3 skutečný Agent/lookup/socket/TLS jen loopback; §4.4 stub leaf. Nic z toho není externí DNS/TTL ani produkční E2E.

## 5. Baseline → stub → red → fix → green → mutace → restore

1. Baseline (provedeno 6. 11. 2026, nepřepisuje se): inventář 758 scénářů bez federační suite; `dav-response/bounded-multiget` exit 0 (1,45 s); `federation_gateway.test.ts`, `federation.test.ts`, `caldav_shared_transport.test.ts`, provider-caldav 36/36 exit 0; scratch repro exit 0 (= mezera). Ve worktree z `047779c` zopakovat tytéž příkazy, zapsat exit/čas/hash; `test ! -e .env`; `node -v` = 22.23.4 dle `.nvmrc` main.
2. Stub (red na chování, ne na importu): `createFederationFetch` s úplnou signaturou a porty, který po validaci (kroky 1–2) volá `globalThis.fetch(url, { ...init, redirect: "manual" })` bez adres; callsites přepojené; shared leaf s rozšířeným typem (pole zatím mapuje na první adresu). Izolace §4 už aktivní.
3. Red (jmenovitě): JSON `public-answer-pinned`, `multi-answer-accepted-set`, `private-profile-accepts-loopback` → `unexpected-port: Ambient fetch reached` (fail-closed, 0 socketů); `abort-during-lookup`/`abort-then-lookup-rejects`/`timeout-during-lookup` (stub bez race → watchdog `expectation-mismatch`); `request-input-rejected` (pokud stub bere `String(input)`); §4.3 http/https případy → guard „no dispatcher“ throw; static wiring → holé `globalThis.fetch` mimo leaf; §4.2 `accepted-set-fallback` → `ECONNREFUSED` na `::1` (první adresa bez fallbacku). Zelené už se stubem (regresní stráž): deny/userinfo/scheme/aborted-before scénáře, §4.4.
4. Fix podle §3; green = JSON suite, §4.2, §4.3, `pnpm --filter @musubi/api test`, `pnpm --filter @musubi/provider-caldav test`, `node --test scripts/test-behavior.test.mjs`, typecheck/lint.
5. Kontrolované mutace (každá zvlášť, přesné místo → pozorovaná chyba → restore `git checkout -- <soubor>` → rerun green):
   - M-leaf-1 `network.ts` `fetchImpl(url, init)` bez `dispatcher` → §4.2 i §4.3 guard leaf: „pinned leaf called without dispatcher“ (0 socketů); existující `index.test.ts:292` a `caldav_shared_transport.test.ts` assertion `"dispatcher" in init` fail. JSON suite tuto mutaci **nevidí** (fake leaf shared leaf nevolá) — záměrně, pár je socket/TLS.
   - M-leaf-2 `network.ts` lookup při `options.all` vrátí jen první adresu → §4.2 `accepted-set-fallback` fail (`ECONNREFUSED` na `::1`, jen loopback); `single-address-no-fallback` zůstává zelený (očekávané).
   - M-wrapper-1 `federation_origin.ts` volá `globalThis.fetch` místo `fetchPinnedImpl` → JSON `public-answer-pinned`, `multi-answer-accepted-set`, `private-profile-accepts-loopback` fail `unexpected-port`; §4.3 guard throw. Žádný dial.
   - M-wrapper-2 `federation_origin.ts` `allowPrivate` vynuceno `true` → JSON `literal-private-denied`, `mixed-answer-denied`, `private-profile-off-denies-loopback` fail (fake leaf dostal blokované adresy, 0 socketů); §4.3 policy-deny fail (vlastní loopback listener dostane request).
   - M-wrapper-3 `redirect: "follow"` vynuceno → JSON `redirect-returned-not-followed` fail (zaznamenaný `init.redirect`); §4.3 302 případ fail (second listener dostane request, loopback).
   - M-wrapper-4 `raceAbort` nahrazen prostým `await` (a bez druhého `throwIfAborted`) → JSON `abort-during-lookup`/`timeout-during-lookup` fail přes watchdog (`expectation-mismatch`, bez visení); `abort-then-lookup-rejects` fail (leaf zavolán nebo `unhandledRejection`).
   Párový test: `private-profile-accepts-loopback` × `private-profile-off-denies-loopback`.
6. Regrese starého transportu: scratch repro (`backups/…/local-review.mjs`) se proti pinned transportu **nespouští beze změny** (validace by přijala 93.184.216.34 a pinned socket by na ni šel). Pokud se má post-fix použít, výhradně s nahrazením „veřejné“ odpovědi vlastní loopback adresou pod `allowPrivate=true` nebo s fake leafem na portu; post-fix důkaz uzavření TOCTOU = `public-answer-pinned` + §4.3 nulový systémový lookup.
7. Restore: po mutacích `git diff` prázdný vůči fix commitu; `.spec-pilot.json` na původní bajty (sha256 `099538b422408b9ea550ff548d0478e278e1e730ffc0ec81bfe2e35d70e610ae`, blob `34297fbe06e601f660c546d0e00ffa2508fd7359`) před finálním review/mergem; dočasné certy/listenery/PG/procesy odstraněny.

## 6. Dočasná branch mapa kontrol (`.spec-pilot.json`, jen ve worktree větvi)

```json
{
  "fast": ["sh", "-c", "pnpm test:behavior --suite federation-transport --scenario public-answer-pinned --json && pnpm exec tsc -p apps/api/tsconfig.json --noEmit --skipLibCheck"],
  "transport-socket": ["pnpm", "--filter", "@musubi/api", "exec", "tsx", "src/federation_transport.test.ts"],
  "transport-leaf": ["pnpm", "--filter", "@musubi/provider-caldav", "test"],
  "planning-whitespace": ["git", "diff", "--check"],
  "source": ["pnpm", "check"]
}
```

`fast` = nejmenší JSON scénář + skutečný API typecheck (týž příkaz jako v root `typecheck` skriptu; F-02/T1 „relevantní types/lint“). Lint pro `apps/api` není aplikovatelný: root `lint` = client + web, API žádný lint skript nemá — přiznáno, ne vynecháno. Před vznikem suite je `fast` = `["sh","-c","pnpm --filter @musubi/api exec tsx src/federation_transport.test.ts && pnpm exec tsc -p apps/api/tsconfig.json --noEmit --skipLibCheck"]`. `full` se nevytváří (žádný jediný ověřený příkaz pro celou Quality; `source` se za něj nevydává): dokončení = skutečný `pnpm check` + 21 current-head Quality jobů (`scripts/quality-proof.mjs` `QUALITY_JOB_NAMES`) + branch-protection checks. `ui` vynecháno s důvodem: žádná změna `apps/web`; browser replay serverový outbound transport neověřuje (neaplikovatelné, ne zelené). Env pro `source`: `ENVIRONMENT=test`, `BETTER_AUTH_URL=http://localhost:7531`, `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:65439/musubi_cp10_test` (vlastní neprodukční cíl; source check DB nepotřebuje). Config přes dotenv automaticky zkouší root `.env`: v novém worktree soubor nesmí existovat (`test ! -e .env` v evidenci), inherited env se zaznamená jen názvy relevantních proměnných, hodnoty pouze těchto tří veřejných. `pnpm check` zahrne nový socket test → vyžaduje `openssl` a Node ≥ 22.19; chybí-li, HOLD.

## 7. Finální integrační a aplikační ověření (mimo fake fetch fixture)

Vlastní disposable PostgreSQL (docker ano; psql/pg_isready lokálně ne):

```sh
docker run -d --rm --name musubi-cp10-pg -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=musubi -p 127.0.0.1:65439:5432 postgres:17-alpine
docker exec musubi-cp10-pg pg_isready -U postgres -d musubi   # opakovat do accepting connections
export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:65439/musubi ENVIRONMENT=test BETTER_AUTH_URL=http://localhost:7531 \
  CALDAV_ENC_KEY=<throwaway 64 hex> FEDERATION_ALLOW_PRIVATE_HOSTS=true
pnpm db:migrate
pnpm test:db:federation-gateway        # skutečný handler + DB vlastníka + fake peer 127.0.0.1 skutečným pinned socketem
pnpm test:federation-db
docker rm -f musubi-cp10-pg            # jen vlastní kontejner
```

Běžící aplikace: `API_SERVER_PORT=17531 pnpm --filter @musubi/api exec tsx src/index.ts` se stejným env; vlastní loopback fixture peer na `127.0.0.1` (`/api/v1/server` → `{version: PRODUCT_VERSION}`, `/api/v1/calendars/tokens/<token>` → marker); session skutečným `POST /api/auth/sign-up/email` (throwaway účet v lokální DB; nevydá-li test env session, zapsat HOLD, nemockovat); pozitivně `GET /api/v1/federation/preview?server=http://127.0.0.1:<fixture>&token=<16+ hex>` → 200 marker (literal IP, bez lookupu; flag true). Sekundárně `server=http://localhost:<fixture>` (F-12): systémový lookup typicky vrátí `[::1, 127.0.0.1]`, pinned socket zkusí `::1` (ECONNREFUSED) a spadne na `127.0.0.1` → 200; očekávaný a zaznamenaný první reálný fallback v aplikaci, ne anomálie. Negativně druhý start bez `FEDERATION_ALLOW_PRIVATE_HOSTS` → `server=http://127.0.0.1:<fixture>` → 400 „internal address“. Volitelně gateway přes vložený `musubi_accounts` řádek → `GET /api/v1/federation/s/<id>/api/v1/server` → 200. Vše vlastní; ukončit API proces, listener, kontejner. Auth/DB se nemění; jejich skutečné ověření je oddělené od portových testů; žádný skutečný provider ani živý útok.

## 8. Review, PR a merge jako samostatné gates

Design review proběhl nad v2 (REQUEST_CHANGES, F-01/F-02 blockery); v3 je přijímán srovnáním koordinátora (dvě blocker korekce + nemateriální disposition) podle výslovného dovolení reviewera, s odkazem na report a hash v3 — není to nepodmíněné APPROVE ani test PASS. Fresh-context `spec-review` finálního diffu před PR zůstává povinný (merge-base `047779c…`/aktuální main, head, testy, změněné fixtures §4.4 s odůvodněním, registry/inventář). PR z codex větve do `main`; squash merge až po zelených checks aktuálního headu a branch protection (skutečný stav pravidel se při acceptance zaznamená; nenakonfigurovaná pravidla nejsou PASS); implementace/publikace/deployment oddělené. Acceptance `checkpoints/CP10-federation-transport-acceptance.md`: revize/hash, příkazy, exit, trvání, nahrazené hranice, red/green/mutation výsledky, DB/app ověření, env evidence bez secret dumpu, runtime (Node/OpenSSL/OS) evidence, review odkazy; soukromé evidence gitignored.

## 9. Stop a return

Stop: invariant §2 doložený §4.1–4.4 + DB integration + běžící aplikace; `pnpm check`, 21/21 Quality, branch rules zelené; nezávisle schválený finální diff; `.spec-pilot.json` obnovený; TRUST-03 dílčí evidence; 10.3 unchecked do merge+acceptance. Neotevírat 10.2/10.4, Better Auth, advisory publikaci, deployment.

Return: test by potřeboval cizí endpoint/externí DNS/produkci; jakýkoli stav, v němž by stub/mutant mohl dialovat mimo loopback; změna chybových stavů/kompatibility mimo §3; oslabení TLS; chybějící `openssl`/docker, Node < 22.19 nebo nedoložený runtime (jiný OS se nefinguje); sign-up bez session (HOLD app gate); změna assertions existujících testů (jen fixtures dle §4.4); nesoulad inventáře/frozen IDs bez review; odchylka od D-A…D-E nebo jiná změna než F-01…F-12 → nejdřív kanonické artefakty a nové review.
