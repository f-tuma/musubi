# MUSU-32 · Delivery recovery

Implementováno a lokálně ověřeno 12. října 2026. Tento záznam dokládá lokální acceptance před zveřejněním PR; stav GitHub kontrol a merge se ověřuje samostatně. Produkční scrape a alert acceptance zůstává MUSU-19. Další fáze refactoru je MUSU-33.

## Výsledek

Event a task executor používají stejný deadline 45 sekund, lease heartbeat 20 sekund a exponenciální backoff s jitterem. Deadline zastaví obnovování lease a vrátí řízení i při adaptéru, který ignoruje cancellation. AbortSignal prochází do HTTP, task readbacku, OAuth čekání i CalDAV discovery/REPORT. Kontroly oprávnění před durable admission mají stejný deadline bez lease.

Task mutation fence kontroluje cancellation před i po ověření zdroje. Acknowledgement vyžaduje platný lease a aktivní signal. Timeout před dispatch zůstává retryable; po možném dispatch zachová unknown outcome. Zachycená response identity umožní CREATE ověřit čtením. Google CREATE bez adresy se znovu neposílá. Specializované RSVP/organizer důkazy a pravidla proti opakovanému odeslání jsou zachované.

`Retry-After` je dolní mez retry času, včetně hodnot delších než hodinový backoff cap. CalDAV dočasná chyba ACL/discovery zůstává dočasnou HTTP chybou; nepromění se na odmítnutí oprávnění. Task Google GET může obnovit odmítnutý access token a zopakovat konkrétní GET jednou; mutace se tím neopakují. Sdílený OAuth refresh má vlastní 30s transport deadline a přerušený čekající klient nezruší refresh ostatním.

## Konfigurace a provozní baseline

| Nastavení | Chování |
| --- | --- |
| `EXTERNAL_SYNC_INTERVAL_MIN=0` | Vypne pravidelný pull providerů. |
| `EXTERNAL_DELIVERY_RECOVERY_MODE=independent` | Nový default: event/task/move recovery při startu a každých 15 s, i při vypnutém pollingu. |
| `EXTERNAL_DELIVERY_RECOVERY_MODE=legacy` | Původní propojení: recovery pouze při kladném intervalu pollingu. |
| `EXTERNAL_DELIVERY_RECOVERY_MODE=disabled` | Vypne background recovery při libovolném intervalu pollingu. |

Request wakeups zůstávají aktivní ve všech režimech. Tyto přepínače nejsou write kill switch. Upgrade instalace, která přes polling=0 pozastavovala i recovery, potřebuje explicitní `legacy`. Selhání jedné rodiny front nevynechá ostatní; rozpočty a férovost mezi účty řeší až MUSU-41.

`musubi_provider_http_requests_total` a matching duration histogram měří konkrétní HTTP dispatches v přijatém event/task delivery kontextu, včetně preflight/readback/OAuth. Polling a preview před durable admission jsou mimo tento rozsah. Labely mají konečnou množinu provider/family/method/status; neobsahují URL, účet, objekt, token ani obsah.

Event/task fronty exportují počet, stáří, eligible due count a due lag. Scrape sdílí 15s cache a stejné SQL claim predicates jako worker, takže aktivní lease, budoucí retry a nevyřešený predecessor nezvyšují due lag. Health a čas posledního úspěšného snapshotu rozlišují výpadek DB od prázdné fronty.

## Ověření

- Všech 79 příkazů API unit sady prošlo. Původní CalDAV test očekával unknown ACL i při HTTP 500; byl upraven na typed transient failure a znovu prošel. Nový test současně zachovává strict unknown/denied pro 200/403/404 a ověřuje Retry-After při 408/429/500/503.
- Nové testy policy, config a scheduleru ověřují deadline, lease loss, cleanup, restart se zachovanou frontou a matici independent/legacy/disabled. Restart scheduleru je simulovaný; reclaim vypršené CREATE lease je ověřený na skutečném PostgreSQL.
- Task delivery PostgreSQL test ověřuje visící preflight i POST/readback, předávání AbortSignal, uvolnění lease, pozdní dispatch fence, 429, resource 401, známý a neznámý CREATE i crash recovery. Stávající shared task a task API integrace prošly.
- Další PostgreSQL integrace prošly pro event delivery, CalDAV RSVP, Microsoft RSVP, Google RSVP, Google organizer, CalDAV organizer, Graph series create, provider create recovery a outbox metriky.
- HTTP fixture ověřuje Google a Graph task abort, CalDAV discovery/ACL/REPORT a GET 401 → OAuth POST → GET 200. Tento auth průchod má přesně tři měřená HTTP volání. OAuth test ověřuje nezávislé přerušení souběžných čekajících klientů.
- API typecheck, route a realtime kontrakty, release metadata, build dokumentace a `git diff --check` prošly.

Testy běžely přes instalovaný Node/tsx runtime. Pnpm launcher v tomto prostředí nedokončil ověření identity binárky při přístupu k registry; neměnili jsme kvůli tomu package manager ani lockfile. PostgreSQL byl samostatný dočasný kontejner. Privátní adresy byly povolené jen v integračním testovacím procesu pro lokální HTTP fixture. Skutečné provider účty, produkční konfigurace a nasazení se neměnily. Nebyla spuštěna celá monorepo/web/browser sada; UI se neměnilo.

## Hlavní implementace

- [Sdílená policy](../../apps/api/src/sync/delivery_policy.ts)
- [Task executor](../../apps/api/src/sync/task_delivery.ts), [event executor](../../apps/api/src/sync/event_delivery.ts)
- [Background scheduling](../../apps/api/src/sync/background.ts)
- [HTTP metriky](../../apps/api/src/sync/provider_http_metrics.ts), [queue scrape](../../apps/api/src/metrics.ts)
- [Provozní dokumentace](../../packages/docs/src/content/docs/operations/observability.mdx)
