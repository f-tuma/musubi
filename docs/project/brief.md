# Musubi — záměr a hranice projektu

Stav: stávající záměr projektu převzatý ze zdrojů; plán dalšího sjednocení je návrh.
Vlastník záměru: Filip Tůma. Výchozí zdroj: b138056218aab1e3b01b69d7e53b3713a553dfcd.

## Vize a hlavní zkušenost

Musubi propojuje lidi, sdílené kalendáře, události a úkoly v jednom self-hostovatelném produktu. Uživatel pracuje přes web nebo mobil, může připojit Google, Microsoft a CalDAV/iCloud a smí rozlišit lokální uložení, čekající doručení, potvrzení providera a stav vyžadující zásah.

Domácí obsah, členství, práva a federace patří Musubi. Sdílené sync jádro poskytuje přenositelné mechanismy s explicitními host porty a doloženými profily. Samostatný reference host ověřuje extrakci; Calendar Relay zůstává samostatným pozdějším produktem.

## Potvrzené cíle této práce

- Ucelit projekt a zavést srozumitelnou cestu vývoj → rychlý test → integrace/aplikace → PR → publikace → provoz.
- Zachovat existující funkce a omezení providerů, bezpečnost oprávnění, durable identity a kompatibilitu vydaných klientů.
- Dokončit přechod na nový sync podle skutečných zdrojů. C08, C09 a C10 jsou již v historii main; zbývající hybridní větve a stav aktivace potřebují vlastní inventář a podmínky ukončení.
- Z auditních hypotéz nejdřív získat reprodukci; nedělat z nich automaticky potvrzené chyby.
- Uchovat rychlé JSON scénáře nad produkčním kódem, relevantní skutečné integrace a závěrečné ověření běžící aplikace.

## Uživatelé a odpovědnosti

| Role | Potřeba |
| --- | --- |
| Člen sdíleného kalendáře | Konzistentní práva, jednoznačné výsledky změn a bezpečné retry |
| Uživatel telefonu | Fungující vydaný klient během nezávislých aktualizací serveru, cache a widgety |
| Self-hoster | Přenositelné nastavení, jasné upgrady, zálohy a obnova bez znalosti soukromého chatu |
| Přispěvatel | Jeden vstup do aktuálních pravidel, malé reprodukovatelné ověření a známé CI hranice |
| Provozovatel | Rozlišitelné čekání/selhání/zásah, jednoznačná odpovědnost za incident a release |

## Platforma a neměnné hranice

Web: apps/web. Mobil: apps/client (Expo/React Native, Android a iOS). API: Express/PostgreSQL.
Porty a jádro: packages/sync-codec, packages/provider-*, packages/sync-runtime.
Samostatný technický consumer: apps/sync-reference.
UI autorita: docs/ui/design-system.md, packages/design-system a apps/web/src/components/ui.

Platí AGENTS.md, sync-profile-v1, sync-operation-v1 a dosavadní provider/host omezení. Produktový a peer floor zůstává 0.2.0; task mutation protokol má vlastní hranici 0.2.2. Návrh neschvaluje jejich zvýšení. MIT licence, soukromé workspace balíčky a omezený alpha kontrakt se samy nemění.

## První hodnotný rozsah a non-goals

První implementační checkpoint po přijetí plánu sjednotí aktuální vstupní dokumentaci a mapu autorit. Bezpečnostní reprodukce může běžet jako oddělený prioritní checkpoint před změnou federace.

Mimo rozsah tohoto plánování: aplikování změn kódu, deploy, veřejná SDK/registry publikace, nový Relay, provider push, cluster/mixed-worker podpora, nové provider schopnosti, globální redesign UI a změny právních slibů/SLA.

## Jak hodnotit výsledek

- Nový člověk najde platný návod, vybere nejmenší relevantní test a rozumí, co jeho zelená znamená.
- Každá sync rodina má deklarovanou routu, authority, compatibility/unsupported hranici a důkaz před změnou.
- Upgrade se starými pending/uncertain operacemi nezmění přijatou projekci, nevynutí nový encoder a neobnoví právo na odeslání.
- Archivované plánování, merge, image, distribuce telefonu a nasazení jsou samostatné doložené skutečnosti.
- Každý přijatý checkpoint má vlastní stop condition, požadavky, relevantní kontroly a nezávislý review.

## Vlastnictví dokumentů

Tento brief vlastní záměr; nemá být další runtime ani release inventář.
OpenSpec vlastní cílové požadavky, design a úkoly změny.
Stávající protokoly vlastní jejich konkrétní sémantiku až do explicitního synchronizování přijatých změn.
Historické acceptance záznamy zůstávají historií. .spec-pilot.json je navigační index.
Současná navržená změna: [sjednocení workflow a dokončení sync přechodu](../../openspec/changes/align-project-workflows-and-complete-sync/proposal.md).

Nejbližší krok: nezávisle zrevidovat návrh a implementační checkpointy. Konec této relace: připravené plánovací artefakty a review; implementace vyžaduje další pokyn.
