# Nylas: sync, autentizace a provozní kontrakt

Ověřeno **12. 10. 2026**. Tato kapitola rozlišuje **doložené chování** veřejného API v3, **historický kód** otevřeného Sync Engine, **odvození** z těchto podkladů a **návrh pro Musubi**. Nejde o audit neveřejného produkčního backendu Nylas ani o potvrzení jeho interních algoritmů. Prohlédnuté veřejné zdroje umožňují velmi dobře rekonstruovat vnější kontrakt, podstatně méně způsob, kterým jej služba skutečně implementuje.

## 1. Nejdůležitější architektonické rozlišení

**Doloženo:** Nylas při uvedení v3 v únoru 2024 popsal odklon od uchovávání dat ne-IMAP účtů: Google a Microsoft se obsluhují přímo proti providerovi. Jeho support následně výslovně spojil odstranění v2 vrstvy ukládání zpráv s přímými provider notifikacemi. Google a Graph mohou posílat upsert, ze kterého služba určuje `created` či `updated`; odběratel proto nemá předpokládat čistý sled create → update. [Uvedení API v3](https://www.nylas.com/blog/introducing-nylas-apiv3/), [změna webhook modelu mezi v2 a v3](https://support.nylas.com/hc/en-us/articles/26826548737053-Why-do-I-need-to-handle-both-message-created-and-message-updated-webhooks-in-Nylas-v3).

**Doloženo:** U IMAP je situace jiná. Současná dokumentace Messages API uvádí průběžnou 90denní cache pro Yahoo, iCloud a generický IMAP. Starší zprávy lze číst přímo přes `query_imap=true`; generický IMAP průvodce upozorňuje na vyšší latenci. Průvodce backfillem vyžaduje při takovém čtení parametr `in`, tedy zpracování konkrétní složky. Tyto údaje se týkají emailů, ne obecného retenčního slibu pro kalendáře. [Messages API](https://developer.nylas.com/docs/v3/email/messages/), [generický IMAP](https://developer.nylas.com/docs/cookbook/email/messages/list-messages-imap/), [historický emailový backfill](https://developer.nylas.com/docs/cookbook/email/backfill-historical-email/).

**Odvození:** Nylas v3 je vhodné chápat jako normalizační a integrační bránu s provozními službami. Není doloženo, že představuje univerzální replikační protokol s dlouhodobým lokálním stavem, offline autoritou a více cíli jednoho kanonického objektu. Sjednocený endpoint odstraní mnoho integračního kódu zákazníka, ale neodstraní rozdíly mezi upstream systémy. Naopak přímý přístup více odhaluje jejich kvóty, dostupnost a pořadí změn.

**Dopad na Musubi:** Náš kanonický model, vlastní kalendáře, sdílené úkoly, federace a opatrné zápisy mají jiný účel. Odstranit databázi nebo outbox podle vzoru v3 by odstranilo vlastnosti produktu, nikoli pouze složitost. Smysluplné zjednodušení je oddělit integrační transport od kanonické autority: adapter ví, jak objekt přečíst a podmíněně zapsat; jádro ví, zda pozorování smí změnit kanonický stav; produkt rozhoduje, komu stav patří a co je veřejné.

Prakticky bych pro otevřený projekt specifikoval dva profily nad společnou sadou typů:

| Profil | Autorita | Uchovávaný stav | Typické použití |
| --- | --- | --- | --- |
| Integrační brána | Provider | Credential reference, schopnosti, krátká cache, provozní metadata | Vývojář chce jednotné čtení nebo vytvořit schůzku |
| Synchronizovaná replika | Výslovně deklarovaná domovská autorita | Kanonické objekty, projekce, cursory, tombstones, durable intent | Musubi, offline klient, sdílení, více providerů |

To umožní jednoduchým integracím platit jen za jednoduchý profil. Složitější aplikace přitom neztratí bezpečnostní a konzistenční kontrakt. Není třeba z jednoho profilu dělat výchozí univerzální odpověď.

## 2. Application, connector, credential, grant

**Doloženo:** Nylas odděluje přístup provider účtu od autorizace volajícího API. `grant_id` označuje připojení uživatele; provider scopes určují jeho oprávnění. API key určuje oprávnění volající služby. Connector obsahuje konfiguraci provider aplikace a výchozí scopes. Podle průvodce custom OAuth má aplikace jeden connector na provider. [Autentizace](https://developer.nylas.com/docs/v3/auth/), [vlastní OAuth connector](https://developer.nylas.com/docs/cookbook/use-cases/build/custom-oauth-connector/).

**Doloženo:** Jeden connector může mít více credentials, každé s vlastním provider `client_id` a `client_secret`. Grant patří konkrétnímu credential. `active_credential_id` vybírá výchozí konfiguraci, ale při Hosted OAuth i BYO lze zvolit konkrétní `credential_id`. Průvodce uvádí zákaznické aplikace a migraci reautentizací při zachování grant ID. [Více provider aplikací](https://developer.nylas.com/docs/v3/auth/using-multiple-provider-applications/).

**Doloženo:** Hosted OAuth s API key pracuje přes `/v3/connect/auth`, přesně registrované callback URI, jednorázový code a `/v3/connect/token`. BYO přijímá existující provider refresh token nebo příslušné credentials. Access-token varianta umožňuje přístup přes `/v3/grants/me/...`, s `access_type=offline` i pozdější obnovu Nylas tokenu. PKCE je další podporovaná možnost. [Hosted OAuth s API key](https://developer.nylas.com/docs/v3/auth/hosted-oauth-apikey/), [BYO autentizace](https://developer.nylas.com/docs/v3/auth/bring-your-own-authentication/), [Hosted OAuth s access tokenem](https://developer.nylas.com/docs/v3/auth/hosted-oauth-accesstoken/).

**Návrh:** Převzít oddělení pojmů, ne další OAuth server uvnitř Musubi. Pro samostatný sync balíček má být `ConnectionRef` stabilní interní identita připojení, `CredentialRef` odkaz na konfiguraci či bezpečný credential resolver a `ProviderAccountRef` identita upstream účtu. Email adresa je zobrazovací údaj, nikoli klíč. Změna adresy, alias, tenant nebo nová provider aplikace nesmějí samovolně sloučit dvě účtové identity.

Resolver dostane scope připojení a požadovanou schopnost, vrátí aktuální přístup nebo strojově čitelnou překážku. Jádro synchronizace nemá dostávat refresh token ani rozhodovat, zda je uživatel přihlášen do produktu. Tím vzniknou adaptér pro Better Auth, adaptér pro vlastní credential store a testovací resolver bez závislosti na webové aplikaci.

V současném Musubi není autentizace kalendáře totéž co přihlášení. Dokumentace to už popisuje správně; [OAuth query vrstva](../../../packages/db/src/queries/oauth.ts) rozlišuje provider scope, optional Tasks scope a stav připojení. [OAuth refresh](../../../apps/api/src/sync/oauth.ts) používá jednu probíhající obnovu pro konkrétní credential snapshot v procesu, šifruje uložené tokeny a ukládá výsledek pod compare-and-swap podmínkou. Starý výsledek tak nesmí přepsat relink nebo disconnect. `invalid_grant` mění stav na nutnou reautentizaci; samotná resource `401` či výpadek token endpointu to nedokazuje.

Tuto ochranu bych zachoval a vyvedl do malé služby. Procesní single-flight není totéž co distribuovaný lock. Při budoucím provozu více workerů je potřeba rozhodnout, zda provider toleruje souběžný refresh, nebo zda resolver potřebuje krátký account lease s fencingem. Zpřísnění musí vycházet z provider důkazu; zavést globální lock pro všechny případy by přidalo latenci a nové riziko uvíznutí bez prokázaného přínosu.

## 3. Životní cyklus připojení a obnova po výpadku

**Doloženo:** Nylas doporučuje reautentizovat existující invalid grant. Při neplatnosti kratší než 72 hodin popisuje backfill webhook notifikací; po delší době ho přeskočí. Delete grant je nevratný a následné připojení dostane novou identitu. [Životní cyklus grantů](https://developer.nylas.com/docs/dev-guide/best-practices/grant-lifecycle/), [Grants API](https://developer.nylas.com/docs/reference/api/manage-grants/).

**Návrh:** Musubi má uchovávat doménový životní cyklus připojení odděleně od čerstvosti konkrétního zdroje. `active` říká, že přístup je možný. Neříká, že všechny kalendáře byly plně přečteny. Potřebujeme také evidence jako poslední úspěšný pull, coverage čtení, stav obnovy, čas invalidace cursoru a aktuální generation identity. Zjednodušení na valid/invalid by schovalo podstatnou nejistotu.

Po reconnectu se obnoví stejná ConnectionRef, zkontrolují se scopes a discovery, připustí se pouze čtení odpovídající aktuální generaci a provede se kontrolovaný catch-up. Pokud cursor expiroval, začne úplná nebo pokrytím omezená obnova. Chybějící objekt lze odstranit až na základě kompletního čtení ve správném scope. Nové připojení není důvod zahodit staré kanonické revize ani důkazem, že lze automaticky odeslat všechny čekající zápisy.

Oddělený import a živé zpracování je dobrý provozní vzor Nylas. Jeho emailový cookbook popisuje checkpointovaný backfill přes `next_cursor`, který nemá blokovat webhook listener ostatních účtů. Přesná stránkovací pravidla jsou emailová, ale princip izolace dlouhého importu lze použít i pro kalendáře. [Škálování email syncu](https://developer.nylas.com/docs/cookbook/email/scale-email-sync/).

Pro Musubi to znamená uložený job s konečným scope, nikoli jednu dlouhou funkci s neurčitým „sync finished“. Stránkovací checkpoint musí jít uložit společně s přijatými pozorováními. Snapshot epoch brání tomu, aby částečný import autorizoval sweep. Živé nudge během importu se zaznamenají a po dokončení spustí doplňkový incremental pull; nesmějí se ztratit jen proto, že worker byl zaneprázdněný.

## 4. Webhook není změnový log

**Doloženo:** Aktuální hlavní guide uvádí maximálně tři pokusy s exponenciálním odstupem, poslední přibližně 10–20 minut od prvního. Retry připouští pro timeout a vybrané kódy `408`, `429`, `502`, `503`, `504`, `507`; jiné chyby nereplayuje. Po vyčerpání notifikaci zahodí. `2xx` považuje za přijetí. Při více než 95 % selhání ve dvou po sobě jdoucích 15minutových oknech přechází endpoint do `failing`; při přetrvání 72 hodin do `failed`. Reaktivace je ruční a nevytváří replay z neaktivního období. Tentýž guide zároveň používá formulaci „at least once“ po publikaci. To nelze číst jako důkaz bezpodmínečného úspěšného doručení. [Webhooks guide](https://developer.nylas.com/docs/v3/notifications/).

**Doloženo:** Samostatné best practices negarantují pořadí ani doručitelnost. Retry cookbook výslovně mluví o best effort s konečným počtem pokusů. Starší support dokument migrace stále uvádí pět retries za 72 hodin; tento údaj je v rozporu se současným v3 guide a nelze jej použít jako aktuální kontrakt. [Webhook best practices](https://developer.nylas.com/docs/dev-guide/best-practices/webhook-best-practices/), [retry cookbook](https://developer.nylas.com/docs/cookbook/use-cases/build/retry-failed-webhooks/), [support migrace v2/v3](https://support.nylas.com/hc/en-us/articles/18564132044957-Issues-and-Differences-During-Migration-from-V2-to-V3-Best-Practices).

**Doloženo:** Notification reference popisuje omezení payloadu na 1 MB, variantu `.truncated` s nutným novým čtením a životní cyklus grantů. Create-destination reference upozorňuje, že retry stejného triggeru jde do všech jeho destinations. Dedup cookbook rozlišuje stabilní top-level notification `id` od ID objektu: legitimní následné updates mají stejný objekt, ale různé notification IDs. [Webhook API reference](https://developer.nylas.com/docs/reference/api/webhook-notifications/), [create destination](https://developer.nylas.com/docs/reference/api/webhook-notifications/post-webhook-destinations/), [deduplikace notifikací](https://developer.nylas.com/docs/cookbook/use-cases/build/handle-duplicate-webhooks/).

**Návrh:** Povinný kontrakt pro Musubi musí říct, že provider notifikace je nudge k reconciliation. Není autoritou pro definitivní smazání, pořadí revizí ani completeness. Pro příjem použít: limitovaný raw body → ověření → durable inbox nebo durable job → ACK. Při neúspěšném durable zápisu vrátit dočasnou chybu. Teprve worker deduplikuje dokončené či rozpracované delivery a zpracovává provider čtení.

Právě zde nesmí být cookbook kopírován mechanicky. Doporučení rychle ACKnout je dobré, ale ACK před bezpečným enqueue vytváří okno trvalé ztráty při pádu procesu. Totéž platí pro Redis `SET NX` před dokončením práce: proces může nastavit seen a zemřít, takže retry zahodíme. Potřebujeme stav accepted/processing/completed s lease nebo dedup a enqueue v jedné transakci. Atomic check-and-set samo o sobě neznamená atomickou aplikaci změny.

Rozlišit tři identity:

- `deliveryId`: opakované doručení stejné notifikace;
- `remoteRef`: stejný provider objekt přes více notifikací;
- `operationId`: naše logická lokální mutace a její remote projekce.

Použití `remoteRef` jako permanentního seen klíče by pozdější legitimní změny zahazovalo. Coalescing nudge je naopak žádoucí: tisíc updates stejného kalendáře může vyvolat jeden pull od posledního cursoru. Záznam musí uchovat generation/sequence, aby dokončení staršího pullu nevynulovalo nudge přijatý během práce. `time` notifikace pomáhá při diagnostice, ale nenahrazuje ETag, provider cursor ani kauzální vztah lokální mutace.

**Doloženo:** Podpis je hex HMAC-SHA256 přes přesné raw bytes s tajemstvím destination, ověřovaný konstantním časem. Průvodce podpisy výslovně uvádí, že u gzip musí jít o komprimované wire bytes; ověření následuje před dekompresí. [Ověření podpisů](https://developer.nylas.com/docs/cookbook/use-cases/build/verify-webhook-signatures/).

**Návrh:** Pro vlastní veřejný webhook protokol explicitně specifikovat encoding, podpisovaná data, verzování algoritmu, časový údaj, key ID a okno replay ochrany. Limitovat velikost komprimovaného i rozbaleného obsahu. Rotace tajemství musí mít popsaný přechod, protože validní retry může přijít s původním podpisem. Výchozí payload by obsahoval reference a lehká provozní metadata, nikoli citlivé title/body všech objektů. Volitelný objektový payload je optimalizace, která nikdy nemění correctness.

## 5. Polling, push a fronty

**Historický kód:** Otevřený engine už kombinoval Google watch a polling. `GoogleEventSync` obnovoval subscriptions a vybíral kalendáře k čtení podle signálu či maximálního intervalu bez synchronizace, definovaného jako jedna hodina. Google provider stránkoval `showDeleted`, používal `updatedMin` a při `410` četl vše. To není popis současného v3. [Historický remote sync](https://github.com/nylas/sync-engine/blob/50698996aef73102ead592e8d0948c1d2edfe123/inbox/events/remote_sync.py), [historický Google provider](https://github.com/nylas/sync-engine/blob/50698996aef73102ead592e8d0948c1d2edfe123/inbox/events/google.py).

**Doloženo v3:** Nylas poskytuje notifikační kanály Pub/Sub i SNS. Pub/Sub nemá ordering key a při vytvoření ověřuje formát topic, nikoli test publish; čtení vlastní subscription je odpovědností zákazníka. SNS požaduje Standard topic, odmítá FIFO a při vytvoření publikuje test event. Transportní fronta tedy nepřidává globální pořadí změn. [Pub/Sub kanál](https://developer.nylas.com/docs/v3/notifications/pubsub-channel/), [SNS kanál](https://developer.nylas.com/docs/v3/notifications/sns-channel/).

**Musubi dnes:** [Scheduler](../../../apps/api/src/index.ts) iteruje uživatele sekvenčně, používá procesní `nonOverlapping` a spoléhá na uniformní polling; komentář uvádí dostupnost veřejného HTTPS a renewal jako překážku self-hostingu. Je to legitimní default pro malé instalace. Není potřeba zahodit polling, aby se zlepšila latence hosted služby.

**Návrh:** Změnová detekce má být volitelný adapter capability: polling-only, push-nudge, případně provider delta stream. Cloud instalace může zapnout Google/Graph subscriptions; malý self-host zůstane na pullu. V obou případech platí stejné `fetchChanges` a reconciliation. Zavést account/source scheduler se durable `nextRunAt`, důvodem probuzení, prioritou a lease, až měření ukáže potřebu. Pro současný PostgreSQL provoz může fronta být tabulka s claimem; Redis, SQS ani Kubernetes nejsou předpoklad otevřeného protokolu.

Periodický audit zůstává nutný i při push. Jeho frekvence může být nižší, s jitterem a backoffem po nečinnosti. Renewal subscriptions je samostatný job s metrikou času do expiry. Ruční sync, push i scheduled audit musejí vstupovat do stejné fronty, aby tři spouštěče nesynchronizovaly jeden account souběžně.

## 6. Chyby, limity a retry bez ztráty důkazu

**Doloženo:** Nylas rozlišuje své `429` (`nylas_rate_limit_exceeded`) a provider limit (`rate_limit_error` s `provider_error`). Provider throttling read/send není automaticky retryován před návratem chyby; `Retry-After` se předává, pokud jej provider dodá. Aktuální tabulka uvádí například 200 calendar requests/s/grant a 50 auth nebo webhook requests/s/application. Jsou to limity Nylas, nikoli dosažitelná propustnost upstreamu. [Nylas a provider rate limits](https://developer.nylas.com/docs/dev-guide/platform/rate-limits/).

**Doloženo:** Chybový envelope obsahuje `request_id`, `error.type`, `message` a u provider/connector původu `provider_error`. Reference zahrnuje partial success, partial missing a `504` provider error. Provozní guide připouští interní retry některých krátkých network chyb a doporučuje zákaznický backoff pro chyby, které API vrátí. [Chybová reference](https://developer.nylas.com/docs/api/errors/), [provozní monitoring chyb](https://developer.nylas.com/docs/dev-guide/best-practices/error-handling/).

**Návrh:** Veřejný sync kontrakt nemá rozhodovat jen podle HTTP status. Každý výsledek zápisu musí nést `written`, `not-written` nebo `unknown`, remote validator, bezpečný error code a scope omezení. `504` může znamenat, že provider zápis provedl a odpověď se ztratila. Opakovaný CREATE v tomto stavu není „odolný retry“, ale možná duplikace schůzky. Čtení je obvykle možné opakovat; podmíněný zápis lze opakovat jen při zachování jeho preconditions a doložené idempotenci.

Musubi tuto oblast již řeší: [Event delivery](../../../apps/api/src/sync/event_delivery.ts) rozlišuje conflict/blocked/unconfirmed/retry, respektuje provider retry interval a používá backoff s jitterem. [Google adapter](../../../apps/api/src/sync/adapters/google.ts) omezuje automatickou obnovu resource `401` na GET, aby wrapper neopakoval mutaci. To je důležitější vlastnost než pohodlný obecný HTTP retry interceptor.

Doplnit společný limiter má smysl, protože současný backoff konkrétní operation není totéž co zabránění stampede celého účtu. Limiter potřebuje více scope: provider app/project, tenant, účet a případně endpoint cost. Timeout jednoho účtu nesmí blokovat ostatní; globální provider outage může naopak dočasně snížit concurrency všech odpovídajících workerů. Per-account pořadí změn nemá vyžadovat držení worker thread během minutového sleep: uložit `nextAttemptAt`, uvolnit slot a zachovat dependency chain.

První měření: stáří nejstaršího admitted intentu, stáří posledního přijatého observation, cursor reset rate, reconnect rate, `429` podle scope, počet uncertain writes, queue delay a skutečné request amplification. Zdravá HTTP success rate může existovat zároveň se starým kalendářem, takže sama o sobě nestačí.

## 7. Historický otevřený engine: co opravdu poskytuje

**Historický kód:** Veřejný repozitář je archivován od 25. 6. 2026 a uvádí AGPL-3.0. README popisuje REST nad email syncem, starý Vagrant development setup a výslovně upozorňuje na nešifrované tokens/passwords v development databázi. Toto není vhodný produkční základ dnešního Musubi ani důkaz aktuální implementace SaaS. [Repozitář a README](https://github.com/nylas/sync-engine), [licenční soubor](https://github.com/nylas/sync-engine/blob/master/LICENSE).

V této analýze je historický kód připnut na commit SHA `50698996aef73102ead592e8d0948c1d2edfe123`, ověřený veřejným GitHub API; jde o commit z 25. 6. 2026 s upozorněním na archivaci. Prohlédnuté části: event pull, Google provider, action log, syncback service a klientský delta log. Jde o statické čtení; engine nebyl spuštěn a jeho správnost na současných providerech není ověřena.

**Historický kód:** `schedule_action` přidává durable ActionLog do dodané databázové session, se stavy pending/successful/failed a počítadlem retries. Syncback service serializuje práci account semaphore, slučuje vhodné adjacent actions a dovoluje 20 pokusů s výchozím 30sekundovým odstupem. Komentář sám připouští až 600sekundovou blokaci účtu a TODO jemnějšího zamykání; další TODO požaduje jitter. Při definitivním selhání `create_event` označuje další pending actions za failed a local event jako deleted. [ActionLog](https://github.com/nylas/sync-engine/blob/50698996aef73102ead592e8d0948c1d2edfe123/inbox/models/action_log.py), [Syncback actions](https://github.com/nylas/sync-engine/blob/50698996aef73102ead592e8d0948c1d2edfe123/inbox/transactions/actions.py).

**Historický kód:** Klientský delta mechanismus čte lokální transaction log, vystavuje veřejný cursor, v dávce slučuje opakované změny stejného záznamu a řadí podle transaction ID. Streaming generator polluje tento log. To je downstream replikační feed po lokálním commitu, nikoli upstream provider webhook. [Delta sync](https://github.com/nylas/sync-engine/blob/50698996aef73102ead592e8d0948c1d2edfe123/inbox/transactions/delta_sync.py).

**Poučení:** Historie potvrzuje hodnotu durable intentu a oddělení upstream syncu od klientského delta feedu. Neposkytuje důvod oslabit dnešní ochrany Musubi. Automatické označení lokálního objektu za deleted po počtu retry by bylo pro naše explicitní local commit receipt nesprávné. Naše `unconfirmed`, leases, reconciliation a privacy generation představují potřebný posun oproti jednoduchému action logu. Historický kód použít jako katalog problémů a scénářů, vlastní realizaci návrhu držet původní a zdokumentovanou. Licenci a původ převzatých částí evidovat; tato studie nečiní právní závěr o kompatibilitě budoucí licence Musubi.

## 8. Data, soukromí a otevřené otázky

**Doloženo:** Nylas provozní guide uvádí sedmidenní S3 cache pro attachments, raw MIME a contact pictures. Data residency guide uvádí US Iowa a Europe London, region oddělený na úrovni application a nové připojení při přesunu regionu. Organizační/dashboard údaje podle guide zůstávají v evropském centru. „Přímý provider přístup“ tedy nelze překládat jako absolutní absenci uchovávaných dat. [Error-handling guide](https://developer.nylas.com/docs/dev-guide/best-practices/error-handling/), [Data residency](https://developer.nylas.com/docs/dev-guide/platform/data-residency/).

**Doloženo:** Privacy mode filtruje kalendářové objekty na events vytvořené aplikací přes Nylas po zapnutí režimu; ostatní se vynechají v listech a při přístupu přes ID vracejí `403`. U recurrence rozhoduje parent. [Privacy mode](https://developer.nylas.com/docs/dev-guide/platform/privacy-mode/).

**Návrh:** Toto filtrované čtení je další důvod deklarovat completeness a coverage. Nepřítomnost pod privacy filtrem není remote delete. Pro Musubi oddělit retenční politiku credential store, minimálních observation evidence, kanonických produktových dat a citlivých debug fixtures. Umět explicitně smazat credential a zároveň uchovat pouze takovou operation evidence, kterou další oprávněný destination ještě potřebuje. Šifrovaný token není oprávnění sdílet jej s každým sync workerem.

Veřejné podklady neřeší dostatečně: atomický vztah capture provider změny a publikace notifikace; durable replay po producer výpadku; přesnou dedup retenci producenta; aktuální v3 pořadí při souběžných writes; interní conflict policy; všechny podmínky uchovávání kalendářových dat a cache; možnosti import/export provozního cursoru; identity při provider moves a relink ve všech tenant konfiguracích. Tato místa nelze vyplnit tvrzením, že Nylas „to určitě má vyřešené“.

## 9. Implementační sled pro Musubi

**Nejprve specifikace:** Popsat scope a identitu connection, source, resource a occurrence; model completeness; životní cyklus cursoru; výsledek zápisu včetně unknown; vztah canonical revision a provider validatoru. Vytvořit capability manifest, který nevydává pouhou existenci metody za garanci podmíněného zápisu. Současné chování rozdělit na protocol invariant a produktovou policy.

**Potom provozní oddělení:** Nezávisle konfigurovat scheduled pull a background outbox recovery. Dnes dokumentace Musubi říká, že `EXTERNAL_SYNC_INTERVAL_MIN=0` vypne obojí; administrátor toužící zastavit polling tak může zastavit i recovery už přijatých writes. Samostatné switches a health evidence sníží riziko bez změny provider sémantiky. Následuje common account scheduling a limiter, pak optional push subscriptions se stejnou reconciliation cestou.

**Nakonec veřejný balíček:** Vyjmout credential resolver, adapter capability typy, normalized observations, cursor envelope, error taxonomy a kontraktní testy. Runtime runner a PostgreSQL persistence dát do samostatných modulů. Nemíchat do minimálního SDK Better Auth, produktové membership ani frontend. Referenční implementace musí ukazovat bezpečný crash recovery a self-host polling už při prvním vydání.

Přejímací testy mají dokazovat chování při pádu mezi remote commit a local ACK, restartu uprostřed stránkování, duplicate/out-of-order nudge, reconnectu během token refreshu, expirovaném cursoru, neúplném discovery, ztracené read authority a `429` sdílené provider aplikace. Úspěch není pouze zelený CRUD test; je jím i zachovaná nejistota tam, kde systém nemá důkaz. To je oblast, ve které může Musubi nabídnout otevřený kontrakt přesnější než běžné integrační API.
