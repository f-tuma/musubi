# Návrh otevřeného sync kontraktu a implementační plán pro Musubi

**Stav: návrh RFC, nikoli implementované či schválené API. Datum: 12. října 2026.** Všechny nové názvy typů, balíčků, stavů a endpointů níže jsou návrhy. Nemění aktuální kontrakty Musubi. Zjištění z implementace jsou oddělena v [auditu](./04-musubi-audit.md), vendorová fakta v [kalendářové](./02-calendar-normalization.md) a [provozní](./03-sync-auth-operations.md) kapitole.

## 1. Co má otevřený projekt poskytovat

Navrhujeme zveřejnit **sémantický sync kontrakt, provider adaptéry a ověřovací sadu**. Začít jako knihovna používající hostitelský runtime, nikoli jako nový SaaS nebo obecný distribuovaný databázový server. Musubi zůstane první hostitelskou aplikací, ale kontrakt nebude vyžadovat Better Auth, Drizzle, PostgreSQL, UI, domácí session či naši federaci.

Projekt má umět jednotně popsat provider connection, kolekci, objekt, konkrétní pozorování a přijatý zápis. Má vysvětlit, jak po pádu pokračovat, jak vypadá konflikt a proč se zápis odmítá. Nemá slibovat globální exactly-once ani atomický zápis do Google, Outlook a DAV současně. To není funkce, kterou lze přidat názvem operationId.

Do prvního otevřeného profilu zahrnout events a příslušnou infrastrukturu: identity, čas, recurrence family, read coverage, conditional writes, delivery receipts a credential port. Tasks přidat jako samostatný profil se zdokumentovanou home authority. Core ale nesmí být navržen tak, aby task znovu vyžadoval vlastní deadline, lease a retry engine.

Musubi↔Musubi federace je odlišná vrstva. Její origin server drží členství a autoritu; prostý provider mirror by spolupráci ztratil. Otevření externího sync engine nesmí nepřímo nahradit federaci. Toto rozdělení odpovídá [ADR-005](../../adr/ADR-005-federation-gateway.md).

## 2. Čtyři hranice místo jednoho obřího adaptéru

~~~mermaid
flowchart TB
  HOST["Musubi host: ACL, privacy, local CAS, memberships"]
  ADMIT["Atomic admission: canonical revision + immutable intent"]
  RUNTIME["Shared runner: lease, deadline, retry, receipt"]
  OPS["Typed operation registry: prepare / execute / observe"]
  ADAPTER["Google / Graph / DAV adapter"]
  PROVIDER["Provider API"]
  OBS["Observations: provenance + coverage + validators"]
  RECON["Host reconciliation: authority + pending intent"]
  HOST --> ADMIT --> RUNTIME --> OPS --> ADAPTER --> PROVIDER
  PROVIDER --> OBS --> RECON --> HOST
  OPS -->|"uncertain: observation before replay"| OBS
~~~

**Host authority** rozhoduje, zda uživatel smí přijmout lokální změnu. Pod jednou hostitelskou transakcí revaliduje oprávnění, lifecycle, expected local revision, privacy generation a cílové zdroje a uloží neměnný intent. Čistý externí engine nesmí získat oprávnění jen tím, že má credential providera.

**Provider operation** ví, jak číst a zapsat jednu podporovanou provider sémantiku. Nezná naše query helpers ani lidské cookies. Specialized recurrence, RSVP a organizer plány mohou mít různé evidence typy. Registry sjednocuje jejich životní cyklus, nikoli nutně celý payload.

**Shared runtime** řídí konkurenci, checkpoint před dispatch, deadline, renewal, backoff, due scheduling a bezpečné receipts. Neprovádí heuristický merge recurrence ani implicitní opakování pozvánek.

**Reconciliation** rozhoduje, co z observations smí změnit kanonický stav. V první fázi zůstane uvnitř Musubi. Vyjmout ji do obecného jádra teprve tehdy, když bude autorita a privacy kontrakt skutečně abstrahovaný a testovaný. Není nutné přepisovat všechno před prvním zveřejněním.

## 3. Minimální sada identit

| Identita | Význam | Co za ni nezaměňovat |
| --- | --- | --- |
| connectionId | Jedna autorizovaná provider connection v jednom tenant scope | Email; ten se může změnit a nemusí být unikátní |
| collectionId | Lokální stabilní identita provider kolekce | Jméno kalendáře či primary alias |
| canonicalObjectId | Domácí objekt, který aplikace vlastní | Provider event ID nebo iCal UID |
| providerLocator | Provider + connection + kolekce + vzdálený locator | Globální meeting identita |
| familyId | Série/resource family pro reconciliation a write serialization | Právě zobrazený výskyt |
| occurrenceIdentity | Série + původní slot a jeho typ času | Přesunutý start výjimky |
| commandId | Jeden lidský záměr s neměnným obsahem | Network request ID |
| operationId | Jeden durable plán pro jeden cíl a jednu operaci | Nové ID při každém retry |
| attemptId | Jedna konkrétní dispatch/observation snaha | Idempotency identity |
| observationId | Jeden přijatý důkaz | Provider object ID |
| sourceEpoch | Generace přístupu/discovery k cíli | Revize obsahu eventu |

Provider locator je resource address. U DAV může jeden URL resource nést několik VEVENT komponent. Při převodu do lokálních eventů musí family boundary zůstat, protože stejný ETag může chránit všechny komponenty. iCal UID pomáhá korelovat meeting, ale nestačí jako klíč napříč účty nebo pro práva k jeho změně.

Provider IDs ani local IDs neurčují autoritu organizátora. Dvě kopie stejné schůzky v kalendářích účastníků mohou mít stejný UID, ale každá má jinou roli a odlišné osobní reminders. Merge pouze podle UID by tuto hranici porušil.

## 4. Datový model: společná sémantika a provider evidence

Rozlišit alespoň EventDefinition, ConcreteOccurrence, TaskDefinition, BusyInterval, ProviderObservation a WriteIntent. ProviderObservation nemusí být kompletní EventDefinition: může obsahovat redigovaný obsah, tombstone, pouhý locator, family evidence nebo neznámý enum.

### Čas

Zachovat tři explicitní domény: civilní čas s pojmenovanou zónou, floating civilní čas a all-day DATE interval. Neznámá legacy data zůstanou explicitně legacy-unknown; nesmí být automaticky označena UTC jen proto, že databáze uchovává instant. Již existující [event_time.ts](../../../packages/types/src/event_time.ts) je hodnotný základ.

Ve veřejném samostatném profilu zvážit all-day startDate + **endDateExclusive**, protože to zjednodušuje interoperabilitu s providerovými hranicemi. Musubi má dnes inclusive end. Rozhodnutí proto vyžaduje nový verzovaný boundary mapper a testy, nikoli globální změnu uložených dat. Pokud se zvolí inclusive wire profil, musí se to stejně explicitně pojmenovat. Obě varianty jsou možné; nepojmenovaný endDate je zdroj chyb.

Zoned recurrence potřebuje civilní kotvu i zone ID; samotný UTC start nestačí přes DST. V první verzi zachovat aktuální Musubi disambiguation policy a druhý fold instant umět přesně uchovat v observations. Nezavádět plošnou re-resoluci starších eventů. Různé zóny start/end, custom VTIMEZONE a jiné dosud nepřenositelné případy musí být capability nebo odmítnutý write, ne tichá ztráta.

### Recurrence

Přenosový profil má oddělit master, pravidla, inclusions, exclusions a overrides. Pro první vydání mohou být interně zachovány současné RFC řetězce, ale veřejný dokument musí pojmenovat round-trip rozsah. RDATE čtení není automaticky RDATE write support. Unsupported recurring family lze věrně číst a ponechat read-only.

Scope má být přijatý úmysl single / occurrence / series / following. Operace following je plán splitu s vlastními recovery hranicemi, nikoli jedna univerzální provider patch. Původní slot výjimky se při přesunu nemění; cancelled occurrence nesmí být odvozena jen z absence v omezeném okně.

### Provider sidecar

Zachovat unknown provider enums a write-relevant evidence v oddělené obálce. Není nutné ukládat všechen surový email či event JSON navždy. Uchovat přesně to, co potřebuje bezpečná aktualizace, conflict detection a round-trip; určit velikost, redakci, retenční čas a vlastnictví. Provider evidence není veřejný DTO a nesmí obejít privacy projekci.

JSCalendar lze použít jako referenční sémantiku, nikoli jako důkaz plné standardové kompatibility našeho profilu. Mapping a odmítnutí musí být testované. [RFC 8984](https://www.rfc-editor.org/rfc/rfc8984.html)

## 5. Read contract: pozorování, úplnost a cursor

Následuje ilustrační tvar kontraktu; chybí plné runtime schéma a jeho implementace:

~~~ts
type ReadScope = {
  connectionId: string;
  collectionId: string;
  sourceEpoch: string;
  configurationFingerprint: string;
};
type ReadBatch = {
  scope: ReadScope;
  runId: string;
  observations: ProviderObservation[];
  coverage:
    | { kind: "incremental" }
    | { kind: "window"; from: string; until: string }
    | { kind: "collection-inventory-complete"; snapshotId: string };
  continuation?: OpaquePageToken;
  checkpoint?: OpaqueSyncCursor;
};
~~~

Úplnost musí být **ověřena na úrovni adaptéru**, ne klientem deklarována. Vymezuje účty, kolekce, rodiny objektů, filtry a access scope. „Konec stránkování časového okna“ neznamená „úplný inventář kolekce“. Změna konfigurace či práv invaliduje starý význam absence i cursor. Cursor nesmí fungovat proti jiné connection jen proto, že jeho string není prázdný.

Pravidla přijetí:

1. Host pořídí source epoch a scope před čtením; po HTTP je revaliduje pod lifecycle fence ve stejné transakci jako apply/checkpoint či sweep. Samostatná kontrola před transakcí by nechala další závod.
2. Stránky lze durable stageovat. Nový sync checkpoint se přijme až s doménovou reconciliací nebo dostatečně trvalým replayable stagingem.
3. Duplicate observations jsou idempotentní. Po pádu mezi apply a checkpoint může stejný batch přijít znovu.
4. Sweep je povolen pouze nad explicitně complete inventory stejného scope. Pending intents, retained deletes a privacy retirement se revalidují.
5. Token invalidation znamená nové complete čtení; nevynucuje ztrátu lokální intent historie.
6. Časové okno má vlastní coverage. Objekt přesunutý mimo okno ani zestárlý záznam není automaticky deletion.
7. Nedostatečná práva vedou k access retirement/redakci, nikoli k globálnímu smazání schůzky nebo úkolu.

Google, Graph a DAV mají rozdílné upstream tokeny. Normalizovat jejich životní cyklus; samotné stringy uchovat opaque. [Google sync](https://developers.google.com/workspace/calendar/api/guides/sync), [Graph delta](https://learn.microsoft.com/en-us/graph/delta-query-overview), [WebDAV sync](https://www.rfc-editor.org/rfc/rfc6578.html)

Současné Musubi fetchChanges načítá kompletní change set uvnitř adaptéru. První extrakce toto chování může zachovat. Streaming pages je následná optimalizace s memory/staging testy; přidat ji současně s redesignem identity by komplikovalo izolaci regresí.

**Důležitá změna dnešního host profilu:** Graph reset v aktuálním Musubi používá sweep absent mappings přes deleteExternalEvent, což u domácího objektu může vést k tombstone a vytvoření fan-out delete intentů. Není to důkaz skutečně provedeného foreign DELETE; specialized tracked family a known-time writer mají další guards. Nový coverage kontrakt proto není jen jiné jméno DTO. Nejdříve explicitně popsat stávající window-mirror profil; následnou změnu na coverage eviction versus proven deletion dodat jako samostatný slice. Acceptance musí zahrnout sdílený domácí event, klientské tombstones a downstream provider kopie. Zdroje a přesné řádky jsou v [doplňkových nálezech auditu](./04-musubi-audit.md).

## 6. Capability není jeden boolean supportsWrites

Capability posuzovat v kontextu **providera, connection scopes, kolekce, aktuálních práv, event role, family tvaru a konkrétní operace**. Statická matice služby nestačí: Google reader a Google owner nejsou stejný zapisovací cíl.

Kandidát výsledku admission:

~~~ts
type CapabilityDecision =
  | { allowed: true; operationProfile: string; evidenceVersion: string }
  | { allowed: false; reason: CapabilityReason; retryAfterReconnect?: boolean };
type CapabilityReason =
  | "insufficient_scope" | "read_only" | "permission_unknown"
  | "identity_unverified" | "unsupported_time_model"
  | "unsupported_recurrence" | "organizer_required"
  | "conditional_write_unproven" | "unsafe_uncertain_create"
  | "source_retired" | "family_evidence_incomplete";
~~~

Povolení před preflight není rezervace práv na věčnost. Host znovu kontroluje sourceEpoch, local revision a privacy při commit a runtime při dispatch i acknowledgement. Provider může právo odvolat také mezi dvěma HTTP požadavky. Rejection musí vrátit konkrétní bezpečný důvod; interní provider details patří do privilegované diagnostiky.

Provider-side write validator je separátní typ. Exact ETag, Graph changeKey, remote sequence a local revision se nesmějí zaměňovat. Samotný read-before-write bez atomické podmínky nechává race. Conditional update/delete deklarovat pouze tam, kde existuje ověřené chování konkrétního endpointu a operace.

Včetně současného Graph DELETE rozlišit profily **conditional**, **guarded-preflight** a **unsupported**. Musubi u vybraného Graph delete připouští preflight s dokumentovaným závodem; nejde o CAS DELETE. Neznámé oprávnění má vlastní důvod a nesmí být převedeno na falešný důkaz read-only nebo organizer_required.

## 7. Write contract: přijatý úmysl, immutable plán, truthfulness

### Životní cyklus

~~~mermaid
stateDiagram-v2
  [*] --> Admitted: local CAS + durable intent
  Admitted --> Waiting: predecessor or provider budget
  Waiting --> Claimed: renewable lease
  Claimed --> DispatchRecorded: dispatch evidence persisted
  DispatchRecorded --> Observing: timeout / lost reply / expired attempt
  DispatchRecorded --> Confirmed: provider evidence + fenced ACK
  Observing --> Confirmed: equivalent accepted remote state
  Observing --> ProvenNotWritten: sufficient negative evidence
  Observing --> Conflict: incompatible state
  Observing --> Unconfirmed: insufficient evidence
  ProvenNotWritten --> Waiting: replay policy permits
  Claimed --> Blocked: authority or capability lost
~~~

Názvy jsou konceptuální; existující persisted stavy se v první fázi nemění. Diagram neslibuje, že lease dokáže zastavit provider side effect. Worker po ztrátě lease může mít request stále ve vzdáleném systému. Fencing chrání **naše přijetí odpovědi a další dispatch**, nikoli zpětně atomický vzdálený zápis. Proto vypršelý dispatch vstupuje do observation recovery.

Každý accepted plán obsahuje stabilní operationId, cíl, scope, přesně přijatou projekci, expected validators, operation schema version, serializer/profile version a povolené vedlejší účinky. Nikdy ho při retry sestavit z novějšího canonical object ani přepočítat jiným serializerem. Nový lidský edit musí být nová operace s predecessor vztahem.

Toto je cílová záruka, nikoli blanket popis dnešního Musubi. Generic event executor nyní znovu počítá projectEvent a může uloženou providerProjection přepsat; task před první fixací dispatchProjection také používá aktuální serializer, potom její target zachovává. U P3 proto přidat immutable projection admission a test změny serializeru mezi enqueue a restartem. Specialized persisted plány se posuzují samostatně. [Audit implementace](./04-musubi-audit.md)

Admission má dvě fáze: provider preflight může proběhnout mimo DB; jeho důkazy nejsou věčně čerstvé. Host potom v transakci revaliduje lokální práva/revizi/source epoch a uloží plán. Před provider mutation adaptér použije nativní podmínku tam, kde ji daný operation profil prokazatelně podporuje; guarded-preflight profil nese přiznaný závod. Databázový lock neřeší souběžnou změnu provedenou uživatelem přímo v Outlooku.

### Tři různé jistoty

**localCommitted** znamená, že host přijal revizi a úmysl. **providerAccepted** znamená potvrzení providerova endpointu. **remoteStateConfirmed** znamená pozorování odpovídajícího vzdáleného stavu. Samostatně existuje **notificationDelivery**, které často zůstává unknown. HTTP 200 ani přítomný ATTENDEE nedokládají přečtenou pozvánku.

Receipt má tyto rozměry zachovat. Zelený „uloženo“ může být pravdivý pro lokální zápis a nepravdivý pro všechna vzdálená doručení. Návrh UI je mimo tuto studii, ale veřejný protokol musí potřebné informace poskytnout.

### Idempotence

Command ledger zamezí tomu, aby opakovaný klientský request po reconnect vytvořil druhý lokální command. Stejné commandId v témže actor/tenant scope se shodným digest vrací stávající výsledek; odlišný obsah je konflikt. Retenční čas musí přesahovat deklarované retry okno. Provider operationId zůstává stabilní a attemptId se mění.

Provider create recovery musí být explicitně klasifikovaná: client-assigned stable event ID, transaction identity, deterministic resource URL, dohledatelná correlation identity s prokázanou jednoznačností, nebo unsafe uncertain create. U posledního případu se automatický replay zastaví. Absence v omezeném listu nestačí k důkazu, že CREATE neproběhl.

Update/DELETE mají expected provider validator. Stale conflict není totéž jako rate limit. Runtime nesmí automaticky načíst novou verzi a znovu propsat původní plný objekt bez definovaného merge a nového admission. Content patch může být užší než full snapshot a omezovat změněná pole; časová tuple, recurrence family a účastnické role potřebují vlastní přísnější pravidla.

### Pozvánky a side effects

V transportu oddělit storage mutation od scheduling/invitation action, pokud provider takové primitive nabízí. Ztracená odpověď po RSVP nebo organizer update vyžaduje read-only recovery, která neodesílá další pozvánku. Když neexistuje důkaz o odeslání notification, receipt uvede unknown. Obecná retry-on-5xx politika bez jistoty side effect je nepřípustná.

Multi-step following split není transakce mezi dvěma resource writes. Plán musí mít checkpointy, stabilní identity, potvrzené částečné výsledky a obnovu. Automatické kompenzační DELETE může být další nevratný scheduling side effect; nelze ho univerzálně vydávat za rollback.

## 8. Loop prevention a konflikty

Detekovat echo pomocí accepted projection baseline pro konkrétní provider cíl a verzi mappingu. Projection obsahuje pouze pole, která daný provider věrně reprezentuje. Provider defaults a osobní settings nepovažovat za nový canonical edit. Hash může porovnání urychlit, ale nikdy nenahrazuje identity, rights či read evidence.

Pokud domovský task obsahuje priority a secondary provider priority neumí, prázdná priority v echo pullu nic nevymazává. Pokud účastník schůzky změní vlastní reminders, nejde o organizer update celé schůzky. Pokud Microsoft převádí HTML description, porovnávat po explicitně definované normalizaci; neprovádět nekontrolovanou „čistící“ transformaci napříč všemi provider payloady.

Default policy je visible conflict. Třícestný merge lze později povolit pro nezávislá textová pole při úplné baseline a explicitním accepted patch. **Neprovádět obecný merge času, recurrence, organizer/attendee role ani deletion.** Je lepší mít málo dobře popsaných merge pravidel než generický deep merge JSON.

Task profile zachová home source authority. Secondary pull potvrzuje projekci; nezískává právo změnit completion nebo globálně smazat task. Independent copy má nové canonical ID a vlastní home. Tato sémantika patří do profilu, nikoli do generického provider transportu.

## 9. Runtime, webhook a scheduling

### Společný runner

Sjednotit deadline, AbortSignal, lease renewal, Retry-After parsing, exponential backoff s jitter, cancellation a attempt certainty pro event a task delivery. Keep operation handlers specialized. Rozlišit timeout observation a timeout mutation. Deadline renew nesmí dovolit neomezeně viset na providerovi. Operace čekající na limit nesmí držet DB transaction ani globální account lock.

Současný audit našel různé event/task politiky a společný vypínač background recovery a polling. [Konkrétní zdroje a řádky](./04-musubi-audit.md)

Konfigurace má oddělit pull cadence, recovery enabled a optional push triggers. Změna poll interval na 0 může zastavit plánované čtení, ale nesmí bez výslovně pojmenovaného režimu vypnout obnovu již přijatých durable zápisů. Migrovat s release note a kompatibilním defaultem; nepřepsat env význam potichu.

### Work partitions a budgets

Natural partition = connection + collection + stream. Collision key = vzdálená resource family nebo command predecessor chain. Bounded concurrency mezi různými účty, serializace uvnitř kolizní domény. Rate budget nejméně provider/application, tenant a account. Rozlišit uživatelské zápisy, initial import, normal incremental pull a recovery. Recovery nejistého zápisu má větší prioritu než speculative refresh, ale jeden pokažený účet nesmí hladovět ostatní.

Account-scoped session/discovery context lze cacheovat jen s epoch a expirací. CalDAV principal/home discovery neprovádět pro každou drobnou metodu; přitom necacheovat authorization tak, aby odvolání práv zmizelo až za několik dní. OAuth refresh single-flight zamezí paralelnímu použití a přepisování rotovaných tokenů.

### Webhook inbox

Ověřit provider podpis/challenge, bezpečně určit connection, zapsat durable oznámení a teprve pak ACK. Worker oznámení sloučí a probudí běžný pull. Dedup notification identity nesmí být object identity; dvě různé změny eventu mají být zpracovatelné. U invalidation notifications lze coalescing provést na work položce kolekce, nikoli ztratit nejnovější dirty generation.

Push subscriptions musí mít expiry, renew schedule, cursor/dirty watermark, degraded state a unsubscribe při disconnect. Challenge ani raw token nelogovat. Veřejně nedostupný self-host pokračuje pollingem. DAV push je optional capability pro kompatibilní server; neplatí absolutní předpoklad, že DAV nikdy nemá push.

Periodický reconciliation zůstává i u zdravého webhooku. Nylas a další služby mohou mít bounded retries, chybějící replay nebo nevydávat všechny změny; podrobně viz [provozní studii](./03-sync-auth-operations.md) a [alternativy](./06-alternative-architectures.md).

## 10. Balíčky a storage porty

Navržené logické hranice:

| Modul | Obsah | Zakázaná závislost |
| --- | --- | --- |
| sync-model | Runtime schemas, identities, time, observations, errors, receipts | DB, auth session, UI |
| sync-operations | Typed operation registry a planner interfaces | Konkrétní SQL tables |
| sync-runtime | Scheduling/lease/retry životní cyklus přes porty | Provider JSON mapping |
| provider-google | Google čtení, projekce, admission evidence, transport | Musubi memberships |
| provider-microsoft | Graph family a operation handlers | Better Auth queries |
| provider-dav | DAV discovery/resource/validator/scheduling profiles | App routes |
| musubi-sync-host | Stávající Drizzle storage, ACL, canonical authority a SSE | Veřejný SDK runtime jako globální singleton |
| sync-conformance | Fiktivní čas/síť, fixtures, crash traces, compatibility vectors | Produkční credentials |

První krok nemusí fyzicky vytvořit osm packages. Logické dependency rules a proof-of-extraction s CLI hostem jsou důležitější než názvy. Sdílený registry zůstane discriminated union; žádný execute(kind: string, payload: any) veřejný kontrakt.

Storage port potřebuje atomickou admission s host daty, claim s lease generation, renewal, conditional ACK, append evidence, due listing a retained retirement/deletion identities. Nemá to být univerzální ORM. Když host neumí atomicky uložit local revision a outbox intent, nesmí deklarovat stejný durability profile. Memory storage je testovací profil; nepoužívat ho jako production guarantee.

CredentialsPort vrací short-lived provider session pro konkrétní connection bez zveřejnění refresh tokenu spotřebiteli. Secret šifrování/key management je implementace hosta; API key v browseru nemá být základ knihovny. HttpPort dovoluje AbortSignal, response headers, request budget a redacted tracing. ClockPort a random/jitter port zajistí deterministické failure testy.

## 11. Pořadí implementace a reviewable výsledky

Odhady jsou plánovací intervaly v **člověkodnech zkušeného vývojáře**, ne slib kalendářního data. Počítají s existující implementací, test DB a přístupem k testovacím účtům; dostupnost provider approval může prodloužit průběh. První užitečná etapa má být malá a nasaditelná sama.

| Etapa | Výsledek | Orientační úsilí | Podmínka dokončení |
| --- | --- | --- | --- |
| P0: runtime hardening | Společné deadline/retry policy a oddělené recovery config | 4–8 dní | Task/event cancellation, throttle a restart scénáře; žádný změněný operation payload |
| P1: normativní profil | RFC identity/coverage/receipt + mapping matrix + fixtures | 5–9 dní | Explicitní scope a current capability profile; review implementátorů všech tří providerů |
| P2: storage-free porty | Model, credential/HTTP port a jeden extrahovaný adaptér slice | 8–15 dní | CLI/test host bez @musubi/db; Musubi parity testy |
| P3: operation registry | Jeden společný runner, zachované staré decoders | 10–18 dní | Starý persisted intent se po upgrade/rollback bezpečně načte; crash recovery parity |
| P4: fair scheduler | Per-collection work a per-account budgets, session context | 5–10 dní | Pomalý účet neblokuje ostatní; pořád singleton deployment boundary |
| P5: optional push | Google/Graph subscriptions a durable inbox; polling fallback | 7–14 dní | Lost/duplicate/reordered webhook scénáře, renew/expiry/disconnect |
| P6: open-source alpha | Samostatný package/reference host, conformance a release docs | 6–12 dní | Čistý install bez Musubi secrets, deklarovaná licence, verze a support policy |

Celkem tato varianta činí přibližně **45–86 člověkodnů**. Část práce lze paralelizovat, P3 ale závisí na ověřených hranicích P1/P2. Nezahrnuje nový scheduler produkt, úplné contacts/email API, plošnou migraci all-day modelu ani horizontální škálování.

### Konkrétní backlog

| ID | Priorita | Úkol | Místo zásahu / deliverable | Klíčový důkaz |
| --- | --- | --- | --- | --- |
| R01 | P0 | Sdílený deadline a AbortSignal pro task delivery | task_delivery + shared runner policy | Visící request ukončí pokus; certainty zůstane unknown po dispatch |
| R02 | P0 | Retry-After ve task errors a backoff | task_write + delivery policy | 429 respektuje header; renewal není nekonečné čekání |
| R03 | P0 | Recovery toggle oddělit od pull interval | API startup scheduler + config docs | Poll=0 zachová předem přijaté recovery v deklarovaném režimu |
| R04 | P0 | Odměřit actual provider calls a due lag | observability | Žádné PII labels; oddělený read/write/recovery budget |
| R05 | P1 | Napsat profile identity/time/recurrence | RFC + schemas | Původní slot a moved time mají odlišné keys |
| R06 | P1 | Coverage/source epoch obálka a deklarace stávajícího window profilu | adapter + read host | Následná změna sweep→eviction má vlastní shared-event/tombstone/fan-out acceptance |
| R07 | P1 | Current operation capability matrix | registry docs + fixtures | Read support nezapne write |
| R08 | P2 | CredentialsPort a AccountSession | google/microsoft/caldav entrypoints | Refresh race a revoked account nemohou oživit credential |
| R09 | P2 | HttpPort + exact validator evidence | transport modules | changeKey není syntetický ETag |
| R10 | P2 | Extrakční proof jedné operace | standalone test/CLI host | Import graph bez @musubi/db, žádná app session |
| R11 | P3 | Versioned operation envelope + serializer/profile version | new encoder + old decoder | Restart po změně serializeru použije původní admitted projection |
| R12 | P3 | Registry handlers připrav/dispatch/pozoruj | event/task delivery | No-resend scheduling invariants zachovány |
| R13 | P3 | Shared lease/ACK lifecycle | durable storage port | Stale worker nemůže ACKnout novou lease generation |
| R14 | P4 | Collection dirty work queue | scheduler | Coalescing neztratí novou dirty generation |
| R15 | P4 | Per-provider/account budget | scheduler + HttpPort | Jeden throttled účet nevyhladoví ostatní |
| R16 | P4 | CalDAV session/discovery cache | DAV adapter | Menší call count při stejném access retirement chování |
| R17 | P5 | Google watch/Graph notification profiles | connector subscriptions | Expiry/renew má durable stav a fallback |
| R18 | P5 | Durable inbox a invalidation queue | webhook ingress | Pád před ACK nepřijde o zapsané oznámení; žádný ACK před commit |
| R19 | P6 | Open-source conformance harness | fixtures + emulator host | Výsledky běží bez cloud secrets a jsou reprodukovatelné |
| R20 | P6 | Licence, provenance a compatibility policy | LICENSE/NOTICE/release docs | Každá externí komponenta má konkrétní původ; žádná kopie proprietary internals |

Záměrně neplánujeme hned jednu migraci všech tabulek. Registry může používat současné typed evidence a host query helpers za storage portem. Teprve prokázaná duplikace datového modelu opravňuje další schema change.

## 12. Migrace, rollout a rollback

Zavést operation schema version do nových intentů; stávající intent deserializovat beze změny payloadu. Přepnout konkrétní operation family na nový runner feature flagem. Shadow mode smí počítat plán a porovnávat rozhodnutí, ale **nesmí odeslat druhý provider write**. Jedna durable operation má vždy jednoho aktivního dispatch ownera.

Nejprve personal single content update, potom conditional delete na prokázaných endpointech a create recovery, teprve potom series/organizer/RSVP. Graph guarded-preflight delete zůstane explicitně jiný profil. Tasks lze převést společným runtime vedle nich, ale authority policy zůstává hostitelská. Každý slice potřebuje staré pending payload fixtures, source retirement race, uncertain dispatch a stale ACK scénář.

Rollback neznamená smazat nejisté operation evidence. Starší binary musí nové envelope buď bezpečně odmítnout a ponechat pending, nebo být před rolloutem vybaven forward-compatible decoderem. Release migrace, která vytváří nové operation shapes, musí tento kontrakt zveřejnit. Omezit rollout počtem účtů a operací, ne deklarovat bezpečnost jen podle buildu.

Použít dvoufázový release: nejprve vydat decoder/router s explicitním odmítnutím neznámé operation version; až potom nový encoder. Rollback povolit jen na takto kompatibilní build. Současný runner může neznámé pole vedle payload.event ignorovat a jít generic větví, takže pouhé additive JSON pole bezpečnost nezajistí. Test neznámé verze musí potvrdit nulový HTTP mutation a současně průchod due fronty pro ostatní podporované operace.

Po prvním zveřejnění zachovat kompatibilitu schemas a receipt významů. Neznámý state nesmí být klientem zobrazen jako success. Capability additions jsou additive; změna významu all-day end nebo uncertainty je breaking změna i při stejném TypeScript field name.

## 13. Conformance a failure experimenty

Následuje plán skutečných testů pro implementaci; při této studii nebyly provedeny live provider experiments:

| Oblast | Scénář | Očekávaný invariant |
| --- | --- | --- |
| Čas | Prague/New York DST gap/fold; title-only edit | Původní časový model a instants se nezmění nechtěným roundtrip |
| All-day | Jednodenní i vícedenní DATE, různé host zones | Přesně jedna převodní hranice inclusive/exclusive |
| Identity | Shodný UID/event ID ve dvou účtech | Oddělené locators a rights |
| Recurrence | Master + moved override mimo okno | Původní slot zůstane, žádná duplicitní occurrence |
| Recurrence | RDATE/EXDATE a unsupported custom zone | Faithful read nebo explicitní write rejection |
| Reset | Google token 410 uprostřed pending write | Žádná ztráta admitted intent ani neautorizovaný sweep |
| Pagination | Pád po page apply před checkpoint | Replay je idempotentní, žádná ztráta změny |
| Completeness | Chyba poslední stránky | Žádný missing-object sweep |
| Privacy | Downgrade práv během provider HTTP | Redakce/retirement přebije pozdní observation |
| Update | Přímá remote změna mezi read a write | Conditional conflict, žádný blind refetch-and-overwrite |
| Create | Timeout po provider commit před reply | Observation recovery; stabilní ID; žádný blind create |
| Delete | Lease loss po dispatch | Než další dispatch, vyřešit nejistotu |
| RSVP | Reply lost after invitation side effect | Read-only recovery neodesílá druhou zprávu |
| Ordering | Dva lokální edits stejné family | Unresolved predecessor zablokuje pozdější overwrite |
| Tasks | Secondary lossy echo a secondary delete | Home authority a bohatší canonical data přežijí |
| Webhook | Duplicate, reorder, loss, expiry | Durable trigger + periodic pull obnoví současný state |
| Credentials | Dva refresh requests, odpojení mezi nimi | Jedna refresh generation; žádné resurrection |
| Rate limit | 429, Retry-After, jedna pomalá connection | Fairness ostatních účtů a truthful pending receipt |
| Upgrade | Old persisted operation na novém runneru | Původní projection a uncertainty se nezmění |
| Upgrade | Serializer změněný po enqueue; neznámý envelope | Původní projekce se zachová; neznámá verze neprovede mutation |
| UI boundary | Cizí účet / retired title v receipt | Sanitized response, žádný secret ani starý privátní obsah |

Testy mají tři úrovně. Deterministické model/transport testy běží při každém PR; PostgreSQL integrace ověřují locks, leases a rollback; live provider suite je opt-in proti izolovaným test kalendářům a zjišťuje skutečnou notification a conditional-write sémantiku. Fixtures nesmí obsahovat osobní schůzky, tokeny ani skutečné adresy účastníků.

Před alpha release projít reference host instalaci z čistého checkoutu a zveřejnit výslednou podporovanou matici. Passing unit test není provider certification. Zvlášť u DAV uvést konkrétní servery a verze místo obecného „CalDAV vše funguje“.

## 14. Výkonnost a provozní kritéria

Nejprve vytvořit baseline: provider HTTP calls na unchanged pull; initial import peak memory; p50/p95 od oznámení k accepted read; due-lag outboxu; recovery observation calls; počet duplicitních dispatch pokusů; source-retirement latence. Nefabulovat cílovou propustnost bez měření.

Ilustrační kapacitní výpočet: N účtů × C kolekcí × R requestů na unchanged pull × 60/I minut = hodinové requesty. Při N=1000, C=5, R=1, I=5 jde o **60 000 requestů/hodinu**, bez discovery, stránkování a retry. To je aritmetický scénář, nikoli naměřený Musubi load. Adaptive scheduling a push coalescing mají přímou hodnotu; nesmějí obětovat pravidelnou kontrolu úplnosti.

P0/P4 acceptance pro call count vyjádřit relativně k předem změřené baseline a rozdělit podle providera. Target memory pro velký import stanovit podle data fixture a pak rozhodnout o page staging. Bez důkazu bottlenecku nezačínat horizontal sharding; současný singleton DB/process boundary zůstává až do vyřešení shared pub/sub, rate limit a ownership.

Metriky labelovat providerem a operation family, nikoli emailem, event title či neomezenou object ID kardinalitou. High-cardinality identities držet v omezeném redacted trace/receipt storage. Retence evidence je součást privacy kontraktu; disconnected owner má být odpojitelný bez smazání důkazů cizích přeživších cílů.

## 15. Otevření projektu a rozhodnutí, která zbývají

Před veřejnou v0.1 rozhodnout: název a scope projektu, licence našeho původního kódu, profil all-day hranic, runtime requirements, minimální providers/operations, compatibility policy, vulnerability reporting a maintenance commitment. Toto jsou následná lidská rozhodnutí, nikoli záminka blokovat technickou extrakci.

Inspiraci převádět do vlastních kontraktů a test vectors. Každý převzatý kus kódu musí mít zdrojovou verzi a licenční provenienci. Historický Nylas sync-engine, SDK, Nango a další repozitáře mají odlišné licenční deklarace; tento dokument není právní posudek. Nezveřejňovat fixtures ze skutečných uživatelských provider účtů.

**Doporučený první implementační balík:** R01–R04, návrh R05–R07 a proof R10. To přináší měřitelnou provozní hodnotu, ověří extrakční hranici a připraví reviewable RFC. Hromadný přepis kompletní synchronizace by přidal migrační riziko bez nutné výhody. Další kroky řídit konkrétními parity výsledky, ne věrností architektuře některého dodavatele.
