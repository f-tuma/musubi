# Spec Delta

## Purpose

Udržet synchronizaci a interaktivní zápisy omezené, férové a provozně čitelné při čekání na budget, selhání providera, změně oprávnění a ukončení procesu.

## ADDED Requirements

### Requirement: SR-01 Stav čeká není neznámý provider výsledek
Systém SHALL odlišit odklad před raw dispatch, skutečně nejistý výsledek po možném dispatch a definitivní odmítnutí. Po lokálním commitu MUST zachovat pravdivé localCommitted a durable identity. Známé čekání se nesmí vydávat za síťový pád; nejistota se nesmí snížit na bezpečný queued stav.

#### Scenario: Durable práce je odložená bez provider HTTP
- **WHEN** byl lokální zápis uložen a planner vrátí známou budoucí eligibility
- **THEN** odpověď a diagnostika uvedou čekající doručení s existující identitou a nepřidají nepravdivý provider failure

#### Scenario: Provider mohl přijmout CREATE
- **WHEN** se ztratí odpověď po možném odeslání
- **THEN** zůstane nejistý výsledek a action-specific reconciliation; nesmí vzniknout nový CREATE pouze z klientského retry

#### Scenario: Preflight skončí před lokálním commitem
- **WHEN** nelze v platném deadline prokázat oprávnění
- **THEN** odpověď přizná neuložený stav a skutečnou kategorii příčiny bez tvrzení, že byla událost uložená

### Requirement: SR-02 Čekání zachovává férovost i authority
Eligible práce SHALL postupovat při zachování deklarovaných globálních/account/collision mezí. Budget a OAuth čekání nesmí držet nepotřebnou fyzickou kapacitu ani zrušit práci ostatních waiterů. Resume MUST znovu ověřit claim, source, grant a cancellation.

#### Scenario: Background pull stejného účtu je zaparkovaný
- **WHEN** dorazí způsobilý foreground zápis a jeho skutečné dispatch gates jsou volné
- **THEN** může postupovat v rámci přijaté bounded policy bez paralelního porušení account/collision serializace

#### Scenario: Jeden OAuth waiter se zruší
- **WHEN** stejnou refresh závislost používá další platný waiter
- **THEN** cancellation prvního nesmí zrušit refresh druhého ani oživit zrušenou operaci

### Requirement: SR-03 Log identita patří vykonané práci
Sdílená background práce SHALL logovat vlastní bounded korelaci nebo explicitně žádnou uživatelskou identitu. Nesmí zdědit cizí requestId/userId jen tím, že ji probudil jiný request. Diagnostika MUST redigovat secrets a nerozšiřovat high-cardinality metric labels.

#### Scenario: Request účtu A probudí pump vykonávající práci B
- **WHEN** background executor B zaznamená výsledek
- **THEN** log není přiřazen requestu nebo uživateli A a izolace loggeru nesmí zrušit skutečné permit/cancellation kontexty

### Requirement: SR-04 Zásah má vlastníka a pozorovatelný signál
Pro čekající automatickou práci a stavy vyžadující zásah SHALL být určen vlastník, signál a postup. Alerty SHALL pokrývat relevantní event i task fronty a stáří skutečně nepostupující práce. Trvalá nezpůsobilost zdroje se nesmí neomezeně tvářit jako nový nečekaný incident.

#### Scenario: Operace zůstane blocked nebo conflict
- **WHEN** se sama nemůže bezpečně dokončit
- **THEN** je viditelná příslušnému uživateli nebo provozovateli s popsaným postupem; retry nesmí bez nového oprávnění obnovit dispatch

#### Scenario: Microsoft účet nemá použitelnou mailbox službu
- **WHEN** je tato způsobilost spolehlivě rozpoznaná
- **THEN** zůstane viditelný konkrétní stav zdroje a neovlivněné dostupné zdroje; klasifikace nesmí skrýt skutečné nové selhání

### Requirement: SR-05 Ukončení procesu má bounded postup
Při řízeném ukončení SHALL host zastavit nové přijímání práce a provést bounded dokončení či bezpečné předání podle deklarované policy. Tvrdý pád MUST zůstat kryt durable recovery. Shutdown nesmí předčasně ACKnout, přepsat uncertain evidence nebo uvolnit cizí claim.

#### Scenario: Přijde SIGTERM během provider zápisu
- **WHEN** se proces pokusí skončit do shutdown budgetu
- **THEN** zachová skutečné acceptance/uncertainty a lease fencing; překročení budgetu vede na stávající crash recovery bez slepého opakování side effectu

### Requirement: SR-06 Čas a capacity jsou pojmenované politiky
Host SHALL deklarovat mez kapacity, časové domény a watchdog/attempt budgety. Změna těchto politik MUST mít příslušné saturace, cancellation a clock-boundary důkazy; prodloužení timeoutu nesmí samo zakrýt chybné čekání.

#### Scenario: Změní se porovnání DB due time a lokálního clock
- **WHEN** planner rozhoduje, zda smí práci spustit
- **THEN** zůstane respektována durable eligibility a lokální refill/cooldown politika i při omezeném clock skew a po restartu
