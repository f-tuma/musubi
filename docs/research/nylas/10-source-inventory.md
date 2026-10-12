# Zdroje, inventář a pokrytí výzkumu

**Ověřeno 12. října 2026.** Tento registr dovoluje odlišit veřejný inventář od obsahově použitého zdroje. Nejde o prohlášení, že byl přečten každý endpoint, proveden živý test nebo rekonstruován proprietary backend.

Veřejný sitemap obsahoval **1203 URL**. Kapitoly 01–09 citují **131 přímých externích URL**; některé jsou aliasy, verze nebo různé soubory téhož projektu. **58 sitemap URL** má po odstranění query a koncového lomítka odpovídající citaci v kapitole. Zbylé položky jsou pouze inventarizované. Citace mimo sitemap zahrnují blog/support, SDK, zdrojový kód, ostatní služby a standardy.

## Reprodukovatelné artefakty

- [Úplný zdrojový manifest](./references/source-manifest.json): všechny sitemap adresy, stav inventoried_only nebo referenced_in_study a odkazy na kapitoly.
- [Původní veřejný sitemap](./references/nylas-sitemap-2026-10-12.xml): uložený XML snapshot; neobsahuje přihlašovací údaje ani texty stránek.
- [Kontrola dostupnosti citací](./references/link-check-2026-10-12.json): všech 131 veřejných URL při omezené HEAD kontrole vrátilo HTTP 200. Potvrzuje dostupnost stránky, nikoli pravdivost jejího obsahu nebo live API kompatibilitu.
- SHA-256 sitemap snapshotu: **8ef66e009f2af158a10c75e3d76e5174cdf46bbab86a47f771f8c964d2f99147**.
- Aktuální provozní dokumentace se může měnit bez verzovaného URL. U opakování studie znovu ověřit normativní stránky a datum jejich změny.

## Rozdělení veřejného inventáře

| Sekce | Počet URL | Jak byla využita |
| --- | ---: | --- |
| docs/reference | 380 | Relevantní kalendářové, auth a webhook endpointy; ostatní inventory. |
| docs/cookbook | 287 | Cílené sync, kalendářové a provozní recepty; kritické statické čtení ukázek. |
| docs/new | 211 | Relevantní v2/v3 změny; jiné migrační detaily jen inventory. |
| docs/v3 | 155 | Kalendáře, auth, notifikace, SDK a přenositelné email/contacts/scheduler modely. |
| docs/changelogs | 88 | Cílené změny aktuálního kontraktu; žádné tvrzení o přečtení všech release notes. |
| docs/dev-guide | 35 | Relevantní platform, metadata, privacy, errors, rate limits a best practices. |
| docs/provider-guides | 24 | Google, Microsoft, iCloud a související scopes/protocols. |
| docs/api | 11 | Chybové kontrakty. |
| docs/support | 11 | Relevantní troubleshooting odkazy, jinak inventory. |
| root | 1 | Vstupní dokumentace. |

## Co studie nepovažuje za ověřené

- Živou latenci, availability SLA, quota throughput či provider notification delivery.
- Neveřejné fronty, dedup retenci, transakce a merge algoritmy Nylas.
- Produkční aktivaci všech implementovaných Musubi slices.
- Úplný source audit všech jazykových SDK, Notetaker, AI Agent Accounts nebo každého UI komponentu.
- Právní kompatibilitu licencí. Deklarace konkrétních zdrojů jsou inventář, nikoli právní posudek.

## Statické snapshoty

| Projekt | Verze / commit | Použití |
| --- | --- | --- |
| Musubi | 99e613f4d43336131b844b62c3d0c06635ff5964 | Reprezentativní kódové toky a sedm čistých kontrol |
| Nylas Node SDK | 8.4.0 / fabe2d679baf20f45f941a7148544acb2434aafa | APIClient, resources, modely, casing, pagination, errors |
| Nylas historický sync-engine | 50698996aef73102ead592e8d0948c1d2edfe123 | Event sync, action log, syncback, downstream delta |
| DAVx⁵ | 0fc9500076c71f97eb1905e84106441df0a7c5da | Resource upload/delete a sync-manager policy |

SDK main archiv byl porovnán s archivem připnutého commitu a obsah byl shodný. Do repozitáře nebyl převzat žádný kód třetí strany. Cizí zdroje byly použity k výzkumu; studijní návrhy a testovací scénáře jsou původní.

## Přímé citace po kapitolách

Odkaz u konkrétního tvrzení v kapitole je hlavní atribuce. Tento seznam je navigační pomůcka. referenced_in_study v manifestu označuje citování a použití podkladu; neurčuje hloubku čtení ani certifikaci správnosti celé služby.

| ID | Primární zdroj | Kapitoly |
| --- | --- | --- |
| S001 | [developer.nylas.com/docs/api/errors/](https://developer.nylas.com/docs/api/errors/) | [03](./03-sync-auth-operations.md) |
| S002 | [developer.nylas.com/docs/api/errors/500-response/](https://developer.nylas.com/docs/api/errors/500-response/) | [02](./02-calendar-normalization.md) |
| S003 | [developer.nylas.com/docs/api/errors/event-codes/](https://developer.nylas.com/docs/api/errors/event-codes/) | [02](./02-calendar-normalization.md) |
| S004 | [developer.nylas.com/docs/changelogs/2026-08-31-scheduler-and-ews-fixes/](https://developer.nylas.com/docs/changelogs/2026-08-31-scheduler-and-ews-fixes/) | [02](./02-calendar-normalization.md) |
| S005 | [developer.nylas.com/docs/cookbook/calendar/caldav-vs-calendar-api/](https://developer.nylas.com/docs/cookbook/calendar/caldav-vs-calendar-api/) | [02](./02-calendar-normalization.md) |
| S006 | [developer.nylas.com/docs/cookbook/calendar/create-recurring-events/](https://developer.nylas.com/docs/cookbook/calendar/create-recurring-events/) | [02](./02-calendar-normalization.md) |
| S007 | [developer.nylas.com/docs/cookbook/calendar/cross-provider-calendar-sync/](https://developer.nylas.com/docs/cookbook/calendar/cross-provider-calendar-sync/) | [01](./01-findings-and-decisions.md), [02](./02-calendar-normalization.md) |
| S008 | [developer.nylas.com/docs/cookbook/calendar/events/create-events-icloud/](https://developer.nylas.com/docs/cookbook/calendar/events/create-events-icloud/) | [02](./02-calendar-normalization.md) |
| S009 | [developer.nylas.com/docs/cookbook/calendar/events/list-events-ews/](https://developer.nylas.com/docs/cookbook/calendar/events/list-events-ews/) | [02](./02-calendar-normalization.md) |
| S010 | [developer.nylas.com/docs/cookbook/calendar/events/list-events-icloud/](https://developer.nylas.com/docs/cookbook/calendar/events/list-events-icloud/) | [02](./02-calendar-normalization.md) |
| S011 | [developer.nylas.com/docs/cookbook/email/backfill-historical-email/](https://developer.nylas.com/docs/cookbook/email/backfill-historical-email/) | [03](./03-sync-auth-operations.md) |
| S012 | [developer.nylas.com/docs/cookbook/email/messages/list-messages-imap/](https://developer.nylas.com/docs/cookbook/email/messages/list-messages-imap/) | [02](./02-calendar-normalization.md), [03](./03-sync-auth-operations.md) |
| S013 | [developer.nylas.com/docs/cookbook/email/scale-email-sync/](https://developer.nylas.com/docs/cookbook/email/scale-email-sync/) | [03](./03-sync-auth-operations.md) |
| S014 | [developer.nylas.com/docs/cookbook/email/threads/gmail-vs-outlook-threading/](https://developer.nylas.com/docs/cookbook/email/threads/gmail-vs-outlook-threading/) | [09](./09-sdk-and-adjacent-models.md) |
| S015 | [developer.nylas.com/docs/cookbook/email/threads/list-threads-imap/](https://developer.nylas.com/docs/cookbook/email/threads/list-threads-imap/) | [09](./09-sdk-and-adjacent-models.md) |
| S016 | [developer.nylas.com/docs/cookbook/scheduler/round-robin-scheduling/](https://developer.nylas.com/docs/cookbook/scheduler/round-robin-scheduling/) | [09](./09-sdk-and-adjacent-models.md) |
| S017 | [developer.nylas.com/docs/cookbook/use-cases/act/schedule-event-reminders/](https://developer.nylas.com/docs/cookbook/use-cases/act/schedule-event-reminders/) | [02](./02-calendar-normalization.md) |
| S018 | [developer.nylas.com/docs/cookbook/use-cases/build/custom-oauth-connector/](https://developer.nylas.com/docs/cookbook/use-cases/build/custom-oauth-connector/) | [03](./03-sync-auth-operations.md) |
| S019 | [developer.nylas.com/docs/cookbook/use-cases/build/handle-duplicate-webhooks/](https://developer.nylas.com/docs/cookbook/use-cases/build/handle-duplicate-webhooks/) | [03](./03-sync-auth-operations.md) |
| S020 | [developer.nylas.com/docs/cookbook/use-cases/build/retry-failed-webhooks/](https://developer.nylas.com/docs/cookbook/use-cases/build/retry-failed-webhooks/) | [03](./03-sync-auth-operations.md) |
| S021 | [developer.nylas.com/docs/cookbook/use-cases/build/verify-webhook-signatures/](https://developer.nylas.com/docs/cookbook/use-cases/build/verify-webhook-signatures/) | [03](./03-sync-auth-operations.md) |
| S022 | [developer.nylas.com/docs/cookbook/use-cases/sync/two-way-calendar-sync/](https://developer.nylas.com/docs/cookbook/use-cases/sync/two-way-calendar-sync/) | [02](./02-calendar-normalization.md) |
| S023 | [developer.nylas.com/docs/dev-guide/best-practices/error-handling/](https://developer.nylas.com/docs/dev-guide/best-practices/error-handling/) | [03](./03-sync-auth-operations.md) |
| S024 | [developer.nylas.com/docs/dev-guide/best-practices/grant-lifecycle/](https://developer.nylas.com/docs/dev-guide/best-practices/grant-lifecycle/) | [03](./03-sync-auth-operations.md) |
| S025 | [developer.nylas.com/docs/dev-guide/best-practices/webhook-best-practices/](https://developer.nylas.com/docs/dev-guide/best-practices/webhook-best-practices/) | [03](./03-sync-auth-operations.md) |
| S026 | [developer.nylas.com/docs/dev-guide/metadata/](https://developer.nylas.com/docs/dev-guide/metadata/) | [09](./09-sdk-and-adjacent-models.md) |
| S027 | [developer.nylas.com/docs/dev-guide/platform/data-residency/](https://developer.nylas.com/docs/dev-guide/platform/data-residency/) | [03](./03-sync-auth-operations.md) |
| S028 | [developer.nylas.com/docs/dev-guide/platform/privacy-mode/](https://developer.nylas.com/docs/dev-guide/platform/privacy-mode/) | [03](./03-sync-auth-operations.md) |
| S029 | [developer.nylas.com/docs/dev-guide/platform/rate-limits/](https://developer.nylas.com/docs/dev-guide/platform/rate-limits/) | [03](./03-sync-auth-operations.md) |
| S030 | [developer.nylas.com/docs/provider-guides/icloud/](https://developer.nylas.com/docs/provider-guides/icloud/?redirect=reorg) | [02](./02-calendar-normalization.md) |
| S031 | [developer.nylas.com/docs/reference/api/configurations/post-configurations/](https://developer.nylas.com/docs/reference/api/configurations/post-configurations/) | [09](./09-sdk-and-adjacent-models.md) |
| S032 | [developer.nylas.com/docs/reference/api/events/](https://developer.nylas.com/docs/reference/api/events/) | [02](./02-calendar-normalization.md) |
| S033 | [developer.nylas.com/docs/reference/api/events/get-all-events/](https://developer.nylas.com/docs/reference/api/events/get-all-events/) | [01](./01-findings-and-decisions.md), [02](./02-calendar-normalization.md) |
| S034 | [developer.nylas.com/docs/reference/api/events/get-events-id/](https://developer.nylas.com/docs/reference/api/events/get-events-id/) | [02](./02-calendar-normalization.md) |
| S035 | [developer.nylas.com/docs/reference/api/events/import-events/](https://developer.nylas.com/docs/reference/api/events/import-events/) | [02](./02-calendar-normalization.md) |
| S036 | [developer.nylas.com/docs/reference/api/events/put-events-id/](https://developer.nylas.com/docs/reference/api/events/put-events-id/) | [02](./02-calendar-normalization.md) |
| S037 | [developer.nylas.com/docs/reference/api/events/send-rsvp/](https://developer.nylas.com/docs/reference/api/events/send-rsvp/) | [02](./02-calendar-normalization.md) |
| S038 | [developer.nylas.com/docs/reference/api/manage-grants/](https://developer.nylas.com/docs/reference/api/manage-grants/) | [03](./03-sync-auth-operations.md) |
| S039 | [developer.nylas.com/docs/reference/api/webhook-notifications/](https://developer.nylas.com/docs/reference/api/webhook-notifications/) | [03](./03-sync-auth-operations.md) |
| S040 | [developer.nylas.com/docs/reference/api/webhook-notifications/post-webhook-destinations/](https://developer.nylas.com/docs/reference/api/webhook-notifications/post-webhook-destinations/) | [03](./03-sync-auth-operations.md) |
| S041 | [developer.nylas.com/docs/reference/notifications/events/event-updated/](https://developer.nylas.com/docs/reference/notifications/events/event-updated/) | [02](./02-calendar-normalization.md) |
| S042 | [developer.nylas.com/docs/v3/auth/](https://developer.nylas.com/docs/v3/auth/) | [03](./03-sync-auth-operations.md) |
| S043 | [developer.nylas.com/docs/v3/auth/bring-your-own-authentication/](https://developer.nylas.com/docs/v3/auth/bring-your-own-authentication/) | [03](./03-sync-auth-operations.md) |
| S044 | [developer.nylas.com/docs/v3/auth/hosted-oauth-accesstoken/](https://developer.nylas.com/docs/v3/auth/hosted-oauth-accesstoken/) | [03](./03-sync-auth-operations.md) |
| S045 | [developer.nylas.com/docs/v3/auth/hosted-oauth-apikey/](https://developer.nylas.com/docs/v3/auth/hosted-oauth-apikey/) | [03](./03-sync-auth-operations.md) |
| S046 | [developer.nylas.com/docs/v3/auth/using-multiple-provider-applications/](https://developer.nylas.com/docs/v3/auth/using-multiple-provider-applications/) | [03](./03-sync-auth-operations.md) |
| S047 | [developer.nylas.com/docs/v3/calendar/](https://developer.nylas.com/docs/v3/calendar/) | [02](./02-calendar-normalization.md) |
| S048 | [developer.nylas.com/docs/v3/calendar/check-free-busy/](https://developer.nylas.com/docs/v3/calendar/check-free-busy/) | [09](./09-sdk-and-adjacent-models.md) |
| S049 | [developer.nylas.com/docs/v3/calendar/recurring-events/](https://developer.nylas.com/docs/v3/calendar/recurring-events/) | [02](./02-calendar-normalization.md) |
| S050 | [developer.nylas.com/docs/v3/calendar/using-the-events-api/](https://developer.nylas.com/docs/v3/calendar/using-the-events-api/) | [02](./02-calendar-normalization.md) |
| S051 | [developer.nylas.com/docs/v3/email/](https://developer.nylas.com/docs/v3/email/) | [09](./09-sdk-and-adjacent-models.md) |
| S052 | [developer.nylas.com/docs/v3/email/contacts/](https://developer.nylas.com/docs/v3/email/contacts/) | [09](./09-sdk-and-adjacent-models.md) |
| S053 | [developer.nylas.com/docs/v3/email/messages/](https://developer.nylas.com/docs/v3/email/messages/) | [03](./03-sync-auth-operations.md) |
| S054 | [developer.nylas.com/docs/v3/notifications/](https://developer.nylas.com/docs/v3/notifications/) | [03](./03-sync-auth-operations.md) |
| S055 | [developer.nylas.com/docs/v3/notifications/pubsub-channel/](https://developer.nylas.com/docs/v3/notifications/pubsub-channel/) | [03](./03-sync-auth-operations.md) |
| S056 | [developer.nylas.com/docs/v3/notifications/sns-channel/](https://developer.nylas.com/docs/v3/notifications/sns-channel/) | [03](./03-sync-auth-operations.md) |
| S057 | [developer.nylas.com/docs/v3/scheduler/managing-availability/](https://developer.nylas.com/docs/v3/scheduler/managing-availability/) | [09](./09-sdk-and-adjacent-models.md) |
| S058 | [developer.nylas.com/docs/v3/sdks/python/manage-events/](https://developer.nylas.com/docs/v3/sdks/python/manage-events/) | [02](./02-calendar-normalization.md) |
| S059 | [developers.google.com/workspace/calendar/api/guides/recurringevents](https://developers.google.com/workspace/calendar/api/guides/recurringevents) | [02](./02-calendar-normalization.md) |
| S060 | [developers.google.com/workspace/calendar/api/guides/sync](https://developers.google.com/workspace/calendar/api/guides/sync) | [05](./05-protocol-and-plan.md), [09](./09-sdk-and-adjacent-models.md) |
| S061 | [docs.aurinko.io/](https://docs.aurinko.io/) | [06](./06-alternative-architectures.md) |
| S062 | [docs.aurinko.io/unified-apis/calendar-api](https://docs.aurinko.io/unified-apis/calendar-api) | [06](./06-alternative-architectures.md) |
| S063 | [docs.aurinko.io/unified-apis/tasks-api](https://docs.aurinko.io/unified-apis/tasks-api) | [06](./06-alternative-architectures.md) |
| S064 | [docs.aurinko.io/unified-apis/webhooks-api](https://docs.aurinko.io/unified-apis/webhooks-api) | [06](./06-alternative-architectures.md) |
| S065 | [docs.cronofy.com/developers/api-alpha/ics-push-notifications/](https://docs.cronofy.com/developers/api-alpha/ics-push-notifications/) | [07](./07-cronofy-reference.md) |
| S066 | [docs.cronofy.com/developers/api-alpha/recurring-events/](https://docs.cronofy.com/developers/api-alpha/recurring-events/) | [07](./07-cronofy-reference.md) |
| S067 | [docs.cronofy.com/developers/api/calendars/list-calendars/](https://docs.cronofy.com/developers/api/calendars/list-calendars/) | [07](./07-cronofy-reference.md) |
| S068 | [docs.cronofy.com/developers/api/events/edit-external-events/](https://docs.cronofy.com/developers/api/events/edit-external-events/) | [07](./07-cronofy-reference.md) |
| S069 | [docs.cronofy.com/developers/api/events/free-busy/](https://docs.cronofy.com/developers/api/events/free-busy/) | [07](./07-cronofy-reference.md) |
| S070 | [docs.cronofy.com/developers/api/events/participation-status/](https://docs.cronofy.com/developers/api/events/participation-status/) | [07](./07-cronofy-reference.md) |
| S071 | [docs.cronofy.com/developers/api/events/read-events/](https://docs.cronofy.com/developers/api/events/read-events/) | [07](./07-cronofy-reference.md) |
| S072 | [docs.cronofy.com/developers/api/events/upsert-event/](https://docs.cronofy.com/developers/api/events/upsert-event/) | [07](./07-cronofy-reference.md) |
| S073 | [docs.cronofy.com/developers/api/push-notifications/](https://docs.cronofy.com/developers/api/push-notifications/) | [07](./07-cronofy-reference.md) |
| S074 | [docs.cronofy.com/developers/calendars-events/editing-events/](https://docs.cronofy.com/developers/calendars-events/editing-events/) | [07](./07-cronofy-reference.md) |
| S075 | [docs.cronofy.com/developers/faqs/event-management/recommended-sync/](https://docs.cronofy.com/developers/faqs/event-management/recommended-sync/) | [07](./07-cronofy-reference.md) |
| S076 | [docs.cronofy.com/developers/getting-started/quick-start-guide/api-quick-start-guide/](https://docs.cronofy.com/developers/getting-started/quick-start-guide/api-quick-start-guide/) | [07](./07-cronofy-reference.md) |
| S077 | [docs.etebase.com/](https://docs.etebase.com/) | [08](./08-open-source-references.md) |
| S078 | [docs.etebase.com/guides/using_collections](https://docs.etebase.com/guides/using_collections) | [08](./08-open-source-references.md) |
| S079 | [docs.etebase.com/guides/using_items](https://docs.etebase.com/guides/using_items) | [08](./08-open-source-references.md) |
| S080 | [docs.etebase.com/overview](https://docs.etebase.com/overview) | [08](./08-open-source-references.md) |
| S081 | [docs.etebase.com/protocol-specs/collections](https://docs.etebase.com/protocol-specs/collections) | [08](./08-open-source-references.md) |
| S082 | [docs.etebase.com/protocol-specs/fetching-data](https://docs.etebase.com/protocol-specs/fetching-data) | [08](./08-open-source-references.md) |
| S083 | [docs.etebase.com/protocol-specs/items](https://docs.etebase.com/protocol-specs/items) | [08](./08-open-source-references.md) |
| S084 | [github.com/NangoHQ/nango](https://github.com/NangoHQ/nango) | [06](./06-alternative-architectures.md) |
| S085 | [github.com/bitfireAT/davx5-manual/blob/main/introduction.rst](https://github.com/bitfireAT/davx5-manual/blob/main/introduction.rst) | [08](./08-open-source-references.md) |
| S086 | [github.com/bitfireAT/davx5-ose/blob/0fc9500076c71f97eb1905e84106441df0a7c5da/core/src/main/kotlin/at/bitfire/davdroid/sync/SyncManager.kt](https://github.com/bitfireAT/davx5-ose/blob/0fc9500076c71f97eb1905e84106441df0a7c5da/core/src/main/kotlin/at/bitfire/davdroid/sync/SyncManager.kt) | [08](./08-open-source-references.md) |
| S087 | [github.com/bitfireAT/davx5-ose/blob/main/LICENSE](https://github.com/bitfireAT/davx5-ose/blob/main/LICENSE) | [08](./08-open-source-references.md) |
| S088 | [github.com/bitfireAT/webdav-push](https://github.com/bitfireAT/webdav-push) | [08](./08-open-source-references.md) |
| S089 | [github.com/etesync/etebase-rs/blob/master/Cargo.toml](https://github.com/etesync/etebase-rs/blob/master/Cargo.toml) | [08](./08-open-source-references.md) |
| S090 | [github.com/etesync/etebase-rs/blob/master/LICENSE](https://github.com/etesync/etebase-rs/blob/master/LICENSE) | [08](./08-open-source-references.md) |
| S091 | [github.com/etesync/etesync-dav](https://github.com/etesync/etesync-dav) | [08](./08-open-source-references.md) |
| S092 | [github.com/etesync/etesync-dav/blob/master/LICENSE](https://github.com/etesync/etesync-dav/blob/master/LICENSE) | [08](./08-open-source-references.md) |
| S093 | [github.com/etesync/server](https://github.com/etesync/server) | [08](./08-open-source-references.md) |
| S094 | [github.com/etesync/server/blob/master/LICENSE](https://github.com/etesync/server/blob/master/LICENSE) | [08](./08-open-source-references.md) |
| S095 | [github.com/nylas/nylas-nodejs/blob/fabe2d679baf20f45f941a7148544acb2434aafa/src/apiClient.ts](https://github.com/nylas/nylas-nodejs/blob/fabe2d679baf20f45f941a7148544acb2434aafa/src/apiClient.ts) | [09](./09-sdk-and-adjacent-models.md) |
| S096 | [github.com/nylas/nylas-nodejs/blob/fabe2d679baf20f45f941a7148544acb2434aafa/src/models/error.ts](https://github.com/nylas/nylas-nodejs/blob/fabe2d679baf20f45f941a7148544acb2434aafa/src/models/error.ts) | [09](./09-sdk-and-adjacent-models.md) |
| S097 | [github.com/nylas/nylas-nodejs/blob/fabe2d679baf20f45f941a7148544acb2434aafa/src/models/events.ts](https://github.com/nylas/nylas-nodejs/blob/fabe2d679baf20f45f941a7148544acb2434aafa/src/models/events.ts) | [09](./09-sdk-and-adjacent-models.md) |
| S098 | [github.com/nylas/nylas-nodejs/blob/fabe2d679baf20f45f941a7148544acb2434aafa/src/resources/events.ts](https://github.com/nylas/nylas-nodejs/blob/fabe2d679baf20f45f941a7148544acb2434aafa/src/resources/events.ts) | [09](./09-sdk-and-adjacent-models.md) |
| S099 | [github.com/nylas/nylas-nodejs/blob/fabe2d679baf20f45f941a7148544acb2434aafa/src/resources/resource.ts](https://github.com/nylas/nylas-nodejs/blob/fabe2d679baf20f45f941a7148544acb2434aafa/src/resources/resource.ts) | [09](./09-sdk-and-adjacent-models.md) |
| S100 | [github.com/nylas/nylas-nodejs/blob/fabe2d679baf20f45f941a7148544acb2434aafa/src/utils.ts](https://github.com/nylas/nylas-nodejs/blob/fabe2d679baf20f45f941a7148544acb2434aafa/src/utils.ts) | [09](./09-sdk-and-adjacent-models.md) |
| S101 | [github.com/nylas/sync-engine](https://github.com/nylas/sync-engine) | [01](./01-findings-and-decisions.md), [03](./03-sync-auth-operations.md) |
| S102 | [github.com/nylas/sync-engine/blob/50698996aef73102ead592e8d0948c1d2edfe123/inbox/events/google.py](https://github.com/nylas/sync-engine/blob/50698996aef73102ead592e8d0948c1d2edfe123/inbox/events/google.py) | [03](./03-sync-auth-operations.md) |
| S103 | [github.com/nylas/sync-engine/blob/50698996aef73102ead592e8d0948c1d2edfe123/inbox/events/remote_sync.py](https://github.com/nylas/sync-engine/blob/50698996aef73102ead592e8d0948c1d2edfe123/inbox/events/remote_sync.py) | [03](./03-sync-auth-operations.md) |
| S104 | [github.com/nylas/sync-engine/blob/50698996aef73102ead592e8d0948c1d2edfe123/inbox/models/action_log.py](https://github.com/nylas/sync-engine/blob/50698996aef73102ead592e8d0948c1d2edfe123/inbox/models/action_log.py) | [03](./03-sync-auth-operations.md) |
| S105 | [github.com/nylas/sync-engine/blob/50698996aef73102ead592e8d0948c1d2edfe123/inbox/transactions/actions.py](https://github.com/nylas/sync-engine/blob/50698996aef73102ead592e8d0948c1d2edfe123/inbox/transactions/actions.py) | [03](./03-sync-auth-operations.md) |
| S106 | [github.com/nylas/sync-engine/blob/50698996aef73102ead592e8d0948c1d2edfe123/inbox/transactions/delta_sync.py](https://github.com/nylas/sync-engine/blob/50698996aef73102ead592e8d0948c1d2edfe123/inbox/transactions/delta_sync.py) | [03](./03-sync-auth-operations.md) |
| S107 | [github.com/nylas/sync-engine/blob/master/LICENSE](https://github.com/nylas/sync-engine/blob/master/LICENSE) | [03](./03-sync-auth-operations.md) |
| S108 | [learn.microsoft.com/en-us/graph/api/resources/patternedrecurrence](https://learn.microsoft.com/en-us/graph/api/resources/patternedrecurrence?view=graph-rest-1.0) | [02](./02-calendar-normalization.md) |
| S109 | [learn.microsoft.com/en-us/graph/delta-query-overview](https://learn.microsoft.com/en-us/graph/delta-query-overview) | [05](./05-protocol-and-plan.md), [09](./09-sdk-and-adjacent-models.md) |
| S110 | [manual.davx5.com/technical_information.html](https://manual.davx5.com/technical_information.html) | [08](./08-open-source-references.md) |
| S111 | [manual.davx5.com/webdav_push.html](https://manual.davx5.com/webdav_push.html) | [08](./08-open-source-references.md) |
| S112 | [nango.dev/docs/guides/functions/syncs/checkpoints](https://nango.dev/docs/guides/functions/syncs/checkpoints) | [06](./06-alternative-architectures.md) |
| S113 | [nango.dev/docs/guides/functions/syncs/deletion-detection](https://nango.dev/docs/guides/functions/syncs/deletion-detection) | [06](./06-alternative-architectures.md) |
| S114 | [nango.dev/docs/guides/functions/syncs/sync-functions](https://nango.dev/docs/guides/functions/syncs/sync-functions) | [06](./06-alternative-architectures.md) |
| S115 | [nango.dev/docs/guides/functions/syncs/sync-partitioning](https://nango.dev/docs/guides/functions/syncs/sync-partitioning) | [06](./06-alternative-architectures.md) |
| S116 | [nango.dev/platform/data-sync](https://nango.dev/platform/data-sync) | [06](./06-alternative-architectures.md) |
| S117 | [support.nylas.com/hc/en-us/articles/18564132044957-Issues-and-Differences-During-Migration-from-V2-to-V3-Best-Practices](https://support.nylas.com/hc/en-us/articles/18564132044957-Issues-and-Differences-During-Migration-from-V2-to-V3-Best-Practices) | [03](./03-sync-auth-operations.md) |
| S118 | [support.nylas.com/hc/en-us/articles/26826548737053-Why-do-I-need-to-handle-both-message-created-and-message-updated-webhooks-in-Nylas-v3](https://support.nylas.com/hc/en-us/articles/26826548737053-Why-do-I-need-to-handle-both-message-created-and-message-updated-webhooks-in-Nylas-v3) | [03](./03-sync-auth-operations.md) |
| S119 | [vdirsyncer.pimutils.org/en/stable/config.html](https://vdirsyncer.pimutils.org/en/stable/config.html) | [06](./06-alternative-architectures.md) |
| S120 | [vdirsyncer.pimutils.org/en/stable/index.html](https://vdirsyncer.pimutils.org/en/stable/index.html) | [06](./06-alternative-architectures.md) |
| S121 | [vdirsyncer.pimutils.org/en/stable/tutorial.html](https://vdirsyncer.pimutils.org/en/stable/tutorial.html) | [06](./06-alternative-architectures.md) |
| S122 | [vdirsyncer.pimutils.org/en/stable/vdir.html](https://vdirsyncer.pimutils.org/en/stable/vdir.html) | [06](./06-alternative-architectures.md) |
| S123 | [www.nylas.com/blog/introducing-nylas-apiv3/](https://www.nylas.com/blog/introducing-nylas-apiv3/) | [01](./01-findings-and-decisions.md), [03](./03-sync-auth-operations.md) |
| S124 | [www.rfc-editor.org/rfc/rfc4791](https://www.rfc-editor.org/rfc/rfc4791) | [02](./02-calendar-normalization.md) |
| S125 | [www.rfc-editor.org/rfc/rfc4791.html](https://www.rfc-editor.org/rfc/rfc4791.html) | [09](./09-sdk-and-adjacent-models.md) |
| S126 | [www.rfc-editor.org/rfc/rfc5545.html](https://www.rfc-editor.org/rfc/rfc5545.html) | [09](./09-sdk-and-adjacent-models.md) |
| S127 | [www.rfc-editor.org/rfc/rfc5546.html](https://www.rfc-editor.org/rfc/rfc5546.html) | [09](./09-sdk-and-adjacent-models.md) |
| S128 | [www.rfc-editor.org/rfc/rfc6578.html](https://www.rfc-editor.org/rfc/rfc6578.html) | [05](./05-protocol-and-plan.md), [09](./09-sdk-and-adjacent-models.md) |
| S129 | [www.rfc-editor.org/rfc/rfc6638](https://www.rfc-editor.org/rfc/rfc6638) | [02](./02-calendar-normalization.md) |
| S130 | [www.rfc-editor.org/rfc/rfc6638.html](https://www.rfc-editor.org/rfc/rfc6638.html) | [09](./09-sdk-and-adjacent-models.md) |
| S131 | [www.rfc-editor.org/rfc/rfc8984.html](https://www.rfc-editor.org/rfc/rfc8984.html) | [05](./05-protocol-and-plan.md), [09](./09-sdk-and-adjacent-models.md) |
