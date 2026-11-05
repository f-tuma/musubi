# Spec Delta

## Purpose

Zajistit dohledatelný a opakovatelný přechod od schváleného zdroje ke konkrétnímu artefaktu a runtime, s pravdivou evidencí kompatibility, distribuce a obnovy.

## ADDED Requirements

### Requirement: PB-01 Přijatá CI evidence je skutečně čerstvá
Publikace MUST použít úplný úspěšný trusted-main běh přesného schváleného SHA podle platného Quality inventáře. Joby a povinné native kroky MUST časově patřit do přijatého attemptu. Počet a attempt label samy nestačí. Opakované nebo nejisté publikování MUST vyžadovat čtecí reconciliation.

#### Scenario: Partial rerun přebere staré úspěchy
- **WHEN** API vrátí kompletní seznam s novými IDs a attempt labelem, ale část jobů začala před startem přijatého attemptu
- **THEN** tento běh není způsobilý pro publikaci podle politiky úplného nového attemptu

#### Scenario: Předchozí publish skončil nejistou odpovědí
- **WHEN** operátor neví, zda vznikl tag nebo release
- **THEN** nejprve přečte skutečný stav a nesmí workflow slepě zopakovat ani tag přepsat

### Requirement: PB-02 Propagovaný artefakt je totožný s ověřeným
Před produkční propagací SHALL být ověřena identita, zdroj a použitelnost skutečných neměnných digestů pro deklarované platformy. Smoke jiného buildu stejného SHA nesmí být označen za ověření tohoto artefaktu.

#### Scenario: Publish znovu sestaví zdroj po Quality
- **WHEN** vznikne nový digest určený pro provoz
- **THEN** relevantní artifact/startup kontrola cvičí tento digest a zaznamená jeho platformu a prostředí

### Requirement: PB-03 Release promotion má jednoznačného konzumenta
Produkcí konzumovaný výběr artefaktů SHALL být připnutý ke schválenému vydání a jeho neměnným digestům. Propagace mutable aliasu nesmí obejít finální gate. Trigger, pořadí API/web a kompatibilní mezistav SHALL být výslovné a ověřené před aktivací změněného deployment procesu.

#### Scenario: Finální guard odmítne kandidáta
- **WHEN** po sestavení nejsou splněny podmínky releasu
- **THEN** kandidát může zůstat uložený jako artefakt, ale produkční automatika ani posunutý latest jej nesmí vydávat za přijaté vydání

#### Scenario: Web a API nemohou být změněny atomicky
- **WHEN** probíhá propagace dvou služeb
- **THEN** rollout použije doložené pořadí nebo kompatibilní mezistav; Docker StartedAt sám neprokazuje aplikační readiness

### Requirement: PB-04 Source, distribuce a runtime jsou samostatné skutečnosti
Release záznam SHALL oddělit implementaci, CI, publication, runtime aktivaci a uživatelské/live ověření. Vše SHALL být svázáno s konkrétní revizí či artefaktem. Retence důkazů MUST umožnit deklarované následné ověření.

#### Scenario: API/web hotfix neobsahuje mobilní distribuci
- **WHEN** se vydá kompatibilní serverová oprava
- **THEN** evidence uvede serverové a webové artefakty a ponechá samostatný poslední distribuovaný Android/iOS build a kanál

#### Scenario: Artefakt s povinným důkazem již expiroval
- **WHEN** verifier nemůže stáhnout požadované skutečné bajty
- **THEN** hlásí neúplné ověření, nikoli zpětně vytvořený pass založený jen na metadatech

### Requirement: PB-05 Obnova používá konkrétní recovery smlouvu
Provozní postup SHALL určit odpovědnou osobu, zálohu, potřebné neveřejné recovery reference a kompatibilní reader/writer hranici. Drill SHALL používat izolovanou kopii, nikoli obnovu do produkce jako test. Neprokázaná old-binary kompatibilita MUST znamenat HOLD.

#### Scenario: Starý binární writer nezná retained marker
- **WHEN** je navržen rollback pod barrier-aware nebo serializer floor
- **THEN** postup odmítne běžné spuštění tohoto writeru bez samostatně ověřené ochrany; nesmí vymazat marker či přepsat přijatý intent

#### Scenario: Záznam o drillu není ve veřejném repu
- **WHEN** reviewer posuzuje schopnost obnovy
- **THEN** vyžádá oprávněnou evidenci nebo uvede unknown; nesmí odvodit, že obnova nikdy neproběhla, ani požadovat zveřejnění klíčů

### Requirement: PB-06 Provozní převzetí je rozsahové
Aktivace SHALL uvést konkrétní služby, schema/config profil, počet writerů, health/readiness a relevantní smoke. Jeden úspěšný provider/account nebo UI průchod nesmí certifikovat všechny rodiny či prostředí.

#### Scenario: Sdílené jádro má lokální alpha PASS
- **WHEN** source a instalovaný reference korpus prošly
- **THEN** veřejná registry distribuce, obecný pull host a produkční aktivace zůstávají samostatnými neprokázanými závěry
