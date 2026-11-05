# Spec Delta

## Purpose

Sjednotit výklad autority a lifecycle dat mezi hostem, klienty a federací při zachování bezpečných identity hranic a explicitním rozhodnutí o nevyjasněných produktových pravidlech.

## ADDED Requirements

### Requirement: ID-01 Neověřená federovaná identita není lokální přihlašovací důkaz
Federovaný profil MUST být oddělen od důkazu vlastnictví lokálního loginu. Samotná shoda e-mailu nesmí umožnit member tokenu získat data nově přihlášeného lokálního uživatele. Rozsah federovaného principala SHALL být výslovný a vynucený na serveru.

#### Scenario: Shadow profil použije e-mail budoucího lokálního uživatele
- **WHEN** se oprávněný vlastník e-mailu později přihlásí přes skutečný auth tok
- **THEN** původní federovaný token nezíská jeho nová lokální data pouze přes tuto shodu; slučování identity vyžaduje samostatně ověřenou autoritu

#### Scenario: Test vyvrátí původní auth hypotézu
- **WHEN** izolované ověření skutečné auth knihovny prokáže bezpečné odmítnutí vazby
- **THEN** výsledek zúží nález a plán nesmí tvrdit potvrzený takeover ani provést nepotřebnou změnu identity

### Requirement: ID-02 Oprávnění mají jednotný význam
Pro každou mutaci SHALL existovat kanonické serverové rozhodnutí a konzistentně popsané klientské capabilities. Provider credential, host membership a provider proof SHALL zůstat odlišné authority. UI nesmí být bezpečnostní hranicí a žádný capability hint nesmí nahradit fresh serverovou kontrolu.

#### Scenario: Provider kalendář má neznámé write evidence
- **WHEN** klient zobrazuje dostupné akce
- **THEN** rozliší known denied a neprokázanou capability podle smlouvy serveru; server při mutaci stále provede platné kontroly

### Requirement: ID-03 Home a creator removal mají přijatou sémantiku
Před změnou mazání SHALL být přijata matice event/task × calendar/account removal × home/secondary/provider destination. Transakce, invalidace a provider intenty MUST odpovídat zvolenému výsledku. Změna nesmí nepozorovaně přidat globální delete, odstranit cizí obsah nebo obnovit write authority.

#### Scenario: Home kalendář zanikne a provider destinace přežívá
- **WHEN** se provede přijatý removal tok
- **THEN** stav kanonického obsahu, přeživších links, provider kopie a jejího recovery je doložitelně v souladu se schválenou maticí

#### Scenario: Účet tvůrce se odstraní během pullu
- **WHEN** dorazí starší provider observation nebo pozdní ACK
- **THEN** nezmění přijatou lifecycle policy ani neobejde retirement/fencing; nejasný výsledek zůstane přiznaný

### Requirement: ID-04 Delta smlouva je pravdivá
Projekt SHALL určit podporovanou deletion a cursor smlouvu klientského feedu. Pokud delta slibuje deletions, MUST je vrátit i po ztrátě posledního viditelného linku. Do ověření úplnosti SHALL zůstat full-refresh recovery zachovaná. Změna veřejného kontraktu vyžaduje kompatibilní postup.

#### Scenario: DELETE odstraní poslední link
- **WHEN** podporovaný delta konzument požádá od platného kurzoru
- **THEN** dostane smluvně určenou informaci o odstranění nebo explicitně dokumentovaný kompatibilní recovery postup; nesmí získat falešný důkaz úplnosti

### Requirement: ID-05 Opakovaná mutace zachovává původní záměr
Idempotence SHALL mít popsané actor/operation hranice, způsob replay či odmítnutí a pravdivý localCommitted. Event/task rozdíly smí zůstat jen jako explicitní kontrakt, který klient umí interpretovat. Retry nesmí změnit uloženou projekci nebo vytvořit nový cíl z chybějícího původního adresování.

#### Scenario: Klient zopakuje vytvoření po ztracené odpovědi
- **WHEN** stejný actor a původní operation identity již existují
- **THEN** odpověď dovolí bezpečně zjistit původní výsledek nebo konkrétní konflikt bez druhého CREATE

### Requirement: ID-06 Odchozí důvěra a konfigurace jsou výslovné
Uživatelem ovlivněný odchozí cíl SHALL mít guard svázaný se skutečným připojením a redirect policy. Výjimky pro privátní sítě a plaintext SHALL být explicitní. Neplatná nastavená bezpečnostní konfigurace MUST selhat rozlišitelně před novým nevratným side effectem.

#### Scenario: Operátor povolí LAN federaci
- **WHEN** změní příslušnou výjimku
- **THEN** nevznikne nedokumentované oprávnění posílat CalDAV credentials přes plaintext nebo důvěřovat další síti

#### Scenario: DNS cíl se změní mezi kontrolou a fetch
- **WHEN** probíhá guarded odchozí připojení
- **THEN** skutečný cíl nesmí obejít přijatou síťovou policy; test používá kontrolovaný port, nikoli živý útok
