# C07 · Personal CREATE/DELETE acceptance audit

Audit z 25. října 2026 pokrývá šest již sloučených CREATE/DELETE slices a úzkou
opravu zachování native evidence nalezenou při jejich společné kontrole. Poslední
slice [#378](https://github.com/f-tuma/musubi/pull/378) prošel všemi 21 kontrolami
headu `83de0111e02da6a42e9b8777ed0f17a81e4cb865` a byl squash merged jako
`9ba231876838c9c53d6bb80a6c6bb10eed411569`; schválený a main strom jsou shodné
`86146c2fea425680a1960e0d75da3080d0ecfa64`.

Dokončení source gate C07 vyžaduje také nezávislé schválení, zelené current-head CI
a merge opravy v této revizi. Lokální výsledky tento poslední gate nenahrazují.
Stav skutečného merge a checklistů vede Its a Plan. Produkční aktivace, živé
provider přijetí a veřejná portable alpha mají vlastní důkazy; tento audit je
neprohlašuje za dokončené.

## Implementované rodiny a jejich rozdíly

| Rodina | Sdílená implementace a lokální profil | Native recovery a hranice | Source evidence |
| --- | --- | --- | --- |
| Google CREATE | Pinned timed, nonrecurring osobní event; původní UUID váže saved body, planned ID a private marker. Musubi response ACK/nullable version; reference strong exact readback. | Po nejistotě exact owned ID/marker/content GET. Pouze exact 404 může dovolit stejné planned-ID/body retry; 410/cancelled/mismatch/409 nedávají automatickou adoption. | [#374](https://github.com/f-tuma/musubi/pull/374), [slice](MUSU-39-google-create.md) |
| Google DELETE | Pinned osobní timed/nonrecurring event se strong accepted ETag. Musubi podporuje i smazání osobní attendee kopie s native ownership důkazem; reference je užší. | Strong conditional DELETE po čerstvých guards; exact absence není vymyšlená provider acceptance. Organizer s dalšími hosty není tímto profilem migrovaný. | [#351](https://github.com/f-tuma/musubi/pull/351), [slice](MUSU-39-google-delete.md) |
| Graph CREATE | Původní transactionId/body; admitted native ID null, candidate a raw acceptance jsou samostatná fakta. Musubi nullable/raw response ACK; reference rezervace a atomická adoption. | Po nevyřešeném možném přijetí POST pouze úplná scoped korelace a jediná přesná shoda. Nula/duplicitní/neúplná shoda nepovolí další POST; reference dispatch marker je one-shot i po známé 429. | [#377](https://github.com/f-tuma/musubi/pull/377), [slice](MUSU-39-graph-create.md) |
| Graph DELETE | Native weak ETag a guarded preflight, nikoli CAS; fresh exact GET 404 před ACK. | Běžné recovery nevyřešeného možného zápisu je observe-only. Musubi má vlastní nový explicit resolution intent a jeho první pokus; reference resolution feature nemá. | [#375](https://github.com/f-tuma/musubi/pull/375), [slice](MUSU-39-graph-delete.md) |
| DAV CREATE | Původní operation UUID, URL/UID a přesný full ICS; bind ACL → `If-None-Match: *` PUT. Musubi strong-or-null response ACK; reference strong exact readback. | Po nevyřešeném dispatch jen exact recovery 404 a nové guards dovolí stejný conditional PUT. 410/známá 412 a same-attempt readback 404 další PUT nepovolují. | [#378](https://github.com/f-tuma/musubi/pull/378), [slice](MUSU-39-caldav-create.md) |
| DAV DELETE | Stejná resource URL/UID a strong If-Match; collection unbind a native organizer proof. Musubi generic guarded redirects/response ACK; reference direct-child/no redirects/exact absence. | Přerušený conditional pokus může použít původní podmínku po nových guards. Není to Graph observe-only ani iCloud missing-ACL výjimka. | [#376](https://github.com/f-tuma/musubi/pull/376), [slice](MUSU-39-caldav-delete.md) |

Musubi zachovává samostatnou retry policy pro conclusively not-written chyby bez
zděděné nejistoty: Graph CREATE 408/429 a Graph DELETE 429 mohou znovu projít fresh
guards a původní request. Není to observe-only recovery nevyřešeného zápisu.
Reference je po dispatch markeru přísnější; její one-shot pravidla zůstávají.

Úplné head/merge piny, datum merge a úspěšné workflow runs jsou ve strojovém
[source merge auditu](evidence/MUSU-39-acceptance/source-merges.json). Šest původních
headů má postupně 21/21/22/22/21/21 zelených jobs; žádná required kontrola nebyla
obejita. Oprava evidence používá stejná schémata, serializery, identity, native
požadavky a dispatch selection. Google UPDATE z C06 se mění pouze ve stejném
zachování historických faktů; Graph CREATE ani DAV CREATE se touto opravou nemění.

## Sdílený kód není nová endpoint záruka

[Deskriptory provider profilů](../../apps/api/src/sync/provider_profiles.ts)
jsou popis schopností, nikoli dispatch registry. Jejich konzervativní tvrzení
zůstávají zachovaná:

| Deskriptor | Native tvrzení zachované po extrakci |
| --- | --- |
| `google-personal-event-create-v1` | `unsupported-portability` / `unsafe-uncertain-create`, recovery `legacy-only-unproven`. Stable ID/private marker a lokální druhý host nejsou certifikace collision/idempotency ani exactly-once Google CREATE. |
| `google-personal-event-delete-v1` | Strong-ETag conditional; observe-before-conditional-retry. |
| `microsoft-personal-event-create-v1` | Non-idempotent action, transactionId korelace a observe-only recovery; nejde o CREATE CAS ani tvrzení deduplikačního okna. |
| `microsoft-personal-event-delete-v1` | Weak native version, guarded preflight/read-write-gap; If-Match header není CAS důkaz. |
| `caldav-personal-event-create-v1` | Resource-must-not-exist conditional request, stabilní operation URL/UID; local fixture necertifikuje libovolný DAV server. |
| `caldav-personal-event-delete-v1` | Strong-ETag conditional s novými resource/UID/privilege guards. |

Musubi volí shared writer až po actual pinned decoderu, outer family gates a
registered native portu. Základní decoder refusal předchází výběru adaptéru;
koherentní nominální kontrakt může být odmítnut až vybraným kernelem. Obojí
provede HOLD před native bridge/session factory a HTTP a nevrátí se k druhému
writeru. Skutečně chybějící envelope,
custom adapter bez portu a známá jiná host rodina zachovají své existující routes.
Rozhoduje [event delivery](../../apps/api/src/sync/event_delivery.ts) a jednotlivé
`*_shared_*_delivery` selectors, nikoli existence deskriptoru.

## Zbývající host profily

| Rozsah | Aktuální hranice |
| --- | --- |
| C06 Google osobní UPDATE | Sdílený bounded content runtime a vlastní completion/readback policy. |
| Graph/DAV osobní UPDATE | Stávající host/pinned executor; C07 je nevydává za nový portable UPDATE runtime. |
| All-day, recurrence/series, original occurrence slot, explicit civil-time včetně UTC timeModel | Host-owned typed routes. C07 nepřidává novou time/recurrence schopnost. |
| Meeting/organizer, RSVP, invitations, reminders/alarms, splits, tracked Graph/DAV families | Původní specializované host handlers a feature gates. Google DELETE attendee-copy výjimka výše není organizer/scheduling migrace. |
| Tasks | Task codec/deskriptory existují, server `task_delivery.ts` je host-owned; UI task-inspector JSON není server task-delivery conformance. Microsoft task conditional UPDATE/DELETE zůstává unproven. |
| Reference general pull/inbox, unresolved CREATE→DELETE queue, resolution/supersession | Neimplementované; reference přijímá serial handoff po ACK a nepoužívá absent binding jako novou CREATE rezervaci. Musubi pull/retained tombstones se ověřují v actual API corpus. |

Nepřevedená Musubi funkce tím není plošně zakázaná. Zůstává host-only nebo explicitně
unsupported pro daný portable profil. Veřejná alpha nesmí z lokální parity těchto
šesti rodin odvodit širší operation matrix.

## Audit checklistu 33–36

| Položka | Konkrétní důkaz a nutná hranice |
| --- | --- |
| 33 · CREATE korelace a recovery bez blind duplicate | UUID/body/marker/URL/UID testy tří CREATE kernels a paired API corpora; Graph kompletní unique listing, Google/DAV pouze původní identity. Nová Google reference regrese zachová unknown → exact404 → retry429 → pozdější matching GET ACK bez dalšího POST. |
| 34 · Conditional a guarded DELETE jsou odlišné | Google/DAV conditional retry s původní native podmínkou; Graph ordinary recovery GET-only a reference one-shot. Explicit Graph resolution má vlastní intent/first-attempt gate, který se neopravou nerozšiřuje. |
| 35 · Predecessor, retained deletion, source a stale ACK parity | Actual old/shared API fixtures pro CREATE successor/predecessor, retained pull/tombstone, source retirement, lease takeover a waiting-ACK rollback; reference integer epochs, serial pending barrier a atomic ACK. Zděděná nejistota ani známé přijetí se při retry nesmí smazat. |
| 36 · „Každá rodina má vlastní rollout evidence; neověřené profiles zůstávají explicitně host-only/unsupported v portable alpha.“ | V bounded source gate jde o evidenci jednotlivých source/local-installed cutovers a přesný záznam neprovedené externí aktivace: šest source pins/CI a slice proofs, nový společný installed proof, effective-vs-descriptive matrix a cutover/rollback tabulka. External canary, produkční rollout, live endpoint acceptance a binary downgrade nejsou ověřené ani označené za hotové. |

Old/shared API evidence obsahuje například `retained deletion blocks before
credentials and native requests`, `lease takeover after provider acceptance
cannot adopt mapping`, `waiting ACK rolls back mapping adoption after timeout`,
`source retirement after provider acceptance rejects stale ACK`, `an actual
retained pull conflict cannot be erased by a later 404 ACK` a `retained remote
requires a fresh explicit intent and its first attempt only`. Jde o skutečné
host DB/HTTP funkce; kernel shadow nemá credential/HTTP/storage capability.

## Oprava nalezená při auditu

Stejný pattern v Google CREATE/DELETE, DAV DELETE a zděděném Google UPDATE
přepisoval při známém odmítnutí nového pokusu starší `uncertain` na `rejected`.
Při ztracené odpovědi mohl také přepsat dřívější `accepted` na `uncertain`.
Explicit Graph DELETE resolution měla první variantu. Google CREATE pak měla
konkrétní liveness chybu: reference již nemohla potvrzený vlastní resource převzít,
protože atomic CREATE completion vyžaduje accepted nebo unresolved evidence.

Oprava těchto pěti kernels zachová aggregate native fact. Aktuální chyba nadále
samostatně nese outcome/status/Retry-After; nový známě odmítnutý pokus nevysvětlí
starší nejistý zápis. Fresh refusal zůstává rejected a nově skutečně odeslaný
lost reply po předchozím known rejection se správně stane uncertain. Nový známý
úspěch může nahradit nejistotu accepted faktem. Provider/store/SQL schémata,
identity/body, ordering a autorizace se nemění.

Genuine RED před opravou zaznamenal nejmenší JSON `uncertain-retry-rate-limit`,
devět kernel testů a Google reference pure i skutečný PG/SIGKILL process případ.
Po opravě prošly tyto testy i další reference runner/process regrese. Stávající
Musubi GET po DELETE 412, current retry classification a Graph observe-only
hranice zůstávají otestované; CREATE 412 nepřidává automatickou adoption.

## Cutover, rollout a rollback

| Ovládání / důkaz | Skutečný význam |
| --- | --- |
| Rozpoznaný pinned profil + registered native port | Pevný cutover v daném source artifactu, shodný s přijatou C06 strategií. Žádný per-family runtime canary switch není implementovaný. |
| `SYNC_OPERATION_V1_ENCODER_ENABLED=false` | Zastaví nové v1 admissions; nevrací již uložené pinned operace na starý writer. Unset/true je source default ON. |
| `EXTERNAL_SYNC_INTERVAL_MIN=0` | Vypíná polling; není C07 rollback. |
| `EXTERNAL_DELIVERY_RECOVERY_MODE=disabled` | Vypíná background recovery drain; nevypíná přímý request dispatch. |
| Pure shadow | Replay uložených facts bez druhého HTTP writeru; není live canary přepínač. |
| Compatible artifact rollback | Pouze na předem kompatibilní a ověřený decoder/codec artifact. Unknown shapes HOLD před efekty; nesmí se smazat receipts/dispatch markers. Encoder flag sám rollback neprokazuje. |
| Lokální forward image upgrade | Ověřený serial old→new se zachováním rows/history/epochs/OIDs a pending deliveries; není test old-binary downgrade nebo concurrent mixed-version deploy. |
| Registry / external canary / production / live providers | Tímto auditem neprovedeno a neprokázáno; zůstává release/operator/consumer gate. |

Obecný návrh family feature flag/canary v research §12 není nově existující
rozhraní. [C06 evidence](MUSU-38-shared-runtime.md) výslovně přijala fixed-source
cutover a oddělený provozní artifact rollback. Tento audit tuto hranici neskrývá
a nevytváří nové deployment tvrzení. Konkrétní release musí určit compatible
rollback pin, účty/operace, backup/migration/recovery gates a skutečné runtime
digests před aktivací; lokální source refactor tyto provozní úkoly neuzavírá.
Source `9ba231876838c9c53d6bb80a6c6bb10eed411569` obsahuje právě nalezenou chybu
a není tímto auditem ověřený bezpečný rollback target pro opravu. Zpětná čitelnost
stejného envelope sama neprokazuje
zachování native historie; konkrétní provozní rollback pin zde není přidělený.

## Ověření této opravy

```sh
pnpm test:behavior --suite google-create --scenario uncertain-retry-rate-limit --json
pnpm test:behavior --json
```

Rychlá sada: 191 případů, zero failures/errors; 187 sync a čtyři UI případy.
Kernel: 131 testů, včetně devíti nových regresí v pěti cestách. Reference má
122 pure / 111 storage / 188 process případů; nové targeted process sady
Google CREATE 22, Google DELETE 18 a DAV DELETE 28 prošly všechny. Celé workspace
unit testy, typecheck, lint, release metadata, route/realtime contracts, peers a
query runtime prošly; web unit část měla 841 úspěšných testů. Instalované a
finální běžící web důkazy mají následující samostatný rozsah.

| Důkaz opraveného artifactu | Výsledek |
| --- | --- |
| [API installed summary](evidence/MUSU-39-acceptance/api-installed-summary.json) | 840 souborů frozen context, 429 byte-equal production TS/SQL. Nonroot/no source mounts, 86 migrací z prázdné DB, default encoder ON bez override a 17 skutečných HTTP kontrol včetně signup/login/cookie/CRUD/idempotence/stale revision. |
| API integration corpus ze stejné installed closure | 415 actual old/shared PG/HTTP případů: Google CREATE 68, Google DELETE 55, DAV DELETE 154, Graph DELETE 124 a C06 Google UPDATE 14. Osm test/child-fixture souborů má také přesnou source hash parity. |
| [Reference installed summary](evidence/MUSU-39-acceptance/reference-installed-summary.json) | 151 byte-equal source/85 production, celý 178-file context shodný, 30-package closure bez Musubi DB/auth/config/mobile. Devět případů, 74 skutečných CLI volání, 94 native fixture HTTP, šest Docker SIGKILL (137), 58.076 s. |
| Reference upgrade a recovery | Starý DAV CREATE image přijal všech sedm pending profilů současně a adopted Graph NULL záznam. Nový image zachoval úplné rows/history/sidecars/epochs a 15 table/index OID, doručil všech sedm a opakovaně migroval historii. Nové CREATE/DELETE truth-fact regrese prošly v instalovaném kódu. |
| Finální skutečný web | 8/8 napoprvé za 14.6 s, Chromium na 1280×900/light a 390×844/dark, route → inspector → JSON edit/conflict/read-only/cancel-delete interakce. |

API integration corpus běžel v samostatných disposable test kontejnerech nad
instalovanými zdroji. Test-only tmpfs `/packages` symlinky vyřešily původní
privátní relativní imports pouze na installed workspace balíčky; žádný source
bind mount, workspace `.env`, nová dependency nebo dodatečný patch produkčního
kódu v test kontejneru.
Tento test layout je výslovně oddělený od mount-free canonical HTTP smoke.
Native požadavky mířily na owned loopback fixtures, ne živé účty.

Všech 43 artifact SHA256 a byte lengths v obou summaries byly nezávisle ověřeny.
Docker inspect/index, platform manifest a image config digests jsou v summaries
oddělené; lokální daemon metadata nejsou registry publication proof.

Závěrečný web použil `frontend-testing-debugging`, standardní Playwright fallback
protože Browser plugin není dostupný, a `http://127.0.0.1:3000`. Kontroly ověřily
route identity, viditelný Tasks obsah, absenci framework overlays a horizontal
overflow a žádné neočekávané page/console errors. Přesný úmyslný HTTP 409
diagnostic má existující úzkou výjimku; ostatní chyby selžou. Desktop saved-content
a narrow conflict-draft screenshot byly vizuálně prohlédnuté. Jde o skutečnou UI
implementaci s auth/API fixtures; reálný DB/auth/provider proof je oddělený výše.
Žádný web UI source se nezměnil.

Dočasné výsledky: `/tmp/musu39-c07-audit-final-browser.log` a
`/tmp/musu39-c07-audit-final-browser/evidence-{desktop,narrow}.png`. Oba API nonce
DB a reference nonce DB i jejich kontejnery byly odstraněné; root-owned
`musubi-c07-audit-qa-20261025` PostgreSQL byl poté zastaven a jeho absence ověřena.
Web port 3000 je také volný. Lokální proof images zůstávají lokální.

## Další gate

Po schválení a green current-head merge této opravy lze uzavřít bounded source
acceptance C07 a odblokovat C08 inventory. Žádný příslušný external/live gate se
tím neuzavírá. Nejmenší další kandidát je Google Task conditional UPDATE s vlastní
production JSON scénářovou cestou a home/secondary-copy/richer-canonical fences.
Provider-assigned task CREATE, Microsoft To Do conditionality, VTODO CREATE,
recurrence a scheduling vyžadují samostatná rozhodnutí; nepřebírají event replay
policy automaticky.
