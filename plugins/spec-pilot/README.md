# Spec Pilot 0.1.0

Lokální pilot pluginu pro Claude Code a Codex. Tři skills vedou rozhovor nad projektem; společný Python skript kontroluje mapované podklady a čerstvost deklarovaných důkazů. Python 3.10+, bez instalace dalších balíčků.

## První spuštění v Musubi

Pracuj v checkoutu větve obsahující tuto složku a přečti projektové instrukce. První pokus má skončit inventurou a návrhem jednoho malého dalšího kroku.

### Claude Code

Z kořene Musubi:

```sh
claude plugin validate ./plugins/spec-pilot
claude --plugin-dir ./plugins/spec-pilot
```

Potom v relaci zadej `/spec-pilot:spec-guide` a například:

> Proveď pilot metodiky nad Musubi. Zmapuj existující podklady, ověř jejich odkazy a doporuč jeden malý checkpoint. Teď neimplementuj produktovou funkci. Skonči po inventuře a doporučení.

Plugin se tím načte pro tuto relaci. V instalaci, která tento způsob blokuje nebo nepodporuje, postupuj podle jejího správce a dokumentace; neobcházej nastavení.

### Codex

Repozitář obsahuje lokální marketplace `.agents/plugins/marketplace.json`. Z kořene checkoutu ho lze registrovat:

```sh
codex plugin marketplace add .
codex plugin marketplace list
```

V podporovaném Codex klientu plugin nainstaluj ze zdroje **Spec Pilot local**. Pro klienty s projektovým nastavením pluginů lze do existujícího `.codex/config.toml` doplnit následující sekci; zachovej ostatní nastavení:

```toml
[plugins."spec-pilot@spec-pilot-local"]
enabled = true
```

Obnov klienta/relaci a ověř, že je dostupná skill **spec-guide**. Vyvolej ji jako `$spec-guide` a použij stejné zadání výše. Dostupnost instalace se liší podle klienta a jeho politik; samotná registrace marketplace nedokládá načtení skills.

## Další kroky

| Skill | Úkol |
| --- | --- |
| spec-guide | Orientace, plán, úplnost, drift, polish a příprava vydání |
| spec-review | Prověření návrhu či diffu, přednostně v novém kontextu |
| spec-checkpoint | Realizace a ověření jednoho přijatého checkpointu |

Claude používá jmenný prostor `/spec-pilot:...`; Codex použije nabízené názvy skills. Lze také pokračovat přirozeným rozhovorem s aktivním průvodcem. Manuálně nainstalované pluginy a soubory se mohou cachovat; po změně zdroje použij obnovení/reinstalaci podporovanou klientem.

Kontrolní skript lze spustit i samostatně z kořene projektu:

```sh
python3 plugins/spec-pilot/skills/spec-guide/scripts/spec_pilot.py audit --root .
python3 plugins/spec-pilot/skills/spec-guide/scripts/spec_pilot.py check --root . --phase orient
python3 -m unittest discover -s plugins/spec-pilot/tests -p 'test_*.py' -v
```

Při použití v jiném projektu ponech plugin odděleně a předávej skutečný kořen přes `--root`. Nepřenášej Musubi konfiguraci jako obecné produktové zadání. Mapping vytváří `adopt`, s volbou `--write` pouze pokud soubor ještě neexistuje.

## Co tato verze ověřuje

Kontroluje strukturu mapování, přítomnost obsahu a deklarované hashe. `mechanical_result: pass` a exit 0 znamenají jen splnění těchto podmínek. `semantic_result` zůstává `unknown`. Důkazy o běhu testů, jejich význam, schválení a CI posuzuje příslušná vrstva. Podrobný kontrakt je v [contracts](skills/spec-guide/references/contracts.md).

EGM a Helix jsou použité principy review a checkpointů; nejde o zabalení jejich plných implementací. OpenSpec se použije tam, kde je přijatý vlastníkem workflow. DESIGN.md je možný formát, nikoli povinné jméno místo existujícího designového systému. Formát rychlých scénářů není předepsaný. Automatické hooks, nový MCP server a factory adaptér v této verzi nejsou.

## Ověření klientů

Nativní načtení a běh v Claude Code a Codex musí potvrdit první spuštění v těchto klientech. Lokální Python testy ani review nejsou takovým potvrzením. Výsledky pilotu zaznamenává projektový dokument `docs/agent-system/spec-pilot.md`.

Primární instalační dokumentace: [Claude Code](https://code.claude.com/docs/en/plugins/create), [Codex a portable pluginy](https://developers.openai.com/plugins/build/plugins). Reálné příkazy a možnosti vždy ověř v instalovaném klientu.
