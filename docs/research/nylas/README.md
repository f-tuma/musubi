# Studie synchronizace kalendářů mezi providery

**Nylas, Musubi a alternativní architektury. Zpracováno 12. října 2026.**

**Výchozí audit před C01:** popis Musubi je připnutý ke commitu
`99e613f4d43336131b844b62c3d0c06635ff5964`. Zachycuje stav před refactorem.
Task deadline, retry a propojení recovery s pollingem následně řeší
[MUSU-32](../../planning/MUSU-32-delivery-recovery.md). Aktuální postup je v
[roadmapě](../../planning/sync-refactor-roadmap.md); původní audit zachováváme
pro porovnání a zdůvodnění změn.

Nylas je velmi dobrá inspirace pro rozdělení integračního API a jeho ergonomii. Musubi řeší navíc domácí autoritu, trvalé lokální změny, více provider projekcí, privacy a obnovu po nejistém zápisu. **Doporučení je zachovat tyto záruky, sjednotit provozní runtime a postupně vyjmout otevřený sync kontrakt a adaptéry.** Přepsání podle jednoduchých Nylas CRUD ukázek by některé naše schopnosti odstranilo.

Studie obsahuje přibližně **22 tisíc slov**, devět odborných kapitol, zdrojový registr, úplný inventář veřejného Nylas sitemapu a implementační backlog. Podrobnosti mají odkazy na primární zdroje a na skutečný Musubi kód. Jde o výsledky výzkumu a návrh; produkční implementace nebyla změněna.

## Doporučené čtení

| Dokument | Co v něm najdete |
| --- | --- |
| [01 — Závěry a rozhodnutí](./01-findings-and-decisions.md) | Co se nám hodí, co chránit a kde máme skutečný dluh |
| [02 — Normalizace kalendářů Nylas](./02-calendar-normalization.md) | Provider matice, identity, čas, recurrence, RSVP, iCloud, konflikty |
| [03 — Synchronizace, auth a provoz](./03-sync-auth-operations.md) | v3/v2, grants, tokeny, webhooky, retry, historický otevřený engine |
| [04 — Audit současného Musubi](./04-musubi-audit.md) | Ověřené toky a zdrojové řádky, skutečná složitost, silné stránky a mezery |
| [05 — Návrh protokolu a plán](./05-protocol-and-plan.md) | Identity, model, coverage, capabilities, delivery, moduly, 20 úkolů, migrace a testy |
| [06 — Aurinko, Nango, vdirsyncer](./06-alternative-architectures.md) | Jednotné delty, programovatelný runtime a baseline dvojice stores |
| [07 — Cronofy](./07-cronofy-reference.md) | Managed IDs, action capabilities, časové okno a invalidation/pull |
| [08 — DAVx⁵ a EteSync/Etebase](./08-open-source-references.md) | DAV preservation, optional push, conflict policy, šifrovaný native sync |
| [09 — SDK, sousední modely a standardy](./09-sdk-and-adjacent-models.md) | Statický Node SDK audit, email/contacts lekce, availability, RFC/JSCalendar |
| [10 — Zdroje a pokrytí výzkumu](./10-source-inventory.md) | Reprodukovatelnost, citované URL, co bylo jen inventarizováno |

Pro rozhodnutí o první práci stačí kapitoly **01 → 04 → 05**. Ostatní vysvětlují, na kterých externích podkladech návrh stojí a kde je dokumentace nejednoznačná.

## Nejdůležitější výsledky

- **Neodstraňovat časovou a identitní sémantiku.** Zoned/floating/all-day, original occurrence slot a scoped provider locators jsou potřeba pro korektní round-trip a privacy.
- **Sjednotit event/task runner.** Největší rychlý přínos mají deadline, cancellation, Retry-After, backoff a nezávislá background recovery.
- **Oddělit adaptéry od databáze.** Současný CalendarAdapter nese @musubi/db kontexty; veřejné provider balíčky potřebují storage-free model a credential/HTTP porty.
- **Verzovat skutečně přijatou projekci.** Generic event cesta ji dnes znovu počítá aktuálním serializerem. Samotné nové operation ID tuto migrační hranici neřeší.
- **Odlišit coverage od smazání.** Současný Graph reset/sweep může z absence v okně vytvořit domácí tombstone a další delete záměry. Přechod na eviction potřebuje samostatnou acceptance.
- **Rozlišit conditional a guarded writes.** Vybrané Graph delete používá preflight s přijatým závodem; není správné ho prezentovat jako CAS DELETE.
- **Webhook použít jako durable trigger.** Signature → durable enqueue → ACK → běžný pull. Polling repair zůstává, včetně self-host instalací.
- **Otevřít kontrakt spolu s conformance sadou.** Malý reference host, capability profiles, crash traces, přesné receipts a známé limity budou větší přínos než široká neověřená promise „všechny providery stejně“.

## Rozsah a míra jistoty

Nylas veřejný sitemap při načtení obsahoval **1 203 URL**. Vytvořili jsme inventář všech těchto adres; **neznamená to, že jsme přečetli obsah všech 1 203 stránek**. Obsahový audit se soustředil na kalendáře, auth/connectors/grants, změnové notifikace, retry/rate limits, v3 migraci, relevantní SDK a historický engine. Email, contacts a scheduler jsme prošli tam, kde poskytují přenositelné architektonické lekce. Notetaker, AI Agent Accounts, UI komponenty a každá jazyková implementace SDK nebyly předmětem úplného auditu.

Studie má přes stovku přímých externích URL; část z nich představuje alias či jinou verzi stejného zdroje. Registr přesně odděluje citované stránky od adres pouze nalezených v sitemapu. Doplněné služby jsou reference rozdílných architektur, nikoli naměřené pořadí kvality dodavatelů.

Použité druhy důkazů:

1. **Doloženo:** veřejná primární dokumentace nebo explicitní chování zdrojového kódu.
2. **Statické pozorování:** porovnání dokumentace, příkladů a implementace bez běhu na externím účtu.
3. **Odvození:** pravděpodobný architektonický důsledek, výslovně označený.
4. **Návrh:** naše doporučená policy či nový kontrakt; není současné API.
5. **Otevřená otázka:** chybějící veřejný důkaz či rozpor, který vyžaduje experiment.

Současný produkční backend Nylas je neveřejný. Historický otevřený sync-engine je samostatně označený a nepovažujeme jej za dnešní v3. Nepřítomnost CAS nebo replay v prohlédnuté referenci neprokazuje, že ho dodavatel interně nemá; nedává nám ale záruku, na kterou lze spoléhat.

## Ověření a reprodukovatelnost

Musubi audit vychází z commitu **99e613f4d43336131b844b62c3d0c06635ff5964**. Node SDK z **fabe2d679baf20f45f941a7148544acb2434aafa**, historický Nylas engine z **50698996aef73102ead592e8d0948c1d2edfe123** a DAVx⁵ z **0fc9500076c71f97eb1905e84106441df0a7c5da**. Úplné zdrojové odkazy jsou v jednotlivých kapitolách.

Proběhlo statické čtení veřejných zdrojů, lokální audit reprezentativních toků, sedm cílených čistých kontrol Musubi a nezávislá revize návrhu dalšími výzkumnými agenty. Opraveny byly mimo jiné nepřesné předpoklady o metadata konverzi SDK, immutable projection, Graph sweep a conditional DELETE. Živé provider zápisy, nový PostgreSQL failure experiment, benchmark služby ani produkční aktivace neproběhly.

Dokumenty jsou uchované v repozitáři a tvoří jeden výzkumný celek. Dated implementační audity a veřejná capability matrix zůstávají autoritou pro aktuálně podporované operace; tento návrh je nenahrazuje.
