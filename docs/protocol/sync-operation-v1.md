# Sync operation v1: decoder-first HOLD floor

**MUSU-35 · První implementační slice: decoder před encoderem.** Kontrakt je v [sync_operation.ts](../../packages/types/src/sync_operation.ts), fixtures v [sync_operation.test.ts](../../packages/types/src/sync_operation.test.ts). Navazuje na [sync profile v1](./sync-profile-v1.md). Tento slice nepřijímá žádné nové v1 operace, nezavádí admission encoder a neprovádí backfill starých outbox payloadů.

Slova **MUSÍ** a **NESMÍ** označují požadavky na implementátora. Merge tohoto decoderu do main je důkaz publikace zdrojového kódu. Nasazení decoderu do všech workerů a jejich skutečných image digestů je samostatný produkční gate před budoucím encoderem.

## Přítomnost formátu a bezpečný návrat ke starému workeru

Decoder nejprve rozliší vlastní property operationEnvelope:

| Persistovaný payload | Výsledek |
| --- | --- |
| operationEnvelope nemá vlastní property | legacy-v0: současný transport může pokračovat beze změny payloadu |
| Property existuje, ale je undefined/null/malformed | Blocked; nikdy fallback do legacy |
| Unknown schema/profile/serializer | Blocked s konkrétním bezpečným kódem |
| Valid v1, rozpoznaný serializer, shodný outbox binding | **Blocked / codec-unavailable HOLD**; první slice nemá dispatch codec |

Kontrola property používá Object.prototype.hasOwnProperty.call, kompatibilní s nynějším ES2020 buildem. Přítomná undefined property je významově jiná než absence, i když běžný JSONB takovou hodnotu neuloží. Validace nemá unknown formát zahodit, přepsat či znovu vytvořit aktuálním mapperem.

Decoder MUSÍ běžet před provider preflight, GET i write. Blocked stav zachová payload, accepted IDs a nejistotu předchozího dispatch; neprovede provider čtení ani mutaci. Acknowledgement a lease fencing nadále patří storage/runtime hostu.

Absence envelope je explicitní legacy profil, nikoli implicitní nejnovější verze. Tento slice neopravuje dosavadní retry reprojection legacy eventů. Neměnnou admitted projection začne používat až následný explicitně registrovaný pinned codec a admission encoder.

## Význam v1 obálky

| Pole | Význam |
| --- | --- |
| schemaVersion: 1 | Tvar celé obálky |
| profileVersion: sync-profile-v1 | Sémantika identity, času a evidence |
| operation.kind/action/version | Event/task a create/update/delete; verze významu této operace |
| serializer.id/version | Konkrétní provider/family datový formát a jeho verze |
| commandId, operationId | Lidský záměr a stabilní operace; retry nevytváří nové ID |
| hostObjectId | Objekt, pro který host přijal intent |
| locator, predecessorOperationId, sourceEpoch | Exact scoped target; native resource ID je null, pokud dosud není známý, s explicitní predecessor dependency a zachycenou source generací |
| acceptedRevision, privacyEpoch | Zachycená host revize a privacy lifecycle evidence |
| allowedSideEffects | Explicitně content write a případně provider notification |
| admittedProjection.data | Přesně přijatá normalizovaná JSON projekce |
| nativePlan.kind/data | Pinned codec data; není obecná HTTP request obálka |

AttemptId a lease token NESMÍ být součástí immutable obálky: mění se mezi pokusy. Schema je strict a odmítá neznámá pole i duplikující top-level version. Native data nemá další synonymní verzi; jeho formát řídí serializer ID/version. Operation version řídí sémantiku operace, nikoli JSON layout.

Schéma samo nezmrazí JavaScript object ani neposkytne databázovou immutability. Budoucí admission MUSÍ uložit accepted payload a canonical revision atomicky a další retry NESMÍ jeho projection/native plan změnit nebo znovu serializovat jiným serializerem.

## Rozpoznané serializer formáty

Rozpoznané názvy verze 1 jsou google-personal-event, microsoft-personal-event, caldav-personal-event, google-task, microsoft-task a caldav-task. Každý je vázaný na konkrétní provider a event/task family. Jde pouze o **rozpoznání deklarovaného formátu**. Žádný z nich v tomto slice nemá registrovaný dispatch codec a názvy neudělují provider capability.

Unknown ID nebo verze vede na delivery-serializer-unavailable. Rozpoznaný formát pro jiný provider/kind vede na binding mismatch. Valid rozpoznaný v1 vede na operation-envelope-codec-unavailable. Všechny tři výsledky zachovají HOLD a NESMÍ spustit legacy transport.

Následný slice musí dodat explicitní registry selection konkrétního immutable serializer package/profile, crash a upgrade fixtures a operation acceptance. Žádné „použij aktuální mapper“ fallback pravidlo neexistuje.

## Row binding a lifecycle evidence

Decoder porovnává envelope s bounded outbox row bindingem: kind, action, operation ID, command ID, host object ID, provider, connection, collection a accepted revision. Zachycený resource ID se musí shodovat. Update/delete bez něj potřebuje přesně shodný persisted predecessorOperationId; resourceId pak zůstane null. Nevymýšlí se native address ani UID.

CREATE row může mít resource ID null před získáním adresy. Graph event a Google/Graph task mají poctivý null target; planned Google event a DAV address musí budoucí codec samostatně prokázat. Decoder pak ověří pouze již uložená scoped pole; plánovanou native identity ještě nemůže dokázat. Operace přesto zůstane HOLD. Budoucí codec/admission musí samostatně prokázat planned identity a recovery profile.

Source epoch a privacy epoch se porovnávají, pokud je row skutečně zachytila. Integrátor NESMÍ namísto chybějící admission evidence dosadit aktuální connection generation. Generic event rows takový capture dnes nemají; tento decoder-only slice nevymýšlí novou historickou evidence a nepovoluje v1 dispatch.

## Codec JSON a credential hranice

Codec data MUSÍ být bounded, lossless JSON: finite numbers, strings, booleans, null, dense arrays a plain objects. Undefined, functions, Date/toJSON objects, accessors, symbols, cycles, nonfinite values a sparse arrays se odmítají. Limit je 10 000 nodes, hloubka 32 a dva miliony UTF-16 string/key units. Překročení skončí chybou; data se netruncují.

Native plan top-level shape povoluje jen kind: codec-data a data. Nepovoluje HTTP metodu, headers, credential port ani session. Codec data odmítá strukturální authorization/access-token/refresh-token/client-secret/password/credential/cookie/API-key/header fields.

Obecná JSON validace nemůže prokázat, že libovolný string neobsahuje secret. Budoucí serializer MUSÍ používat vlastní allowlist skutečných provider write fields, nesmí kopírovat credential/session/raw response objects a musí mít vlastní fixtures pro redakci. Field-name filtr není náhradou této hranice.

## Existující task dispatch projection

Legacy task payload má separátní dispatchProjection. Její nepřítomnost zachovává současné chování. Přítomná hodnota musí mít version 1, JSON-object projection/patch, explicitní JSON-object-or-null baseline a případně string errorCode.

Přítomná malformed/null/undefined projection nebo unknown verze je blocked před jakýmkoli provider GET. Valid legacy version 1 prochází **původní payload beze změny**; decoder nevybere aktuální projector ani nepřepíše saved baseline. ProviderProjection je preflight diagnostic preview a není totožná s dispatch evidence, takže její samotná verze tento dispatch gate neřídí.

## Compatibility a rollout gate

První PR je decoder-only floor: legacy provoz pokračuje, všechny přítomné future envelopes jsou HOLD. Neexistuje encoder, migrace ani backfill. Tento floor lze použít jako bezpečný rollback worker **až po prokázání jeho nasazení**.

Před zapnutím encoderu musí následný slice doložit: všechny aktivní workers obsahují decoder floor; decoder přežije neznámou novější envelope a zachová uncertain evidence; registry má pinned konkrétní codec; admitted projection/native plan se po restartu a upgrade nemění; source/privacy/local revision se ověřují pod stávající authority fence. Deploy důkazy zůstávají oddělené od merge a lokálních fixtures.
