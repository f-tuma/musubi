# Revize backlogu Its a Plan — Musubi

Datum: **12. října 2026**. Výchozí tracker: projekt `frgtn.MUSU`, 30 issues,
čtyři initiatives, žádné cycles. Inventura je z read-only snapshotu
`/tmp/musubi-tracker-before-2026-10-12.json`. V projektu není MUSU-2.
Auditovaná lokální revize je `99e613f4d43336131b844b62c3d0c06635ff5964`.

Tento dokument je návrh úprav trackeru. Nezaznamenává nové nasazení, živé
providerové testy, schválení scope ani fyzické převzetí klienta. Stav implementace
porovnává s Git historií a současnými kontrakty; starý text issue není důkaz, že
je jeho tehdejší problém stále otevřený.

## Co se ve výchozím backlogu rozchází se skutečností

Sdílené úkoly nejsou nepushnutá feature větev. PR #331 je squash sloučené jako
`aea392d` a v0.2.2 je publikované od 5. října. Source kontrakt už obsahuje zvláštní
namespace `/task-mutations`, odmítnutí starých task writes před commitem,
reconciliaci fork receipts a blokaci nepodporovaných To Do live links. Tyto věci
se nesmějí znovu implementovat na základě popisů MUSU-3/7/8/9/10.

Google read recovery a první CalDAV diagnostika jsou na main přes #330
(`71d2659`), pozdější kategorizace CalDAV přes #335 (`523340c`). Druhá změna není
oprava skutečné intermittent discovery chyby. Android/iOS widgety a Android
system-bar/window změny jsou na main přes #333/334/336/337; merge nevytvořil nový
podepsaný store artefakt ani jeho device acceptance. Dokumentace je na main přes
#332 a diagramy přes #339.

HEAD zároveň připravuje **nepublikovaného API/web kandidáta 0.2.3** přes #342.
Není důvod znovu vydávat v0.2.2 nebo znovu dělat již dokončené source migrace.
Zůstává důvod doložit přesné produkční digests/journal, přijmout aktuální chování
a odděleně naplánovat nový release. Podrobnosti uvádějí
[v0.2.2](../releases/0.2.2.md),
[kandidát 0.2.3](../releases/0.2.3-deployment.md),
[shared tasks](../sync/shared-tasks.md) a
[capability matrix](../../packages/docs/src/content/docs/operations/capabilities.mdx).

## Dispozice všech 30 issues

`Ponechat Done` znamená ponechat doložené dokončení původního implementačního
úkolu. `Přepsat` zachovává ID, historii a nedoložené acceptance. `Přesunout`
mění initiative/prioritu, nepravdivě neuzavírá práci. `Zrušit jako nahrazené`
vyžaduje v popisu výslovně uvést, kam přešly všechny zbývající podmínky.

| Issue | Doporučená dispozice a stav | Nový obsah / přesný zbývající důkaz |
| --- | --- | --- |
| MUSU-1 | Ponechat **Done** bez tracker editace. | #328 / `2dccf57` a doložené source/CI ověření zůstávají. Nasazení patří MUSU-14/15, nikoli zpět do tohoto dokončeného implementačního úkolu. |
| MUSU-3 | Přepsat, ponechat **In Progress** jako acceptance umbrella; initiative „Převzetí vydaných funkcí“. | „Převzít sdílené úkoly v0.2.2“. Nahradit tvrzení o lokální větvi faktickým shipped source kontraktem. Zbývají MUSU-11/12/13. Home authority, nové receipts a outbox jsou zachovávané invarianty, nikoli nová implementace. |
| MUSU-4 | Přepsat, ponechat **Todo**, Filipův assignee a celý checklist. | „Reprodukovat a opravit intermittent CalDAV discovery“. #330/#335 jsou sloučené, #335 pouze diagnostika. Je potřeba konkrétní autorizované read-only fixture/evidence postiženého účtu, kontrolovaná oprava a následné živé ověření na identifikované nasazené verzi. Zachovat namespace/status/ACL/identity odmítnutí. |
| MUSU-5 | Přepsat, ponechat **Todo**. | „Živě převzít Google read recovery a reconnect“. `googleReadFetch` již jednou opakuje odmítnutý GET; mutace nejsou obalené read retry. Zbývá aktuální nasazená revize, skutečné Calendar/Tasks scope, invalid/revoked grant a content-free důkaz úspěchu/reconnect. Devět dříve hlášených reconnect účtů není automaticky chyba refresh implementace. |
| MUSU-6 | **Canceled**, nahrazené konkrétními acceptance a release úkoly. | „Historický provider hotfix — implementace doručená v #330; acceptance převedená“. Residual CalDAV → MUSU-4, Google → MUSU-5, skutečná revize/journal → MUSU-14, metriky/alerts → MUSU-19, další publication/rollback → MUSU-15. Odstranit tvrzení „lokální větev bez PR“ a hard blocker odkazy na tento canceled úkol. Nevydávat cancellation za potvrzení opravy CalDAV. |
| MUSU-7 | Ponechat **Done** bez tracker editace. | Samostatný PR #331, zachování UI a následný merge jsou doložené. Původní popis se čte jako historické zadání dokončené implementace; rebase není znovu otevřená práce. |
| MUSU-8 | Ponechat **Done** bez tracker editace. | Implementovaný výsledek: legacy `/tasks` writes dostanou 426 před preflight/DB; nové `/task-mutations` nikdy nedělají fallback. Global floors zůstávají 0.2.0. Store distribution a mixed deployment acceptance zůstávají MUSU-13/16/17. |
| MUSU-9 | Ponechat **Done** bez tracker editace. | Implementovaný výsledek: exact fork retry vrací původní oprávněně čitelnou kopii; fingerprint brání jinému payloadu, source revision change neopakuje create a current copy authorization platí i při replay. Původní report je historický. Live provider nejistota patří MUSU-11. |
| MUSU-10 | Ponechat **Done** bez tracker editace. | Implementovaný výsledek: server, DB admission a oba klienti rozlišují link/copy; sekundární CREATE/UPDATE/DELETE jsou blokované, stará vazba má Unsupported link a explicitní unlink postup. Microsoft CAS experiment je oddělený MUSU-22 a dokončenou blokaci neblokuje. |
| MUSU-11 | Ponechat **Todo**, acceptance nynějšího kontraktu. | Google Tasks a kontrolovaný VTODO server: create/update/complete/unlink/delete, secondary conflict, lost CREATE reply, projekční baseline a zachování UID/ETag/alarms/foreign properties. Zaznamenat přesný účetový typ/server/build, cleanup a independent provider readback. Mock HTTP ani opt-in test skip nejsou splnění. |
| MUSU-12 | Přepsat, ponechat **Todo**. | „Převzít shared-task práva a UX dvěma uživateli“. Source/CI a migrační sady již doložené #331. Přesunout opakovaný požadavek „připravit finální PR“ do historie. Zbývá skutečný home editor/secondary reader, source retirement, draft/retry a current web/native build acceptance. Nový úplný test běh je nutný až pro změněný finální head. |
| MUSU-13 | Přepsat, ponechat **Todo**. | „Uzavřít produkční acceptance shared tasks v0.2.2“. Migrace 0080–0084 a vydání existují. Potřebný je skutečný journal/hashes a preservation/counts, outbox/lease/restart evidence, source/destination smoke, aktuálně instalovaní klienti a přijaté výjimky. Neprovádět druhý blind migration/rollout jen kvůli stale issue. |
| MUSU-14 | Přepsat, ponechat **Todo**. | „Zaznamenat přesný produkční baseline před refactorem“. API/web digests/revision, DB journal, source gates jako názvy/stav bez secret values, native/peer inventory, unresolved queue counts/age. Veřejná health 0.2.2 a mutable latest tags jsou historické důkazy s mezerami. Baseline se obnovuje pro konkrétní změnu, nikoli každým automatickým runem. |
| MUSU-15 | Přepsat, ponechat **Todo**, samostatná release cesta. | „Převzít a vydat konkrétní API/web kandidát — nyní 0.2.3“. 0.2.2 publication uvést jako hotovou historii. Aktuální candidate má source scope/runbook, publication hold, bez nové migrace. Potřebuje accepted head/CI, skutečný trigger/latest behavior, backup/maintenance decision, digests a nasazený smoke. Native rollout je podle zvoleného scope samostatný. |
| MUSU-16 | Přepsat, ponechat **Todo**. | „Převzít Android store artefakt s widgets/window/system-bar změnami“. #333/336/337 sloučené; source/DEX/emulator evidence zůstane. Nové signed AAB/versionCode, přesný uploaded artefakt/Play analysis, fyzický upgrade, TalkBack, font scaling, tablet/foldable, session/offline/reminders/widgets nejsou potvrzené. Zachovat konkrétní build/device doklad, nevytvářet nový store artefakt pouhým přesunem issue. |
| MUSU-17 | Přepsat, ponechat **Todo**. | „Převzít iOS aktuální beta distribuci a reminders“. #334 sloučené; build 21/TestFlight a vlastníkova základní widgetová zkouška jsou historická acceptance konkrétního headu. Přesný installed build, session/server switching, task sharing/offline, accessibility a OS reminder delivery zůstávají. |
| MUSU-18 | Ponechat **Todo**, zúžit na provider/native acceptance. | Přijímat přesné již podporované timed/all-day/occurrence/series/organizer/RSVP profily. Pro každý platform/build rozlišit local receipt, provider readback a organizer/recipient důkaz. Nevydávat při refactoru všechny speciální akce jako znovu implementované. MUSU-27/29 jsou oddělené mezery evidence. |
| MUSU-19 | Přepsat, ponechat **Todo**; stává se provozní acceptance nového instrumentačního úkolu. | „Převzít synchronizační monitoring a skutečné doručení alertu“. Neprázdnost/freshness collectors, event/task queue count/age, uncertainty, stale inventory, reconnect-required, retention a QA receiver routing. Nové code instrumentation patří runtime epiku; tento issue dokládá jejich skutečný scrape/provoz. Příjem alertu jen v dohodnutém QA scénáři. |
| MUSU-20 | Ponechat **Todo**, aktualizovat podle již opraveného checklistu. | Google Tasks verification stále není doložená. Současný source používá tři granular Calendar scopes, Tasks a conditional availability scope; ty znovu nepřepisovat na broad scope. Je potřeba přesný Cloud status, public/reviewer disclosure, review build/video, disconnect/delete a nezávisle doložené podání/výsledek. |
| MUSU-21 | Přepsat, ponechat **Todo**, rehome do provozního převzetí. | „Ověřit veřejné nasazení dokumentace a current capability matrix“. Source/doc build/link/browser acceptance a #332 jsou hotové. Nedoloženou publikaci veřejné služby nepřeklápět na Done bez live evidence; zachovat rozdíly implemented/automated/live/deployed/deferred. U maintenance dokumentu odkazovat na nové RFC, nikoli znovu otevřít staré Outlook implementace. |
| MUSU-22 | Ponechat **Backlog**, rehome do „Odložená providerová acceptance“. | Izolovaný Microsoft To Do stale/valid ETag UPDATE/DELETE experiment s nezávislým readback. Negativní výsledek je platné dokončení research. Conditional support se nezapne z event Graph evidence ani z preflight. Neblokuje bezpečnou současnou blokaci či první standalone event slice. |
| MUSU-23 | Ponechat **Backlog**, budoucí task profil. | Recurring external task links jsou nová doménová práce s jediným occurrence generátorem, completion/reopen a series edits. Není součást prvního calendar routing node ani podmínka veřejného event core. Native memberships/home recurrence už existují. |
| MUSU-24 | Ponechat **Backlog**, samostatná Musubi federace. | Cross-instance tasks potřebují vlastní ACL/authority/federation gateway. Není to provider-provider routing a nesmí se sloučit s novou vedlejší službou. Zachovat dva servery, revocation/cache fences, retry a rights acceptance. |
| MUSU-25 | Ponechat **Backlog**, produktová aktivita. | Durable **activity inbox pro lidi** není event/task delivery receipt ani **webhook ingress inbox**. Stabilní cursor, current authorization, dedupe/read markers, web/native jsou samostatný produktový feature. Při refactoru lze sdílet mechanické porty, ale jeho absence neblokuje extraction. |
| MUSU-26 | Ponechat **Backlog**, UI roadmap. | Calendar sidebar je produktový návrh; nespojovat jej s routovací konzolí nebo core extraction. Zůstávají page-filter semantics, rights, shared UI, Storybook, narrow/keyboard/theme a návrhové převzetí. |
| MUSU-27 | Ponechat **Backlog**, rehome do stávající initiative 1 jako provider QA. | Outlook Decline one-off/occurrence/finite series potřebuje organizer-side proof po zmizení attendee kopie. Unconfirmed není nový POST permission. Neblokuje personal-event routing profil bez attendees; příslušný RSVP profil má explicitní omezení. |
| MUSU-28 | Ponechat **Backlog**, rehome do stávající initiative 1 jako provider QA. | CalDAV/iCloud live ACL loss→regain při otevřeném UI, stale DTO/sync/ACK, fresh authorized pull a stable identity. Implementované privacy/source fences se zachovají. Tento scénář je užitečná parity evidence pro refactor, ale fixture/discovery access musí být opravdu dostupné. |
| MUSU-29 | Ponechat **Backlog**, rehome do stávající initiative 1 jako odložené provider QA. | iCloud native attendee resource a scheduling acceptance teprve při dostupnosti vhodné pozvánky. Email není proof; imported CLIENT agent zůstává mimo scope; RSVP gate off do samostatně přijatého rozhodnutí. Zachovat vlastníkovo odložení. |
| MUSU-30 | Ponechat **Backlog**, samostatný scope decision. | Reminders/CalDAV alarms/Google availability mají již existující implementace. Vybrat konkrétní scope a live/device evidence; odklad platí. Google instance default mismatch nevynulovat kvůli obecnému „unified reminders“ modelu. |
| MUSU-31 | Ponechat **Backlog**, rehome do stávající initiative 1 jako odložené provider QA. | Graph private-read true→false→true čeká na vhodný same-tenant owner/recipient pár a změnu vlastníkova rozhodnutí. Nevytvářet trial/licenci. Synthetic privacy regression zůstává; není blocker first task acceptance či personal slice, ale public profile nesmí tvrdit plnou live certifikaci. |

**Výsledná bezpečná změna stavů:** pět již dokončených MUSU-1/7/8/9/10 zůstává
Done; MUSU-6 se ruší jako nahrazená orchestrace; žádný další issue se z tohoto
statického auditu nově neoznačuje Done. Otevřená acceptance se neztrácí. Pokud
novější ověřená evidence dovolí uzavřít její samostatnou část, přiloží se přesný
doklad a zbývající část se před uzavřením přenese na konkrétní issue.

## Lidská práce a historie, které zachovat

Assignee Filip Tůma je ve snapshotu na MUSU-1, MUSU-3 a MUSU-4. Nepřepisovat jej
hromadně na agenta. Watchers a původní assignee/delegate se zachovají. Na žádném
jiném issue snapshot neobsahuje lidského assignee.

Jediný checklist je na MUSU-4: `Create handler for better error log` je done;
`Catch the error log` a `Fix the error` nejsou done. Oba zbývající stavy se
zachovají. Existence anonymizovaných produkčních logů sama nepotvrzuje, že
vlastníkem zamýšlený krok „Catch“ zachytil vhodnou root-cause fixture. Při
překladu či rozdělení lze doplnit současné acceptance do description, checklist
se nepřepisuje zaškrtnutím bez důkazu.

Jeden tracker dokument kombinuje current stav a velmi dlouhou historickou
posloupnost. Doporučení: zachovat původní obsah jako datovaný archiv, vytvořit
krátký aktuální roadmap dokument s odkazy na issues/cycles/RFC. Není vhodné
přepsat aktuální snapshot v původním dokumentu tak, aby zmizely vlastníkova
rozhodnutí, builds, release evidence či přijaté limity.

## Opravy závislostí

1. Odstranit hard blocker vztahy MUSU-4/5/14 → MUSU-6 po jeho cancellation;
   MUSU-4/5 k aktuálnímu MUSU-15 pouze `relates`: kandidát 0.2.3 zahrnuje
   CalDAV diagnostiku a netvrdí opravu její root cause. Google acceptance nemusí
   čekat na CalDAV root cause. Budoucí skutečná oprava může dostat závislost na
   příslušném scope release, až se tento release vybere. MUSU-6 nemá žádný
   outgoing hard blocker, proto jeho cancellation neztrácí tranzitivní blokaci.
2. MUSU-14 → MUSU-13/15 zůstává: bez přesné runtime/schema baseline nelze
   přiznat bezpečný upgrade a aktuální release record. Source hardening může
   začít nezávisle a nevyžaduje čekání na lidský produkční přístup.
3. Zrušit hard MUSU-16 → MUSU-15 a MUSU-18 → MUSU-15 pro API/web-only candidate;
   zachovat `relates`. Přidat platformní acceptance jako release blocker až
   když chosen release scope skutečně tvrdí nové native distribution/akce.
4. MUSU-16 → MUSU-18 změnit na `relates`: Android store build je závislost
   Android evidence, nikoli všech iOS/native provider scénářů. MUSU-18 eviduje
   svůj konkrétní platform/build místo blanket blockeru.
5. Completed MUSU-7/8/9/10 mohou zůstat historickými dependency odkazy
   MUSU-11/12/13; nedávat je do nového implementačního cycle jako otevřenou práci.
6. MUSU-11/12 → MUSU-13 se týká přijetí/rozšíření tvrzené podpory. v0.2.2 již
   bylo vydané; historické publikování se nevrací do Todo. Neověřený scénář lze
   výslovně odložit se zachováním current capability boundary, nikoli potichu
   prohlásit prošlý.
7. MUSU-13 → MUSU-23/24 je roadmap pořadí; před implementací těchto rozšíření
   přidat nový task-profile či federation RFC. Nezaměnit jejich dependency za
   blocker extrakce obecného deadline/lease/retry runtime.
8. MUSU-20 → veřejná hosted Tasks acceptance je skutečná externí podmínka,
   pokud běžný uživatel nemůže autorizovat scope. Disposable approved QA
   adapter/conformance práce může pokračovat nezávisle; další veřejný produkt
   nemá tvrdit Google approval pouze kvůli Musubi approval.

Aktuální refactor blueprint má budoucí `RL01` relay PoC závislé na core alpha
`RF09`; musí navíc záviset na přijatém routing/ownership modelu `RL02`.
`RL02` závisí jen na `RF05B`, takže tato dependency nevytváří cyklus. PoC nemá
začít s live writes dříve, než jsou jeho target edit/delete, owned-copy a
conflict pravidla konkrétní.

## Nové refactor epiky bez překryvu se starými úkoly

Číslování níže je pracovní. Při vytvoření tracker issues se přiřadí skutečné
MUSU ID a naváže se na
[research backlog R01–R20](../research/nylas/05-protocol-and-plan.md).

| Epik / slices | Implementace a evidence | Hranice vůči původnímu backlogu |
| --- | --- | --- |
| A. Delivery runtime hardening — deadline/cancellation, Retry-After/backoff, recovery config, baseline instrumentation | R01–R04. Task i event policy; signal se propíše až do HTTP; visící request skončí; lease renewal není nekonečný. Dispatch uncertainty a nonrepeatable CREATE/RSVP zůstávají. `poll=0` má explicitní nezávislý recovery režim a upgrade/config test. Code metrics pro calls, due lag, queue age mají content-free labels. | MUSU-19 zůstává nasazené scrape/alert acceptance. MUSU-5 je live přijetí existujícího auth recovery, nikoli stejná retry implementace. |
| B. Normativní profiles, coverage a capabilities | R05–R07. Scoped logical/remote/resource/occurrence identity, civil time a recurrence, access/source epoch, completeness/window, outcome evidence, operation-specific conditional/guarded/unsupported profiles. Mapping na current Musubi model a fixtures; event/task authority jako odlišné host policies. | Neotevírat MUSU-8 nebo MUSU-10; jejich current wire/To Do contracts jsou fixtures. MUSU-23/24 nejsou automatická feature přidání. |
| C. Coverage eviction a delete-fidelity změna | Samostatný behavior slice: Graph window reset musí rozlišit nepřítomnost v coverage od provider deletion; žádný nový globální tombstone či fanout delete pouze z importního okna. Explicitní DB transition a upgrade/read parity. Zvlášť current Graph guarded DELETE a user-chosen fidelity profile. | Statický research nález potřebuje vlastní acceptance; není „CalDAV chyba“ MUSU-4 ani příležitost opustit přijatý Graph preflight limit bez produktu rozhodnutí. |
| D. Storage-free model a první provider slice | R08–R10. Credential/account session a HTTP/clock ports, refresh/revoke races, exact validator. Jeden personal-event a jeden task slice s injected storage/credentials; standalone CLI/fake host bez `@musubi/db`, Express, Better Auth, app config a produktových ACL. Musubi PostgreSQL bridge zachová admission/atomic local commit. | Stávající shared-task DB/query implementace se hned nepřepisuje celá. Standalone host není finální routovací SaaS a není Musubi federation gateway. |
| E. Versioned operation envelope a společný runner | R11–R13. Discriminated operation registry; immutable admitted projection + serializer/profile version; staré persisted payload decoder fixtures; storage lease/generation/ACK port; event/task parity; postupně personal → task → specialized family/organizer/RSVP. | Nepsat další delivery engine pro budoucí node. MUSU-9 je API fork replay; crash recovery remote effect je širší a odlišné téma. |
| F. Fair scheduler, account budgets a DAV session context | R14–R16. Coalesced per-collection dirty generation, bounded concurrency/per-account budgets a Retry-After; zachované family/lease ordering. Request/call-count baseline před/po; cache nenahradí aktuální ACL/source retirement. | Není horizontal-sharding projekt. MUSU-14 dokládá current singleton baseline, nikoli novou architekturu clusteru. |
| G. Optional provider push jako invalidace | R17–R18. Google/Graph subscription lifecycle, durable ACK-after-commit ingress inbox, duplicate/lost/reordered notification recovery a polling fallback; disconnect/expiry/renew. | Ingress webhook inbox není human activity inbox MUSU-25; webhook payload nezískává canonical write authority. CalDAV stále potřebuje polling profile. |
| H. Open-source alpha a conformance host | R19–R20. Čistá instalace bez Musubi secretů, normativní profile/verze/support/licence/provenance, public CI crash/replay suite, PostgreSQL reference bridge a reference host. Capability certifikace má konkrétní provider/account/server/date/profil. | Public docs release nestačí pro implementation release. MUSU-21 může linkovat release evidence, ale samostatný package lifecycle potřebuje nový epik. |
| I. Budoucí calendar-routing service — zatím contract/reference host | Directed routes, origin/projection identity, forward/reverse policy, echo/conflict/delete semantics a transport/owned-mirror safety. Od D/E lze připravovat headless reference host; produktový daemon/API/onboarding/billing/console zůstává roadmap. První povolený profil může být personal events bez invitation side effects, explicitní conflict místo blind last-write-wins. | Není Musubi UI, federace MUSU-24 ani multirecurring tasks MUSU-23. Cílem je používat stejné jádro; nebudovat konkurenční sync implementaci vedle něj. |

První implementační cycle má být A plus připravený B návrh a D extraction proof.
Již sloučené features a odložené provider experiments se do něj nepočítají jako
otevřená coding kapacita. C je samostatná změna sémantiky a nepřidává se skrytě
do „bez změny behavioru“ extrakce. E musí mít B/D interfaces a parity trace;
F následuje po měřitelné baseline; G lze ponechat později, pokud provider push
není aktuální bottleneck.

## Co musí definovat nový směrovací uzel

Uzel bude plnohodnotný host sdíleného sync core. Route `CalDAV → Google` může
zpřístupnit schůzky ve zvoleném Google kalendáři; volba reverse směru je policy,
nikoli další nezávislá kopie celé route. Stabilní původ a projection mapping
brání tomu, aby target echo vytvořilo druhý logický event. Route se musí
vyhodnocovat v grafu, včetně trojúhelníku A→B→C→A, nejen v jedné dvojici.

Pro MVP musí kontrakt odpovědět na následující otázky před otevřením writes:

- Který zdroj a pole smějí měnit kanonický obsah; které změny v target jsou
  read-only, reverse-edit nebo konflikt? Nejde použít současnou task home
  authority jako nevyřčený automatický event-routing merge.
- Co znamená delete zdroje, delete target kopie, unlink route a access loss?
  Permission loss ani vypadnutí z query okna nesmí být interpretované jako
  uživatelský příkaz smazat všechny ostatní kopie.
- Jak se route vypne, změní filtry/target či rozdělí bez ztráty mapping evidence
  a bez opětovného importu dříve vytvořené kopie? Zpětné uživatelské vlastnictví
  target item se musí odlišit od service-owned projection.
- Jak se řeší souběžné remote změny, missing CAS, lossy fields, recurrence
  exceptions, timezone/floating/all-day a uncertain CREATE? Obě větve směru
  musí mít explicitní profil; konflikt nesmí předstírat oboustrannou shodu.
- Jak se zachází s attendee/organizer identity a reminders? Zrcadlení informace
  nesmí bez samostatného přijatého profilu přeposlat pozvánky, poslat RSVP nebo
  přesunout organizer identity mezi účty.
- Jak uživatel zjistí provenance, last confirmed progress a unresolved
  destination? Status „all calendars synced“ potřebuje důkaz každé route,
  nikoli pouze úspěšný lokální job.

Tento návrh vytváří architektonický tlak na správné porty nyní a nechává plnou
službu jako budoucí produkt. První shared-core release může být knihovna,
specifikace, conformance a headless reference host; routing API/onboarding
potom budou skládat tutéž implementaci.

## Evidence použité pro tuto revizi

- `git log` a `git show 71d2659`: #330 `71d2659`, #331 `aea392d`, #332
  `84a88f4`, #333 `9c3f3a9`, #334 `2ede3bf`, #335 `523340c`, #336 `80d1092`,
  #337 `6d28fc3`, #339 `6bba502`, #342 `99e613f`.
- [Shared-task mutation, authority a unsupported link
  kontrakt](../sync/shared-tasks.md).
- [v0.2.2 publication a mezery provozní acceptance](../releases/0.2.2.md),
  [0.2.3 candidate boundaries](../releases/0.2.3-notes.md).
- [Google OAuth source checklist versus dosud nedoložené
  review](../google-oauth-verification.md).
- [Aktuální implemented/automated/live/deployed/deferred
  matrix](../../packages/docs/src/content/docs/operations/capabilities.mdx).
- [Nylas/Musubi audit](../research/nylas/04-musubi-audit.md) a
  [RFC/20 původních refactor slices](../research/nylas/05-protocol-and-plan.md).
- Current `apps/api/src/sync/adapters/google.ts:113` — pouze GET rejected-token
  recovery; `task_delivery.ts:28/119` — lease/pevný retry; `index.ts:742` —
  společný polling/recovery vypínač. Tyto source odkazy nejsou živá acceptance.

Při této revizi se nespouštěly opakovaně plné testy neměněné implementace,
nepoužívaly se soukromé provider účty a neprováděly se tracker zápisy. Její účel
je zmenšit duplicity a chybné dependency při zachování pravdivé acceptance.
