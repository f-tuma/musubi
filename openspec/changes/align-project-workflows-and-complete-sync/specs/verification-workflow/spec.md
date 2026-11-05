# Spec Delta

## Purpose

Poskytnout rychlou a pravdivou zpětnou vazbu při vývoji a jednoznačnou cestu k finálnímu ověření bez druhé implementace business pravidel nebo skrytého vynechání kontrol.

## ADDED Requirements

### Requirement: VT-01 Rychlý scénář cvičí skutečnou logiku
Rychlé scénáře SHALL volat produkční funkce nebo komponenty a nahrazovat závislosti na existujících portech. Výsledek MUST rozlišit pass, failure a chybu runneru. Neznámé ID, prázdná povinná sada a nespotřebovaná fixture MUST skončit neúspěchem.

#### Scenario: Vybere se jediný scénář
- **WHEN** vývojář zadá existující suite a scenario ID
- **THEN** běží vybraná produkční cesta, report uvede skutečný počet, trvání a nahrazené hranice

#### Scenario: Vybraný scénář neexistuje
- **WHEN** vstup obsahuje neznámé ID
- **THEN** runner vrátí neúspěch a nesmí jej vydat za úspěšný běh s nulou případů

### Requirement: VT-02 Inventář a skutečný vstup se nemohou tiše rozejít
Projekt SHALL kontrolovat dosažitelnost požadovaných testů a shodu deklarovaného inventáře s reálnou selekcí. Doporučený společný vstup SHALL být sám ověřen skutečným spuštěním. Frozen konformance MUST zůstat nezávislým očekáváním a její změna vyžaduje věcný diff a review.

#### Scenario: Přibude nový behavior případ
- **WHEN** se změní korpus produkčních scénářů
- **THEN** kontrola ukáže rozdíl registry, vykonaných případů a frozen očekávání; nesmí automaticky přijmout novou podobu kontraktu

#### Scenario: Regex produkčního smoke přestane vybírat povinný test
- **WHEN** se přejmenuje povinný titul nebo změní výběr
- **THEN** kontrola selekce odmítne neúplnou sadu před tvrzením, že produkční smoke prošel

### Requirement: VT-03 Ověření má přiznané hranice
Každý checkpoint SHALL uvést příslušné vrstvy ověření: statickou, rychlou, integrační, aplikační a případnou live/artifact. Změna persistence, auth nebo provider dispatch MUST mít skutečné ověření dotčené hranice. API fixtures v browseru tyto důkazy nenahrazují.

#### Scenario: Změní se scheduler a durable ACK
- **WHEN** checkpoint zasáhne interakci poolu, budgetu a DB claimu
- **THEN** vedle rychlých scénářů proběhne relevantní PG/HTTP test v produkčním složení a následné ověření změněného toku běžící aplikací

#### Scenario: Browser běží proti fixture API
- **WHEN** report obsahuje úspěšný UI průchod
- **THEN** označí mockované hranice a nesmí tvrdit ověření skutečných oprávnění, DB nebo provider zápisu

### Requirement: VT-04 Prostředí testu je reprodukovatelné a vlastněné
Testy vyžadující lokální protokolový server, databázi nebo zařízení SHALL uvést verze, konfiguraci, přístup a vlastnictví zdrojů. Úklid MUST zasáhnout pouze prokazatelně vlastní zdroje. Nesplněný předpoklad se nesmí tiše změnit v pass.

#### Scenario: Čistý checkout spouští CalDAV lane
- **WHEN** je zvolen test s lokálním CalDAV serverem
- **THEN** má verzovaný nebo explicitně připnutý startovací předpis bez závislosti na soukromém HOME; výsledek Radicale nesmí certifikovat iCloud

#### Scenario: Databázi stále používá neznámý klient
- **WHEN** cleanup nemá důkaz vlastnictví nebo nulových sessions
- **THEN** odmítne destruktivní úklid a zachová konkrétní diagnostiku místo force drop či ukončení cizího procesu

### Requirement: VT-05 Finální kontrola odpovídá deklaraci
Projekt SHALL rozlišit cílenou edit-loop sadu a úplné finální kontroly. Příkaz označený jako úplný MUST buď pokrýt deklarované CI hranice, nebo přesně uvést zbývající platformní/externí gates. Povinné branch kontroly se nesmí obejít lokálním reportem.

#### Scenario: Dokumentace doporučí finální příkaz
- **WHEN** přispěvatel čte, že příkaz ověří vše
- **THEN** uvedená definice zahrnuje skutečné DB, UI/native a konformační gates nebo výslovně pojmenuje jejich samostatné vykonání

### Requirement: VT-06 Native a meziplatformní důkaz je konkrétní
Sdílený widget nebo klientský wire kontrakt SHALL mít ověření konzumentů na příslušných platformách. Build, parser fixture, shipped artifact scan a test podepsané aplikace SHALL být vykázány odděleně.

#### Scenario: Změní se widget snapshot
- **WHEN** se změní jeho formát nebo význam
- **THEN** kompatibilitu ověří skutečné TS/Kotlin/Swift konzumenty relevantních platforem a finální běžící aplikace; APK build sám nesmí být označen za device behavior test
