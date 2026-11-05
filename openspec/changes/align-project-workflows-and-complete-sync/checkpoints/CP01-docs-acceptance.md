# CP01 docs — lokální výsledek a meze přijetí

Záznam k 2026-11-05T16:44:51.999261+00:00. Implementovaný obsah: `0bfe2c796f184ba5659907a585768a3e6a81dfe2` nad přijatým CP01 návrhem `041774e111aceff59dd745ef4b52c0f49468f680`. Výchozí program: `1bf82a8985113f8c6f3165c2c127aa831326eea4` (PR #406, dosud ne v main). Jde o autorský záznam skutečně provedených lokálních kontrol, nikoli autentizovanou provenance nebo nezávislé schválení.

## Dodaný lokální rozsah

- CP01 1.1/1.2/1.4: README/docs README navigace, trvalá mapa autorit v docs/project/brief.md, contributor/setup/onboarding/command guides, jediný current release pointer docs/releasing.md, datování capability a release evidence a historický banner C01–C10 roadmapy. Nepřidán další runbook, registry nebo generátor.
- Příkazy a testovací hranice odpovídají skutečným scripts/Quality; nejmenší JSON příklad ověřuje produkční inspector/client s fixtures/jsdom. Není to důkaz DB/auth/provider chování ani univerzální test projektu.
- Native a web UI konvence jsou oddělené; žádný runtime/UI komponentový kód, SQL, provider, flag, lockfile, package script, workflow nebo toolchain se nemění.
- Capability tabulky a datované release/acceptance záznamy zůstaly zachované. Koordinátor po agentově editaci ještě kvalifikoval závěrečnou větu „current released contract“ a název starého 0.2.2 runbooku jako datovanou historii; v onboarding doplnil stejné datované označení odkazu. Jde pouze o naplnění WF-01, bez změny guarantee nebo nové inventury.

## Skutečně provedené kontroly

| Příkaz / průchod | Výsledek a rozsah |
| --- | --- |
| `pnpm test:behavior --suite task-inspector --scenario conflict-keeps-draft --json` před edits | 1 passed, 0 failures/errors; report 3959 ms |
| Stejný JSON příkaz po agentových edits | 1 passed, 0 failures/errors; report 3563 ms |
| `pnpm check` | exit 0; skutečné kontrakty, types, workspace unit testy, lint a web/docs build. Běh před poslední jednoslovnou kvalifikací odkazu v onboarding; produkční kód se neměnil, dotčený docs build se po ní provedl znovu. Není celá Quality. Celková doba příkazu se samostatně neměřila; nezaměňovat dílčí build timing za celou kontrolu. |
| `pnpm docs:build` a opakovaný `pnpm docs:build` po poslední formulaci | exit 0; finální Astro server build hlásí 3.08 s a Pagefind 31 HTML stránek; tento dílčí timing není čas celé source sady |
| `spec check --project <absolute-repo-root> --phase design` před apply | mechanical_result=pass, semantic_result=unknown; není acceptance implementace |
| `spec openspec --project <absolute-repo-root> -- validate align-project-workflows-and-complete-sync --strict --json` před apply | valid=true, issues=[]; canonical T1/T2/D6 a brief validní strukturou |
| Whitespace | `git diff --check` i staged kontrola před content commitem: exit 0 |
| HTTP/anchor ledger na čerstvém docs buildu | 260 cílů v 11 editovaných dokumentech + read-only observability pointer; 178 lokálních cílů/anchor kontrol pass, 0 lokálních failures. 36 historických/permalink odkazů neověřeno na jejich původní revizi; 44 dalších externích cílů nepozorováno; 2 GitHub blob/main odkazy na nové soubory čekají na merge #406. Tyto kategorie nejsou PASS veřejného webu. |
| Běžící docs v Orca browseru | Produkční node entry z čerstvého dist, HOST=127.0.0.1, PORT=4531, ASTRO_NODE_LOGGING=disabled. Contributing → Run locally → Commands/CI anchor → Releases → Capabilities a přes úzké menu Onboarding. Použity skutečné odkazy, myš i focus/Enter; theme selector přešel Auto→Light. Desktop 1440×1000 dark, narrow 390×844 light/dark; oba uložené screenshoty vizuálně přečteny, kontrolované stránky neměly viewport horizontal overflow. |

Lokálně skutečný Node v22.23.4 a pnpm 11.8.0. `pnpm check` dostal ENVIRONMENT=test, BETTER_AUTH_URL=http://localhost:7531, DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:65439/musubi_cp01_test. config může standardně načíst jiné hodnoty z lokálního root .env; jeho soukromý obsah se neexportoval. Tento běh se nevydává za identické CI prostředí; rozhodující verify/Quality pro nový head stále chybí. Nespouštěla se migrace, produkční DB ani reálný provider.

Browser meze: jedno kliknutí na vzdálenější link a na narrow Menu nevedlo k okamžitému očekávanému přechodu; stejný flow byl skutečně dokončen focus/Enter. Jeden stale ref po změně viewportu byl odmítnut a obnoven novým snapshotem; není započtený jako úspěšná interakce. Neprokazuje to plošnou podporu všech zařízení, runtime aplikace nebo nulový počet všech konzolových chyb. Pro onboarding poslední reload potvrdil finální dated label, scénář, light theme a 390px bez overflow.

Dočasný server byl ukončen pouze podle přesného PID/cmdline/cwd a port 4531 je opět volný. Zavřena jen vlastní browserová záložka. Screenshoty, plné tool/command receipty, JSON ledger a content hashe jsou v privátním session záznamu; nejsou nutné k opakování výše uvedených veřejných příkazů.

## Projekce Its a Plan

D6 vlastník potvrdil 5. listopadu 2026 a výslovně zadal tracker srovnat. Koordinátor přečetl projekt, 56 existujících issue, úplné acceptance MUSU-3/14/54/15/21 a MUSU-40/41/42 a před zápisy vyhledal duplicity. Nový přehled je iniciativa 32 „SPEC · Sjednocení workflow a sync konvergence“:

| CP | Pointer issue | Stav při zápisu |
| --- | --- | --- |
| CP01 | MUSU-58 | unstarted; celý balík není done |
| CP02–CP12 | MUSU-59 až MUSU-69 v pořadí | backlog; apply dalších CP nebyl spuštěný |
| CP01 docs 1.1/1.2/1.4 | MUSU-70, child MUSU-58 | started během skutečné implementace a ověření; před ukončením relace se stav pravdivě upraví podle zbývající práce |
| CP01 toolchain 1.3 | MUSU-71, child MUSU-58 | backlog |

Upraven jen popis projektu, přidána jedna iniciativa, 12 pointer issues, dva CP01 child issues a 11 relates vazeb ke konkrétním dřívějším úkolům. Re-read potvrdil 70 issue; žádné staré issue nezměnilo stav, parent ani archivaci. Původní acceptance, lidská přiřazení, historie, termíny a struktury projektu se neměnily. Tracker odkazy používají immutable commit 041774e s přijatým briefem/D6 a výslovně říkají, že #406 je otevřený a není v main. Žádný starý live/store/OAuth úkol se tím nepovažuje za hotový.

Finální content revize vyžádala zpřesnění auditních statusů: lokální provedení je uvedené jen u CP01, navazující 2.5/5.1/11.2/11.4 nebyly provedené a původní neověřená třída/store caveat REL-07 jsou zachované. README znovu výslovně upozorňuje, že repository record nepotvrzuje hosted Google OAuth verification; neodvozuje se tím aktuální stav Google Console. Tyto následné úpravy mění pouze Markdown metadata a README text, žádné vykreslované MDX, odkazy, testy nebo runtime; docs build/browser výsledky výše mají nadále stejné vstupy.

## Kanonické upřesnění a otevřené hranice

T1 upřesňuje dočasné checks overrides a návrat před finálním content review/mergem; T2 pojmenovává datovanou capability autoritu; D6 zapisuje potvrzenou projekci trackeru. Jde o vyjmenované úpravy canonical design/research podle přijatého směru, nezávisle zrevidované před implementací. .spec-pilot.json je před final review byte-identické se sdíleným indexem v 1bf82a8; žádný poslední slice se nestal novým globálním fast/full.

- Všechny tasks zůstávají unchecked (0/72): 1.1/1.2/1.4 mají lokální výsledek, ale checkpoint zatím nemá aktuální PR/21-job CI ani merge; 1.3/DX-06 se nezačal a Node doporučení nejsou tímto kompletně narovnaná.
- Pro codex branch bez PR Quality vůbec nevzniká (trigger PR/main). Starý zelený běh #406 není důkaz nových docs bajtů. Žádný PR proti jiné base se nepoužil jako obcházka.
- Automatická kontrola odmítla merge #406, protože předchozí souhlas nepovažovala za výslovnou autorizaci změny main. Žádost o explicitní souhlas zůstává otevřená. CP01 PR do main se otevře až po povoleném skutečném merge #406 a přenesení pouze CP01 změn na nový main; před tím není main dotčený a dva blob/main cíle zůstávají pending.
- Další runtime/provider/capability inventura, source→installed→publication→activation gaps, device/live/restore a související ostatní audit části zůstávají u svých CP. ARCH-06 zůstává CP05; nebyl nalezen a nepřesouval se konkrétní DB/domain reader/writer jen kvůli názvu balíčku. Existující feature-introduced/historické v0.2.2 reference mimo vyjmenovaný scope se nepřepisovaly.
- Žádný tag, release, registry publikace, produkční deploy ani native distribuce neproběhly. Nezávislý finální content review je samostatný report v reviews/; tento záznam ho nenahrazuje.
