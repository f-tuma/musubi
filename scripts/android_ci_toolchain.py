"""Report bounded, selected Android toolchains without changing cache policy."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

from android_ci_report import metadata


ABIS = ("arm64-v8a", "x86_64")
VERSION = r"[0-9]{1,3}(?:\.[0-9]{1,10}){1,3}(?:-(?:alpha|beta|rc|milestone)-?[0-9]{1,3})?"
JAVA_VERSION = r"[0-9]{1,3}(?:\.[0-9]{1,10}){0,3}(?:\+[0-9]{1,5})?(?:-(?:LTS|ea))?"
HASH = r"[a-f0-9]{64}"
MAX_JSON = 1024 * 1024
MAX_TEXT = 4 * 1024 * 1024
MAX_BINARY = 512 * 1024 * 1024
MAX_HASH_BYTES = 2 * 1024 * 1024 * 1024
BAD = {
    "context_invalid", "input_invalid", "input_stale", "path_untrusted",
    "selection_ambiguous", "selected_cache_invalid", "compiler_metadata_invalid",
    "toolchain_file_untrusted", "toolchain_file_invalid", "timings_invalid",
    "observer_coverage_mismatch",
}


class EvidenceError(Exception):
    def __init__(self, issue):
        self.issue = issue


def require(ok, issue):
    if not ok:
        raise EvidenceError(issue)


def object_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def regular_bytes(path, maximum, missing="toolchain_file_missing"):
    try:
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode), "toolchain_file_untrusted")
        require(info.st_size <= maximum, "hash_limit_exceeded")
        with path.open("rb") as stream:
            value = stream.read(maximum + 1)
        require(len(value) <= maximum, "hash_limit_exceeded")
        after = path.lstat()
        require((info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
                == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
                and len(value) == info.st_size, "toolchain_file_invalid")
        return value
    except FileNotFoundError:
        raise EvidenceError(missing) from None
    except OSError:
        raise EvidenceError("read_error") from None


def read_json(path, maximum=MAX_JSON, missing="input_missing"):
    try:
        return json.loads(regular_bytes(path, maximum, missing), object_pairs_hook=object_pairs)
    except (ValueError, UnicodeError, RecursionError):
        raise EvidenceError("input_invalid") from None


def text(path, maximum=MAX_TEXT, missing="toolchain_file_missing"):
    try:
        return regular_bytes(path, maximum, missing).decode("utf-8")
    except UnicodeError:
        raise EvidenceError("toolchain_file_invalid") from None


def string(value, pattern, maximum=64):
    return isinstance(value, str) and len(value) <= maximum and re.fullmatch(pattern, value) is not None


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def digest(value):
    return hashlib.sha256(value).hexdigest()


def contained(path, root, issue="path_untrusted"):
    require(isinstance(path, str) and 0 < len(path) <= 4096 and "\x00" not in path, issue)
    candidate = Path(path)
    require(candidate.is_absolute(), issue)
    try:
        resolved = candidate.resolve(strict=True)
        require(resolved.is_relative_to(root), issue)
        return resolved
    except (OSError, RuntimeError):
        raise EvidenceError(issue) from None


class BinaryHashes:
    def __init__(self, sdk):
        self.sdk = sdk
        self.cache = {}
        self.total = 0

    def file(self, raw):
        path = contained(raw, self.sdk, "toolchain_file_untrusted")
        try:
            info = path.stat()
            identity = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
            if (path, identity) in self.cache:
                return self.cache[(path, identity)]
            require(stat.S_ISREG(info.st_mode), "toolchain_file_untrusted")
            require(len(self.cache) < 64 and info.st_size <= MAX_BINARY
                    and self.total + info.st_size <= MAX_HASH_BYTES,
                    "hash_limit_exceeded")
            result = hashlib.sha256()
            read = 0
            with path.open("rb") as stream:
                while chunk := stream.read(1024 * 1024):
                    read += len(chunk)
                    require(read <= MAX_BINARY and self.total + read <= MAX_HASH_BYTES, "hash_limit_exceeded")
                    result.update(chunk)
            require(read == info.st_size, "toolchain_file_invalid")
            after = path.stat()
            require(identity == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
                    "toolchain_file_invalid")
            self.total += read
            self.cache[(path, identity)] = result.hexdigest()
            return self.cache[(path, identity)]
        except OSError:
            raise EvidenceError("read_error") from None


def cache_values(cache):
    keys = {
        "ANDROID_NDK", "CMAKE_ANDROID_NDK", "ANDROID_ABI", "CMAKE_ANDROID_ARCH_ABI",
        "ANDROID_PLATFORM", "CMAKE_SYSTEM_VERSION", "CMAKE_BUILD_TYPE", "CMAKE_GENERATOR",
        "CMAKE_COMMAND", "CMAKE_MAKE_PROGRAM", "CMAKE_C_COMPILER", "CMAKE_CXX_COMPILER",
        "CMAKE_CACHE_MAJOR_VERSION", "CMAKE_CACHE_MINOR_VERSION", "CMAKE_CACHE_PATCH_VERSION",
        "CMAKE_C_FLAGS", "CMAKE_CXX_FLAGS", "CMAKE_C_FLAGS_RELWITHDEBINFO",
        "CMAKE_CXX_FLAGS_RELWITHDEBINFO", "ANDROID_STL",
    }
    values = {}
    for line in text(cache, missing="selected_cache_missing").splitlines():
        match = re.fullmatch(r"([A-Za-z0-9_]+):[A-Za-z_]+=(.*)", line)
        if not match or match[1] not in keys:
            continue
        require(match[1] not in values and len(match[2]) <= 32768, "selected_cache_invalid")
        values[match[1]] = match[2]
    return values


def agreeing(values, keys, issue="selected_cache_invalid"):
    selected = [values[key] for key in keys if key in values]
    require(selected and all(value == selected[0] for value in selected), issue)
    return selected[0]


def compiler_values(directory, cmake_version, language):
    # The cache's exact version identifies its compiler-info directory. A build
    # suffix is accepted only when it is unique; never choose the newest entry.
    try:
        children = []
        for child in (directory / "CMakeFiles").iterdir():
            require(len(children) < 64, "hash_limit_exceeded")
            children.append(child)
    except FileNotFoundError:
        raise EvidenceError("compiler_metadata_missing") from None
    except OSError:
        raise EvidenceError("read_error") from None
    matches = [child for child in children if re.fullmatch(re.escape(cmake_version) + r"(?:-g[a-f0-9]{1,64})?", child.name)]
    require(len(matches) == 1, "compiler_metadata_missing" if not matches else "selection_ambiguous")
    folder = contained(str(matches[0]), directory, "toolchain_file_untrusted")
    values = {}
    names = {f"CMAKE_{language}_COMPILER", f"CMAKE_{language}_COMPILER_ID", f"CMAKE_{language}_COMPILER_VERSION"}
    for line in text(folder / f"CMake{language}Compiler.cmake", missing="compiler_metadata_missing").splitlines():
        match = re.fullmatch(r'set\((CMAKE_[A-Z_]+) "([^"\r\n]*)"\)', line.strip())
        if match and match[1] in names:
            require(match[1] not in values, "compiler_metadata_invalid")
            values[match[1]] = match[2]
    require(set(values) == names, "compiler_metadata_invalid")
    require(values[f"CMAKE_{language}_COMPILER_ID"] == "Clang", "compiler_metadata_invalid")
    require(string(values[f"CMAKE_{language}_COMPILER_VERSION"], VERSION), "compiler_metadata_invalid")
    return values


def selected_record(project, directory, abi, workspace, sdk, hashes):
    # AGP may redirect a model folder through build.ninja.txt. This observer
    # deliberately does not read/follow that marker: only a regular Ninja file
    # in the directly selected model directory is supported in this slice.
    ninja_file = directory / "build.ninja"
    try:
        ninja_info = ninja_file.lstat()
    except FileNotFoundError:
        raise EvidenceError("selection_redirected" if (directory / "build.ninja.txt").exists()
                            else "selected_build_missing") from None
    require(stat.S_ISREG(ninja_info.st_mode), "toolchain_file_untrusted")
    values = cache_values(directory / "CMakeCache.txt")
    require(agreeing(values, ("ANDROID_ABI", "CMAKE_ANDROID_ARCH_ABI")) == abi, "selected_cache_invalid")
    require(values.get("CMAKE_BUILD_TYPE") == "RelWithDebInfo" and values.get("CMAKE_GENERATOR") == "Ninja",
            "selected_cache_invalid")
    require(string(values.get("ANDROID_PLATFORM"), r"android-[1-9][0-9]{0,2}"), "selected_cache_invalid")
    api = int(values["ANDROID_PLATFORM"][8:])
    require(values.get("CMAKE_SYSTEM_VERSION", str(api)) == str(api), "selected_cache_invalid")
    ndk = contained(agreeing(values, ("ANDROID_NDK", "CMAKE_ANDROID_NDK")), sdk, "toolchain_file_untrusted")
    properties = regular_bytes(ndk / "source.properties", 65536)
    revisions = re.findall(rb"^Pkg\.Revision\s*=\s*([^\r\n]+)\s*$", properties, re.MULTILINE)
    require(len(revisions) == 1, "toolchain_file_invalid")
    try:
        revision = revisions[0].strip().decode("ascii")
    except UnicodeError:
        raise EvidenceError("toolchain_file_invalid") from None
    require(string(revision, VERSION), "toolchain_file_invalid")
    parts = [values.get(f"CMAKE_CACHE_{part}_VERSION", "") for part in ("MAJOR", "MINOR", "PATCH")]
    require(all(string(part, r"[0-9]{1,4}") for part in parts), "selected_cache_invalid")
    cmake_version = ".".join(parts)
    cpp = compiler_values(directory, cmake_version, "CXX")
    c = compiler_values(directory, cmake_version, "C")
    for language, compiler in (("CXX", cpp), ("C", c)):
        key = f"CMAKE_{language}_COMPILER"
        require(key not in values or values[key] == compiler[key], "compiler_metadata_invalid")
        contained(compiler[key], ndk, "toolchain_file_untrusted")
    flags = {}
    for key in ("CMAKE_C_FLAGS", "CMAKE_CXX_FLAGS", "CMAKE_C_FLAGS_RELWITHDEBINFO", "CMAKE_CXX_FLAGS_RELWITHDEBINFO"):
        require(key in values, "selected_cache_invalid")
        flags[key] = values[key].replace(str(workspace), "<workspace>").replace(str(sdk), "<sdk>")
    require(values.get("ANDROID_STL") in ("c++_shared", "c++_static", "none", "system"), "selected_cache_invalid")
    return {
        "module_id": digest(project.relative_to(workspace).as_posix().encode("utf-8")),
        "abi": abi, "build_type": "RelWithDebInfo", "android_api": api,
        "android_stl": values["ANDROID_STL"], "ndk_revision": revision,
        "ndk_source_sha256": digest(properties),
        "c_compiler_id": "Clang", "c_compiler_version": c["CMAKE_C_COMPILER_VERSION"],
        "c_compiler_sha256": hashes.file(c["CMAKE_C_COMPILER"]),
        "cxx_compiler_id": "Clang", "cxx_compiler_version": cpp["CMAKE_CXX_COMPILER_VERSION"],
        "cxx_compiler_sha256": hashes.file(cpp["CMAKE_CXX_COMPILER"]),
        "cmake_version": cmake_version, "cmake_sha256": hashes.file(values.get("CMAKE_COMMAND")),
        "ninja_version": None, "ninja_sha256": hashes.file(values.get("CMAKE_MAKE_PROGRAM")),
        "global_flags_sha256": digest(canonical(flags)),
    }


def build_toolchain_report(directory, private_input, workspace, sdk_root, env):
    context, cache, _, invalid, build_outcome, _ = metadata(env)
    components = cache["request"]["components"]
    issues = set()
    selected = []
    runtime = {"gradle_version": None, "agp_versions": [], "jdk_version": None, "jdk_release_sha256": None}
    report = {
        "schema_version": 1, "context": context,
        "observations": {"image_version": components["image_version"], "build_outcome": build_outcome},
        "runtime": runtime,
        "scope": {"abis": list(ABIS), "module_count": 0, "selected_module_abi_count": 0,
                  "target_flags_covered": False},
        "selected": selected,
        "shadow_fingerprint": {"schema_version": 1, "algorithm": "sha256", "mode": "shadow", "value": None},
        "status": "incomplete", "issues": [],
    }
    try:
        require(not invalid and context["complete"] is True and context["coherent"] is True
                and cache["request"]["coherent"] is True, "context_invalid")
        timings = read_json(directory / "timings.json", 65536, "timings_missing")
        require(isinstance(timings, dict) and type(timings.get("schema_version")) is int
                and timings["schema_version"] == 2 and isinstance(timings.get("context"), dict)
                and timings["context"] == context
                and all(type(timings["context"][key]) is type(value) for key, value in context.items())
                and isinstance(timings.get("cache"), dict)
                and isinstance(timings["cache"].get("request"), dict)
                and timings["cache"]["request"].get("components") == components, "timings_invalid")
        start = text(directory / "build.start", 64, "build_markers_invalid").strip()
        end = text(directory / "build.end", 64, "build_markers_invalid").strip()
        require(string(start, r"[1-9][0-9]{0,15}") and string(end, r"[1-9][0-9]{0,15}")
                and 0 <= int(end) - int(start) <= 86400000, "build_markers_invalid")
        require(private_input.resolve().parent == directory.resolve().parent, "path_untrusted")
        data = read_json(private_input)
        expected = {"schema_version", "build_start_ms", "run_id", "run_attempt", "github_sha",
                    "gradle_version", "agp_versions", "jdk_version", "jdk_release_sha256", "records",
                    "observer_complete", "records_truncated"}
        require(isinstance(data, dict) and set(data) == expected and type(data["schema_version"]) is int
                and data["schema_version"] == 1, "input_invalid")
        require(data["build_start_ms"] == start and data["run_id"] == str(context["run_id"])
                and data["run_attempt"] == str(context["run_attempt"])
                and data["github_sha"] == context["github_sha"], "input_stale")
        require(type(data["observer_complete"]) is bool and type(data["records_truncated"]) is bool, "input_invalid")
        require(data["observer_complete"], "observer_incomplete")
        require(not data["records_truncated"], "observer_truncated")
        require(string(data["gradle_version"], VERSION) and string(data["jdk_version"], JAVA_VERSION)
                and string(data["jdk_release_sha256"], HASH), "input_invalid")
        require(isinstance(data["agp_versions"], list) and 0 < len(data["agp_versions"]) <= 16
                and all(string(version, VERSION) for version in data["agp_versions"]), "input_invalid")
        require(data["jdk_release_sha256"] == components["jdk_release_hash"], "input_stale")
        runtime.update(gradle_version=data["gradle_version"], agp_versions=sorted(set(data["agp_versions"])),
                       jdk_version=data["jdk_version"], jdk_release_sha256=data["jdk_release_sha256"])
        # The private observer currently supplies a global version set. Until
        # versions are bound per module, multiple AGPs cannot form a complete
        # selected identity merely because all versions were observed.
        require(len(runtime["agp_versions"]) == 1, "agp_coverage_incomplete")
        require(isinstance(data["records"], list) and len(data["records"]) <= 256, "input_invalid")
        workspace = workspace.resolve(strict=True)
        sdk = sdk_root.resolve(strict=True)
        require(workspace.is_dir() and sdk.is_dir(), "path_untrusted")
        groups = {}
        observed_counts = {phase: {abi: 0 for abi in ABIS} for phase in ("configure", "build")}
        for record in data["records"]:
            require(isinstance(record, dict) and set(record) == {"project_dir", "abi", "phase", "outcome", "build_dir"}, "input_invalid")
            require(record["abi"] in ABIS and record["phase"] in ("configure", "build")
                    and record["outcome"] in ("success", "failure", "skipped"), "input_invalid")
            observed_counts[record["phase"]][record["abi"]] += 1
            project = contained(record["project_dir"], workspace)
            require(project.is_dir(), "path_untrusted")
            pair = groups.setdefault((project, record["abi"]), {"builds": [], "directories": set()})
            if record["phase"] == "build":
                require(record["build_dir"] is None, "input_invalid")
                pair["builds"].append(record["outcome"])
            elif record["outcome"] == "failure":
                issues.add("configure_not_successful")
            elif record["build_dir"] is None:
                issues.add("selection_missing")
            else:
                selected_dir = contained(record["build_dir"], project)
                parts = selected_dir.relative_to(project).parts
                require(len(parts) == 4 and parts[:2] == (".cxx", "RelWithDebInfo")
                        and string(parts[2], r"[A-Za-z0-9_.-]{1,80}", 80) and parts[3] == record["abi"]
                        and selected_dir.is_dir(), "path_untrusted")
                pair["directories"].add(selected_dir)
        cmake = timings.get("cmake")
        require(isinstance(cmake, dict) and cmake.get("complete_build_log") is True
                and cmake.get("truncated") is False and isinstance(cmake.get("observed_outcomes"), dict),
                "observer_coverage_mismatch")
        try:
            require(set(cmake["observed_outcomes"]) == {"configure", "build"}
                    and all(isinstance(phase, dict) and set(phase) == set(ABIS)
                            for phase in cmake["observed_outcomes"].values())
                    and all(isinstance(abi, dict) and set(abi) == {
                        "executed", "FROM-CACHE", "UP-TO-DATE", "SKIPPED", "NO-SOURCE", "FAILED"}
                            for phase in cmake["observed_outcomes"].values() for abi in phase.values()),
                    "observer_coverage_mismatch")
            actual_counts = {phase: {abi: sum(cmake["observed_outcomes"][phase][abi].values())
                                     for abi in ABIS} for phase in ("configure", "build")}
            valid_counts = all(type(value) is int and 0 <= value <= 256
                               for phase in cmake["observed_outcomes"].values()
                               for abi in phase.values() for value in abi.values())
        except (KeyError, TypeError, AttributeError):
            raise EvidenceError("observer_coverage_mismatch") from None
        require(valid_counts and actual_counts == observed_counts
                and type(cmake.get("observed_task_count")) is int
                and cmake["observed_task_count"] == len(data["records"]), "observer_coverage_mismatch")
        require(groups, "selection_missing")
        hashes = BinaryHashes(sdk)
        for (project, abi), group in groups.items():
            if not group["builds"] or any(outcome != "success" for outcome in group["builds"]):
                issues.add("native_build_not_successful")
                continue
            if len(group["directories"]) != 1:
                issues.add("selection_ambiguous" if group["directories"] else "selection_missing")
                continue
            try:
                selected.append(selected_record(project, next(iter(group["directories"])), abi, workspace, sdk, hashes))
            except EvidenceError as error:
                issues.add(error.issue)
        selected.sort(key=lambda record: (record["module_id"], ABIS.index(record["abi"])))
        module_abis = {}
        for record in selected:
            module_abis.setdefault(record["module_id"], set()).add(record["abi"])
        if not module_abis or any(abis != set(ABIS) for abis in module_abis.values()):
            issues.add("abi_coverage_incomplete")
        if build_outcome != "success":
            issues.add("native_build_not_successful")
        report["scope"].update(module_count=len(module_abis), selected_module_abi_count=len(selected))
        if not issues:
            identity = {
                "schema_version": 1, "runtime": runtime, "selected": selected,
                "abis": list(ABIS), "target_flags_covered": False,
                "runner_platform": components["runner_platform"], "image_os": components["image_os"],
                "native_contract_hash": components["native_contract_hash"],
                "compatibility_hash": components["compatibility_hash"],
            }
            report["shadow_fingerprint"]["value"] = digest(canonical(identity))
    except EvidenceError as error:
        issues.add(error.issue)
    except (OSError, RuntimeError):
        issues.add("read_error")
    report["status"] = "inconsistent" if issues & BAD else "incomplete" if issues else "complete"
    report["issues"] = sorted(issues)
    return report


def write_toolchain_report(directory, private_input, workspace, sdk_root, summary_path, env):
    report = build_toolchain_report(directory, private_input, workspace, sdk_root, env)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "native-toolchain.json").write_text(json.dumps(report, indent=2) + "\n")
    with summary_path.open("a") as summary:
        summary.write("\n## Android selected toolchain\n\n")
        summary.write(f"Evidence: {report['status']}; selected module/ABI pairs: "
                      f"{report['scope']['selected_module_abi_count']}; "
                      f"shadow fingerprint: {report['shadow_fingerprint']['value']}.\n\n")
        summary.write("Shadow identity only; target-specific flags are not covered. Cache keys and policy are unchanged.\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--private-input", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--sdk-root", type=Path, required=True)
    parser.add_argument("--summary", type=Path, required=True)
    args = parser.parse_args()
    try:
        write_toolchain_report(args.directory, args.private_input, args.workspace, args.sdk_root, args.summary, os.environ)
    except Exception:
        sys.stderr.write("Selected toolchain report could not be written\n")
        sys.exit(1)
