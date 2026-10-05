# Core kalendáře: historický checkpoint a acceptance

> **Archivní přehled, označeno 2026-10-05.** Níže jsou zachované datované řezy
> ze září 2026, nikoli aktuální seznam chybějících implementací. Současný
> kontrakt v0.2.2, automatické/živé důkazy, neověřená runtime aktivace a odklady
> jsou v [udržované capability matrix](../../packages/docs/src/content/docs/operations/capabilities.mdx)
> ([publikovaná stránka](https://musubi.pro/docs/operations/capabilities/)).
> Novější Outlook content/time/all-day/UNTIL/global-zone/move a finite-series
> RSVP kroky překonávají příslušná starší „nepodporované“ tvrzení níže. Zachování
> starého textu není nové otevření již implementované práce. Živé release-device
> a produkční důkazy zůstávají oddělené; veřejný health v0.2.2 nepotvrzuje Core gate.

> Rozhodnutí 2026-09-14: vlastník vybral časový model, organizer, RSVP a osobní
> iCloud obsahové zápisy pro dosud nevydanou 0.1.8. Připomínky a dostupnost
> zůstávají vypnuté. [Historický aktivační plán 0.2.0](../releases/core-0.2.0-activation.md)
> nahrazuje dřívější požadavek na pozdější verzi; živé a device mezery níže tím
> nejsou označené za splněné.

Základní checkpoint aktualizován 2026-09-11; pozdější záznamy mají vlastní data.
Tento přehled doplňuje
[implementační plán](calendar-core-implementation-plan.md); jeho historické
checkpointy popisují stav v okamžiku příslušného řezu, ne vždy dnešní omezení.
Vymezená autonomní implementace K12–K14 je lokálně dokončená a společně ověřená.
Neznamená to podporu všech providerových variant ani uzavřenou živou acceptance.
Konečné převzetí dávky vyžaduje povinné CI a squash merge; přesnou head revizi
a její výsledky eviduje příslušné PR. K15 ani produkční M2 nejsou převzaté.

## Co už lze lokálně ověřit

„Implementováno“ níže znamená podporovaný kontrakt za příslušným vypnutým flagem,
s lokálními regresními důkazy. Není to živá certifikace všech účtů nebo povolení
produkční aktivace. Stejný provider může podporovat jednu operaci a odmítnout jinou.

| Oblast | Implementovaný rozsah | Zbývající hranice a důkaz |
| --- | --- | --- |
| K12 Google | Osobní generated/existing occurrence update, čas ve stejném typu, cancel; durable queue/worker/ACK a explicitní apply-saved konflikt | Whole-series nepodporované podle rozhodnutí o zachování výjimek; following nepovolené. [Kontrakt](../sync/google-occurrence-writes.md) |
| K12 CalDAV | Osobní whole-resource series content/time/RRULE změna, explicitní zoned→UTC převod konečné COUNT série se stejným civilním časem bez výjimek, obnovení vybraných importovaných all-day EXDATE dat v konečné COUNT sérii bez výjimek a odebrání samotného RRULE bez výjimek, occurrence content/time/cancel/revival, series/following delete a dvoukrokový following update | Známý zoned/floating/all-day model a úplná resource evidence; resource write, collection bind/unbind dle operace. Explicitní potvrzení master/active-child content a uloženého series/active-child time či series RRULE záměru je podporované při shodné původní nativní struktuře. Generated/cancel/revival potvrzení zachovává původní definice a intent; Partial following-delete konflikt má přesné potvrzení bodu řezu, kontrolu tombstones a ochranu proti opožděnému starému syncu. Whole-resource delete konflikt má samostatné potvrzení celé série a collection-unbind proof. Source konflikt splitu před prvním ACK má potvrzení obou operací se stejnou budoucí identitou. Po source ACK lze samostatně potvrdit vytvoření budoucí série na původní adrese, pokud chybí nebo již přesně odpovídá uloženému celému resource; dokončený source receipt zůstává neměnný. Přepis cizího resource, změna budoucí adresy a širší převody zbývají. [Kontrakt a Radicale důkazy](../sync/caldav-series-writes.md) |
| K12 CalDAV přidané datum | Přidání nebo odebrání jednoho all-day RDATE mimo pravidlo osobní konečné COUNT série; explicitní stored-master scope, neměnný záměr, konflikt a úplný ACK | Jeden VEVENT bez EXDATE a detached historie, zachovaný DTSTART/COUNT, trvání a ostatní raw bytes. Web a native callery včetně generated slotu používají uložený master. HTTP/DB a disposable Radicale evidence nenahrazují živý iCloud; více dat, timed/UNTIL a kombinace zůstávají nepodporované. [Kontrakt](../sync/caldav-rdate-writes.md) |
| K12 CalDAV DATE import/export | Veřejný ICS import/export zachovává all-day RDATE/EXDATE, původní DTSTART a COUNT včetně vyloučeného začátku a přidaných dat za koncem pravidla | Nejednoznačné či neplatné datumové parametry se odmítnou před vytvořením cílového kalendáře; přesné chyby zachovává i sdílený legacy serializer. Nejde o nový nativní dated writer ani úplné zachování detached importu. [Kontrakt](../sync/caldav-date-export.md) |
| K12 Graph | Default-off veřejný create osobní konečné série: jeden vlastní kalendář, známý zoned/all-day model, COUNT nebo přesně ekvivalentní konečné UNTIL do 366 výskytů / 730 dnů. Durable intent, jediný POST, transaction recovery, úplný family ACK a sync bez duplicit včetně odstranění/obnovy masteru | HTTP 202 potvrzuje místní uložení, ne nativní doručení. Opakování používá stabilní klíč nebo UUID události a vrací aktuální dostupný stav. Web/native draft identita a browser HTTP-mock acceptance jsou pokryté; osobní Prague zoned a all-day COUNT=3 create včetně read-only obnovy původního konfliktu živě prošly; fyzická native acceptance a širší varianty zbývají. [Živá evidence](calendar-personal-series-live-acceptance-20260910.md); NOEND, širší převody, konfliktní create recovery s výjimkami a native scope UPDATE/DELETE nejsou uzavřené. Weak ETag ani changeKey nejsou důkaz podmíněného zápisu. [Create kontrakt](../sync/graph-recurring-create.md), [import](../sync/provider-time-import.md#graph-occurrence-mapping-slice)  Explicitní lokální převzetí jedinečné změněné osobní plain finite create family je pokryté bez provider write; širší exception/cancellation adoption zbývá. [Adoption kontrakt](../sync/graph-create-adoption.md) |
| K13 read/preserve | Privátní source observation organizátora, účastníků, rolí a odpovědí pro Google/Graph/CalDAV | CalDAV vlastní identita vyžaduje scheduling proof; provider observation není Musubi social attendance. [Kontrakt](../sync/provider-event-state.md) |
| K13 Google RSVP | Vlastní primary copy one-off a vázané existující instance: přijmout/tentative/odmítnout, veřejný endpoint, web/native editor, queue/worker, explicitní konflikt | Master a generated sloty, neúplná native evidence včetně chybějící zóny timed instance, širší withdraw nejsou pokryté. Jednorázové ano/možná/ne živě prošly; u jedné známé zoned vázané instance prošly všechny tři odpovědi přes backend a kontrolu v Google UI organizátora se zachováním masteru/sousedů. Navazující [Musubi browser acceptance](calendar-google-recurring-browser-acceptance-20260911.md) stejných tří odpovědí na nové zoned instanci také prošla; navazující [all-day browser acceptance](calendar-google-all-day-meeting-browser-acceptance-20260911.md) ověřila i uloženou DATE instanci. Úplná notification/device acceptance zbývá. [Recurring evidence](calendar-google-recurring-live-acceptance-20260911.md). [Živá evidence](calendar-google-invite-live-acceptance-20260910.md). [Kontrakt](../sync/google-rsvp.md) |
| K13 CalDAV RSVP | Default-off osobní one-off RSVP s ověřeným automatic scheduling, public/web/native, durable PUT/CAS, trvalým markerem jediného pokusu a úplným readback ACK | Známý zoned/all-day resource bez recurrence, přesný self/principal/owner/outbox proof; organizer delivery zůstává unknown. Po markeru i u legacy intentů bez historie pouze read-only Check response, včetně konfliktu; nejistý PUT se neopakuje. Konflikt bez overwrite potvrzení, širší identity/series a živá dvouúčtová acceptance zbývají. iCloud identita a ruční příjem pozvánky do Pracovní včetně Musubi importu jsou ověřené; RSVP preflight odmítá chybějící resource privilege a Schedule-Tag. Nativní Apple srovnání rovněž postrádá tato metadata. [Živá evidence](calendar-icloud-invite-live-acceptance-20260910.md). [Kontrakt](../sync/caldav-rsvp.md) |
| K13 Graph RSVP | Default-off vlastní primary one-off attendee copy: accept/tentativelyAccept/decline, veřejný endpoint, web/native editor a trvalý marker před POST | Po možném odeslání jen read-only Check response, včetně konfliktu a zmizelé kopie. Bez CAS nebo garance doručení organizátorovi. Accept/Tentative a read-only obnova živě prošly; Decline odstranil kopii, ale doručení organizátorovi nebylo prokázané. Recurring/delegated RSVP zbývají. [Živá evidence](calendar-outlook-live-acceptance-20260910.md). [Kontrakt](../sync/microsoft-rsvp.md) |
| K13 Graph organizer create | Default-off vlastní default calendar: one-off create se server-invite, private journal, transactionId, trvalým dispatch markerem a read-only recovery; web/native callery | Explicitní UTC/all-day, 1–100 hostů; bez update/delete/CAS tvrzení. Vývojové OAuth, one-off create a přijetí hostem živě prošly. Automatická obnova mirroru při chybějícím delta odstranění, fyzické native QA a aktivace zbývají. [Živá evidence](calendar-outlook-live-acceptance-20260910.md). [Kontrakt](../sync/microsoft-organizer-create.md) |
| K13 Google organizer | Default-off vlastní primary one-off create/update/cancel a existující vázaná instance content-update/cancel s explicitním oznámením všem hostům, stabilní identitou a trvalým markerem před odesláním; veřejný endpoint a web/native callery | Nejistá obnova pouze čte stav a nikdy automaticky neopakuje pozvánku. Změny seznamu hostů, času instance, celé série, delegace/federace zůstávají otevřené. Jednorázové create/update/cancel živě prošly; u jedné známé zoned vázané instance prošly backend content-update/cancel a kontrola v Google UI hosta se zachováním masteru/sousedů. Navazující [Musubi browser acceptance](calendar-google-recurring-browser-acceptance-20260911.md) content-update/cancel nové zoned instance také prošla; navazující [all-day browser acceptance](calendar-google-all-day-meeting-browser-acceptance-20260911.md) ověřila i uloženou DATE instanci. Úplné e-mailové doručení a device acceptance zbývají. [Recurring evidence](calendar-google-recurring-live-acceptance-20260911.md). [Živá evidence](calendar-google-invite-live-acceptance-20260910.md). [Kontrakt](../sync/google-organizer.md) |
| K13 CalDAV organizer | Default-off one-off create, změna obsahu, explicitní změna času ve stejném typu/zóně a cancel s ověřeným automatic scheduling a explicitním server-invite; vlastní principal/owner, operaci odpovídající privilege proof a web/native callery | Stabilní URL/UID, podmíněný zápis, úplný readback a trvalý marker brání opakování nejisté pozvánky. Samostatné update/delete capabilities zachovávají i cancellation-only obnovu. Změna času vyžaduje úplný nativní časový důkaz a obnoví žádost o odpověď u hostů. Recurrence, změna hostů, změna typu/zóny a živé doručení nejsou pokryté. Původní iCloud create-capability proof prošel pouze čtením; po přidání iCloud Mail má principal dvě mailto identity. Nativní Apple pozvánka dorazila do Google, ale není důkazem Musubi organizer writeru. Nativní organizátor používá ověřenou ne-emailovou cestu a chybí Schedule-Tag i resource privilege proof. [Živá evidence](calendar-icloud-invite-live-acceptance-20260910.md). [Kontrakt](../sync/caldav-organizer.md) |
| K14 read/preserve | Privátní provider reminders a raw availability/privacy/type observation; Google title-only HTTP update/readback zachovává special state, conference metadata a reminders, Graph HTTP read/re-read zachovává workingElsewhere/Teams (writer zůstává blokovaný); Google freeBusyReader se nevydává za plnohodnotný detailový mirror | Google změny přístupu mají version fence proti opožděnému importu a vynucují čerstvé úplné načtení. Zúžení Google přístupu nyní skryje obsah provider-origin mirroru i při neúspěšném fetch, zachová identity/intenty a invaliduje otevřené detaily web/native. Úplné odebrání zdroje rediguje sdílené tombstones; veřejná historie doručování a čekající e-maily znovu ověřují aktuální přístup. Web/native otevřené editory a cache jsou pokryté v navazujících PR #249/#251; zbývá fyzická acceptance a ověření starších klientů; intervalová dostupnost má samostatný kontrakt níže. [Web editor kontrakt](../ui/google-editor-privacy-refresh.md); nejde o kompletní intervalový free/busy model. [Access kontrakt](../sync/google-calendar-access.md). [Kontrakt](../sync/provider-event-state.md) |
| K14 Graph private-read access | Discovery rozlišuje canEdit a tri-state canViewPrivateItems; potvrzené zúžení rediguje staré detaily před fetch a generation fence blokuje opožděný import/delete/cursor včetně rodin | Čerstvý omezený read může obnovit aktuálně povolený obsah; unknown proof neobnoví redigovaný obsah. Retained receipts/email a web/native editor drafty mají stejnou privacy hranici. Fake HTTP/DB a mounted klientské regrese nenahrazují živou Graph/device acceptance. CalDAV collection read-privilege parity je popsána v samostatném řádku níže. [Kontrakt](../sync/microsoft-calendar-access.md) |
| K14 CalDAV collection read access | Přesné href/namespace/úspěšné propstat discovery; samostatný DAV read/free-busy/write důkaz a generační fence pro VEVENT rodiny i VTODO | Potvrzená ztráta read rediguje import před fetch, čerstvý celý resource obnovuje stejnou identitu; stale task DTO/ACK nemůže vrátit starý obsah. Web task/event a native event editory zachovávají vlastní drafty. Starší task klient po retirement dostane conflict; živé iCloud resource ACL a device acceptance zůstávají lidské ověření. [Kontrakt](../sync/caldav-read-access.md) |
| K14 CalDAV event alarms | One-off nebo explicitní konečná COUNT master série: známý zoned/all-day osobní VEVENT, nula/jeden jednoduchý DISPLAY START-relative alarm; web/native editor a explicitní konflikt | Samostatný default-off flag, plný privátní resource proof, strong ETag CAS, durable replay/ACK a blokace neúplného pull jsou lokálně pokryté včetně disposable Radicale. Nejde o per-user preference. Master-only série zachovává přesný RRULE a vyžaduje explicitní scope; active/retired exceptions, RDATE/EXDATE, složitější recurrence, komplexní alarmy, meeting/floating resources a živá iCloud/OS acceptance zůstávají otevřené. [Kontrakt](../sync/caldav-event-alarms.md) |
| K14 Google intervalová dostupnost | Default-off freeBusy.query API, privátní registry zdrojů a explicitní výběr do 20 zdrojů v Connections na webu i v nativním klientu; UTC intervalový dialog bez Event identit či edit akcí | Scope/owner/account/generation kontroly, reconnect-required versus unavailable versus potvrzené prázdno, bez offline cache. Web day/week nabízí explicitní session/page opt-in statických intervalů včetně přechodů DST. Vlastníkem schválená společná časová osa pokrývá události, intervaly i interakce; další grid pohledy jsou mimo tento vymezený rozsah. Nativní callback/transport regrese nejsou fyzická ani renderovaná acceptance; živý re-consent, intervalový dialog, day/week a odebrání sdílení prošly ([evidence](calendar-google-availability-live-20260911.md)); device QA a aktivace zbývají. [Kontrakt](../sync/google-availability.md) |
| K14 Google reminders | Vlastní one-off defaults/off/custom a vázané existující instance off/custom, veřejný web/native editor, durable delivery a explicitní konflikt | Parent/original identity, známý čas, podmíněný PATCH, plná obnova a explicitní konflikt jsou pokryté lokálně. Web/native callbacky a browser/mock acceptance rozlišují výskyt a sérii. Osobní Google one-off a vázané zoned/all-day instance mají živý důkaz custom popup/off včetně zachování sousedů. Nové instance defaults jsou blokované po živém nesouladu potvrzeného stavu; [evidence](calendar-google-all-day-reminders-live-20260911.md). series, Graph native writer a skutečné OS oznámení zůstávají otevřené. [Živá evidence instance](calendar-personal-series-live-acceptance-20260910.md). Vymezený CalDAV alarm writer je samostatně popsaný výše. [Instance kontrakt](../sync/google-instance-reminders.md). Musubi reminder plánování je oddělené. [Kontrakt](../sync/provider-event-state.md#gated-personal-google-reminder-editor) |

## Závěrečné lokální ověření vymezeného rozsahu

K12 scope/create/adoption, K13 RSVP a podporované organizer operace i K14
read privacy, připomínky a intervalová dostupnost jsou implementované v přesných
kontraktech tabulky výše. Společná dávka zahrnuje CalDAV one-off změnu času,
Google bound-occurrence operace a Graph one-off organizer CREATE včetně oddělené
OAuth/Graph identity pro organizer a RSVP. Nezávislá feature i integrační review
jsou uzavřená; regrese jsou registrované ve standardních kontrolách.

Finální lokální `pnpm check` a celá `pnpm test:db` prošly. Klientské sady obsahují
327 native a 555 web testů. Cílená browser acceptance prošla ve 22 scénářích;
oprava překrytí dialogů má 17 cílených unit testů a 4 cílené Storybook scénáře.
Typy a lint prošly. Tyto počty nejsou tvrzením o úplné browser/Storybook matici,
fyzickém zařízení nebo živém providerovi. Lokální průchod nenahrazuje povinné CI
kontroly a squash merge nutné pro konečné převzetí dávky; výsledky pro přesnou
head revizi eviduje příslušné PR.

V tomto vymezeném rozsahu nezbývá další autonomní feature implementace.
Konkrétní nová regrese či review nález se musí opravit před převzetím.
Samostatná integrace DST osy byla po schválení vlastníkem provedena; její
[vymezená acceptance](calendar-dst-axis-acceptance-20260910.md) zahrnuje webové interakce. Další grid pohledy,
komplexní RDATE/recurrence, editace hostů a Graph UPDATE/DELETE nejsou nově
přidanou podmínkou této dávky. Nepodporované varianty v tabulce zůstávají
nepodporované; bezpečné odmítnutí se nevydává za jejich implementaci.

## Živá Google acceptance — 2026-09-10

Jednorázové Google organizer create/update/cancel a RSVP ano/možná/ne prošly
mezi dvěma vlastníkovými účty, s kontrolou změn a odpovědí v druhém Google
kalendáři a skutečné první pozvánky v Gmailu. Obě testovací schůzky jsou uklizené.
[Přesná evidence a omezení](calendar-google-invite-live-acceptance-20260910.md).
Nejde o živou certifikaci recurring instancí, přesně jednoho doručení e-mailu ani
celého K13. Předchozí [webový Google test](calendar-google-web-live-acceptance-20260910.md)
ověřil také jednorázové osobní připomínky a potvrzení úpravy výskytu.

## Na konec: vstup nebo rozhodnutí vlastníka

Tyto body neblokují výše uvedenou lokální implementaci. Přihlašovací údaje patří
pouze do lokálního připojení, nikdy do chatu, repozitáře nebo testovacích logů.

| Potřeba | Proč ji nelze nahradit lokální regresí |
| --- | --- |
| Další Outlook acceptance a conditional-write důkaz | Vývojové OAuth a one-off create/Accept/Tentative již prošly, stejně jako [osobní zoned/all-day DAILY COUNT=3 create](calendar-personal-series-live-acceptance-20260910.md). Decline delivery, širší recurrence varianty a skutečný event conditional-write kontrakt zbývají; `changeKey` není CAS důkaz. [Invite/RSVP evidence](calendar-outlook-live-acceptance-20260910.md). |
| Identity a konkrétní invite/RSVP scénáře pro zbývající providery | Google one-off a Outlook create/Accept/Tentative mezi schválenými účty jsou ověřené. iCloud adresy jsou potvrzené a příchozí pozvánka ručně přidaná do Pracovní se importuje do Musubi. Nativní Apple→Google pozvánka dorazila; Musubi iCloud RSVP ani organizer writer ale acceptance nemají. Je třeba samostatně vymezit kontrakt pro chybějící Schedule-Tag/privilege proof a ne-emailové nativní identity, nikoli znovu žádat adresu nebo heslo. Zbývající iCloud a recurring scénáře vyžadují vymezené testovací adresáty; samotné připojení nebo capability proof není důkaz doručení. [Živá evidence a další brána](calendar-icloud-invite-live-acceptance-20260910.md). |
| Fyzické native/OS a notification QA | Mockované callbacky a Chromium nejsou důkaz chování telefonu, OS oprávnění, klávesnice ani skutečných oznámení. |
| Release, minimální klientské verze a produkční aktivace | Samostatné rozhodnutí až po odpovídající acceptance. Dosavadní práce nemění verze/minima 0.1.8 ani nezapíná produkční time/reminder/RSVP flagy. |

Google whole-series nyní **nevyžaduje opakování otázky**: vlastník již rozhodl
zachovat obsah výjimek a tuto operaci nepodporovat. Nový návrh má smysl pouze s
prokázanou ochranou celé family nebo novým výslovně schváleným produktovým
kontraktem. [Rozhodnutí a reprodukce souběhu](calendar-google-series-live-acceptance.md#follow-up-exception-concurrency-and-product-decision).


### Dokončená navazující integrace DST osy

Vlastník schválil návrh 2026-09-10. Webový den/týden používá společnou osu
pro vykreslení, výběr, náhled, přesun, resize, klávesnici a dostupnost. Přesné
okamžiky přecházejí také do rychlého/plného editoru a jeho URL draftu. Sdílený
nativní layout zůstává samostatný; nejde o fyzickou native/OS acceptance.
[Implementace a vymezené výsledky](calendar-dst-axis-acceptance-20260910.md).

### Dokončený iCloud master-content kontrakt

Schválený default-off `ICLOUD_PERSONAL_CONTENT_WRITES_ENABLED` umožňuje při
výslovně chybějící resource privilege vlastnosti ponechat autorizaci na
podmíněném PUT. Živá HTTP scope/outbox/worker/ACK acceptance prošla pro zoned,
all-day a floating osobní série, se zachováním výjimek, úplným readbackem,
replayem a odmítnutím změny času. Testovací kalendář a lokální data jsou
uklizené. Ostatní operace zachovávají původní permission kontrakt; sdílené
kalendáře a produkční aktivace nejsou touto evidencí přijaté.
[Živá evidence](calendar-icloud-series-live-acceptance.md#accepted-authenticated-personal-master-content-path-2026-09-10).

## Navazující iCloud scheduling — 2026-09-10

Vlastník chce další iCloud etapu prozkoumat a implementovat rovnou. Současný
vymezený core nadále nepodporuje iCloud RSVP ani organizer zápisy bez požadovaného
scheduling důkazu. Nativní Apple pozvánka přitom prokazuje, že chybějící metadata
neznamenají obecnou nemožnost doručovat pozvánky.

První dávka posiluje stávající přísný CalDAV RSVP kontrakt: trvalé atomické
označení před prvním PUT, nejvýše jeden pokus a následná obnova pouze čtením,
včetně starých intentů bez prokazatelné historie. Testy používají fake HTTP
a vyhrazenou PostgreSQL databázi. Tato změna sama iCloud RSVP nezpřístupňuje.

Další režim vyžaduje samostatný vypnutý kontrakt pro přesně pozorovanou absenci
metadat, ověřenou identitu a podmíněný zápis. Nesmí předstírat Schedule-Tag pomocí
ETag ani přebírat fallback osobních obsahových změn. Následovat musí nezávislá
review, regresní testy a živé ověření vlastníkových testovacích účtů. Produkční
aktivace ani fyzická device acceptance tím nejsou převzaté.

Navazující dávka implementuje samostatný default-off `ICLOUD_RSVP_EDITS_ENABLED`
pro jednorázové attendee RSVP s přesným paired-404 důkazem a skutečně chybějícím
Schedule-Tag. Zachovává ověřenou identitu, strong ETag, trvalý dispatch marker
a oddělený režim při ACK. Lokální HTTP/DB regrese nejsou živá acceptance:
existující ručně importovaná pozvánka má `SCHEDULE-AGENT=CLIENT` a je nadále
správně odmítnutá. Nativní URI organizátoři a organizer zápisy nejsou rozšířené.
[Kontrakt a hranice](../sync/caldav-rsvp.md#separately-gated-icloud-attendee-compatibility).

## Rozhodnutí vlastníka a další pořadí — 2026-09-11

Vlastník schválil ponechat e-mailové RSVP pro ručně importované pozvánky
(`SCHEDULE-AGENT=CLIENT`) mimo současný core. Samostatný ověřený mailový
transport patří do následné etapy; jeho absence není novou feature podmínkou
uzavření vymezené implementace K12–K14. Takové pozvánky se vyřizují v původním
e-mailu nebo odpovídajícím kalendářovém klientu.

PR #275 a #276 jsou squash mergnutá po nezávislé review a všech 14 CI kontrolách.
Vypnutý iCloud attendee režim zůstává bez živé RSVP acceptance; rozhodnutí
o vyřazení e-mailové varianty není důkaz jeho funkčního doručení.

Další práce se vrací k acceptance existujících kontraktů: nejprve Google
RSVP/organizer operace na vázaném výskytu opakované schůzky, následně zbývající
živé privacy/free-busy a reminder scénáře podle tabulky výše. Konkrétní chyby
se opravují obvyklým review/CI loopem. Fyzické native/OS oznámení vyžadují
samostatnou device acceptance. Výstupem má být přesný seznam přijatých operací,
známých omezení a dosud neověřených variant; release a aktivace zůstávají
samostatným rozhodnutím.

## Google vázané schůzky — 2026-09-11

Backend RSVP ano/možná/ne a organizer content-update/cancel prošly na dvou
konečných známých zoned sériích mezi vlastníkovými Google účty. Nezávislá
kontrola v druhém Google kalendáři potvrdila odpovědi, změněný obsah a zmizení
zrušeného výskytu; master a sousedé zůstali zachované v porovnávaných polích obsahu, času,
identity a účastníků; další metadata tento test neposuzoval.
[Přesná evidence](calendar-google-recurring-live-acceptance-20260911.md).

Přihlášení a Google availability re-consent v browseru byly následně výslovně
schválené a dokončené. Živá intervalová acceptance je popsána níže; backend
evidence se nadále nevydává za náhradu neprovedených browser/device scénářů.

## Připomínky výskytu: živý nález a omezení — 2026-09-11

Celodenní custom popup/Off prošly, ale Google nepotvrdil návrat výskytu
k výchozím připomínkám. Samostatný časovaný test potvrdil také nesoulad mezi
PATCH a následným GET. Nové instance defaults jsou proto blokované před zápisem
i v editorech; one-off defaults zůstávají zachované. Přesná historická shoda
se může pouze ověřit čtením. Prokázané smazání Google masteru umí ukončit přesně
navázaný nepodporovaný konflikt jako zrušený, bez předstírání doručení.
Testovací data jsou uklizená. [Evidence a hranice](calendar-google-all-day-reminders-live-20260911.md).

## Google dostupnost a ruční obnova — 2026-09-11

Živě prošel re-consent bez Tasks scope, objevování soukromého free/busy zdroje
s výchozím vypnutím, explicitní výběr, intervalový dialog a day/week opt-in.
Soukromé detaily se nezobrazily, transparentní událost neblokovala dostupnost
a odebrané sdílení po obnově odstranilo zdroj i interval. Nové tlačítko
Refresh connected calendars odstraňuje chybějící cestu ručního discovery;
během obnovy nepotvrzuje starou dostupnost ani po zavření dialogu.

Testovací kalendář je uklizený. Živé writer/reader privacy přechody čekají na
výslovný souhlas s rozšířením oprávnění nového QA kalendáře, které odmítla
automatická kontrola. Device acceptance a produkční aktivace zůstávají oddělené.
[Přesná evidence a neověřené varianty](calendar-google-availability-live-20260911.md).

## Google privacy přechody — následné dokončení 2026-09-11

Vlastník následně výslovně schválil konkrétní změny testovacího sdílení. Živě
prošly writer → reader → writer a writerWithoutPrivateAccess přechody se
zachováním identity, odstraněním soukromých polí a jejich obnovením i při stejném
ETagu. Otevřený detail reagoval bez zavření; otevřený editor přešel na read-only
a po návratu oprávnění zachoval vlastní rozepsanou změnu. Přechod na freeBusyReader
odstranil běžnou událost a nabídl vypnutý zdroj dostupnosti.

Nalezené označení skrytého záznamu jako `(untitled)` bylo opraveno na Busy jen
při čerstvém důkazu omezené role a soukromého záznamu bez názvu/organizátora.
Živý retest prošel. Fixture je uklizená; pro tento přesně vymezený privacy test
už další souhlas nechybí. Device a širší varianty zůstávají výslovně oddělené.
[Evidence](calendar-google-privacy-live-20260911.md).


## Google vázané schůzky — dokončená browser acceptance 2026-09-11

Na dvou nových konečných zoned sériích prošly přes skutečné Musubi formuláře
RSVP ano/možná/ne a organizer content-update/cancel prostředního uloženého
výskytu. Přesné UI receipts dokončil standardní worker; druhý Google kalendář
nezávisle potvrdil odpovědi, změněný obsah a odstranění jediného výskytu.
Master a sousedé zůstali zachované v porovnávaných polích. Stará verze se bezpečně
odmítla bez uložení; explicitní obnova připojených kalendářů umožnila pokračovat.

Obě série jsou uklizené, všech pět receipts dokončených a aktivních lokálních
fixture řádků je nula. Tím se uzavírá předchozí mezera čerstvé Musubi browser
admission pro tento zoned scénář. All-day schůzky, širší providerové varianty,
fyzická zařízení a produkční aktivace touto sadou převzaté nejsou.
[Přesná evidence a provozní omezení testu](calendar-google-recurring-browser-acceptance-20260911.md).


## Google celodenní vázané schůzky — dokončená browser acceptance 2026-09-11

Navazující dvě konečné DATE série ověřily přes skutečné Musubi formuláře
všech pět stejných akcí: ano/možná/ne, změnu obsahu a zrušení jednoho uloženého
výskytu. Druhý Google kalendář potvrdil odpovědi, obsah i odstranění cíle;
master a sousedé zůstali v porovnávaných polích zachované. Po úklidu je všech
osm známých nativních resources zrušených, aktivních místních řádků nula a všech
pět UI receipts dokončených. [Evidence a hranice](calendar-google-all-day-meeting-browser-acceptance-20260911.md).

Souběžné aplikace na localhostu používající stejnou výchozí Better Auth cookie
byly odděleny volitelným dev-only prefixem Musubi. Výchozí cookie ani produkce
se nemění; pro native/Expo QA musí prefix zůstat vypnutý.
[Diagnostika a ověření](calendar-dev-cookie-isolation-20260911.md).

Další živý Graph privacy test potřebuje kontrolovaný sdílený kalendář druhého
vlastníka. Aktuální read-only inventura jediné aktivní Graph identity našla tři
kalendáře stejného vlastníka, všechny s `canViewPrivateItems=true`; samostatný
owner/recipient pár pro změnu true→false→true zatím připravený není. Samotné
`canEdit=false` u dvou kalendářů tento předpoklad nenahrazuje. Tato inventura neprováděla event ani permission zápisy. Následující rozhodnutí
vlastníka tuto přípravu výslovně odkládá.
Fyzická zařízení, širší kontrakty a rozhodnutí o produkční aktivaci zůstávají
oddělené od dokončené Google browser sady.


## Graph private-read — odložené živé ověření podle rozhodnutí vlastníka

Dne 2026-09-11 vlastník schválil ponechat přechod soukromého čtení
`true→false→true` jako neověřený. Dostupný pracovní Microsoft 365 účet a osobní
Outlook účet nejsou ve stejné organizaci. Nativní Outlook na novém prázdném QA
kalendáři nabídl pro tohoto externího příjemce pouze volno/obsazeno nebo názvy
a místa; delegaci s přístupem k soukromým detailům nenabídl. Sdílení nebylo
odeslané a prázdný QA kalendář byl odstraněný.

Vlastníkem zpřístupněný administrátorský tenant nemá licenční produkty podle
Entra ani dokončeného seznamu licencí Microsoft 365. Nabídka měsíčního trialu
byla pouze prohlédnutá; vlastník aktivaci odmítl. Žádný trial, nákup, testovací
uživatel ani nové přiřazení licence nebyly provedené. Bez změny tohoto rozhodnutí
se nemá znovu požadovat tentýž setup ani tento test označit jako prošlý.

To neblokuje další vymezenou acceptance s již připojenými účty. Lokální Graph
privacy regrese zůstávají samostatným důkazem; odklad není důkazem nefunkčnosti
implementace ani povolením produkční aktivace. [Microsoft popisuje soukromé
čtení delegáta a omezení na stejnou organizaci](https://learn.microsoft.com/en-us/graph/outlook-share-or-delegate-calendar).


## Outlook celodenní UNTIL — dokončená browser acceptance 2026-09-11

Obnovený URL draft v Musubi vytvořil osobní DATE sérii s inkluzivním UNTIL
30. září. Native Outlook a Graph readback potvrdily přesně tři výskyty 28.–30.
září, poslední s exkluzivním koncem 1. října. První worker pokus zůstal
nepotvrzený; skutečné Check creation původní operaci následně dokončilo.
Jeden immutable journal, master, tři děti a čtyři mapování byly stabilní po sync.
Přesná příčina prvního nepotvrzení nebyla prokázaná; nevyžádala si změnu kódu.

Série je nativně odstraněná, aktivní místní fixture řádky jsou nula a dokončená
historie je zachovaná. Tato sada nepřebírá nový UNTIL picker, zoned UNTIL,
Use provider version adoption ani odložený Graph private-read. [Přesná evidence,
postup recovery a limity měření](calendar-outlook-until-browser-acceptance-20260911.md).


## Outlook změněný create — vymezená adoption acceptance 2026-09-11

Skutečné Musubi UI vytvořilo all-day COUNT=3 sérii; kontrolovaný QA transport
simuloval ztrátu skutečné odpovědi Graph 201. Native Outlook změna názvu současně
změnila délku a recurrence zone, proto byla správně odmítnutá. Tento nativní UI
scénář není převzatý. Opravené hlášení dialogu nyní ukazuje serverové odmítnutí
místo zavádějící chyby sítě, se dvěma regresními důkazy a živým opakováním.

Po oddělené, výslovné QA normalizaci času jediné vlastní série prošlo skutečné
Use provider version: jeden původní journal s adoption markerem, master a tři
děti, čtyři mapování, zachovaný záměr a stabilní sync. Úklid je dokončený,
aktivních fixture řádků nula. Nejde o rozšíření přísného Graph parseru nebo
produkční writer; [evidence přesně odděluje odmítnutou UI variantu a pozitivní
kontrolovanou fixture](calendar-outlook-adoption-browser-acceptance-20260911.md).

## Outlook změny existující série — aktualizace 2026-09-22

Novější ověřené kroky doplňují historický stav výše: [obsah jednoho výskytu](outlook-occurrence-content-20260922.md), [obsah celé série](outlook-series-content-20260922.md) a [čas jednoho výskytu UTC série](outlook-occurrence-time-20260922.md) pro osobní události i schůzky organizátora. Zůstávají vázané na úplnou nativní evidenci, přesnou identitu a příslušné feature flagy. Změny času celé série, další časové zóny/celodenní přesuny, recurrence pravidla a „tento a následující“ tím nejsou převzaté. Nejde o produkční aktivaci ani garanci doručení pozvánek.


### 2026-09-22: Outlook occurrence time in Europe/Prague

The latest bounded extension adds single-occurrence rescheduling in the proven
Europe/Prague series zone, alongside UTC. Web/native drafts use that zone;
gaps/folds and local neighbouring-day crossings are refused. Native-tested
Outlook RSVP resets after a real time change are observed without changing the
guest list or treating them as unrelated conflicts. Details and redacted live
results: [occurrence zones](./outlook-occurrence-zones-20260922.md).
Other zones, all-day moves and series-wide time/recurrence changes remain open.

### 2026-09-22: Outlook all-day occurrence dates

A fully observed UTC-authored all-day series now supports moving/resizing one
all-day occurrence, including personal events and organizer meetings. Inclusive
Musubi dates serialize to Graph's exclusive next midnight, preserving original
slots and moved/cancelled neighbours. Web/native use their existing date controls;
legacy opt-ins retain their earlier strict response shapes. Native probes and
actual queue/outbox edits passed with fixture cleanup. Details and redacted
results: [all-day occurrence contract](./outlook-occurrence-allday-20260922.md).
Other zones, timed/all-day conversion and whole-series time/recurrence changes
remain open; this is not a production activation.


### 2026-09-23: Outlook attendee RSVP for one imported occurrence

The first recurring RSVP scope now has an explicit client opt-in and occurrence
request, exact native parent/originalStart binding, frozen target/master proof,
and the existing durable at-most-once POST marker. Web/native reuse their RSVP
editor with occurrence wording. Synthetic tests cover moved exceptions,
occurrence-to-exception materialization, concurrent mapping/parent edits,
read-only recovery and disappearance after decline.

Live verification found that a first instance RSVP changes an unanswered
master and inherited sibling responses to tentative. Those masters are now
refused before admission and dispatch. Initial exception materialization also
refreshes a valid creation timestamp. The final actual queue/outbox pass on an
already-answered series completed Accept/Tentative, preserved the master and
neighbours, and kept a disappeared Decline copy explicitly unconfirmed without
resending. Native/local cleanup is verified; [evidence](outlook-occurrence-rsvp-20260923.md).
Whole-series RSVP, canonical local-series attendee children, delegated calendars
and general all-day representations remain separate work. No production gate,
release tag or deployment changes. [Contract](../sync/microsoft-rsvp.md).


### 2026-09-24: Outlook RSVP for a finite meeting series

Current web/native clients opt in with `outlookRsvp=2` and offer Entire series
only after complete finite native proof. This also permits a first response to
an unanswered invitation without presenting it as an occurrence-only change.
The master and inherited occurrences receive the requested response; existing
exceptions retain their own response. Native-family admission serialization,
preview/version checks and the permanent dispatch marker prevent automatic
resends and overlapping local RSVP intents.

The actual queue/outbox completed initial Tentative, Accept and another Tentative
anchored from an exception on an America/New_York series spanning DST. Decline
removed the copies and remained unconfirmed; read-only recovery sent no second
POST. Fixtures are removed and notification delivery remains unknown. Global
IANA/Windows labels, UTC all-day and COUNT/UNTIL representations have separate
synthetic regressions. [Audit and redacted evidence](outlook-series-rsvp-20260924.md).

This supersedes the whole-series/initial-response gap noted in the September 23
entry. Unbounded/unverifiable families, canonical local-series attendee children,
delegation and general all-day representations remain outside the contract.
Production gate, deployment and release settings are unchanged.
