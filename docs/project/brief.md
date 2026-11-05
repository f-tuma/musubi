# Musubi — záměr a hranice projektu

Stav: stávající záměr převzatý ze zdrojů; vlastník 5. listopadu 2026 zadal postupnou realizaci programu sjednocení, počínaje CP01. Přijetí směru není dokončení tasků ani deployment.
Vlastník záměru: Filip Tůma. Výchozí zdroj: b138056218aab1e3b01b69d7e53b3713a553dfcd.

## Vize a hlavní zkušenost

Musubi propojuje lidi, sdílené kalendáře, události a úkoly v jednom self-hostovatelném produktu. Uživatel pracuje přes web nebo mobil, může připojit Google, Microsoft a CalDAV/iCloud a smí rozlišit lokální uložení, čekající doručení, potvrzení providera a stav vyžadující zásah.

Domácí obsah, členství, práva a federace patří Musubi. Sdílené sync jádro poskytuje přenositelné mechanismy s explicitními host porty a doloženými profily. Samostatný reference host ověřuje extrakci; Calendar Relay zůstává samostatným pozdějším produktem.

## Zadání vlastníka a přijatý směr

Vlastník požádal o sjednocení projektu, jasné workflow testů/publikace a zahrnutí skutečného zbytku sync přechodu i auditních pozorování. Vlastník následně zadal začít realizaci po checkpointech; aktuální přijatý slice je CP01 docs. Tento souhlas neřeší otevřená produktová rozhodnutí D1–D5 ani neautorizuje deployment:

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

Platí AGENTS.md, sync-profile-v1, sync-operation-v1 a dosavadní provider/host omezení. Aktuální klientské a peer minimum vlastní middleware require_client_version, task wire smlouva a docs/releasing.md. Brief jejich číselné hodnoty nekopíruje; navržený program sám jejich zvýšení neschvaluje. MIT licence, soukromé workspace balíčky a omezený alpha kontrakt se samy nemění.

## První hodnotný rozsah a non-goals

První implementační checkpoint po přijetí plánu sjednotí aktuální vstupní dokumentaci a mapu autorit. Bezpečnostní reprodukce může běžet jako oddělený prioritní checkpoint před změnou federace.

Mimo rozsah aktuálního dokumentačního slice CP01: změny runtime kódu a toolchainu, deploy, veřejná SDK/registry publikace, nový Relay, provider push, cluster/mixed-worker podpora, nové provider schopnosti, globální redesign UI a změny právních slibů/SLA.

## Jak hodnotit výsledek

- Nový člověk najde platný návod, vybere nejmenší relevantní test a rozumí, co jeho zelená znamená.
- Každá sync rodina má deklarovanou routu, authority, compatibility/unsupported hranici a důkaz před změnou.
- Upgrade se starými pending/uncertain operacemi nezmění přijatou projekci, nevynutí nový encoder a neobnoví právo na odeslání.
- Archivované plánování, merge, image, distribuce telefonu a nasazení jsou samostatné doložené skutečnosti.
- Každý přijatý checkpoint má vlastní stop condition, požadavky, relevantní kontroly a nezávislý review.

## Vlastnictví dokumentů

Tento brief vlastní záměr, nikoli runtime nebo release inventář. Ostatní vstupy na následující autority odkazují:

| Odpovědnost | Autorita | Hranice |
| --- | --- | --- |
| Projektový záměr a vlastnictví dokumentů | Tento brief | Nevydává plán za implementaci |
| Pravidla práce agentů | [AGENTS.md](../../AGENTS.md) | Příslušné scoped skills platí navíc |
| Normativní sync sémantika | [sync-profile-v1](../protocol/sync-profile-v1.md), [sync-operation-v1](../protocol/sync-operation-v1.md) a jejich odkazované kontrakty | Platí do explicitně přijaté změny; nový delta návrh je sám nenahrazuje |
| Cílové požadavky, návrh a průběh programu | [OpenSpec change](../../openspec/changes/align-project-workflows-and-complete-sync/proposal.md), jeho specs/design/tasks a přijaté checkpoint briefs | Checkbox done vyžaduje skutečné ověření a nezávislý review; archiv sám není release |
| Web UI | [musubi-ui](../../.agents/skills/musubi-ui/SKILL.md), [design system](../ui/design-system.md), packages/design-system a apps/web/src/components/ui | Native konvence se nepřenášejí automaticky na web; žádný druhý token/komponentový zdroj |
| Skutečné příkazy a CI | [package.json](../../package.json), package scripts a [Quality](../../.github/workflows/quality.yml) | Návody obsahují vybrané příklady, nikoli nezávislý úplný inventář |
| Contributor workflow a lokální setup | [contributing.mdx](../../packages/docs/src/content/docs/guides/contributing.mdx), [running-locally.mdx](../../packages/docs/src/content/docs/guides/running-locally.mdx) | Onboarding je výukový kurz, command reference navigace; toolchain nesoulad řeší samostatný 1.3 |
| Rychlé JSON scénáře | [behavior-scenarios.md](../testing/behavior-scenarios.md) a skutečný --list | Fixtures neprokazují DB/auth/provider; zvolit relevantní scénář a finální dotčené hranice |
| Aktuální release a obecný upgrade/recovery postup | [docs/releasing.md](../releasing.md) | Source, image, native distribuce a runtime jsou samostatné skutečnosti |
| Publication proof a promotion | [publication.md](../releases/publication.md) | Current-head Quality není sama produkční aktivace |
| Capability a provozní evidence | Datované [capabilities.mdx](../../packages/docs/src/content/docs/operations/capabilities.mdx), [observability](../observability.md) a jejich konkrétní kontrakty/receipts | Datum přehledu není tvrzení o aktuálním runtime všech providerů |
| Historie | Datované acceptance, audity a staré roadmapy v docs | Zachovat datum/zdroj/rozsah; neoznačovat je jako aktuální pokyn |
| Its a Plan frgtn.MUSU | Přehled CP01–CP12 s odkazy na kanonické úkoly a PR | Vlastník výslovně přijal tuto roli 5. listopadu 2026. Tracker není druhá autorita požadavků ani důkaz merge/runtime |

.spec-pilot.json je pouze navigační index. Dočasné slice checks se před finálním review/mergem vracejí ke sdílené mapě; skutečné příkazy, revize a výsledky zůstávají v acceptance checkpointu. Dřívější C01–C10 jsou implementační historie, další konvergence vychází z aktuálních cest a důkazů.
Současný program: [sjednocení workflow a dokončení sync přechodu](../../openspec/changes/align-project-workflows-and-complete-sync/proposal.md).

Role specification v .spec-pilot.json naviguje cílové delta specs aktivního programu, nikoli již úplně implementované main specs. Přijetí a sync/archive mění tento stav výslovně; samotné mapování není souhlas s implementací.
