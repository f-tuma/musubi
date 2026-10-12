# Otevřené reference: DAVx⁵ a EteSync/Etebase

Ověřeno **12. 10. 2026**. Tyto projekty řeší jiné vrstvy než Nylas, a právě proto jsou užitečné pro návrh samostatného sync protokolu. **Doloženo** označuje dokumentaci nebo staticky prohlédnutý veřejný kód; **návrh** naše vlastní doporučení. Neproběhl provozní test těchto aplikací ani audit jejich bezpečnosti.

## 1. DAVx⁵: provider adapter bez vlastní produktové databáze

**Doloženo:** DAVx⁵ je Android CalDAV/CardDAV synchronizační aplikace mezi DAV serverem a systémovými content providers. Události a kontakty neuchovává jako vlastní produktový backend; k jejich editaci slouží jiné aplikace. Dokumentace také správně odlišuje synchronizaci od zálohy: smazání se může přenést na ostatní místa. [Úvod DAVx⁵](https://github.com/bitfireAT/davx5-manual/blob/main/introduction.rst).

**Doloženo:** Technický manuál popisuje capability discovery přes PROPFIND, podmíněný PUT/DELETE s ETag nebo Schedule-Tag, create s `If-None-Match: *`, collection sync tam, kde je podporován, a fallback na seznam resources plus multiget. Invalid sync token znamená initial sync; sweep patří až k dokončené počáteční synchronizaci. Konflikty mají policy **server always wins**, bez interaktivního výběru. Recurrence se předá Android Calendar Provideru, který počítá instances. Neznámé iCalendar properties jsou v omezené velikosti uchovány pro round trip. [Technický manuál](https://manual.davx5.com/technical_information.html).

**Statický kód:** Na snapshotu `0fc9500076c71f97eb1905e84106441df0a7c5da` je obecný SyncManager oddělen od konkrétního CalendarSyncManager, ContactsSyncManager a task managers. Upload rozlišuje new resource a existing resource, řeší 403, 404/410 a precondition failure. Při lokálním DELETE zachytí HTTP výjimku a lokální záznam odstraní; komentář připouští pozdější nové stažení. To odpovídá koncepci serverové autority, ale nepředstavuje durable potvrzení našeho lokálního delete intentu. [SyncManager](https://github.com/bitfireAT/davx5-ose/blob/0fc9500076c71f97eb1905e84106441df0a7c5da/core/src/main/kotlin/at/bitfire/davdroid/sync/SyncManager.kt).

**Návrh pro Musubi:** Převzít strukturu capability discovery, separation lokálního store a sync runneru, conditional writes a soubor testů pro platformní ztráty. Nepřebírat konfliktovou policy. Musubi uživatelem přijatou změnu nesmí tiše zahodit jen proto, že běží na pozadí. Může ji označit conflict, zobrazit receipt nebo vyžádat řešení. Jasné vymezení autority umožní mít server-wins profil pro jednoduchý mirror, aniž tento profil oslabí kanonické sdílené úkoly.

Zásadní poučení je, že **ETag safety a zachování lokálního úmyslu jsou dvě různé věci**. Klient může správně neoverwriteovat upstream a přesto ztratit lokální editaci. Protokol musí popsat obě vlastnosti. Podobně lokálně označená absence není důkaz remote delete. U mnoha providerů musí při access loss nebo neúplném čtení nastat retirement/redaction, nikoli globální tombstone.

DAVx⁵ je dobrý případ skutečného lossy adapteru. Android reprezentace je omezený cílový formát; ne vše lze převést bijektivně. Pro Musubi proto dává smysl uvést u projekce accepted baseline a field-level loss, nikoli jen `supportsEvents: true`. Round-trip fixtures mají pokrýt recurrence exceptions, unknown properties, floating time, custom timezone a scheduling side effects. Importovat a exportovat validní ICS nestačí, pokud se při tom změní význam schůzky.

## 2. WebDAV Push: další důvod mít capability model

**Doloženo:** DAVx⁵ manuál uvádí WebDAV Push od 4.4.10, vyžaduje podporu na serveru a na zařízení FCM nebo UnifiedPush distributor. Popisuje šifrované push messages a uvádí Nextcloud extension. Veřejný projekt nadále označuje protokol jako draft. [WebDAV Push v manuálu](https://manual.davx5.com/webdav_push.html), [repozitář draftu](https://github.com/bitfireAT/webdav-push).

**Návrh:** V Musubi tedy nepsat obecně „CalDAV nemá push“. Přesné tvrzení je: samotný běžný CalDAV adapter má polling; kompatibilní rozšíření může dodat push nudge. Není důvod slibovat kompatibilitu se všemi DAV servery nebo stavět naše correctness na nové extension. Push capability má obsahovat discovery, subscribe, renewal, unsubscribe a poslední úspěšné ověření. Periodický pull je zachovaný fallback.

Pro self-hosting je přínosné, že člověk může vybrat transport podle své infrastruktury. Jeden server může mít veřejný webhook, druhý pouze poll, třetí UnifiedPush. Náš normalized observation kontrakt musí zůstat stejný. Vyřeší se tím latence bez přidání povinného centrálního vendor relay. Před zavedením je potřeba kontraktně ověřit Nextcloud a další konkrétní podporovaný server; existence draftu neznamená interoperabilitu našeho kódu.

## 3. Etebase: end-to-end šifrovaná synchronizace vlastních objektů

**Doloženo:** Etebase je nový název protokolu EteSync 2.0. Jeho model používá Collection, Item a Revision. Server podle dokumentace nemá přístup k plaintextu; kryptografické operace a práce s obsahem se dějí na klientovi. Collection má neměnný type, access control a sync token `stoken`. [Úvod Etebase](https://docs.etebase.com/), [model a odpovědnost klient/server](https://docs.etebase.com/overview).

**Doloženo:** Fetching specifikace používá neprůhledný stoken a odpovědi `data`, `done`, `stoken` či `iterator`. Collection listing zvlášť vrací removed memberships, tedy ztrátu přístupu odlišnou od smazání. Using Collections rozlišuje podepsaný delete a nepodepsané odstranění membership; doporučuje při druhém dát uživateli indikaci před odstraněním lokální kopie. [Fetching Data](https://docs.etebase.com/protocol-specs/fetching-data), [Collections protocol](https://docs.etebase.com/protocol-specs/collections), [Using Collections](https://docs.etebase.com/guides/using_collections).

**Doloženo:** `batch` může overwriteovat aktuální remote stav; `transaction` kontroluje očekávané verze všech zúčastněných items a při mismatch celé selže. Lze přidat dependencies, které se nemění, ale jejich změna zápis zablokuje. Volitelný stoken umožní kontrolu celé collection. Nejde o automatický kalendářový merge ani důkaz CRDT. [Using Items](https://docs.etebase.com/guides/using_items).

**Návrh pro Musubi:** Převzít explicitní rozdíl object revision, collection cursor a authorization removal. Pro native/federovaný protokol můžeme nabídnout dávku s expected revisions a jednoznačnou atomicitou v jednom domácím serveru. Při více externích providerech máme pouze lokální atomický commit a oddělené durable projekce; nemáme jejich distribuovanou transaction. Stejný název operace by tuto odlišnost nesměl skrýt.

Etebase je zajímavé pro budoucí encrypted native calendar, ale není náhradou Google/Graph normalizace. Pokud server provádí transformaci do běžné schůzky a volá provider API s plaintext title a attendees, někde musí plaintext a přístupové credentials získat. End-to-end soukromí může zachovat klientský integration agent, což ovšem změní dostupnost syncu při vypnutém zařízení. Tento tradeoff patří do produktu i threat modelu; přidání kryptografické knihovny ho neodstraní.

**Doloženo:** `etesync-dav` nabízí lokální CalDAV/CardDAV server jako compatibility bridge pro desktop klienty a používá Radicale. Je to velmi praktický vzor interoperability: standardní klient může přistupovat k jinému storage protokolu přes samostatnou lokální bránu. [EteSync DAV bridge](https://github.com/etesync/etesync-dav).

**Návrh:** Podobný Musubi agent by mohl být samostatný proces s vlastním credential store, minimální oprávněnou sadou collections a durable queue. Není potřeba z celé Musubi API dělat CalDAV server už v prvním otevřeném vydání. Nejprve stabilizovat core contract; exportní server a klientský bridge přidat jako konkrétní implementace.

## 4. Licence, ověřitelnost a pořadí další práce

Ověřené veřejné soubory uvádějí DAVx⁵ GPL-3.0, Etebase Rust SDK BSD-3-Clause, Etebase server AGPL-3.0 a EteSync DAV bridge GPL-3.0. Jde o inventář zdrojů, nikoli právní závěr o kompatibilitě nebo o licenci všech souvisejících knihoven. [DAVx⁵ LICENSE](https://github.com/bitfireAT/davx5-ose/blob/main/LICENSE), [Etebase SDK manifest](https://github.com/etesync/etebase-rs/blob/master/Cargo.toml), [SDK LICENSE](https://github.com/etesync/etebase-rs/blob/master/LICENSE), [server LICENSE](https://github.com/etesync/server/blob/master/LICENSE), [bridge licence](https://github.com/etesync/etesync-dav/blob/master/LICENSE).

Etebase protocol docs mají některé nedokončené části: Items specification obsahuje pouze TBD. Pro skutečnou novou interoperabilní implementaci by proto nestačilo přečíst guide; musí se porovnat SDK, server a test vectors. Také upgrade ze starého EteSync 1.0 na 2.0 je ve server README popsán jako nekompatibilní, s novou instalací a migrací dat. [Items specification](https://docs.etebase.com/protocol-specs/items), [server migration](https://github.com/etesync/server).

Praktické pořadí pro nás: nejprve přidat DAVx⁵ do externí interoperability matice vůči Radicale/Musubi exportům; potom vyhodnotit WebDAV Push jako volitelný experiment; model Etebase využít při návrhu klientského delta feedu a access retirement. Kryptografický native profil má vlastní návrh, test vectors, key lifecycle a obnovu zařízení. Do původního scope provider syncu ho nepřidávat jako automatické „zlepšení bezpečnosti“: je to podstatně jiná trust boundary a provozní architektura.
