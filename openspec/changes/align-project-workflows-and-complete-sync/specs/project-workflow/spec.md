# Spec Delta

## Purpose

Umožnit přispěvateli i provozovateli najít platný záměr, pravidla a ověřovací cestu bez soukromé historie projektu a rozlišit plán od skutečně dodané změny.

## ADDED Requirements

### Requirement: WF-01 Jedna autorita pro každou odpovědnost
Projekt SHALL pro záměr, produktové/protokolové chování, UI, příkazy a aktuální release určit kanonický zdroj. Ostatní vstupy na něj SHALL odkazovat nebo strojově ověřovat shodu. Historický záznam SHALL mít datum a nesmí být vydáván za aktuální pokyn.

#### Scenario: Nový přispěvatel otevře README
- **WHEN** přispěvatel hledá současnou verzi a návod k testování
- **THEN** README jej dovede na platné autority a neuvádí rozpornou kopii aktuálního stavu

#### Scenario: Historický acceptance záznam zůstává dohledatelný
- **WHEN** se publikuje další verze
- **THEN** předchozí záznam zůstane zachován se svým původním rozsahem a nebude použit jako důkaz nového nasazení

### Requirement: WF-02 Reprodukovatelný vstup do vývoje
Projekt SHALL deklarovat podporovaný toolchain a předpoklady prostředí tak, aby nový checkout mohl provést dokumentovanou rychlou smyčku. Návody, lokální doporučení a CI SHALL mít ověřovanou kompatibilitu verzí a uvádět odlišnosti platforem.

#### Scenario: Lokální doporučení se rozejde s CI
- **WHEN** změna doporučí jinou hlavní runtime verzi bez ověřené podpory
- **THEN** kontrola koherence označí nesoulad a návod nesmí tento runtime vydávat za ověřený

### Requirement: WF-03 Checkpoint má rozsah a konec
Každý implementační checkpoint MUST uvést požadavky, očekávaný výsledek, relevantní kontroly a stop condition. Za dokončený smí být označen až po jejich skutečném vyhodnocení a nezávislém review přesné finální revize. Mechanický SPEC/OpenSpec pass ani hash sám schválení nenahrazuje.

#### Scenario: Změní se revidovaný vstup
- **WHEN** se po schválení materiálně změní design nebo implementace
- **THEN** dotčené review a ověření se znovu otevře a starý souhlas se nepřenese na nové bajty

#### Scenario: Plánování je dokončené
- **WHEN** existují proposal, specs, design a tasks a jejich review
- **THEN** stav znamená připravený návrh, nikoli implementaci, merge, publikaci nebo oprávnění pokračovat za hranici aktuálního zadání

### Requirement: WF-04 Auditní tvrzení mají rozlišený status
Projekt SHALL evidovat, zda je nález staticky doložený, reprodukovaný, hypotetický, vědomý kompromis nebo odložený. Každý nález zahrnutý do tohoto programu SHALL mít dohledatelný požadavek, checkpoint nebo důvod odložení.

#### Scenario: Review narazí na nedoloženou auth hypotézu
- **WHEN** audit odvodí možný problém závislý na chování knihovny
- **THEN** plán určí cílené ověření a nesmí z tohoto odvození udělat potvrzený incident ani automatické povolení měnit produkt
