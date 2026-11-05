# Proposal

## Why

Musubi potřebuje jednotnou cestu od změny po provoz a srozumitelnou autoritu pro produktová pravidla. Audit na b138056 odhalil dokumentační a testovací drift i nevyjasněné hranice; přechod C08–C10 je již součástí main, ale současná roadmapa a hybridní sync cesty tento stav nevysvětlují.

## What Changes

- Převést záměr projektu do jednoho stručného briefu a mapovat stávající autority do SPEC bez paralelního frameworku.
- Sjednotit aktuální dokumentaci, toolchain, testovací inventář a skutečné příkazy pro rychlou smyčku a finální CI.
- Popsat a po rodinách dokončit sync přechod: portable profily, shared host compatibility, retained-v0 a unsupported případy; zachovat host authority.
- Zpřesnit čekání/selhání, log kontext, alerty, shutdown a operátorské recovery kroky.
- Reprodukovat otázky federované identity a datového lifecycle před rozhodnutím o změně jejich sémantiky.
- Sjednotit podporované capabilities a klientské toky včetně federovaných task cílů, refresh/reconnect a widget kontraktů.
- Vyjasnit publikační čerstvost CI, image promotion, source/artifact/runtime evidence a ukončení legacy cest.

Jde o plánovací část delivery. Tato změna nyní vytváří specifikaci, design a malé implementační checkpointy; nespouští apply. Neobsahuje schválenou breaking změnu. Případný budoucí breaking návrh vyžaduje vlastní explicitní rozhodnutí, kompatibilitu a recovery plán.

## Capabilities

### New Capabilities

Následující capability názvy jsou nové v prázdném OpenSpec katalogu; neznamenají, že příslušné funkce dosud neexistují.

- `project-workflow`: autority, aktuální dokumentace, toolchain a životní cyklus checkpointu.
- `verification-workflow`: rychlé produkční scénáře, inventář, konformance, integrace a UI/native hranice.
- `publication-operations`: výběr zdroje, CI provenance, image promotion, distribuce, zálohy a recovery.
- `sync-convergence`: inventář a ukončení přechodu existujících sync rodin při zachování durable kompatibility.
- `sync-reliability`: plánování, budgety, odklady, diagnostika, alerty a řízené ukončení.
- `identity-and-data`: federovaná authority, oprávnění, mazání a delta kontrakt s rozhodovacími gates.
- `client-consistency`: jednotné capabilities, směrování, výsledky mutací, refresh a widget kontrakty.

### Modified Capabilities

Žádné existující OpenSpec specs: katalog byl při začátku prázdný. Relevantní stávající smlouvy se znovu nepublikují jako již přijatá změna; vazby a přesné hranice jsou v [research.md](research.md).

## Impact

Aplikace, DB, auth, sync balíčky, CI, release nástroje a provozní návody jsou dotčené cílovým plánem, nikoli nynější implementací. Nevzniká nová testovací knihovna, UI závislost, provider capability, veřejný balíček, Relay ani podpora více writerů. Dosavadní CI/branch ochrany zůstávají povinné.

Normativní požadavky jsou v sedmi delta specs, architektura a rozhodovací gates v design.md, pořadí a přijetí jednotlivých checkpointů v tasks.md. [Audit disposition](audit-disposition.md) přiřazuje všech 81 pozorování a dodatečný publikační nález k úkolu, rozhodnutí nebo odložení. Soukromé auditní podklady nejsou předpokladem čitelnosti veřejného plánu.
