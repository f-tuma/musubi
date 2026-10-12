# Co prozrazuje SDK, sousední datové modely a standardy

Ověřeno **12. října 2026**. Node SDK jsme stáhli do dočasného adresáře a staticky prošli. Snapshot je **nylas/nylas-nodejs, commit fabe2d679baf20f45f941a7148544acb2434aafa**, package verze **8.4.0**. Archiv z main byl porovnán s archivem tohoto konkrétního commitu; obsah byl shodný. Žádný požadavek proti účtu Nylas ani providerovi jsme nespouštěli.

## SDK je klient služby, nikoli zveřejněný normalizační engine

Events resource sestavuje URL pod v3/grants, volá sdílené list/find/create/update/destroy metody a nabízí zvláštní import a RSVP. Providerovou normalizaci neprovádí. [Events resource, přesný snapshot](https://github.com/nylas/nylas-nodejs/blob/fabe2d679baf20f45f941a7148544acb2434aafa/src/resources/events.ts)

To nastavuje hranici reverzní analýzy. Ze zdrojů lze doložit cestu požadavku, typy a chování SDK; nelze z nich rekonstruovat algoritmus Graph-to-RRULE nebo interní token fencing Nylas. MIT SDK není licence ani zdrojový kód produkčního serveru. Pro naši budoucí nabídku je to užitečný kontrast: open-source sync protokol má zveřejnit význam operací a testy, nikoli jen tenký HTTP wrapper.

Model Events popisuje objekty API, query parametry, recurrence, konferenci, reminders a různé varianty času. [Events model](https://github.com/nylas/nylas-nodejs/blob/fabe2d679baf20f45f941a7148544acb2434aafa/src/models/events.ts)

Typy jsou dobrá mapa uživatelské plochy, ale TypeScript rozhraní samo nezaručuje runtime validaci cizí JSON odpovědi. V Musubi ponechat oddělené request intent, accepted plan, provider observation a public DTO. Podobně vypadající objekt read a write často znamená něco jiného: null může být „hodnota není známá“, „uživatel ji vymazal“ nebo „provider ji zredigoval“. Jediný Partial<Event> nedokáže tento rozdíl věrně pojmenovat.

## HTTP klient: dobré rozhraní chyb, opatrně s timeouty

APIClient přidává auth, query parametry a timeout přes AbortController, převádí request keys do snake_case a response keys do camelCase a předává metadata exclusion. Převádí chyby do typovaných tříd a zachovává response headers i request/flow identifikátory. V prohlédnutém sendRequest není generický retry loop. Timeout override používá hodnoty menší než 1000 jako sekundy a hodnoty ≥1000 jako milisekundy. [APIClient](https://github.com/nylas/nylas-nodejs/blob/fabe2d679baf20f45f941a7148544acb2434aafa/src/apiClient.ts)

**Převzít:** request ID, opaque provider error pro interní diagnostiku, normalizovanou bezpečnou chybu pro klienta, přístup k rate-limit hlavičkám. **Navrhnout jinak:** jednotky timeoutu explicitně pojmenovat deadlineMs nebo durationMs. Odhadovat jednotku z velikosti čísla je kompatibilitní kompromis, který nový protokol nepotřebuje.

Po lokálním timeoutu může provider už mít zápis přijatý. AbortController ruší čekání a případně přenos; nevrací čas zpět u příjemce. Proto SDK timeout nepovažovat za důkaz not-written. Musubi má odlišit „neodesláno“, „odesláno bez potvrzení“ a „přijato“. Opakování může být bezpečné jen s ověřeným idempotentním contractem nebo po reconciliation.

Chybové třídy oddělují SDK timeout, OAuth error a obecné API error s providerError a hlavičkami. [Error model](https://github.com/nylas/nylas-nodejs/blob/fabe2d679baf20f45f941a7148544acb2434aafa/src/models/error.ts)

Pro vlastní knihovnu doporučujeme místo jedné retryable=true hodnoty tři nezávislé informace: **klasifikaci příčiny**, **jistotu vedlejšího účinku** a **doporučený další krok**. Například rate_limited + proven_not_dispatched + wait_until je jiný případ než transport_timeout + dispatched_unknown + observe. Stejný HTTP status nemusí u dvou operací znamenat stejný bezpečný retry.

## Stránkování: příjemné API může skrývat více HTTP volání

Resource.fetchList umí při nedosaženém limitu dotahovat další stránky a spojovat jejich data. Async iterator poskytuje stránky. První fetch normalizuje i vnořený list envelope; další dotahy v této metodě volají klienta přímo. [Resource implementation](https://github.com/nylas/nylas-nodejs/blob/fabe2d679baf20f45f941a7148544acb2434aafa/src/resources/resource.ts)

Jde o statické pozorování implementace, nikoli zjištěnou produkční závadu. Pokud endpointy vracejí rozdílný envelope, je to dobrý kandidát testu kompatibility, ne důvod bez experimentu vyhlásit SDK rozbité. Důležitější obecná lekce pro Musubi: list(limit=100) nesmí být v dokumentaci zaměňováno s přesně jedním provider requestem. Integrační runtime má měřit skutečné HTTP calls, bytes a retry, ne pouze naše top-level metody.

Stránkovací cursor není automaticky sync cursor. Page token pokračuje uvnitř jednoho výčtu; sync token vymezuje další změnové kolo. Ve veřejných typech našeho protokolu je třeba oba pojmy oddělit, aby spotřebitel omylem nezačal příští synchronizaci posledním page tokenem.

Utility konvertuje klíče rekurzivně a path parametry encoduje. Exclusion však nepředává do rekurzivních volání. Top-level request metadata je chráněno; běžné response data.metadata podle tohoto statického toku může projít konverzí klíčů. Je to kandidát regresního testu SDK, nikoli zjištění z běžící služby. [Utilities](https://github.com/nylas/nylas-nodejs/blob/fabe2d679baf20f45f941a7148544acb2434aafa/src/utils.ts)

Při porovnávání requestů a webhooků nejprve vybudovat vlastní kanonickou projekci. Hash surového SDK requestu a surového webhooku nemusí souhlasit kvůli casing, defaultům, pořadí arrays, přesnosti času, provider enrichment nebo chybějícím hodnotám. Hash je urychlení porovnání konkrétních kanonických polí; není verze, autorita ani důkaz identity. Metadata musí mít oddělený namespace a transport nikdy nemá přepisovat uživatelské klíče automatickou konverzí.

## Co se naučit z emailu a kontaktů, aniž bychom rozšířili Musubi na mailbox

Nylas Email API používá společné message/thread/folder objekty. Gmail má labels a může mít více přiřazení, zatímco Microsoft používá folder. Společné thread flags představují agregace, nikoli vlastnosti každé zprávy. [Email API](https://developer.nylas.com/docs/v3/email/), [Provider differences in threading](https://developer.nylas.com/docs/cookbook/email/threads/gmail-vs-outlook-threading/)

To má přímou analogii k našim calendar memberships. Stejný canonical object může být v několika kolekcích, ale providerové kopie nejsou tím automaticky jedna vzdálená entita. Seznam memberships není seznam provider locators. Protokol potřebuje vlastní tabulku identity/provenance, jinak se do kopie přenese role organizátora, účastnický stav či deletion authority omylem.

U IMAP Nylas sestavuje threads z hlaviček a používá IDLE pro Inbox/Sent, jiné složky prochází periodicky. [IMAP threads](https://developer.nylas.com/docs/cookbook/email/threads/list-threads-imap/)

To ukazuje, že jednotné API může skrývat zásadně jinou latenci a úplnost. Pro kalendáře proto nepoužívat jeden obecný syncStatus=ok. Rozlišit poslední úspěšné discovery, poslední complete pull, freshness projekce a stav doručení konkrétní operace. UI pak může zobrazení starých dat označit podle skutečného důkazu, nikoli podle posledního HTTP 200 na jiné části účtu.

Contacts API odlišuje zdroje address_book/domain/inbox. iCloud a Yahoo address_book mají CardDAV chování; notification a writable field support se liší. Dokumentace u iCloudu výslovně nepovažuje notification feed za lossless exactly-once log. [Contacts API](https://developer.nylas.com/docs/v3/email/contacts/)

Poučení pro Musubi je formulace původu. „Vidíme kontakt“ neznamená „smíme ho změnit“; obdobně „vidíme free/busy“ neznamená „vidíme event detail“. Zdroj observations má nést rights, completeness a privacy generation. Lossy projection sekundárního providera nemá při echo pullu mazat bohatší kanonické informace.

Metadata Nylas má string pairs a několik indexovaných klíčů; update je nahrazení celého metadata objektu. [Metadata guide](https://developer.nylas.com/docs/dev-guide/metadata/)

Náš protokol by místo vyhrazených obecných key1 až key5 měl používat pojmenované a verzované účely: correlation.operation, origin.object, projection.version. Citlivá domácí identity nebo ACL metadata neposílat do providerova popisu. Provider může metadata ignorovat, odříznout nebo nevrátit; bezpečnost a uncertain create recovery nesmějí stát jen na jejich přítomnosti.

## Availability jako samostatná projekce

Nylas odděluje free/busy a výpočet bookable slots. Free/busy tedy není jen zkrácený Event response. [Free/busy](https://developer.nylas.com/docs/v3/calendar/check-free-busy/)

Doporučujeme obdobné samostatné BusyInterval observations. Bez titulu, účastníků či kanonické event identity. Běžné období s několika busy intervaly nemusí dovolovat CRUD ani tombstone propagation. Musubi již má samostatnou Google freeBusyReader discovery a availability cestu, ověřenou v aktuálním [auditu](./04-musubi-audit.md). Návrh je zobecnit tento existující přístup do veřejného profilu a dalších adapterů.

Scheduler má oddělenou Configuration, participant availability a cílový booking calendar. Novější průvodce popisuje přednost konkrétních hodin, časových pásem, buffers a minimální notice. U buffers zmiňuje větší hodnotu aplikovanou symetricky, zatímco reference jednotlivých parametrů sugeruje samostatné before/after působení. [Managing availability](https://developer.nylas.com/docs/v3/scheduler/managing-availability/), [Create Configuration reference](https://developer.nylas.com/docs/reference/api/configurations/post-configurations/)

To je evidovaný rozpor dokumentace, ne potvrzené chování živé služby. Naše lesson: očekávání buffers vyjádřit příklady intervalů a conformance testy. Pokud chceme bufferBefore=5 a bufferAfter=15, test musí přesně určit, zda 10:00–11:00 blokuje 09:55–11:15, nebo 09:45–11:15. Pouhé dvě jména polí nestačí.

Scheduler cookbook popisuje opětovné ověření dostupnosti před vytvořením booking. [Round-robin scheduling](https://developer.nylas.com/docs/cookbook/scheduler/round-robin-scheduling/)

Ani nové GET free/busy a následný CREATE ale nevytvářejí obecnou atomickou rezervaci vůči jinému klientovi u providera. Vlastní booking produkt by musel definovat svou rezervaci a konkurenci, případně providerovy silnější primitive. Proto nyní doporučujeme pouze oddělit doménu scheduling od sync protokolu; vlastní scheduler je následný produkt, ne nutná podmínka otevření engine.

## Standardy jako stabilnější základ než kopie vendor JSON

RFC 5545 definuje iCalendar včetně DATE, lokálních/UTC časů, recurrence a RECURRENCE-ID. RFC 5546 definuje scheduling zprávy a role; RFC 6638 přidává scheduling na CalDAV. Aktualizace kalendářového zdroje a účinek pozvánky nejsou tentýž kontrakt. [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545.html), [RFC 5546](https://www.rfc-editor.org/rfc/rfc5546.html), [RFC 6638](https://www.rfc-editor.org/rfc/rfc6638.html)

RFC 4791 popisuje CalDAV zdroje a operace; RFC 6578 změnovou synchronizaci WebDAV kolekce. Pro provider adaptér jsou relevantní resource locators, validators a scoped tokeny. [RFC 4791](https://www.rfc-editor.org/rfc/rfc4791.html), [RFC 6578](https://www.rfc-editor.org/rfc/rfc6578.html)

Google poskytuje incremental sync s terminálním nextSyncToken; invalidace tokenu vyvolává 410 a vyžaduje nové full čtení. Graph delta odděluje nextLink a deltaLink a obsahuje vlastní scope a pravidla. [Google sync](https://developers.google.com/workspace/calendar/api/guides/sync), [Graph delta](https://learn.microsoft.com/en-us/graph/delta-query-overview)

Naše doporučení se odlišuje od jednoduchých průvodců „vymaž lokální cache a stáhni znovu“: Musubi má pending writes, domácí identity a privacy důkazy. Reset proto musí stageovat úplné nové pozorování a teprve potom provést scoped reconciliation. Nesmí smazat lidský neodeslaný záměr či vrátit dříve odstraněný obsah.

RFC 8984 JSCalendar nabízí JSON model Event, Task a Group, civilní čas, recurrence overrides a rozšiřující properties; není jen mechanickým JSON přepisem iCalendar. [JSCalendar](https://www.rfc-editor.org/rfc/rfc8984.html)

Pro open-source Musubi je JSCalendar dobrá referenční sémantika. Nejprve napsat mapping matrix: co uchováváme přesně, co losslessly exportujeme, co umíme pouze pozorovat a co odmítáme zapisovat. Neslibovat plnou shodu RFC pouhým použitím podobných jmen. Protokol musí navíc přidat provozní obálku: provenance, local revision, admitted intent, delivery certainty, privacy generation a cursor scope. Standard formátu dat sám neřeší naše distribuované doručování.

První RFC verzi proto zaměřit na malý testovatelný profil, nikoli na kompletní implementaci všech vlastností JSCalendar. Schéma modelu a protokol synchronizace verzovat odděleně: nový enum v provider observation nemusí být nová schopnost write engine.
