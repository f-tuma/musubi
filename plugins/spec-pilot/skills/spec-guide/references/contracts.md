# Mechanical helper and evidence contracts

Python 3.10+; standard library only. Resolve `scripts/spec_pilot.py` from the installed spec-guide skill directory. All calls require `--root` pointing at the selected checkout or snapshot. No command executes project scripts or contacts a service.

| Operation | Result |
| --- | --- |
| `audit --root ROOT` | Read selected existing candidates and package script names; no write, no readiness verdict |
| `adopt --root ROOT` | Print a proposed mapping and bounded orientation context |
| `adopt --root ROOT --write` | Exclusively create `.spec-pilot.json`; fail instead of overwriting |
| `check --root ROOT --phase PHASE` | Check mapping schema and required document roles; verify declared paths and simple empty/placeholder cases |
| `check ... --ui` | Also require a mapped visual design source |
| `check ... --evidence path.json` | Additionally check supplied subject/artifact hashes against current contained files |
| `fingerprint --root ROOT --input file` | Print input hashes; repeat `--input`; no check or approval is created |

Phases: `orient`, `design`, `implement`, `verify`, `release`. The checker prints JSON. Exit 0 means selected mechanical predicates passed, 1 means findings, 2 means invalid invocation/input or a failed requested write. Every check retains `semantic_result: unknown`. Missing preferred filenames do not fail when an equivalent role is explicitly mapped.

Mapping version 1 contains integer `schema_version: 1`, `mode` (`methodology`, `pilot`, `delivery`), nonempty `goal` and `stop_condition`, and `documents` mapping names to nonempty path lists. Optional `checks` maps names to nonempty argument arrays; it is an index, not execution permission. The helper does not infer approved scope from those strings.

Receipt version 1 contains integer `schema_version: 1`, `subject` and `artifacts`, both nonempty maps from relative file path to lowercase SHA-256. Example input fingerprints are not complete receipts until actual output artifacts are identified. Use exact actual hashes; never fabricate them. Store raw outputs only in an appropriate project-approved location. CI's authoritative final-revision outputs should remain outside the mutable source tree.

A matching receipt checks only the bytes explicitly declared. It cannot detect omitted dependencies, authenticate execution/provenance or human approval, establish useful test counts, interpret results or prove semantic correctness. Adding `passed: true` does not change that. Treat the helper as an advisory/mechanical check, not a trust authority. Repository permissions and protected CI checks enforce actual merge/deployment rules.

Local input paths must stay inside the selected root. Absolute paths, traversal, symlink inputs, nonfiles, inputs over 2 MiB and invalid UTF-8 document mappings are rejected. A larger artifact can use the project's native reporting instead; do not change evidence scope silently.

A semantic finding should include a stable ID, rule, subject, expected/actual state, specific evidence, impact, confidence and next action. Low confidence calls for investigation. `unknown` does not satisfy a required condition; `not-applicable` needs a scope-based reason. A model's lack of findings is not proof of completeness.
