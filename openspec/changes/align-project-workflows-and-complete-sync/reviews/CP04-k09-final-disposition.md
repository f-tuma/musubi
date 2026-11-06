# Disposition final review — CP04 slice 4.1–4.2 (K-09 freshness accepted attemptu)

Datum: 2026-11-06. Autor: Claude Fable 5.1, Orca task `task_853fbd4c76bf` (follow-up ve stejném worktree, větev `codex/cp04-k09-freshness`).

## Původní reviewovaný subjekt

- Diff `e6015977adba39e909a0824787ac9adcb64a8e99..fe55449e1222581bb3c9d02fa0dd550416eb1dbe` (head `fe55449e…`), 8 souborů.
- Manifest `reviews/CP04-k09-final-subject.json` (nezměněná kopie `/tmp/musubi-k09-final-subject.json`), SHA256 `7a0baf814cce623159e6ca67fbd35fe6a716ed3c87f7bd3fb3c6c7b0d3f26747`.
- Report `reviews/CP04-k09-final.md` (nezměněná kopie `/tmp/musubi-k09-final-review.md`, durable kopie `backups/codex-cp01-20261105/reports/K09-final-review.md` původního checkoutu), SHA256 `6959b29b3a86a50e66305cc84ee1f15f0e7d223db50897cb06b66e4b265cfbe2`. Reviewer: Orca task `task_f7194eeecb5c`.
- Verdikt: **APPROVE** bez blockerů; nálezy FR-01–FR-03 (třída D) s výslovným povolením vyřešit je úpravou acceptance textu v téže větvi bez nového code review.

## Co se po review změnilo (pouze evidence)

- Jediný změněný soubor z manifestu: `checkpoints/CP04-k09-acceptance.md` — původní SHA256 `03e1bd27116cb1be044e6cf68c3830f369c593de05b70d4e1260f9959d95000b` → nový `65da7a18750676af3af400a69522ee8fd75d9ad474b3d3ab42bbc1e9a33f28e4`. Změny: FR-01 (`+3/−2` → `+4/−2`), FR-02 (§5 limit `created_at == run_started_at` v reálném attempt 1; diskriminace jen z fixtures M2/M2b), FR-03 (§6 přiznaná hranice zpětné re-verifikace historických publikací; žádná změna časového kontraktu/politiky) a odkaz na tento final review.
- Ostatních 7 souborů manifestu (`docs/releases/publication.md`, `audit-disposition.md`, `checkpoints/CP04-k09-freshness.md`, `reviews/CP04-k09-design.md`, `scripts/quality-proof.mjs`, `scripts/quality-proof.test.mjs`, `scripts/verify-publication.test.mjs`): SHA256 beze změny, ověřeno proti manifestu před commitem. `.spec-pilot.json` zůstává `099538b4…10ae`. Kód a testy se neměnily, proto se `pnpm check`, build ani mutace neopakovaly; původní runs platí svými přesnými source hashi (`backups/spec-sessions/cp04-k09-20261106/`).
- Přidané soubory: `reviews/CP04-k09-final.md`, `reviews/CP04-k09-final-subject.json`, tento soubor. Historický report ani hash manifest se nepřepisují.

## Skutečný stav

Nezávislý final review: **splněn** (APPROVE pro `fe55449e…`; evidence-only změny výše jej neotevírají). Otevřené: PR, 21/21 current-head Quality na PR headu, branch protection, merge; runtime publikace/deployment mimo rozsah. Tasks 4.1/4.2 zůstávají nezaškrtnuté.
