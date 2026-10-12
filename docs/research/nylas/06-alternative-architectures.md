# Aurinko, Nango a vdirsyncer: tři odlišné odpovědi na synchronizaci

Datum ověření: **12. října 2026**. Toto je srovnání architektonických přístupů z veřejných primárních zdrojů. Nejde o provozní benchmark ani doporučení změnit dodavatele. Cronofy rozebírá [samostatná kapitola](./07-cronofy-reference.md), DAVx⁵ a EteSync [další kapitola](./08-open-source-references.md).

## Proč porovnávat různé vrstvy

Kalendářová integrace má nejméně čtyři samostatné problémy: přihlásit účet, přeložit providerova data, průběžně zjistit změny a bezpečně prosadit lidský záměr. Produkt může zvládat první tři a čtvrtý přenechat aplikaci. Označení „two-way sync“ samo neurčuje, co nastane při dvou současných úpravách, ztracené odpovědi na CREATE nebo změně oprávnění během doručování.

Pro Musubi je proto důležitější kontrakt selhání než počet log v integračním katalogu. Relevantní jsou následující osy: kdo drží kanonická data; jaká je jednotka identity; zda existuje změnový kurzor; kdo může změnit obsah; jak se pozná úplnost čtení; jak se zachází s nejistým zápisem; jak jsou odděleny obsah a vedlejší účinky pozvánek.

| Řešení | Hlavní abstrakce | Přínos pro náš návrh | Co z něj nelze automaticky vyvodit |
| --- | --- | --- | --- |
| Nylas | Jednotné API nad grantem | Přehledný veřejný objektový model a integrace | Distribuovaná transakce mezi našimi cíli |
| Aurinko | Jednotné API se sync/delta rozhraním | Změnový kontrakt jako produktová funkce | Exactly-once zápis či atomický merge |
| Nango | Auth, proxy a programovatelné funkce | Oddělení integračního runtime od domény | Hotová kalendářová sémantika |
| Cronofy | Synchronizované kalendáře a aplikační projekce | Oddělená identita aplikačně vytvořených událostí | Plná přenositelnost všech RFC vlastností |
| vdirsyncer | Dvojice úložišť a přetrvávající baseline | Malý, pochopitelný model konfliktů | Víceúčtová spolupráce a scheduling účinky |
| DAVx⁵ | DAV ↔ lokální zařízení | Praktická kompatibilita serverů a zdrojové testy | Serverové fan-out záruky |
| EteSync/Etebase | Šifrovaná synchronizace mezi kompatibilními klienty | Revisions, privacy a oddělení ciphertext transportu | Transparentní E2EE přes Google/Graph |

Závěry v tabulce jsou naše syntéza rozsahu produktů; podrobné důkazy jsou v jednotlivých kapitolách.

## Aurinko: změny jsou součástí veřejného API

Aurinko se popisuje jako převážně průchozí platforma: překládá a směruje požadavky k providerům a pro delta funkce uchovává omezená řídicí data, například vztahy identit. Obsah kalendářů podle dokumentace neukládá jako vlastní trvalou repliku. To je tvrzení provozovatele, nikoli výsledek našeho auditu infrastruktury. [Architektura Aurinko](https://docs.aurinko.io/)

Calendar API zahajuje synchronizaci pro konkrétní kalendář a časové okno. Inicializace může vrátit ready=false. Následně poskytuje samostatné tokeny pro aktualizované a smazané události; stránkování používá page token a dokončené kolo delta token. Model uvádí masters a exceptions a rozšiřování sync rozsahu. [Calendar API](https://docs.aurinko.io/unified-apis/calendar-api)

To je pro Musubi přímější reference změnového protokolu než běžné jednotné CRUD API. Aplikace se může bavit o „pokračování synchronizace kolekce“ bez znalosti Google syncToken, Graph deltaLink nebo DAV sync-token. Naše současné fetchChanges už tuto myšlenku obsahuje. Příležitost je zapsat pravidla do samostatného veřejného kontraktu: token musí být opaque, scoped na účet, kolekci, konfiguraci a generaci přístupu; změna filtru vyžaduje nové kolo; terminální token se nesmí přijmout po neúplném čtení.

Oddělené updated/deleted proudy ale vytvářejí vlastní otázky. Pokud dojde k UPDATE a DELETE stejné identity mezi dvěma čteními, musí spotřebitel znát pořadí nebo znovu pozorovat aktuální stav. Z otevřených průvodců nelze vyvodit společnou atomickou hranici obou tokenů. **Doporučení pro nás:** přednostně jeden uspořádaný normalizovaný batch s jednoznačným checkpointem. Dva upstream tokeny může interně držet adaptér; veřejné jádro nemá odhadovat jejich časový vztah.

Webhooky Aurinko mají subscription, resource a accountId, batched payloady a podpis. Dokumentace popisuje exponenciální retry s intervalem omezeným na deset minut; odpověď 422 odstraní subscription. Není z toho patrná neomezená retenční lhůta či univerzální pořadí změn. [Webhooks API](https://docs.aurinko.io/unified-apis/webhooks-api)

**Doporučení:** definovat webhook jako oznámení „tato kolekce může být zastaralá“. Vlastní pull a pravidelná kontrola zůstávají zdrojem obnovitelnosti. Uložit oznámení do durable inboxu před ACK; poté lze několik oznámení sloučit do jednoho pullu stejné kolekce. Event payload je důkaz s konkrétní proveniencí, nikoli univerzální svolení přepsat lokální revizi.

Aurinko má také samostatné Tasks API se seznamy úkolů a incremental sync. To je pro nás důležitý rozdíl rozsahu vůči vybranému veřejnému modelu Nylasu. [Tasks API](https://docs.aurinko.io/unified-apis/tasks-api)

Úkoly však nelze přidat do společného protokolu pouhým přejmenováním event.start na task.due. Musubi řeší domovskou autoritu a projekce do sekundárních služeb. Delta poskytovatele neurčuje, která kopie smí globálně dokončit úkol. Z Aurinka proto převzít změnový transport, nikoli nezdokumentovanou představu stejné autority všech kopií.

**Otevřené otázky pro ověřovací experiment:** invalidace a retence delta tokenů; pořadí mezi updated a deleted proudem; obnova změn po výpadku webhooku; stabilita identity přes přesun; conditional PATCH/DELETE; chování uncertain CREATE; úplnost série s výjimkou přesunutou mimo časové okno. Bez odpovědí není korektní stavět nad touto službou záruky silnější než její veřejný kontrakt.

## Nango: integrační infrastruktura bez vnucené domény

Nango rozděluje práci na autentizaci, proxy a programovatelné funkce. Sync function čte externí data a ukládá normalizované records; action function provádí uživatelský zápis. Aplikace po sync oznámení čte records přes vlastní kurzor. [Průvodce sync funkcemi](https://nango.dev/docs/guides/functions/syncs/sync-functions)

Toto rozdělení je výborná reference pro balíčky Musubi. CredentialsPort nemusí znát recurrence, HTTP transport nemusí znát membership a planner nemusí znát Better Auth. Smyslem oddělení není zvýšit počet package.json. Smyslem je možnost pustit stejný provider adaptér v CLI, serveru nebo test harnessu bez importu naší databáze a bez vytvoření lidské session.

Checkpointy Nango představují typovaný perzistentní stav sync funkce pro pokračování po selhání. Průvodce ukazuje načtení a uložení checkpointu v průběhu zpracování. [Checkpoints](https://nango.dev/docs/guides/functions/syncs/checkpoints)

Z toho nelze vyvodit, že uložení records a checkpointu v cizím runtime tvoří tutéž transakci jako naše doménová databáze. **Naše pravidlo:** cursor smí postupovat až s přijatou lokální změnou, nebo s durable stagingem, který garantuje její následné idempotentní přijetí. Pád po uložení řádku před cursor je přijatelný, protože znamená opakované čtení. Pád po cursor před řádkem znamená ztrátu a přijatelný není.

Nango dokumentuje dva způsoby mazání. Incremental sync musí explicitně ohlásit smazané identity; full sync může použít trackDeletesStart/End. Výslovně upozorňuje na falešné deletions při potlačeném selhání a neúplném datasetu. [Deletion detection](https://nango.dev/docs/guides/functions/syncs/deletion-detection)

To podporuje naši současnou opatrnost v Musubi: absence při neúplném discovery ani při omezeném okně neprokazuje smazání. Pro open-source protokol má být úplnost vlastní typovaný údaj. Jediné reset=true s nejasným rozsahem je příliš snadné špatně použít při doplnění nového adaptéru. Doporučujeme explicitní CollectionSnapshotComplete včetně vymezení inventory a odlišení „objekt byl smazán“ od „do objektu jsme přestali mít právo vidět“.

Nango sync variants oddělují běhy a jejich checkpointy i cache pod jedním connection; může tak samostatně běžet každý mailbox, folder nebo jiná partition. [Sync partitioning](https://nango.dev/docs/guides/functions/syncs/sync-partitioning)

Musubi má stejný přirozený klíč: connection + collection + stream/configuration. Pomalá CalDAV kolekce nemá zdržovat úkoly jiného účtu. Zároveň musí operace stejné resource family zachovat pořadí. Proto nelze prostě paralelizovat všechny události. Scheduler má oddělit **fairness mezi účty**, **limity providera** a **serializaci uvnitř kolizní domény**.

Produktová stránka uvádí kombinaci webhooků a polling reconciliation i krátkodobou cache v Nango Cloud. [Data Sync](https://nango.dev/platform/data-sync)

Pro self-host Musubi je zásadní, že webhook není povinná dostupnostní závislost. Neveřejně dostupný server může synchronizovat pollingem; veřejný endpoint může totéž jádro probouzet push oznámením. Použít stejnou queue pro obě cesty, deduplikovat work a zachovat periodickou opravu.

Veřejný repozitář Nango uvádí Elastic License a omezený bezplatný self-host feature set. Marketingové „open source“ proto samo nestačí k rozhodnutí, co můžeme převzít do vlastního distribuovaného projektu. Zaznamenáváme deklaraci licence, nikoli právní posudek. [Repozitář a licence](https://github.com/NangoHQ/nango)

**Co převzít:** rozhraní runtime portů, typované checkpointy, partition scheduler, oddělené read sync a write action, testy dry-run/restart. **Co nekopírovat bez dalších důkazů:** obecné automatické retry zápisů, které mohou odeslat další pozvánku, ani příliš široké jednotné schéma bez kalendářových guardů.

## vdirsyncer: jednoduchost díky omezenému kontraktu

vdirsyncer synchronizuje kalendáře a adresáře mezi dvěma úložišti, běžně DAV serverem a soubory. Umí i dvojici serverů. [Přehled projektu](https://vdirsyncer.pimutils.org/en/stable/index.html)

Tutorial při současné změně na obou stranách nabízí chybu, volbu vítězné strany nebo externí merge. Párování kolekcí je výslovně konfigurace; stejné zobrazované jméno není identita. [Tutorial](https://vdirsyncer.pimutils.org/en/stable/tutorial.html)

Právě přiznání konfliktu je užitečná lekce. Profesionální synchronizační systém nemusí každý konflikt automaticky „vyřešit“. U pozvánek a série může automatická volba jedné strany napáchat víc škody než zastavení s konkrétním důvodem. Pro náš protokol doporučujeme default stop-on-conflict a explicitně pojmenované režimy copy, projection a collaborative authority. Konfigurace, která říká jen „obousměrně“, je nedostatečná.

Konfigurační manuál popisuje status_path jako uložený stav potřebný k rozlišení, zda nepřítomná položka vznikla na druhé straně, nebo byla odstraněna. Read-only režimy mají vlastní revert/ignore/error chování. [Konfigurace](https://vdirsyncer.pimutils.org/en/stable/config.html)

To je dobrý argument proti „stačí porovnat aktuální seznamy“. Bez baseline nemáme historii a nemůžeme bezpečně propagovat deletion. Stejně tak tombstone a retenční adresy Musubi nejsou nadbytečná infrastruktura. Zjednodušit lze jejich jednotnou reprezentaci a životní cyklus, nikoli je nahradit domněnkou z okamžitého seznamu.

Formát vdir přirozeně umožňuje, aby jeden event resource obsahoval master a výjimky v několika VEVENT komponentách. [Vdir storage format](https://vdirsyncer.pimutils.org/en/stable/vdir.html)

To je důvod ponechat vedle objektových pozorování i **resource-family** boundary. Jeden ETag DAV může krýt celou sérii, nikoli právě zobrazený výskyt. Naše kanonické entity mohou být jemnější, ale zapisovací lock a validator musí respektovat hranici vzdáleného zdroje.

vdirsyncer je jednodušší než Musubi částečně proto, že neřeší náš produktový kontrakt: více lidských členů, kanonické task authority, klientské receipt UI, domovský server a privacy fencing. Použít ho jako kontrolu „je naše jádro zbytečně složité?“ dává smysl jen při porovnání stejného úkolu. Pro dvojici resource stores může stačit baseline + conditional writes; pro souběžné fan-out meeting writes to nestačí.

## Doporučená kombinace inspirací

Pro otevřený Musubi sync protokol navrhujeme: veřejný model změnových kol jako u Aurinka; infra porty a partition scheduler ve stylu Nango; konzervativní conflict baseline jako u vdirsyncer; srozumitelné objektové API a capabilities inspirované Nylasem a Cronofy. Výsledkem má být menší a lépe ověřitelné jádro, které pojmenuje rozdíly a záruky. Nemá vzniknout nový univerzální SaaS ani kopie interního systému cizí firmy.

Srovnání není pořadí kvality dodavatelů. Veřejná dokumentace neposkytla jednotně srovnatelná data o latenci, míře konfliktů ani chování všech serverů. K tomu slouží experimentální matice v [implementačním plánu](./05-protocol-and-plan.md).
