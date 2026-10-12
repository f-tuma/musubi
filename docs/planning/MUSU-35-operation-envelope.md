# MUSU-35: versioned operations and immutable admitted plans

**C03 · 12. října 2026 · implementace ve dvou publication slices.**

## Decoder-first floor

První slice přidává [strict kontrakt](../protocol/sync-operation-v1.md) a společný
row-binding decoder. Pouze absence vlastní property `operationEnvelope` dovolí
explicitní legacy-v0. Present malformed/unknown schema/profile/serializer nebo
binding mismatch končí `blocked` před adapter factory i provider GET. Valid v1
má zatím `codec-unavailable` HOLD; encoder, codec registry a backfill zde nejsou.

[Event](../../apps/api/src/sync/event_delivery.ts) a
[task](../../apps/api/src/sync/task_delivery.ts) zachovají lease fencing, celý
accepted payload, IDs, response evidence a předešlou dispatch nejistotu.
Claim sám není důkaz dispatch. Unknown operace přejde z due fronty do HOLD,
takže další podporované operace v dalším batch mohou pokračovat.

Pull odmítne legacy echo fallback před organizer, baseline, onlyReplaceObservation,
DELETE, late unmapped-create i CalDAV family deletion shortcuts. Nejasnou native
observation uloží, ale nepřepíše accepted payload a neprovede ACK. Resolution
context odmítne převést unknown persisted formát do nové legacy operace.

JSONB typing má optional `operationEnvelope?: unknown`; není třeba SQL migration.
Privacy loss/regain nadále zachovává marker i hash celého payloadu. Žádný
historický intent nebyl přepsán či doplněn chybějící admission evidence.

## Lokální důkazy prvního slice

[DB fixture](../../apps/api/src/sync/operation_decoder.integration.test.ts) běží
na disposable PostgreSQL a ověřuje nula adapter factory/provider volání,
schema/profile/serializer/binding refusal, valid-v1 HOLD, task dispatch projection,
expired lease, payload/hash/evidence parity, specializované pull bypassy a skutečný
Google event/task privacy loss→regain. Obě fronty prošly přes 60 unknown operací
k následující legacy operaci. Suite je zapojená do `test:db:operation-decoder`.

Pure schemas/decoder fixtures, API typecheck, původní event/task delivery,
DB event-outbox a 32 Google personal privacy recovery scénářů prošly.
Finální nezávislé review, celý PR CI a main merge se teprve provádějí.

## Druhý slice a provozní hranice

Následný pinned codec a admission encoder musí zachovat projection i skutečný
native write plan při změně serializer A→B před prvním dispatch i po lost reply.
Zápis accepted payloadu a canonical revize musí být atomický. Retry nesmí vytvořit
nové operation ID ani použít aktuální serializer jako fallback.

Encoder zůstane **default OFF** až do ověřeného nasazení kompatibilního decoderu
ve všech skutečných consumers. Merge do main není deployment gate. První floor
je rollback do HOLD; dostupnost doručení vyžaduje přesně registrovaný pinned codec.
Unknown/malformed formáty se automaticky neodblokují a historical payload hash
není oprávnění doplnit do starého intentu nový plán.

MUSU-35 zatím zůstává Started; decoder-only slice nesplňuje immutable-write gate.
Produkční rollout ani live provider mutation neproběhly.
