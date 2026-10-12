# Sync profile v1: identity, observations and write evidence

**MUSU-33 · Normativní sémantický profil `sync-profile-v1`.** Runtime schémata a host port jsou v [sync_protocol.ts](../../packages/types/src/sync_protocol.ts); reprodukovatelné fixtures v [sync_protocol.test.ts](../../packages/types/src/sync_protocol.test.ts). Profil je interní základ pro extrakci sdíleného jádra. Není tvrzením, že všechny současné Musubi operace jsou přenositelné, ani veřejným release balíčku.

Slova **MUSÍ**, **NESMÍ** a **MĚL BY** označují požadavky na implementátora tohoto profilu. Samotné Zod schéma ověří datový tvar, nikoli upstream chování, transakce nebo oprávnění. Označení profilu nenahrazuje důkaz konkrétní provider operace.

## Hranice a kompatibilita

Profil normalizuje význam identit, času, recurrence evidence, coverage, capability rozhodnutí a výsledků doručování. Jeho jedinými závislostmi jsou Zod a stávající čisté časové typy. Nepotřebuje databázi Musubi, auth session, domácí kalendář, memberships, UI ani app config.

Host vlastní admission, lokální CAS, ACL, privacy a rozhodnutí, která observations smí měnit jeho kanonický stav. Provider transport vlastní HTTP mapping a specifické write/read důkazy. Runtime vlastní durable životní cyklus operace. Vlastnictví provider credential není oprávněním měnit Musubi objekt; Calendar Relay bude potřebovat vlastní route/binding authority.

`SYNC_PROFILE_V1` je přesně `sync-profile-v1`. Chybějící, starý i neznámý profil je pro tento decoder **unsupported**. `classifySyncProfile` nikdy nepřevede neznámý profil na aktuální. Budoucí compatibility decoder musí být explicitní, mít vlastní fixtures a zachovat původní význam přijatého zápisu. Verze profilu je oddělená od verze operation envelope, serializer ID a serializer version. Změna významu all-day end, original slot nebo uncertainty je změna profilu, i kdyby field names zůstaly stejné.

Schémata jsou strict. Neznámá pole se NESMÍ potichu zahazovat při přijetí durable evidence. Tento profil není současné Musubi HTTP DTO a není přidaný do stávajícího klientského wire kontraktu.

## Identity a resource boundaries

| Identita | Význam | Zakázaná záměna |
| --- | --- | --- |
| `connectionId` | Hostem přidělená identita jedné autorizované provider connection | Email, account display name, OAuth token |
| `collectionId` | Stabilní host identita kolekce v connection | Název kalendáře, provider primary alias |
| `locator.resourceId` | Exact provider resource address nebo native ID v dané kolekci | iCal UID, host object ID |
| `uid` | Providerová meeting/recurrence korelace | Globálně unikátní write identity nebo authority |
| `hostObjectId` | Objekt vlastněný konkrétním hostem | Native resource ID nebo cizí host ID |
| `familyId` | Boundary série/resource family pro reconciliation a serialized writes | Aktuálně zobrazený výskyt |
| `originalStart` | Původní occurrence slot v explicitní časové doméně | Aktuální přesunutý start výjimky |
| `commandId` | Jeden lidský záměr v host command ledger | Network request nebo provider object ID |
| `operationId` | Jedna durable přijatá operace pro konkrétní cíl | Nové ID při retry |
| `attemptId` | Jedna dispatch/observation snaha nebo lease | Idempotency identity operace |
| `sourceEpoch` | Konkrétní source instance a její lifecycle generation | Obsahová revize události nebo samotný config hash |

Opaque identity stringy jsou neprázdné, case-sensitive a NESMÍ se trimovat nebo přepisovat. TypeScript brands oddělují connection, collection, host object, family, command, operation a attempt. Runtime schéma není schopné poznat, že volající omylem předal jiný string; tento význam musí zachovat host ledger.

`scopedProviderLocatorKey` kóduje tuple provider/connection/collection/resource. Stejný UID a native ID ve dvou connections tedy nevytvoří společnou identitu. Musubi UUID pravidla zůstávají v Musubi bridge; obecný host není nucen používat UUID.

`familyId` přiděluje host a MUSÍ být unikátní v jeho ledgeru napříč connections a collections. Provider `seriesMasterId` ani DAV UID se nesmí vložit přímo jako family ID bez scoped host mappingu. `syncOccurrenceKey` má význam uvnitř jednoho host ledgeru; při spojení více hostů jej volající MUSÍ navíc scopeovat host ID. Dvě provider resources se stejným UID nesdílejí family ID, pokud je host výslovně nepřiřadil ke stejné kanonické family podle své authority.

DAV resource může nést master i několik VEVENT výjimek. Resource locator a ETag patří celé resource family; NESMÍ se rozdělit na nezávislé komponentové CAS důkazy. `SyncOccurrenceIdentity` používá family ID a typovaný original slot. Přesun occurrence NESMÍ změnit jeho key. Změna `instant` na `floating` nebo `date` je změna identity.

## Čas a explicitní all-day boundary

`SyncTime` má čtyři varianty:

- `zoned`: IANA time zone a civilní `startLocal`/`endLocal`. Nepovinný pár `resolved.start`/`resolved.end` zachovává již pozorované instants včetně druhého DST fold. Schema neprovádí tichou re-resoluci.
- `floating`: offset-free civilní interval. Nemá IANA zone ani UTC suffix; host timezone jej NESMÍ implicitně interpretovat.
- `date`: `startDate` a výslovně **`endDateExclusive`**. Oba jsou DATE; konec musí být po začátku.
- `legacy-unknown`: zachované `observed` instants bez nové interpretace zóny nebo all-day významu. Není to zápis nového floating/UTC profilu.

Civilní hodnoty používají stávající `CivilDateTimeSchema`, normalizují maximálně millisecond precision a nepřijímají offset. Instant evidence používá UTC formát. U zoned času není lexikografická civilní posloupnost důkazem pořadí: interval přes podzimní fold může mít zdánlivě dřívější lokální konec. Pokud jsou instants známé, musí být uspořádané. Jejich vztah k civilní kotvě a provider disambiguation policy ověří mapper/resolver mimo toto schéma; custom VTIMEZONE a dvě různé endpoint zones vyžadují samostatný profil nebo unsupported write.

Musubi dál uchovává dnešní inclusive all-day end. Profil nezavádí plošnou migraci uložených událostí. Boundary mapper je výslovný:

~~~ts
musubiInclusiveDatesToSync({
  startDate: "2028-02-28", endDateInclusive: "2028-02-29",
}); // { startDate: "2028-02-28", endDateExclusive: "2028-03-01" }

syncDatesToMusubiInclusive({
  startDate: "2028-02-28", endDateExclusive: "2028-03-01",
}); // { startDate: "2028-02-28", endDateInclusive: "2028-02-29" }
~~~

Mapper přidává/odebírá civilní DATE den v UTC date arithmetic; nepřidává 24 hodin k lokálnímu zoned eventu. Jeho pojmenovaný vstup `endDateInclusive` vyžaduje, aby bridge vědomě namapoval existující Musubi `endDate`. Jednodenní inclusive interval se převádí na jeden den exclusive intervalu. Přetečení čtyřciferného DATE rozsahu skončí chybou, nikoli truncation nebo wrap.

## Recurrence evidence a scopes

`SyncRecurrence` rozlišuje `single`, reprezentovanou `series` a `unrepresented` family. Series uchovává pravidla, inclusions, exclusions a overrides; override má original slot, cancelled flag a nepovinný přesunutý čas. Pravidla jsou zachované RFC property values. Schéma neprovádí recurrence expansion a jeho přijetí NESMÍ být považované za ověření round-trip write support.

`completeness` je explicitně complete/partial/unknown. Neúplná sada výjimek NESMÍ být zapsána jako kompletní family snapshot. Absence occurrence v omezeném read okně není cancelled override. Složitá family může zůstat čitelná a unrepresented/read-only; host zachová potřebnou provider evidence ve vlastním privilegovaném sidecaru.

Capability family odděluje personal single, recurring master, recurring occurrence, recurring following, meeting a task. `split-following` je konkrétní plán s vlastními recovery boundaries, nikoli synonymum obyčejného PATCH. Ani deklarace enum hodnoty neuděluje nové provider capability.

## Capability rozhodnutí a validators

`SyncCapabilityContext` váže rozhodnutí na locator, aktuální source epoch, konkrétní operation, event role, scope knowledge, granted scopes a family shape. Je to evidence pro plán; runtime MĚL BY znovu ověřit práva před dispatch. Host MUSÍ znovu ověřit svou authority při admission a acknowledgement.

Rozhodnutí má právě jednu variantu:

| Rozhodnutí | Význam |
| --- | --- |
| `allowed` | Konkrétní profil má ověřenou operaci a explicitní guarantee |
| `denied` | Známý nedostatek scopes, role, identity nebo retired source |
| `unknown` | Právo, upstream behavior nebo family evidence není prokázaná |
| `unsupported` | Tento mapper/operation profil bezpečnou sémantiku neumí |

Unknown není denied a není allowed. Schéma odmítá write allowed s unknown scope/role/family a reader rolí. Scope seznam nemá být univerzálně neprázdný: DAV používá ACL a nemusí mít OAuth scopes. Ověření konkrétních požadovaných scopes a kolekce je odpovědností capability resolveru.

Allowed guarantee je samostatná discriminated union:

- `read-only`: read/list, nikdy write.
- `conditional`: exact validator a **ověřený endpoint profile**, který atomicky podmiňuje tento konkrétní write.
- `guarded-preflight`: porovnání před dispatch, výslovná `read-write-gap` race a `observe-only` recovery při nejistotě.
- `provider-idempotency`: endpointem prokázaná deduplication pro stejný operation key v daném scope; recovery opakuje stejný key.
- `non-idempotent-action`: explicitní action profil s observe-only recovery; například scheduling side effect, pokud jej současná implementace skutečně podporuje.

Žádný univerzální unconditional fallback neexistuje. Unsupported je rozhodnutí, ne slabší allowed guarantee. Graph guarded personal DELETE porovnává exact native weak `@odata.etag` při preflight a výslovně zachovává read-write race; NESMÍ být popsán jako conditional CAS. `changeKey` NESMÍ nahradit tuto native ETag evidence.

Současné implementační endpoint profiles eviduje [provider_profiles.ts](../../apps/api/src/sync/provider_profiles.ts). Tento manifest nenahrazuje live access/role/scope kontrolu a není slibem, že uvedené operace již běží v samostatném hostu.

Google client-assigned event ID a privátní operation marker poskytují scoped recovery identity. Samy ale nedokazují garantovanou provider deduplication: Google výslovně připouští nezachycené kolize při vytvoření v distribuovaném systému ([Events.insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)). Manifest proto uchovává současnou legacy recovery strategii odděleně od portable guarantee; její popis neuděluje univerzální oprávnění opakovat nejistý POST.

`SyncValidator` odděluje exact ETag, changeKey, sequence a resource-must-not-exist. Local host revision není provider validator. Přítomnost ETag, weak ETag, changeKey ani sequence ve čtení sama nedokazuje mutation precondition na jiném endpointu. `endpointProfile` musí odkazovat na konkrétní implementační profil a jeho acceptance; profile string není sám upstream důkaz.

## Read coverage, absence a deletion

`SyncReadScope` váže čtení na provider, connection, collection, source epoch a configuration fingerprint. Fingerprint MUSÍ zahrnovat filtry, family selection, read profile a discovery/access shape, které mění význam úplnosti. Cursor/checkpoint je opaque a MUSÍ být uložený se svým scope; nesmí být použit na jinou connection nebo epoch.

`SyncCoverage` odděluje:

- `incremental`: dávka změn bez tvrzení kompletního inventáře.
- `window`: výslovné inclusive/exclusive instant hranice a paging completeness **tohoto okna**.
- `partial`: explicitní neúplnost kvůli pagination, permissions, filter nebo upstream behavior.
- `collection-inventory-complete`: adapterem ověřený dokončený inventář stejného scope se snapshot ID.

Dokončené paging časového okna zůstává window. Kompletní window nebo inventory nesmí mít continuation. Schema odmítne observation pro jiný provider/connection/collection. Úplnost pochází od důvěryhodného adapteru, nikoli od libovolného klientského JSON.

Observation je `present`, `resource-absent` nebo `deletion-proven`. `resource-absent` s reason window-removal/inventory-absence/access-retired/unknown neposkytuje oprávnění smazat kanonický host objekt nebo rozeslat DELETE do dalších providers. Host může po svých pending-intent/privacy kontrolách změnit coverage/mapping visibility. Ani complete inventory absence sama neuděluje globální deletion authority.

Graph calendarView `@removed` může znamenat přesun mimo okno a NESMÍ se bez dalšího vyhodnotit jako provider tombstone. Microsoft výslovně popisuje i added/updated/deleted události mimo hranice okna jako `@removed` s reason `deleted`: [calendarView delta](https://learn.microsoft.com/en-us/graph/api/event-delta?view=graph-rest-1.0). Deletion evidence musí pocházet z jednoho z explicitních profilů:

- provider tombstone, jehož konkrétní native read profile skutečně dokládá smazání resource;
- přijatý conditional DELETE konkrétní operace;
- scoped native absence po resource read s prokázanou současnou read authority a ověřenou 404/410 sémantikou daného endpointu.

Samostatná 404, chybný locator, odvolaná práva, window delta removal nebo prázdná stránka nejsou deletion proof. `readAuthorityVerified: true` je adapter assertion; host jej může přijmout pouze z důvěryhodného profilu. Deletion proof platí pro danou resource a source epoch. Host nadále rozhoduje, zda je tento source autoritativní pro domácí tombstone/fan-out.

## Source lifecycle a atomické apply

`sourceEpoch` má `sourceId` a monotonní bezpečnou integer `generation`. Nová source instance dostane nové source ID. Retirement, reconnect, access/discovery nebo configuration změna, která zneplatní starý read/write význam, MUSÍ změnit generation nebo source ID. Obsahová editace eventu ji sama nenahrazuje. Musubi bridge může mapovat source link ID a `providerAccessRevision`, pokud skutečně dodrží lifecycle invariant.

HTTP čtení může běžet mimo transakci. Revalidace epoch, configuration a aktuální authority musí proběhnout **uvnitř stejné apply transakce/lifecycle fence** jako observations, checkpoint a případný sweep. Kontrola před otevřením transakce ponechává race.

`applySyncReadBatch` přijme strict batch a zavolá `withSourceTransaction`; uvnitř zavolá `revalidateSource`, teprve pak `applyBatch`. Changed/retired source se vrátí jako `rejected-source` bez apply ani checkpoint acceptance. Host port musí serializovat retirement/config změny, zachovat rollback a nesmí delegovat skutečný commit do pozdější nechráněné callback fáze. Port nemůže vynutit databázové locks; tento požadavek ověřuje host storage integration.

`applyBatch` atomicky reconciliuje observations a checkpoint nebo durable replayable staging. Duplicate observations musí být idempotentní. Neúspěšný apply nesmí posunout checkpoint tak, že po restartu ztratí dávku. Sweep vyžaduje complete inventory stejného scope a nové ověření pending intents, retained deletes a privacy/source retirement. Čtení nebo samotný cursor neposkytují Musubi ani relay authority.

`SyncHostAuthority` nese host ID/object ID, expected local revision, privacy epoch a source scope. Je to vstup pro host kontrolu, nikoli provider write permission token. Adapter nesmí obejít host admission z jiného místa jen proto, že má platný credential.

## Errors a receipts

Error odděluje conflict, permission, unsupported profile, rate limit, transport failure a uncertain dispatch. `retry` je explicitně never/after-delay/after-reconnect/observe-only. Delay patří pouze k after-delay. Obecný `uncertain-dispatch` vyžaduje observe-only; bez idempotency důkazu nesmí runtime zopakovat nejasný write. Prokazatelný provider-idempotency profil má svůj samostatný lifecycle.

`SyncDeliveryReceipt` má čtyři nezávislé evidence:

| Evidence | Co potvrzuje |
| --- | --- |
| `local.committed` | Host přijal revizi a durable intent |
| `provider.accepted` | Provider endpoint přijetí potvrdil |
| `remote.confirmed` | Konkrétní následná observation potvrdila očekávaný stav |
| `notification.provider-reported` | Provider oznámil queued/sent/failed; nikoli doručení nebo přečtení příjemcem |

Local commit neimplikuje provider success. HTTP success neimplikuje remote readback ani pozvánku. Lost reply může zůstat provider uncertain, přestože pozdější readback potvrdí stav; schema NESMÍ vyrobit neexistující endpoint reply. Notification může zůstat unknown. Neadmitted work (`local.not-committed`) nesmí tvrdit downstream effects. Receipt platí pro jednu konkrétní operaci, nikoli atomický úspěch všech calendars.

Receipts nesmějí obsahovat tokeny, raw provider responses ani cizí privátní content. Host určuje přístup a retenci diagnostiky. Údaje o notification delivery se nezpřesňují heuristikou z ATTENDEE nebo stavu události.

## Ověřovací corpus a další integrace

Fixtures obsahují dvě connections se stejným UID/native ID, odlišné host IDs a attempt IDs; přesunutou DATE výjimku; DST fold/gap a floating/legacy význam; jednodenní, leap-day, year-boundary a extended-year date mapper; Graph guarded versus DAV conditional profiles; known denial versus unknown versus unsupported; window/partial/inventory constraints; scoped native deletion proof; epoch/config mismatch při transakčním apply; lost reply a nezávislou notification uncertainty.

Čisté testy prokazují tvar a význam tohoto kontraktu. Neověřují nové provider oprávnění, skutečné endpoint conditional behavior, PostgreSQL lifecycle locks, produkční rollout ani public package release. MUSU-34 použije coverage/deletion boundaries; MUSU-35 uloží profile/serializer versions a neměnnou přijatou projekci. MUSU-36/37 doplní storage-free provider porty a skutečný standalone host důkaz.

Návrhové podklady: [otevřený sync kontrakt](../research/nylas/05-protocol-and-plan.md), [audit Musubi](../research/nylas/04-musubi-audit.md), [roadmap](../planning/sync-refactor-roadmap.md), [Calendar Relay authority](../planning/calendar-relay-context.md).
