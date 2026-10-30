import contextlib
import importlib.util
import io
import json
from pathlib import Path
import re
import tempfile
import unittest

PLUGIN = Path(__file__).resolve().parents[1]
HELPER = PLUGIN / "skills/spec-guide/scripts/spec_pilot.py"
spec = importlib.util.spec_from_file_location("spec_pilot", HELPER)
sp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sp)


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        for name in ("AGENTS.md", "README.md", "package.json"):
            self.put(name, '{"scripts": {"test": "echo deliberately-not-executed"}}' if name.endswith("json") else "# Source\nActual project behavior and commands.\n")
        self.config = sp.draft_config(self.root)
        self.save()

    def put(self, path, text):
        p = self.root / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")

    def save(self):
        self.put(sp.CONFIG, json.dumps(self.config))

    def run_cli(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = sp.main([*args, "--root", str(self.root)])
        return code, json.loads(out.getvalue())

    def receipt(self):
        self.put("reports/test-output.txt", "1 actual fixture test result for this test\n")
        return {"schema_version": 1, "subject": {"README.md": sp.digest(self.root, "README.md")},
                "artifacts": {"reports/test-output.txt": sp.digest(self.root, "reports/test-output.txt")}}

    def test_audit_is_read_only_and_not_semantic_acceptance(self):
        before = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        code, report = self.run_cli("audit")
        after = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        self.assertEqual(before, after)
        self.assertEqual(code, 0)
        self.assertEqual(report["semantic_result"], "unknown")
        self.assertEqual(report["script_names"], ["test"])

    def test_equivalent_visual_design_is_discovered(self):
        self.put("docs/ui/design-system.md", "Existing canonical token usage rules")
        self.assertEqual(sp.audit(self.root)["documents"]["visual_design"], ["docs/ui/design-system.md"])

    def test_explicit_brief_preferred_over_readme(self):
        self.put("docs/project-brief.md", "User-owned purpose")
        self.assertEqual(sp.discover(self.root)["brief"], ["docs/project-brief.md"])

    def test_instruction_alias_maps_the_regular_canonical_source_once(self):
        (self.root / "CLAUDE.md").symlink_to("AGENTS.md")
        draft = sp.draft_config(self.root)
        self.assertEqual(draft["documents"]["instructions"], ["AGENTS.md"])
        self.assertEqual(sp.check(self.root, "orient")["mechanical_result"], "pass")

    def test_adopt_refuses_existing_mapping_without_overwriting(self):
        before = (self.root / sp.CONFIG).read_bytes()
        code, _ = self.run_cli("adopt", "--write")
        self.assertEqual(code, 2)
        self.assertEqual((self.root / sp.CONFIG).read_bytes(), before)

    def test_adopt_draft_and_explicit_creation(self):
        (self.root / sp.CONFIG).unlink()
        code, draft = self.run_cli("adopt")
        self.assertEqual(code, 0)
        self.assertFalse((self.root / sp.CONFIG).exists())
        code, written = self.run_cli("adopt", "--write")
        self.assertEqual(code, 0)
        self.assertEqual(draft, written)
        self.assertEqual(json.loads((self.root / sp.CONFIG).read_text()), written)

    def test_missing_config_fails(self):
        (self.root / sp.CONFIG).unlink()
        code, report = self.run_cli("check")
        self.assertEqual(code, 1)
        self.assertEqual(report["findings"][0]["rule"], "SP-CONFIG")

    def test_valid_mapping_only_passes_mechanical_predicates(self):
        code, report = self.run_cli("check")
        self.assertEqual(code, 0)
        self.assertEqual(report["mechanical_result"], "pass")
        self.assertEqual(report["semantic_result"], "unknown")

    def test_missing_required_role_fails(self):
        del self.config["documents"]["brief"]
        self.save()
        self.assertTrue(any(f["rule"] == "SP-DOCUMENT-ROLE" for f in sp.check(self.root, "orient")["findings"]))

    def test_existing_equivalent_file_satisfies_role(self):
        self.put("custom/intent.txt", "Actual intent and boundaries")
        self.config["documents"]["brief"] = ["custom/intent.txt"]
        self.save()
        self.assertEqual(sp.check(self.root, "orient")["mechanical_result"], "pass")

    def test_empty_heading_or_placeholder_is_not_substantive(self):
        for content in ("", "  \n", "# Brief\n## Purpose\n", "# Brief\n<fill in>\n", "TODO: write brief"):
            with self.subTest(content=content):
                self.put("README.md", content)
                self.assertTrue(any(f["rule"] == "SP-DOCUMENT-EMPTY" for f in sp.check(self.root, "orient")["findings"]))

    def test_real_document_can_contain_a_todo(self):
        self.put("README.md", "# Intent\nActual accepted purpose.\nTODO: optional later detail")
        self.assertEqual(sp.check(self.root, "orient")["mechanical_result"], "pass")

    def test_invalid_utf8_is_reported(self):
        (self.root / "README.md").write_bytes(b"\xff")
        self.assertEqual(sp.check(self.root, "orient")["findings"][0]["rule"], "SP-DOCUMENT-PATH")

    def test_missing_mapped_file_fails(self):
        self.config["documents"]["brief"] = ["missing.md"]
        self.save()
        self.assertEqual(sp.check(self.root, "orient")["mechanical_result"], "fail")

    def test_paths_cannot_escape_or_follow_symlinks(self):
        with tempfile.TemporaryDirectory() as other:
            secret = Path(other) / "outside.txt"
            secret.write_text("outside")
            (self.root / "linked.md").symlink_to(secret)
            (self.root / "local-link.md").symlink_to(self.root / "README.md")
            for path in (str(secret), "../outside.txt", "a/../../outside", "linked.md", "local-link.md", "C:\\outside.txt"):
                with self.subTest(path=path), self.assertRaises(sp.InputError):
                    sp.contained(self.root, path)

    def test_large_input_is_rejected(self):
        (self.root / "large").write_bytes(b"x" * (sp.MAX_BYTES + 1))
        with self.assertRaises(sp.InputError):
            sp.digest(self.root, "large")

    def test_embedded_nul_produces_structured_failure(self):
        self.config["documents"]["brief"] = ["bad\x00path"]
        self.save()
        code, report = self.run_cli("check")
        self.assertEqual(code, 1)
        self.assertEqual(report["findings"][0]["rule"], "SP-DOCUMENT-PATH")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = sp.main(["audit", "--root", "bad\x00root"])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(out.getvalue())["mechanical_result"], "error")

    def test_invalid_config_types_do_not_pass(self):
        for field, value in (("schema_version", True), ("mode", "oops"), ("goal", ""), ("stop_condition", None), ("documents", []), ("checks", {"test": "sh command"})):
            with self.subTest(field=field):
                broken = dict(self.config, **{field: value})
                self.put(sp.CONFIG, json.dumps(broken))
                self.assertEqual(sp.check(self.root, "orient")["findings"][0]["rule"], "SP-CONFIG")

    def test_malformed_json_and_nonobject_config_fail(self):
        for raw in ("{", "[]", "null"):
            self.put(sp.CONFIG, raw)
            self.assertEqual(sp.check(self.root, "orient")["mechanical_result"], "fail")

    def test_mapping_path_list_must_be_nonempty(self):
        for value in ([], "README.md", [None], [""]):
            self.config["documents"]["brief"] = value
            self.save()
            self.assertEqual(sp.check(self.root, "orient")["mechanical_result"], "fail")

    def test_ui_requires_equivalent_design_without_forcing_filename(self):
        self.assertEqual(sp.check(self.root, "orient", ui=True)["mechanical_result"], "fail")
        self.put("style-rules.txt", "Canonical design and token source")
        self.config["documents"]["visual_design"] = ["style-rules.txt"]
        self.save()
        self.assertEqual(sp.check(self.root, "orient", ui=True)["mechanical_result"], "pass")

    def test_implement_does_not_inherit_orientation_readiness(self):
        report = sp.check(self.root, "implement")
        self.assertEqual(report["mechanical_result"], "fail")
        self.assertTrue(any(f["subject"] == "technical_design" for f in report["findings"]))

    def test_configured_commands_are_not_executed(self):
        self.config["checks"] = {"unexpected": ["touch", "SHOULD_NOT_EXIST"]}
        self.save()
        self.run_cli("check")
        self.run_cli("audit")
        self.assertFalse((self.root / "SHOULD_NOT_EXIST").exists())

    def test_fingerprint_is_not_complete_execution_evidence(self):
        code, report = self.run_cli("fingerprint", "--input", "README.md")
        self.assertEqual(code, 0)
        self.assertEqual(report["subject"]["README.md"], sp.digest(self.root, "README.md"))
        self.assertTrue(sp.check_evidence(self.root, report))

    def test_current_receipt_checks_only_declared_bytes(self):
        receipt = self.receipt()
        receipt["passed"] = True
        receipt["tests_executed"] = 0
        self.put("receipt.json", json.dumps(receipt))
        code, report = self.run_cli("check", "--evidence", "receipt.json")
        self.assertEqual(code, 0)
        self.assertEqual(report["semantic_result"], "unknown")
        self.assertTrue(any("test counts" in x for x in report["limitations"]))

    def test_changed_subject_invalidates_receipt(self):
        receipt = self.receipt()
        self.put("README.md", "Changed requirement")
        self.assertEqual(sp.check_evidence(self.root, receipt)[0]["rule"], "SP-EVIDENCE-STALE")

    def test_changed_artifact_invalidates_receipt(self):
        receipt = self.receipt()
        self.put("reports/test-output.txt", "Rewritten output")
        self.assertEqual(sp.check_evidence(self.root, receipt)[0]["rule"], "SP-EVIDENCE-STALE")

    def test_missing_artifact_is_not_evidence(self):
        receipt = self.receipt()
        (self.root / "reports/test-output.txt").unlink()
        self.assertEqual(sp.check_evidence(self.root, receipt)[0]["rule"], "SP-EVIDENCE-PATH")
        receipt["artifacts"] = {}
        self.assertEqual(sp.check_evidence(self.root, receipt)[0]["rule"], "SP-EVIDENCE-MISSING")

    def test_malformed_evidence_is_reported(self):
        self.put("receipt.json", "{not-json}")
        code, report = self.run_cli("check", "--evidence", "receipt.json")
        self.assertEqual(code, 1)
        self.assertTrue(any(f["rule"] == "SP-EVIDENCE" for f in report["findings"]))

    def test_invalid_hash_and_traversal_in_receipt_fail(self):
        receipt = self.receipt()
        receipt["subject"] = {"README.md": "fake", "../outside.txt": "0" * 64}
        rules = {f["rule"] for f in sp.check_evidence(self.root, receipt)}
        self.assertEqual(rules, {"SP-EVIDENCE-HASH", "SP-EVIDENCE-PATH"})

    def test_finding_ids_are_stable(self):
        (self.root / "README.md").unlink()
        self.assertEqual(sp.check(self.root, "orient")["findings"], sp.check(self.root, "orient")["findings"])


class PackageTests(unittest.TestCase):
    def test_three_manifests_share_identity_and_presentation(self):
        portable = json.loads((PLUGIN / "plugin.json").read_text())
        codex = json.loads((PLUGIN / ".codex-plugin/plugin.json").read_text())
        claude = json.loads((PLUGIN / ".claude-plugin/plugin.json").read_text())
        self.assertEqual(portable["$schema"], "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json")
        for manifest in (codex, claude):
            for key in ("name", "version", "description", "author", "license"):
                self.assertEqual(portable[key], manifest[key])
        self.assertEqual(portable["extensions"]["com.openai"]["interface"], codex["interface"])
        self.assertLessEqual(len(codex["interface"]["shortDescription"]), 30)
        self.assertEqual(codex["skills"], "./skills/")

    def test_three_skills_have_matching_names_and_self_contained_links(self):
        skills = list((PLUGIN / "skills").glob("*/SKILL.md"))
        self.assertEqual(len(skills), 3)
        for skill in skills:
            text = skill.read_text()
            self.assertTrue(text.startswith("---\n"))
            self.assertIn("\nname: " + skill.parent.name + "\n", text)
            self.assertIn("\ndescription: ", text)
        for path in PLUGIN.rglob("*.md"):
            text = path.read_text()
            for link in re.findall(r"\[[^\]]+\]\(([^\s)]+)\)", text):
                if link.startswith(("https://", "http://", "#")):
                    continue
                target = (path.parent / link.split("#", 1)[0]).resolve()
                self.assertTrue(target.is_relative_to(PLUGIN), (path, link))
                self.assertTrue(target.is_file(), (path, link))


if __name__ == "__main__":
    unittest.main()
