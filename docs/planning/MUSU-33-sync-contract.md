# MUSU-33: sync profile and capability contract

**C02 · 12. října 2026 · výchozí main `be267b2a960c768c60bd0f91de1106f8878e7999`.**

Implementace zavádí interní normativní profil `sync-profile-v1`. Odděluje host
authority od provider transportu a poskytuje čistá runtime schémata i transakční
apply port. Následující C03 použije tento kontrakt při opravě Graph coverage a
při ukládání neměnných přijatých zápisů.

## Implementační důkazy

| Acceptance | Implementace a fixture |
| --- | --- |
| Scoped identity, UID, host ID, operation/attempt a original slot mají vlastní význam | [Kontrakt](../../packages/types/src/sync_protocol.ts) a [fixture corpus](../../packages/types/src/sync_protocol.test.ts): dvě connections se stejným UID/native ID, přesunutá výjimka, stabilní operation ID při novém attemptu. |
| Zoned, floating, DATE a legacy význam se zachová | Stejný corpus ověřuje DST fold/gap, zachované observed instants a explicitní inclusive Musubi → exclusive DATE mapper včetně přestupného dne a hranic roku. Uložené Musubi události se nemigrují. |
| Capability závisí na operaci, roli, scopes a family | Strict capability schémata rozlišují allowed, denied, unknown a unsupported; [endpoint manifest](../../apps/api/src/sync/provider_profiles.ts) vymezuje konkrétní implementované personal/task profily a jejich důkazní hranice. |
| Coverage není deletion; host vlastní authority a atomické apply | Window/partial/inventory a resource-absent/deletion-proven mají samostatné varianty. Host port provádí source revalidaci uvnitř apply transakce. Receipt odděluje local commit, provider acceptance, readback a notification evidence. |

Normativní požadavky, verze a další integrační gates:
[Sync profile v1](../protocol/sync-profile-v1.md).

## Hranice této změny

Endpoint manifest neuděluje živá oprávnění a nepřepíná stávající dispatch.
Přijetí JSON schématem samo neprokazuje provider CAS, PostgreSQL transakční
locks ani účinek side effectu. Existující specialized meeting/recurrence
transporty mají své dosavadní acceptance; jejich absence v omezeném manifestu
je nevypíná. Portable To Do profil neslibuje conditional UPDATE/DELETE jen na
základě přítomnosti ETag. Google CREATE manifest uchovává legacy exact-ID
recovery samostatně; vlastní ID nepovažuje za garantovanou portable
idempotenci.

MUSU-34 musí ještě zapojit source fence, scope/checkpoint a coverage do skutečné
Graph apply transakce. MUSU-35 musí ještě uložit a doručovat původní
serializer/profile version. C04/C05 teprve prokáží samostatné provider porty a
druhý host bez Musubi DB/auth. Žádný z těchto budoucích výsledků není potvrzen
samotným MUSU-33.

## Ověření a publikace

Lokálně prošlo všech devět testových příkazů sdílených typů (včetně původního
wire kontraktu), všech 80 API unit/fake-provider příkazů včetně osmi nových
manifest fixtures, typecheck všech konzumentů (`pnpm typecheck`), docs build,
route/realtime/release kontroly a `git diff --check`. Čistý profile corpus
ověřuje také fingerprint/epoch změnu a retired source před apply/checkpoint.
Před otevřením PR se vyžaduje nezávislé skeptické schválení finálního diffu.

PR, stav kontrol a squash commit jsou samostatným důkazem publikace v main. Produkční deployment,
upstream live acceptance a veřejné vydání sync package jsou samostatné gates.
