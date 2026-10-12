# Cronofy jako druhý referenční návrh kalendářového syncu

Ověřeno **12. října 2026** z veřejné primární dokumentace. Jde o srovnání konkrétních kontraktů s Musubi, nikoli doporučení nákupu nebo audit proprietárního backendu. Žádný účet nebyl připojen a žádný provider zápis nebyl proveden. **Doloženo** označuje veřejný kontrakt; **návrh** a **odvození** naše interpretace.

Cronofy je zajímavé hlavně tím, že explicitně odděluje aplikací spravované události od cizích událostí, definuje omezené sync okno a vystavuje oprávnění jednotlivých akcí. Tyto tři prvky jsou pro otevřený protokol Musubi užitečnější než převzít jeho event JSON jako univerzální reprezentaci všech kalendářů.

## 1. Deterministická identita spravovaných zápisů

**Doloženo:** Create or Update Event přijímá aplikací dodané `event_id`. První požadavek pro dvojici `(calendar_id, event_id)` vytvoří položku; další aktualizují existující. Vrací 202. U `description` je popsáno, že omitted nebo null zachová původní obsah, prázdný řetězec jej vymaže. Nejde tedy o jednoduché bezvýjimečné nahrazení celého objektu. Ve zkoumané referenci nebylo nalezeno ETag ani `If-Match`. [Upsert Event](https://docs.cronofy.com/developers/api/events/upsert-event/)

**Odvození:** stabilní aplikační ID je dobrý základ pro zotavení po ztracené create odpovědi. Není to totéž co idempotency key konkrétního intentu. Požadavek se stejným event ID a novějším obsahem znamená update; není veřejně doloženo, že starší opakovaný požadavek nemůže přepsat novější edit nebo znovu vyvolat vedlejší účinek. Musubi by proto měl dál rozlišovat object ID, operation ID, expected revision a dispatch proof.

**Doloženo:** Partner/Managed Events vytvořila aplikace a mají její `event_id`; External Events mají `event_uid`. [Editing Events](https://docs.cronofy.com/developers/calendars-events/editing-events/) External edit vyžaduje elevated access a `options.update=true`; stejný endpoint se adresuje `event_uid`. Po smazání se externí objekt tímto zápisem znovu nevytvoří. Externí opakované události nejsou editovatelné. [Edit External Events](https://docs.cronofy.com/developers/api/events/edit-external-events/)

**Návrh:** pro Musubi převzít explicitní provenance a operation classes. Objekt na zdroji, který jsme vytvořili, může mít důkaz stabilního create adresování. Importovaný objekt má jinou recovery hranici. Provenance však nesmí nahradit aktuální ACL ani organizer identity: aplikací vytvořená schůzka může mezitím ztratit práva nebo být ručně upravena. Interní a provider ID držet v různých typech, aby je nebylo možné omylem zaměnit.

## 2. Omezené okno jako součást kontraktu

**Doloženo:** Read Events má výchozí rozsah 42 dní zpět a 201 dní dopředu. Managed events mohou být bez explicitních date filtrů vráceny i mimo toto okno. `include_moved` umožňuje vrátit objekty, které někdy existovaly v dotazovaném okně, ale nyní jsou jinde. Výchozí čtení nezahrnuje managed events; lze požádat o deleted. Incremental kombinace používá stabilní `tzid`, vynechá `from/to`, zapne deleted/managed a předá `last_modified`. [Read Events](https://docs.cronofy.com/developers/api/events/read-events/)

**Doloženo:** posun sync okna, kterým se dříve vzdálená událost stane viditelnou, sám nevyvolá webhook. Cronofy doporučuje pravidelné weekly nebo daily čtení celé dostupné sady. [Recommended sync](https://docs.cronofy.com/developers/faqs/event-management/recommended-sync/)

To je přímo přenositelné do našeho Graph coverage modelu. Absence záznamu v roce 2035 nemá znamenat „nic tam není“. Coverage není pouze textový disclaimer; je to datový kontrakt obsahující interval, čas posledního úplného fetch, zdroj a representation. Posun okna je vlastní důvod resync, nezávislý na detekci změny obsahu. Musubi dnes omezení Outlook importu výslovně popisuje. [Provider time import](../../sync/provider-time-import.md)

**Návrh:** zavést explicitní příčiny background práce: `providerChanged`, `coverageAdvanced`, `recoveryRequired`, `accessChanged`. Stejný worker může sloučit více invalidací jednoho zdroje a provést jen potřebné čtení. Posouvat cursor až při úplném commit dat. Plný sweep musí porovnávat jen objekty v prokázaně úplném rozsahu. Přesunutá výjimka mimo rozsah musí zůstat dostupná jako suppression definition původního slotu; `include_moved` je inspirací pro veřejné pojmenování této potřeby.

## 3. Webhook jako signál k čtení

**Doloženo:** Calendar Webhooks vrací change notification s `changes_since`; klient pak načte změny. Vlastní změny vyvolané API hovorem change webhook nevytvářejí. Callback musí vrátit 2xx do pěti sekund; po 24 hodinách bez úspěšného doručení se channel automaticky uzavře. HMAC-SHA256 nad raw body používá client secret a při rotaci může obsahovat více podpisů. [Calendar Webhooks](https://docs.cronofy.com/developers/api/push-notifications/)

**Návrh:** v Musubi oddělit provider invalidation od veřejného committed change feed. Invalidation jen plánuje pull; veřejný feed oznamuje potvrzenou změnu naší autority včetně vlastní úspěšné operace. Suppression vlastních provider echoes nesmí zabránit aktualizaci druhého zařízení. Klient nepotřebuje znát, zda provider používá native push, subscription nebo polling. Potřebuje poslední potvrzený checkpoint a aktuální health zdroje.

Pro veřejný protokol je vhodnější opaque checkpoint než přímo timestamp. Timestamp může být adaptérová strategie, ale musí mít definovanou inclusivity, překryv a deduplikaci. Přerušení channelu potřebuje repair mechanismus a periodický health check; existující subscription není důkaz, že provider změny nadále přicházejí. Pětisekundová odpověď callbacku potvrzuje příjem práce, ne dokončení importu.

## 4. Schopnosti na úrovni objektu a akce

**Doloženo:** kalendáře mají readonly/deleted, profile ID, permission level a samostatné příznaky conferencing/attachments. `provider_name` je rozšiřitelný a klient má přijímat budoucí hodnoty. [List Calendars](https://docs.cronofy.com/developers/api/calendars/list-calendars/) Event response vystavuje `options.delete`, `options.update` a `options.change_participation_status`. [Read Events](https://docs.cronofy.com/developers/api/events/read-events/)

Participation Status je samostatná operace nad `event_uid`, vyžaduje svůj scope a event option. Microsoft Office365/Exchange decline může událost odstranit; odpověď endpointu je 202. [Participation Status](https://docs.cronofy.com/developers/api/events/participation-status/)

**Návrh:** z existujících Musubi admission pravidel generovat stejný per-action capability envelope pro web, mobil a externí SDK. Rozšířit jej oproti Cronofy booleanům o scope, concurrency level, relevantní time profile a reason code. Aktuální proof musí být znovu ověřen při commit; capability z posledního read je užitečný pro UI, nikoli trvalé oprávnění. Tento přístup může podstatně zmenšit klientské větvení, aniž bychom oslabili specializované writery.

Cronofy Free/Busy má samostatné oprávnění a explicitně rozlišuje širší read-events scope. Při incremental aktualizaci doporučuje zahrnout i nyní free události, aby se odstranila stará blokace. [Free/Busy](https://docs.cronofy.com/developers/api/events/free-busy/) Musubi by mělo zachovat vlastní privacy hranici interval-only zdrojů. Není správné vytvářet z dostupnosti pseudoudálost s neověřenou identitou nebo povolit detail read jen proto, že známe busy interval.

## 5. Recurrence a export: vědomě úzký model

**Doloženo:** Recurring Events je označeno Alpha. Má strukturované `rules`, prakticky jednu, frekvence daily až yearly, interval/count a inclusive `until` date. Monthly `by_day` může mít jedinou položku. Exclusions jsou lokální original dates, maximálně 64. Jen první výskyt managed recurrence je managed; další jsou external a mají vazbu `series_master`. [Recurring Events](https://docs.cronofy.com/developers/api-alpha/recurring-events/)

To je vhodný design pro snadné booking případy. Pro bezeztrátový import/export Musubi však nestačí. Neměli bychom redukovat RFC5545 RDATE, floating identity, detached duration a provider raw properties na tyto editorové možnosti. Srozumitelný recurrence editor může produkovat omezený profil, ale transport musí umět zachovat bohatší přečtenou definici jako unsupported-for-write. Kvalita otevřeného protokolu spočívá také ve schopnosti přesně odmítnout ztrátový zápis.

Cronofy má Alpha ICS Webhooks s konkrétními invite/cancel iCalendar payloady a volbou, kdo odpovídá za doručení. [ICS Webhooks](https://docs.cronofy.com/developers/api-alpha/ics-push-notifications/) To je užitečná inspirace pro oddělení scheduling delivery od event persistence. Není to doložené univerzální archivní export API všech native resources. Pro Musubi zachovat vlastní whole-resource preservation a u exportu uvést fidelity, provenance a podporované komponenty.

## 6. Co převzít a co doplnit

| Přenositelné řešení | Doplnění pro Musubi |
| --- | --- |
| Aplikační ID pro managed creates | Samostatný immutable operation ID a expected revision |
| Per-event action options | Scope, reason, freshness a concurrency proof |
| Invalidation následovaná pull | Atomický checkpoint a veřejný committed feed |
| Explicitní sync window | Strojově čitelné coverage a posun okna |
| Managed/external provenance | Aktuální role, source authority a preservation |
| Samostatné participation API | Provider verification a notification outcome |
| Strukturované editorové recurrence | Bezeztrátový definition transport a refusal |

**Otevřené otázky:** veřejné podklady zde nedokládají CAS update, přesný původní start moved recurrence, chování všech exception transitions ani záruku bez duplicitních notifikací při retry upsert. Quickstart navíc popisuje local time bez `Z`, zatímco Upsert reference žádá UTC; tvrzení o libovolném rozšíření okna také nesedí s limity Read Events. [Quickstart](https://docs.cronofy.com/developers/getting-started/quick-start-guide/api-quick-start-guide/) Před použitím služby ověřit tyto hranice na konkrétním disposable fixture, neslučovat marketingový walkthrough s normativním kontraktem.

Výsledkem studie je doporučení vzít si z Cronofy kompaktní model managed identity, action capabilities a coverage repair. Nevyplývá z ní důvod nahradit náš časový model, conditional provider writes nebo durable recovery. Ty řeší širší synchronizační zadání, než jaké dokládají zde zkoumané booking endpointy.
