#!/usr/bin/env python3
"""Spec Pilot: read-only inventory, document checks and evidence freshness.

Python 3.10+, standard library only. Exit 0 means the selected mechanical
predicates passed, never acceptance of a design, implementation or release.
"""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys

MAX_BYTES = 2 * 1024 * 1024
CONFIG = ".spec-pilot.json"
PHASES = {
    "orient": ("instructions", "brief", "commands"),
    "design": ("instructions", "brief", "architecture", "specification"),
    "implement": ("instructions", "specification", "technical_design", "tasks", "commands"),
    "verify": ("instructions", "specification", "commands"),
    "release": ("instructions", "specification", "commands", "release"),
}
CANDIDATES = {
    "instructions": ("AGENTS.md", "CLAUDE.md"),
    "brief": ("docs/project-brief.md", "PROJECT.md", "README.md"),
    "architecture": ("docs/architecture.md", "ARCHITECTURE.md", "packages/docs/src/content/docs/architecture/overview.mdx"),
    "specification": ("docs/specification.md", "docs/sync/README.md"),
    "commands": ("package.json", "pyproject.toml", "Makefile", "docs/testing/behavior-scenarios.md"),
    "visual_design": ("DESIGN.md", "docs/ui/design-system.md"),
    "session": ("docs/work-session.md",),
    "release": ("docs/releasing.md", "RELEASING.md"),
}


class InputError(ValueError):
    pass


def contained(root, relative):
    """Accept regular files inside root; reject traversal and symlink inputs."""
    if not isinstance(relative, str) or not relative or "\\" in relative or "\x00" in relative:
        raise InputError("Expected a nonempty repository-relative POSIX path")
    rel = PurePosixPath(relative)
    if rel.is_absolute() or ".." in rel.parts or ":" in relative:
        raise InputError("Absolute paths and traversal are not supported")
    path = root
    for part in rel.parts:
        path = path / part
        if path.is_symlink():
            raise InputError("Symlink inputs are not supported")
    if not path.resolve().is_relative_to(root):
        raise InputError("Path leaves the selected repository")
    if not path.is_file():
        raise InputError("File is missing or is not a regular file")
    if path.stat().st_size > MAX_BYTES:
        raise InputError("Input exceeds the 2 MiB pilot limit")
    return path


def read_json(root, relative):
    try:
        data = json.loads(contained(root, relative).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise InputError(f"Cannot read JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise InputError("Expected a JSON object")
    return data


def digest(root, relative):
    return hashlib.sha256(contained(root, relative).read_bytes()).hexdigest()


def finding(rule, subject, expected, actual):
    return {"id": f"{rule}:{subject}", "rule": rule, "subject": subject,
            "expected": expected, "actual": actual, "severity": "error"}


def discover(root):
    documents = {}
    for role, candidates in CANDIDATES.items():
        found = []
        for candidate in candidates:
            try:
                contained(root, candidate)
                found.append(candidate)
            except InputError:
                continue
        if found:
            # Prefer an explicit brief over a general README; preserve all instructions.
            documents[role] = found[:1] if role == "brief" else found
    specs = root / "openspec/specs"
    if specs.is_dir() and not specs.is_symlink():
        found = []
        for path in sorted(specs.glob("*/spec.md")):
            rel = path.relative_to(root).as_posix()
            try:
                contained(root, rel)
                found.append(rel)
            except InputError:
                continue
        if found:
            documents["specification"] = found
    return documents


def audit(root):
    result = {"schema_version": 1, "operation": "audit", "documents": discover(root),
              "semantic_result": "unknown", "limitations": [
                  "Candidates are file mappings, not accepted requirements.",
                  "Only documented candidate locations were inspected; this is not a full repository scan.",
                  "No project command, model review or browser was executed."]}
    if "package.json" in result["documents"].get("commands", []):
        try:
            package = read_json(root, "package.json")
            scripts = package.get("scripts", {})
            result["package_manager"] = package.get("packageManager")
            result["script_names"] = sorted(scripts) if isinstance(scripts, dict) else []
        except InputError as exc:
            result["limitations"].append(str(exc))
    return result


def draft_config(root):
    return {"schema_version": 1, "mode": "pilot",
            "goal": "Map existing project sources and identify the next bounded step",
            "stop_condition": "Finish orientation; do not start product delivery",
            "documents": discover(root), "checks": {}}


def validate_config(data):
    if type(data.get("schema_version")) is not int or data["schema_version"] != 1:
        raise InputError("schema_version must be integer 1")
    if data.get("mode") not in ("methodology", "pilot", "delivery"):
        raise InputError("mode must be methodology, pilot or delivery")
    for field in ("goal", "stop_condition"):
        if not isinstance(data.get(field), str) or not data[field].strip():
            raise InputError(f"{field} must be a nonempty string")
    docs = data.get("documents")
    if not isinstance(docs, dict):
        raise InputError("documents must map roles to nonempty lists of relative file paths")
    for role, paths in docs.items():
        if not isinstance(role, str) or not role.strip() or not isinstance(paths, list) or not paths:
            raise InputError("Each document role needs a nonempty list")
        if any(not isinstance(p, str) or not p.strip() for p in paths):
            raise InputError(f"Invalid paths for role {role}")
    checks = data.get("checks", {})
    if not isinstance(checks, dict):
        raise InputError("checks must be an object")
    for name, argv in checks.items():
        if not name or not isinstance(argv, list) or not argv or any(not isinstance(a, str) or not a for a in argv):
            raise InputError("Each check must contain a nonempty argument list; checks are never auto-executed")


def placeholder_only(text):
    lines = [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    return bool(lines) and all(re.fullmatch(r"(?:[-*]\s*)?(?:<[^>]+>|\[TODO[^\]]*\]|TODO(?::.*)?|TBD|FILL-IN)", line, re.I) for line in lines)


def check_evidence(root, receipt):
    """Verify supplied hashes, not the truth or provenance of claimed outcomes."""
    if type(receipt.get("schema_version")) is not int or receipt["schema_version"] != 1:
        raise InputError("Evidence schema_version must be integer 1")
    issues = []
    for field in ("subject", "artifacts"):
        values = receipt.get(field)
        if not isinstance(values, dict) or not values:
            issues.append(finding("SP-EVIDENCE-MISSING", field, "Nonempty path-to-SHA256 map", "Missing or empty"))
            continue
        for path, expected in values.items():
            label = f"{field}/{path}"
            if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected):
                issues.append(finding("SP-EVIDENCE-HASH", label, "Lowercase SHA-256", "Invalid hash"))
                continue
            try:
                current = digest(root, path)
                if current != expected:
                    issues.append(finding("SP-EVIDENCE-STALE", label, expected, current))
            except InputError as exc:
                issues.append(finding("SP-EVIDENCE-PATH", label, "Readable contained file", str(exc)))
    return issues


def check(root, phase, ui=False, evidence=None):
    issues = []
    required = list(PHASES[phase]) + (["visual_design"] if ui else [])
    try:
        config = read_json(root, CONFIG)
        validate_config(config)
    except InputError as exc:
        issues.append(finding("SP-CONFIG", CONFIG, "Valid explicit project mapping", str(exc)))
        config = None
    if config:
        for role in required:
            if role not in config["documents"]:
                issues.append(finding("SP-DOCUMENT-ROLE", role, "Mapped relevant document", "Role is not mapped"))
        # Check all declared paths, not just those required by this phase.
        for role, paths in config["documents"].items():
            for relative in paths:
                try:
                    text = contained(root, relative).read_text(encoding="utf-8")
                    if not text.strip() or not re.sub(r"(?m)^\s*#.*$", "", text).strip() or placeholder_only(text):
                        issues.append(finding("SP-DOCUMENT-EMPTY", f"{role}/{relative}", "Substantive content", "Empty, headings only or placeholder only"))
                except (InputError, OSError, UnicodeError) as exc:
                    issues.append(finding("SP-DOCUMENT-PATH", f"{role}/{relative}", "Readable contained UTF-8 file", str(exc)))
    if evidence:
        try:
            issues.extend(check_evidence(root, read_json(root, evidence)))
        except InputError as exc:
            issues.append(finding("SP-EVIDENCE", evidence, "Valid evidence object", str(exc)))
    return {"schema_version": 1, "operation": "check", "phase": phase,
            "mechanical_result": "fail" if issues else "pass", "semantic_result": "unknown",
            "findings": issues, "limitations": [
                "Existence and simple placeholders do not establish document quality or requirement completeness.",
                "Supplied hashes check only declared files; omitted dependencies are not detected.",
                "Execution, test counts, outcome interpretation, provenance and human approvals are not authenticated.",
                "This result does not authorize implementation, merge, publication or deployment."]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="operation", required=True)
    for name in ("audit", "adopt", "check", "fingerprint"):
        p = sub.add_parser(name)
        p.add_argument("--root", required=True, help="Explicit repository or snapshot root")
        if name == "adopt":
            p.add_argument("--write", action="store_true", help="Create a draft mapping; never overwrite")
        if name == "check":
            p.add_argument("--phase", choices=PHASES, default="orient")
            p.add_argument("--ui", action="store_true")
            p.add_argument("--evidence", help="Relative evidence receipt path")
        if name == "fingerprint":
            p.add_argument("--input", action="append", required=True, help="Relative file; repeat as needed")
    args = parser.parse_args(argv)
    try:
        root = Path(args.root).resolve(strict=True)
        if not root.is_dir():
            raise InputError("Root must be a directory")
        if args.operation == "audit":
            result = audit(root)
        elif args.operation == "adopt":
            result = draft_config(root)
            if args.write:
                # Exclusive creation also rejects dangling symlinks and existing mappings.
                with (root / CONFIG).open("x", encoding="utf-8") as out:
                    out.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        elif args.operation == "fingerprint":
            result = {"schema_version": 1, "subject": {p: digest(root, p) for p in args.input},
                      "artifacts": {}, "meaning": "Input fingerprint only; no check has been run"}
        else:
            result = check(root, args.phase, args.ui, args.evidence)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1 if result.get("mechanical_result") == "fail" else 0
    except (OSError, ValueError) as exc:
        print(json.dumps({"error": str(exc), "mechanical_result": "error", "semantic_result": "unknown"}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
