"""Write bounded Android build/cache timing evidence without uploading a build scan."""

import argparse
import json
import os
from pathlib import Path
import re


OUTCOMES = {"success", "failure", "cancelled", "skipped"}
HASH = r"[a-f0-9]{64}"
SHA = r"[a-f0-9]{40}"
IMAGE_VERSION = r"[0-9]{8}\.[0-9]{1,9}(?:\.[0-9]{1,9})?"
IMAGE = rf"ubuntu[0-9]{{2}}-{IMAGE_VERSION}"
COMPATIBILITY = rf"android-gradle-v1-Linux-(?:X64|ARM64)-{IMAGE}-{HASH}-{HASH}-"
PREFIX = rf"{COMPATIBILITY}{HASH}-"
KEY = rf"{PREFIX}{SHA}"


def metadata(env):
    """Read only allowlisted public build metadata; never copy arbitrary env."""
    invalid = []

    def value(name, pattern, max_length=512):
        raw = env.get(name, "")
        if not raw:
            return None
        if not isinstance(raw, str) or len(raw) > max_length or not re.fullmatch(pattern, raw):
            invalid.append(name)
            return None
        return raw

    def sha(name):
        result = value(name, SHA)
        if result == "0" * 40:
            invalid.append(name)
            return None
        return result

    def number(name):
        raw = value(name, r"[1-9][0-9]{0,14}")
        return int(raw) if raw else None

    def outcome(name):
        raw = env.get(name, "")
        if isinstance(raw, str) and raw in OUTCOMES:
            return raw
        if raw and raw != "unknown":
            invalid.append(name)
        return "unknown"

    context = {
        "repository": value("ANDROID_CI_REPOSITORY", r"f-tuma/musubi"),
        "run_id": number("ANDROID_CI_RUN_ID"),
        "run_attempt": number("ANDROID_CI_RUN_ATTEMPT"),
        "event": value("ANDROID_CI_EVENT_NAME", r"push|pull_request|workflow_call"),
        "ref": value("ANDROID_CI_REF", r"refs/heads/main|refs/pull/[1-9][0-9]{0,14}/merge", 64),
        "checkout_sha": sha("ANDROID_CI_CHECKOUT_SHA"),
        "github_sha": sha("ANDROID_CI_GITHUB_SHA"),
        "head_sha": sha("ANDROID_CI_HEAD_SHA"),
    }
    context["complete"] = all(context.values())
    context["coherent"] = None
    if context["complete"]:
        context["coherent"] = context["checkout_sha"] == context["github_sha"]
        if context["event"] == "push":
            context["coherent"] &= context["ref"] == "refs/heads/main" and context["head_sha"] == context["github_sha"]
        elif context["event"] == "pull_request":
            context["coherent"] &= context["ref"].startswith("refs/pull/")
    components = {
        "runner_platform": value("ANDROID_CI_RUNNER_PLATFORM", r"Linux-(?:X64|ARM64)"),
        "image_os": value("ANDROID_CI_IMAGE_OS", r"ubuntu[0-9]{2}"),
        "image_version": value("ANDROID_CI_IMAGE_VERSION", IMAGE_VERSION, 32),
        "jdk_release_hash": value("GRADLE_CACHE_JDK_HASH", HASH),
        "compatibility_hash": value("GRADLE_CACHE_COMPATIBILITY_HASH", HASH),
        "native_contract_hash": value("GRADLE_CACHE_NATIVE_HASH", HASH),
    }
    request = {
        "key": value("GRADLE_CACHE_REQUESTED_KEY", KEY),
        "prefix": value("GRADLE_CACHE_PREFIX", PREFIX),
        "compatibility_prefix": value("GRADLE_CACHE_COMPATIBILITY_PREFIX", COMPATIBILITY),
        "components": components,
    }
    coherent = None
    if all(components.values()) and context["complete"] and all(request[k] for k in ("key", "prefix", "compatibility_prefix")):
        compatibility = "android-gradle-v1-" + "-".join(components[k] for k in (
            "runner_platform", "image_os", "image_version", "jdk_release_hash", "compatibility_hash")) + "-"
        prefix = compatibility + components["native_contract_hash"] + "-"
        coherent = (context["coherent"] and request["compatibility_prefix"] == compatibility and request["prefix"] == prefix
                    and request["key"] == prefix + context["github_sha"])
        if context["checkout_sha"] and context["checkout_sha"] != context["github_sha"]:
            coherent = False
    request["coherent"] = coherent
    primary = value("GRADLE_CACHE_PRIMARY_KEY", KEY)
    matched = value("GRADLE_CACHE_MATCHED_KEY", KEY)
    restore = outcome("GRADLE_CACHE_RESTORE_OUTCOME")
    save = outcome("GRADLE_CACHE_SAVE_OUTCOME")
    hit = env.get("GRADLE_CACHE_HIT", "")
    if hit not in ("", "true", "false"):
        invalid.append("GRADLE_CACHE_HIT")
    state, exact = "unavailable", None
    if restore == "skipped" and any(env.get(name, "") for name in (
            "GRADLE_CACHE_PRIMARY_KEY", "GRADLE_CACHE_MATCHED_KEY", "GRADLE_CACHE_HIT")):
        state = "inconsistent"
    elif restore in {"skipped", "failure", "cancelled"}:
        state = restore
    elif restore == "success":
        if (coherent is False or invalid or (primary and primary != request["key"])
                or (matched and not primary) or (hit == "true" and (not primary or not matched))):
            state = "inconsistent"
        elif coherent is True and primary == request["key"]:
            if hit == "true" and matched == primary:
                state, exact = "exact", True
            elif hit == "false" and matched and matched != primary and matched.startswith(request["compatibility_prefix"]):
                state, exact = "partial", False
            elif not hit and not matched:
                # The pinned action/toolkit also returns no match after some
                # service/extraction warnings. This is not a confirmed miss.
                state = "no_match_reported"
            else:
                state = "inconsistent"
    cache = {
        "request": request, "action_primary_key": primary, "matched_key": matched,
        "restore_state": state, "exact_hit": exact, "restore_outcome": restore,
        "save_outcome": save,
        "save_state": "attempted_unverified" if save == "success" else "unavailable" if save == "unknown" else save,
        "archive_persisted": None,
        "restore_match_scope": ("exact" if state == "exact" else
                                ("native_contract" if matched.startswith(request["prefix"]) else "compatibility")
                                if state == "partial" else None),
    }
    ccache = env.get("ANDROID_CI_CCACHE_AVAILABLE", "")
    if ccache not in ("", "true", "false"):
        invalid.append("ANDROID_CI_CCACHE_AVAILABLE")
    return context, cache, {"executable_on_path": {"true": True, "false": False}.get(ccache)}, invalid, outcome("ANDROID_BUILD_OUTCOME"), outcome("ANDROID_DEX_OUTCOME")


def cmake_tasks(log, build_complete):
    # Only aggregate fixed phase/ABI/outcome labels; never export task paths.
    observed = {}
    pattern = (r"^> Task (:(?:[^\s:]+:)+(build|configure)CMake[A-Za-z]+\[(arm64-v8a|x86_64)\])"
               r"(?: (FROM-CACHE|UP-TO-DATE|SKIPPED|NO-SOURCE|FAILED))?$")
    truncated = False
    for match in re.finditer(pattern, log, re.MULTILINE):
        if len(observed) >= 256 and match[1] not in observed:
            truncated = True
            continue
        observed[match[1]] = (match[2], match[3], match[4] or "executed")
    counts = {phase: {abi: {outcome: 0 for outcome in (
        "executed", "FROM-CACHE", "UP-TO-DATE", "SKIPPED", "NO-SOURCE", "FAILED")}
        for abi in ("arm64-v8a", "x86_64")} for phase in ("build", "configure")}
    for phase, abi, outcome in observed.values():
        counts[phase][abi][outcome] += 1
    return {"complete_build_log": build_complete and not truncated, "truncated": truncated,
            "observed_task_count": len(observed), "observed_outcomes": counts}


def elapsed_seconds(directory, phase):
    try:
        start = int((directory / f"{phase}.start").read_text())
        end = int((directory / f"{phase}.end").read_text())
    except (FileNotFoundError, ValueError):
        return None
    return round((end - start) / 1000, 3) if end >= start else None


def task_totals(log):
    unknown = {"executed": None, "from_cache": None, "up_to_date": None}
    summaries = re.findall(r"^([0-9]{1,9}) actionable tasks?: (.+)$", log, re.MULTILINE)
    if len(summaries) != 1:
        return unknown
    total, text = summaries[0]
    counts = {key: 0 for key in unknown}
    seen = set()
    labels = {"executed": "executed", "from cache": "from_cache", "up-to-date": "up_to_date"}
    for item in text.split(", "):
        match = re.fullmatch(r"([0-9]{1,9}) (executed|from cache|up-to-date)", item)
        if not match or match[2] in seen:
            return unknown
        seen.add(match[2])
        counts[labels[match[2]]] = int(match[1])
    return counts if sum(counts.values()) == int(total) else unknown


def build_report(directory, env):
    log_path = directory / "gradle.log"
    log = log_path.read_text(errors="replace") if log_path.exists() else ""
    counts = task_totals(log)
    context, cache, ccache, invalid, build_outcome, dex_outcome = metadata(env)
    return {
        "schema_version": 2,
        "context": context,
        "seconds": {phase: elapsed_seconds(directory, phase) for phase in ("restore", "build", "save")},
        "cache": cache,
        "ccache": ccache,
        "invalid_metadata_fields": sorted(set(invalid)),
        "build_outcome": build_outcome,
        "dex_outcome": dex_outcome,
        "tasks": counts,
        "cmake": cmake_tasks(log, counts["executed"] is not None and build_outcome == "success"),
        "from_cache_task_lines": len(re.findall(r"^> Task \S+ FROM-CACHE$", log, re.MULTILINE)),
    }


def write_report(directory, summary_path, env):
    directory.mkdir(parents=True, exist_ok=True)
    report = build_report(directory, env)
    (directory / "timings.json").write_text(json.dumps(report, indent=2) + "\n")
    with summary_path.open("a") as summary:
        summary.write("## Android build and cache\n\n")
        summary.write(f"Build: {report['build_outcome']}; APK/AAB DEX: {report['dex_outcome']}.\n\n")
        summary.write(f"Run: {report['context']['run_id']}; attempt: {report['context']['run_attempt']}; "
                      f"checkout: {report['context']['checkout_sha']}.\n\n")
        summary.write(f"Cache exact hit: {report['cache']['exact_hit']}; matched entry: {bool(report['cache']['matched_key'])}. "
                      f"Restore: {report['cache']['restore_outcome']}; save: {report['cache']['save_outcome']}.\n\n")
        summary.write(f"Restore evidence: {report['cache']['restore_state']}; "
                      f"save evidence: {report['cache']['save_state']}. "
                      "No reported match is not a confirmed miss; save action success is not archive persistence.\n\n")
        summary.write("| Step | Wall time (seconds) |\n| --- | ---: |\n")
        for phase, seconds in report["seconds"].items():
            summary.write(f"| {phase} | {seconds if seconds is not None else 'unavailable / skipped'} |\n")
        summary.write(f"\nGradle task totals: {json.dumps(report['tasks'])}. "
                      f"FROM-CACHE task lines: {report['from_cache_task_lines']}.\n\n")
        summary.write("Local Gradle profile and timing JSON are in `android-build-timings`. "
                      "A restored archive does not prove that native compilation was cacheable.\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--summary", type=Path, required=True)
    args = parser.parse_args()
    write_report(args.directory, args.summary, os.environ)
