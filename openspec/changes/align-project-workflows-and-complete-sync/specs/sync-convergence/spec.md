# Spec Delta

## Purpose

Dokončit a doložit přechod Musubi na sdílenou sync orchestraci po konkrétních rodinách bez opětovné implementace již dodaného jádra, změny přijatých operací nebo neodůvodněného rozšíření provider slibů.

## ADDED Requirements

### Requirement: SC-01 Přechod má úplný rodinný inventář
Každá podporovaná provider/action/shape rodina SHALL mít určenou authority, vybranou cestu, portable nebo host-compatibility profil, upgrade/recovery hranici a acceptance gate. Zdrojová implementace, instalovaný consumer, publikace a aktivace SHALL mít samostatný status.

#### Scenario: Historická roadmapa tvrdí že C08 až C10 čekají
- **WHEN** aktuální main již obsahuje jejich merge a funkční cesty
- **THEN** nový plán je označí za existující výchozí stav a zbylý rozsah odvodí z konkrétních rout a evidence, nikoli ze starého tracker statusu

#### Scenario: Rodina není pokrytá portable profilem
- **WHEN** inventář narazí na stávající host-specialized operaci
- **THEN** označí ji jako explicitní host compatibility nebo unsupported a nesmí ji připsat k jiné portable rodině

### Requirement: SC-02 Zápis má jedinou účinnou orchestraci
Převáděná rodina SHALL mít právě jednu účinnou dispatch cestu a sdílený lifecycle. Porovnávací režim nesmí provést druhý provider write. Musubi SHALL nadále rozhodovat o lokálním CAS, ACL/privacy a durable admission/ACK; transport ani runtime je nesmí nahradit.

#### Scenario: Nová cesta se porovnává se starou
- **WHEN** se ověřuje zachování stejného přijatého zápisu
- **THEN** srovnání nesmí vyvolat dvě skutečné mutace a výsledná cesta zachová původní identity, oprávnění a side-effect hranice

### Requirement: SC-03 Retained data se znovu nekódují
Upgrade MUST zachovat accepted projection, původní serializer/profile verzi, resource/family identity, original slot, predecessor, source/grant capture a nejistotu. Chybějící envelope smí znamenat jen explicitní v0 host profil (legacy-v0 v decoderu, retained-v0 v hostu), včetně živého admission; přítomný neznámý nebo chybný formát MUST skončit bezpečným HOLD bez fallback write.

#### Scenario: Pending operace vznikla před novým encoderem
- **WHEN** ji převezme nový worker
- **THEN** použije její původní přijatá data a oprávnění; nesmí vyrobit nový native plán pouze proto, že je dostupný novější mapper

#### Scenario: Pinned serializer není podporovaný
- **WHEN** worker načte jinak validní řádek s neznámým serializerem
- **THEN** neodešle HTTP, zachová evidence/uncertainty a nevybere legacy větev

### Requirement: SC-04 Původní provider guarantee zůstává pravdivá
Konvergence MUST zachovat conditional, guarded-preflight, observe-only a non-idempotent rozdíly. Extrakce do společného runtime sama nesmí měnit unsupported capability, notification outcome, time/recurrence hranice ani permission policy.

#### Scenario: Graph DELETE má guarded profil
- **WHEN** se přesune jeho lifecycle do sdílené cesty
- **THEN** nadále přizná read-write gap a nesmí začít tvrdit silný CAS nebo slepě opakovat uncertain delete

#### Scenario: RSVP může odeslat notifikaci
- **WHEN** existuje possible-send marker nebo markerless historická operace podle no-resend politiky
- **THEN** kompatibilní reader zachová read-only recovery a retry nesmí markerem obnovit právo na další odeslání

### Requirement: SC-05 Legacy větev má doložený exit gate
Vyřazení admission cesty nebo decoderu MUST být schválené po rodině a doložit živé v0 admission, aktivní i retained data, podporované obnovy/peery, minimální reader a bezpečné zacházení se starým vstupem. Nulový počet současných pending řádků sám nestačí. Nevyřaditelná compatibility SHALL mít jednoznačného správce a testy.

#### Scenario: Fronta je nyní prázdná, ale podporovaný backup obsahuje v0
- **WHEN** se navrhne odstranění v0 decoderu
- **THEN** checkpoint zůstane blokovaný, dokud není zachovaný kompatibilní reader nebo přijatá a ověřená upgrade/recovery hranice

#### Scenario: Prázdná fronta stále připouští nové v0 operace
- **WHEN** daná rodina dál používá v0 admission
- **THEN** její decoder zůstane podporovaný; prázdná fronta není exit gate

#### Scenario: Host-only rodina zůstává dlouhodobě nativní
- **WHEN** ji nelze bez změny guarantee bezpečně portovat
- **THEN** může zůstat za explicitním host portem se sdílenou orchestrací; musí mít stejný inventář, vlastníka a regresní gate

### Requirement: SC-06 Sdílené jádro zůstává nezávislé na Musubi
Portable profily SHALL být ověřitelné samostatným hostem s vlastní persistencí a credential správou bez Musubi DB, auth, memberships a app konfigurace. Technický alpha consumer nesmí být označen za obecný pull host ani veřejně podporovaný SDK bez samostatného přijetí.

#### Scenario: Instaluje se technický alpha artefakt
- **WHEN** ověření proběhne mimo checkout s čistým home/cwd
- **THEN** musí používat vlastní deklarované závislosti a záznam uvést skutečný runtime/platform/profile rozsah

### Requirement: SC-07 Přepnutí rodiny má měřitelnou acceptance
Každá změna účinné cesty MUST mít relevantní produkční scénáře, skutečné host/native integrace a podle dotčené hranice crash/upgrade/installed ověření. Existující 0.2.16 foreground a OAuth authority regresní záruky MUST být zachovány.

#### Scenario: Přepíná se personal nebo specialized rodina
- **WHEN** finální review rozhoduje o přijetí
- **THEN** dostane source-bound výsledek normálního, denied/unsupported, uncertain, retirement a recovery toku; stará acceptance jiných bajtů jej nesmí nahradit
