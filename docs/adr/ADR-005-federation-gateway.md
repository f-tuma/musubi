# ADR-005: Federovaný přístup přes gateway na domácím serveru

- Stav: accepted
- Datum: 2026-07-27
- Kontext rozhodnutí: web parity (M6) narazila na federaci; product owner schválil resilience trade-off a definici parity.

> ADR-001 až ADR-004 zatím žijí v `store/musubi-web-handoff/adrs/` a nebyly do repozitáře přeneseny. Tenhle ADR je první v `docs/adr/`; přenesení zbytku je samostatná úloha.

## Kontext

Federace v1 (Musubi ↔ Musubi) funguje jako **multi-server klient**:

- kalendář žije na svém origin serveru B; uživatel z domácího serveru A přijme invite a získá na B **shadow account** (`user.isExternal` + `homeServer`) a **member token**;
- `require_auth.ts` má fallback: member token autentizuje na **každé** `requireAuth` route, autorizace pak běží normálně přes `calendar_members`. B tedy nepotřebuje žádné federační endpointy — federovaný uživatel je pro něj nativní člen;
- `GET /api/v1/users/connections/musubi` **dešifruje member token a vrátí ho klientovi v plaintextu**; mobil s ním volá B přímo (~20 endpointů: event CRUD, link/fork, attendance, členové, role, kick, leave, invites, revoke, export, accept, rotate, SSE).

Pro webový klient je tento model nepoužitelný:

1. **Token v prohlížeči** — 90denní bearer credential k cizímu serveru v JS je terč pro XSS. (Pozn.: dnes ho z toho endpointu získá jakákoli autentizovaná session, takže expozice existuje bez ohledu na to, jestli ho web používá.)
2. **CORS** — browser nemůže volat B přímo; B neposílá CORS hlavičky pro cizí web origin. Mobil dělá nativní cross-origin fetch, browser ne.
3. **Deployment kompatibilita** — jakékoli řešení vyžadující změnu na B by u self-hostingu znamenalo, že mixed-version federace tiše nefunguje.

Zvažovanou alternativou byl **mirror** přes existující external-provider engine (`musubi` adapter) — původní plán „v2". Zamítnuto: `adapter.ts` (`NormalizedEvent`, `ExternalCalendarInfo`) neumí přenést attendance, členy, role ani invites. Mirror by federaci degradoval z **spolupráce** na read-ish kopii, což jde proti jejímu smyslu. Pro Google/CalDAV je mirror správný (jsou to cizí systémy), pro Musubi↔Musubi ne.

## Rozhodnutí

Member token **nikdy neopustí server**. Domácí server A se stává jedinou cestou k federovaným datům pro **oba** klienty.

### Gateway

```
ANY /api/v1/federation/s/:connectionId/api/v1/*   (vyžaduje home session)
   → {musubi_accounts.server}{path}  s  Authorization: Bearer <decryptSecret(token)>
```

- `:connectionId` je **`musubi_accounts.id`** (uuid), scoped na `req.user.id`. **Cílový origin se čte z databáze, klient ho nikdy nezadává** — tím padá hlavní SSRF vektor už návrhem.
- Passthrough zachovává v1 semantiku beze zbytku: co umí mobil dnes, umí i web.
- B se **nemění**; gateway funguje proti dnes vydaným serverům.

### Fázování

1. **Gateway + SSRF hardening** (aditivní, nic nerozbíjí) → odblokuje web.
2. **SSE fan-in**: A drží jedno upstream SSE spojení na federovanou connection per uživatel a přeposílá eventy do svého existujícího hubu (`notifyCalendarMembers`). Klienti mají jeden stream.
3. **Agregace čtení**: A slučuje federované kalendáře/eventy do vlastních `/calendars` a `/events` odpovědí, tagne je `provider:"musubi"`, `accountId=connectionId`, `accountLabel=host`, `syncStatus`, a přidá per-server stav. Mutace zůstávají passthrough.
4. **Mobil se odstřihne od custody** (zmizí SecureStore token registry i client-side rotace); až potom se plaintext token přestane vydávat.

**Stav: všechny čtyři fáze hotové (2026-07-27).** Ve fázi 4 byly odstraněny `GET` i `POST /api/v1/users/connections/musubi` — tedy jak čtení connections s dešifrovaným tokenem, tak ukládání tokenu dodaného klientem. `DELETE` zůstává (odpojení serveru). Tím má member token **jedinou** cestu do systému: `POST /federation/connect`, kde ho získá server sám.

Odstranění (404) je vůči starým nasazeným klientům šetrnější než vracet řádky bez tokenu: starý mobil má `getMusubiAccounts()` v try/catch a při chybě padá na lokální registry s platnými tokeny, kterou jeho vlastní rotace proti nezměněnému originu drží živou. Tokenless odpověď by mu tu funkční cache přepsala nepoužitelnými záznamy. `minClientVersion` (vynucený v `app/_layout.tsx`) zůstává k dispozici, pokud by starší klienty bylo potřeba vyloučit tvrdě.

### Parita

Parita mezi klienty = **capability parita na opravené baseline**, ne kopie současného mobilního chování. Mobilní federace má reálné mezery, které se opraví ve sdílené vrstvě (server + `packages/types`), místo aby se replikovaly do webu:

- federovaný server nelze odpojit (`removeFederatedAccount`, `deleteMusubiAccount` bez callerů);
- žádný per-server status (`syncStatus`/`reconnect_required` se federovaným kalendářům nenastavuje) → mrtvý server ukazuje stará data bez signálu;
- odvolaný member token na background syncu končí tichem, bez re-accept promptu (na rozdíl od home 401 → sign-out recovery);
- federované kalendáře nemají `accountId` → splynou s domácí „Musubi" skupinou, ale zároveň se počítají jako `isExternal`;
- `providerDisplayName` nemá case pro `"musubi"` → propadá na „the CalDAV server";
- vzdálený pull je vždy plný (`GET /events` bez `since`) s client-side diffingem místo tombstones.

Fáze 3 většinu z nich řeší strukturálně: jednotné tagování zapne existující generické provider UI (per-server sekce, disconnect, reconnect badge) na obou klientech.

## Důsledky

- token opustí klienty úplně → bezpečnostní zlepšení i pro mobil, ne jen odblokování webu;
- jedna API plocha pro oba klienty → parita vynucená serverem, ne disciplínou;
- mobil se zjednoduší (zmizí token custody i rotace);
- **A je v datové cestě**: leží-li A, federované kalendáře jsou nedostupné, i když B běží. Dnes by mobil B dosáhl přímo. Trade-off vědomě přijat — bez A uživatel nemá ani session a domácí data; klienti mají lokální cache;
- jeden síťový hop navíc (latence);
- SSE fan-in přidává A per-uživatele upstream spojení — konzistentní s dnešním single-replica záměrem, se stejnou dokumentovanou výhradou před horizontálním škálováním;
- `federation.mdx` a `reference/api.mdx` potřebují aktualizaci.

## Invarianty

- Dešifrovaný member token **nesmí** opustit proces API jinam než v `Authorization` hlavičce upstream requestu na B. Nikdy do odpovědi, nikdy do logu.
- Cílový origin gateway pochází **výhradně** z `musubi_accounts` řádku vlastněného callerem. Request nesmí origin, host ani port ovlivnit.
- Gateway vyžaduje home session (`requireAuth`) a je **same-origin only** — žádné CORS hlavičky.
- Domácí cookie/session hlavičky se **nikdy** nepřeposílají upstream; `Authorization` se nahrazuje.
- Autorizace zůstává na B přes `calendar_members` — gateway autorizaci neobchází ani nenahrazuje. Kick na B = okamžitá ztráta přístupu i přes gateway.
- Path allowlist (`/api/v1/…`) je defense-in-depth, ne bezpečnostní hranice: uživatel má dnes stejnou schopnost přímo tokenem.

## Threat model

| Hrozba | Vektor | Mitigace |
|---|---|---|
| **SSRF** — čtení interních služeb / cloud metadat | Gateway fetchuje na URL ovlivněnou uživatelem | Origin jen z DB (ne z requestu); validace při ukládání connection **i** při každém requestu; deny loopback/private/link-local/CGNAT/unique-local rozsahy (`127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` ← metadata, `100.64/10`, `::1`, `fc00::/7`, `fe80::/10`); jen `http`/`https`; bez credentials v URL |
| **DNS rebinding** — origin projde validací, pak se přeloží na interní IP | TTL manipulace mezi kontrolou a connectem | Revalidace při **každém** requestu (ne jen při ukládání). **Zbytkové riziko přijato:** validujeme přeložené adresy, ale connect jde přes hostname — pinnutí IP by rozbilo TLS SNI. Zneužití vyžaduje autentizovaného uživatele, který zkoumá síť svého vlastního domácího serveru; `FEDERATION_ALLOW_PRIVATE_HOSTS` je pro nasazení, kde jsou interní cíle legitimní |
| **Confused deputy** — A přiloží silný credential na cestu zvolenou klientem | Klient/XSS volá gateway na libovolnou cestu na B | Není eskalace: uživatel má dnes tuto schopnost přímo tokenem, a XSS na webu má i domácí session. Zmírnění: same-origin only, `requireAuth`, path allowlist `/api/v1/`, žádné proxování `/api/auth/*` |
| **Token exfiltrace** | XSS v prohlížeči | Token není v JS ani v žádné odpovědi — endpointy, které ho vydávaly/přijímaly, jsou odstraněné |
| **Token at rest** | Přístup k DB | AES-GCM přes `CALDAV_ENC_KEY`, stejná třída jako CalDAV hesla |
| **Admin domácího serveru jedná za uživatele na B** | Admin má DB + `CALDAV_ENC_KEY` | **Nezměněno vůči v1** — vědomě přijaté a zdokumentované; gateway to nezhoršuje (token už dnes leží na A) |
| **Amplifikace / A jako open proxy** | Zneužití gateway k útoku na třetí stranu | Cíl jen z vlastních connection řádků callera; rate-limit na gateway; timeout a cap na velikost body |
| **Únik hlaviček** | Přeposlání domácích cookies/CSRF tokenů na B | Allowlist hlaviček směrem upstream; `Authorization` nahrazena; cookies zahozeny |
| **Odvolaný/expirovaný token** | Uživatel byl na B kicknut nebo token vypršel | Upstream 401/403 se mapuje na per-server `reconnect_required` stav (fáze 3), ne na tiché selhání |

**Dodatek 2026-11-06 k řádku „DNS rebinding“ (CP10 task 10.3, ID-06, TRUST-03):** zbytkové riziko výše už neplatí a věta „pinnutí IP by rozbilo TLS SNI“ byla mylná. Každý federační odchozí požadavek (gateway, preview, connect, peer probe, rotace tokenu, SSE stream) jde přes `federationFetch` (`apps/api/src/federation_origin.ts`), který hostname přeloží, celou odpověď prověří stávající private-network policy a **tutéž přijatou adresní sadu** předá sdílenému pinned leafu (`createPinnedCaldavFetch`, `packages/provider-caldav/src/network.ts`). Připnutí je v `lookup` undici Agenta, ne v URL: hostname zůstává v URL, `Host`, SNI i nativní ověření certifikátu jsou původní, socket hostname znovu nepřekládá, redirecty se nenásledují (`manual`) a abort/timeout platí i během čekání na DNS. Pre-check `assertPublicOrigin` zůstává (stejné chybové plochy); pinned fetch přidává svázané připojení. Doloženo testy na vlastních loopback listenerech (JSON suite `federation-transport`, `apps/api/src/federation_transport.test.ts`, `packages/provider-caldav/src/index.test.ts`); viz `openspec/changes/align-project-workflows-and-complete-sync/checkpoints/CP10-federation-transport.md`.

### Testovací požadavky

- SSRF unit test: privátní rozsahy, IPv6, DNS rebinding (resolve→IP mismatch), URL s credentials, non-http scheme, path escape (`..`, absolutní URL v cestě).
- Authz test: gateway s `connectionId` cizího uživatele → 404/403; bez session → 401.
- Header test: domácí cookie se nepropaguje; `Authorization` je přepsána.

## Otevřené / odložené

- **Fáze 3 partial-failure semantika** (co vrací `/calendars` když je B nedostupný) — návrh: home data vždy + per-server `syncStatus`.
- **v3 cross-server linking** — postavitelné nad gateway; mimo scope tohoto ADR.
- **S2S ověření identity serveru** (že B je opravdu Musubi a `homeServer` claim je pravdivý) zůstává nevyřešené z v1; gateway to nemění.
