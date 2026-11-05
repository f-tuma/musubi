# Spec Delta

## Purpose

Zachovat jednotný význam akcí a výsledků na webu, telefonu a widgetech při rozdílných platformách, offline stavech a nezávislém vydávání klientů.

## ADDED Requirements

### Requirement: CL-01 Nabízená mutace má podporovanou route a authority
Klient SHALL nabídnout cíl mutace jen pokud pro něj existuje podporovaný kontrakt a správné směrování. Federovaný kalendář nesmí být nabízen pro lokální task write pouze proto, že vzdálený server podporuje tasks. Serverové odmítnutí SHALL zůstat konečnou bezpečnostní kontrolou.

#### Scenario: Federovaný editor vybere task cíl
- **WHEN** domácí klient nemá přijatý task gateway kontrakt
- **THEN** nesmí nabídnout nepodporovaný zápis na domácí route; read/event schopnosti kalendáře tím automaticky nezanikají

### Requirement: CL-02 Klient rozumí fázím mutace
Web a mobil SHALL rozlišit neuloženo, uloženo/čeká, provider uncertain, konflikt a dokončeno podle typovaného kontraktu. Text síťové chyby nesmí přepsat známý doménový stav. Klient SHALL zachovat draft a původní operation identity podle příslušné retry policy.

#### Scenario: Server potvrdí lokální commit s čekajícím doručením
- **WHEN** klient zobrazí výsledek
- **THEN** nesmí uživatele navést k novému vytvoření stejného obsahu a umožní zobrazit skutečný stav doručení

### Requirement: CL-03 Refresh nesmí ztratit invalidaci ani authority scope
Klientské čtení SHALL zachovat scope serveru, identity, kalendářů a coverage. Slučování refreshů smí omezit duplicitní práci jen pokud neztratí novější dirty generation. Full snapshot recovery SHALL zůstat dostupná do prokázání úplné delta smlouvy.

#### Scenario: Foreground, SSE open a network restore žádají stejný snapshot
- **WHEN** jejich scope a požadovaná coverage souhlasí
- **THEN** klient může sdílet práci, ale po dokončení musí pokrýt i novější invalidaci vzniklou během čtení

#### Scenario: Uživatel přepne server nebo se odhlásí
- **WHEN** se dokončí starší refresh
- **THEN** jeho výsledek nesmí přepsat cache, widget ani oprávnění nové identity

### Requirement: CL-04 Reconnect má bounded session lifecycle
Web a mobil SHALL mít popsanou reconnect/backoff/cancellation policy včetně ztráty session, upgrade-required a background/foreground stavů. Žádný klient nesmí neomezeně opakovat zjevně nepoužitelnou autorizaci bez předepsaného přechodu.

#### Scenario: SSE odmítne vypršelou session
- **WHEN** je odmítnutí podle kontraktu knihovny spolehlivě rozpoznané
- **THEN** klient provede smluvní session recovery nebo odhlášení a nepokračuje v nekontrolované smyčce

### Requirement: CL-05 Widget wire je verzovaný a ověřený konzumenty
Widget snapshot SHALL mít jednu deklaraci významu a explicitní verzi s ověřením skutečných konzumentů. Neznámá nebo nekompatibilní data MUST mít bezpečný fallback bez zveřejnění obsahu jiné identity. Změněné UI SHALL zachovat přístupnost a relevantní úzké/layout/theme stavy.

#### Scenario: Starší widget načte novější payload
- **WHEN** jeho verzi neumí bezpečně číst
- **THEN** použije přijatý fallback a nezobrazí neplatný či cizí stav; test formátu musí být oddělený od testu podepsané aplikace na zařízení
