"""Exercise selected current-build toolchain evidence without Gradle or network."""

import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from android_ci_report import build_report
from android_ci_toolchain import BinaryHashes, build_toolchain_report, write_toolchain_report
from test_android_ci_report import cache_environment


class AndroidCiToolchainTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.workspace = self.root / "workspace"
        self.sdk = self.root / "sdk"
        self.project = self.workspace / "apps/client/android/app"
        self.directory = self.root / "android-ci"
        self.private = self.root / "android-toolchain-input.json"
        self.summary = self.root / "summary.md"
        self.env = cache_environment()
        self.directory.mkdir()
        self.ndk = self.sdk / "ndk/27.1.12297006"
        compiler_bin = self.ndk / "toolchains/llvm/prebuilt/linux-x86_64/bin"
        compiler_bin.mkdir(parents=True)
        self.c_compiler = compiler_bin / "clang"
        self.cxx_compiler = compiler_bin / "clang++"
        self.c_compiler.write_bytes(b"fixture C compiler")
        self.cxx_compiler.symlink_to(self.c_compiler)
        (self.ndk / "source.properties").write_text("Pkg.Desc = Android NDK\nPkg.Revision = 27.1.12297006\n")
        cmake_bin = self.sdk / "cmake/3.22.1/bin"
        cmake_bin.mkdir(parents=True)
        self.cmake = cmake_bin / "cmake"
        self.ninja = cmake_bin / "ninja"
        self.cmake.write_bytes(b"fixture CMake executable")
        self.ninja.write_bytes(b"fixture Ninja executable")
        self.data = {
            "schema_version": 1, "build_start_ms": "1000", "run_id": "39779496281",
            "run_attempt": "1", "github_sha": "1" * 40, "gradle_version": "8.14.3",
            "agp_versions": ["8.12.0"], "jdk_version": "17.0.18+8-LTS",
            "jdk_release_sha256": "a" * 64, "observer_complete": True,
            "records_truncated": False, "records": [],
        }
        self.caches = {}
        for abi in ("arm64-v8a", "x86_64"):
            self.add_pair(self.project, abi)
        (self.directory / "build.start").write_text("1000\n")
        (self.directory / "build.end").write_text("2000\n")
        self.write_timings()

    def add_pair(self, project, abi, config="selected-config"):
        selected = project / ".cxx/RelWithDebInfo" / config / abi
        selected.mkdir(parents=True)
        (selected / "build.ninja").write_text("# fixture selected Ninja build\n")
        values = {
            "ANDROID_NDK": str(self.ndk), "CMAKE_ANDROID_NDK": str(self.ndk),
            "ANDROID_ABI": abi, "CMAKE_ANDROID_ARCH_ABI": abi,
            "ANDROID_PLATFORM": "android-24", "CMAKE_SYSTEM_VERSION": "24",
            "CMAKE_BUILD_TYPE": "RelWithDebInfo", "CMAKE_GENERATOR": "Ninja",
            "CMAKE_COMMAND": str(self.cmake), "CMAKE_MAKE_PROGRAM": str(self.ninja),
            "CMAKE_CACHE_MAJOR_VERSION": "3", "CMAKE_CACHE_MINOR_VERSION": "22",
            "CMAKE_CACHE_PATCH_VERSION": "1", "ANDROID_STL": "c++_shared",
            "CMAKE_C_FLAGS": "-DANDROID", "CMAKE_CXX_FLAGS": f"-ffile-prefix-map={self.workspace}=.",
            "CMAKE_C_FLAGS_RELWITHDEBINFO": "-O2 -g -DNDEBUG",
            "CMAKE_CXX_FLAGS_RELWITHDEBINFO": "-O2 -g -DNDEBUG",
        }
        self.caches[(project, abi)] = (selected, values)
        self.write_cache(project, abi)
        info = selected / "CMakeFiles/3.22.1-g37088a8"
        info.mkdir(parents=True)
        for language, compiler in (("C", self.c_compiler), ("CXX", self.cxx_compiler)):
            (info / f"CMake{language}Compiler.cmake").write_text(
                f'set(CMAKE_{language}_COMPILER "{compiler}")\n'
                f'set(CMAKE_{language}_COMPILER_ID "Clang")\n'
                f'set(CMAKE_{language}_COMPILER_VERSION "18.0.2")\n'
                'set(CMAKE_CXX_COMPILER_ENV_VAR "CXX")\n')
        self.data["records"] += [
            {"project_dir": str(project), "abi": abi, "phase": "configure",
             "outcome": "success", "build_dir": str(selected)},
            {"project_dir": str(project), "abi": abi, "phase": "build",
             "outcome": "success", "build_dir": None},
        ]
        return selected

    def write_cache(self, project, abi):
        selected, values = self.caches[(project, abi)]
        (selected / "CMakeCache.txt").write_text("\n".join(f"{key}:STRING={value}" for key, value in values.items()) + "\n")

    def write_timings(self):
        lines = [f"> Task :module{index}:{'configure' if record['phase'] == 'configure' else 'build'}CMakeRelWithDebInfo[{record['abi']}]"
                 for index, record in enumerate(self.data["records"])]
        (self.directory / "gradle.log").write_text("\n".join(lines) + f"\n{len(lines)} actionable tasks: {len(lines)} executed\n")
        (self.directory / "timings.json").write_text(json.dumps(build_report(self.directory, self.env)))

    def report(self, write_input=True):
        if write_input:
            self.private.write_text(json.dumps(self.data))
        return build_toolchain_report(self.directory, self.private, self.workspace, self.sdk, self.env)

    def test_actual_selected_toolchain_and_context_are_bounded_complete(self):
        report = self.report()
        self.assertEqual(report["status"], "complete", report["issues"])
        self.assertEqual(report["issues"], [])
        self.assertEqual(report["context"]["head_sha"], "9" * 40)
        self.assertEqual(report["context"]["checkout_sha"], "1" * 40)
        self.assertEqual(report["scope"], {"abis": ["arm64-v8a", "x86_64"], "module_count": 1,
                                          "selected_module_abi_count": 2, "target_flags_covered": False})
        self.assertEqual(report["runtime"]["agp_versions"], ["8.12.0"])
        self.assertEqual([record["abi"] for record in report["selected"]], ["arm64-v8a", "x86_64"])
        self.assertEqual(report["selected"][0]["ndk_revision"], "27.1.12297006")
        self.assertEqual(report["selected"][0]["cmake_version"], "3.22.1")
        self.assertIsNone(report["selected"][0]["ninja_version"])
        self.assertRegex(report["shadow_fingerprint"]["value"], r"^[a-f0-9]{64}$")
        for value in (str(self.root), "selected-config", "CMAKE_CXX_FLAGS", "clang++"):
            self.assertNotIn(value, json.dumps(report))

    def test_image_run_attempt_and_source_are_observations_not_fingerprint(self):
        before = self.report()["shadow_fingerprint"]["value"]
        self.env = cache_environment(ANDROID_CI_IMAGE_VERSION="20261021.171.10")
        for key in ("GRADLE_CACHE_REQUESTED_KEY", "GRADLE_CACHE_PREFIX", "GRADLE_CACHE_COMPATIBILITY_PREFIX",
                    "GRADLE_CACHE_PRIMARY_KEY", "GRADLE_CACHE_MATCHED_KEY"):
            self.env[key] = self.env[key].replace("20261012.163.1", "20261021.171.10")
        self.env.update(ANDROID_CI_RUN_ID="123456", ANDROID_CI_RUN_ATTEMPT="2",
                        ANDROID_CI_CHECKOUT_SHA="2" * 40, ANDROID_CI_GITHUB_SHA="2" * 40,
                        ANDROID_CI_HEAD_SHA="3" * 40)
        self.env["GRADLE_CACHE_REQUESTED_KEY"] = self.env["GRADLE_CACHE_PREFIX"] + "2" * 40
        self.env["GRADLE_CACHE_PRIMARY_KEY"] = self.env["GRADLE_CACHE_REQUESTED_KEY"]
        self.env["GRADLE_CACHE_MATCHED_KEY"] = self.env["GRADLE_CACHE_PREFIX"] + "4" * 40
        self.data.update(run_id="123456", run_attempt="2", github_sha="2" * 40)
        self.write_timings()
        report = self.report()
        self.assertEqual(report["status"], "complete", report["issues"])
        self.assertEqual(before, report["shadow_fingerprint"]["value"])

    def test_real_binary_content_mutations_change_fingerprint_without_execution(self):
        baseline = self.report()["shadow_fingerprint"]["value"]
        for binary in (self.c_compiler, self.cmake, self.ninja):
            with self.subTest(binary=binary.name):
                previous = binary.read_bytes()
                binary.write_bytes(previous + b" changed")
                self.assertNotEqual(self.report()["shadow_fingerprint"]["value"], baseline)
                binary.write_bytes(previous)

    def test_ndk_api_flags_and_public_contract_mutations_change_identity(self):
        baseline = self.report()["shadow_fingerprint"]["value"]
        properties = self.ndk / "source.properties"
        original = properties.read_text()
        properties.write_text(original.replace("27.1.12297006", "27.2.12479018"))
        self.assertNotEqual(self.report()["shadow_fingerprint"]["value"], baseline)
        properties.write_text(original)
        for changes in ({"ANDROID_PLATFORM": "android-26", "CMAKE_SYSTEM_VERSION": "26"},
                        {"CMAKE_CXX_FLAGS_RELWITHDEBINFO": "-O3 -g -DNDEBUG"}, {"ANDROID_STL": "c++_static"}):
            with self.subTest(changes=changes):
                _, values = self.caches[(self.project, "arm64-v8a")]
                previous = dict(values)
                values.update(changes)
                self.write_cache(self.project, "arm64-v8a")
                self.assertNotEqual(self.report()["shadow_fingerprint"]["value"], baseline)
                values.clear(); values.update(previous)
                self.write_cache(self.project, "arm64-v8a")
        for field in ("GRADLE_CACHE_NATIVE_HASH", "GRADLE_CACHE_COMPATIBILITY_HASH"):
            with self.subTest(field=field):
                prior = self.env.copy()
                old_hash = self.env[field]
                self.env[field] = "d" * 64
                for key in ("GRADLE_CACHE_REQUESTED_KEY", "GRADLE_CACHE_PREFIX", "GRADLE_CACHE_COMPATIBILITY_PREFIX",
                            "GRADLE_CACHE_PRIMARY_KEY", "GRADLE_CACHE_MATCHED_KEY"):
                    self.env[key] = self.env[key].replace(old_hash, "d" * 64)
                self.write_timings()
                self.assertNotEqual(self.report()["shadow_fingerprint"]["value"], baseline)
                self.env = prior
                self.write_timings()

    def test_module_heterogeneity_is_preserved_deterministically(self):
        project = self.workspace / "node_modules/fixture/android"
        for abi in ("arm64-v8a", "x86_64"):
            self.add_pair(project, abi)
            self.caches[(project, abi)][1]["ANDROID_PLATFORM"] = "android-26"
            self.caches[(project, abi)][1]["CMAKE_SYSTEM_VERSION"] = "26"
            self.write_cache(project, abi)
        self.write_timings()
        report = self.report()
        self.assertEqual(report["status"], "complete", report["issues"])
        self.assertEqual(report["scope"]["module_count"], 2)
        self.assertEqual({record["android_api"] for record in report["selected"]}, {24, 26})
        self.data["records"].reverse()
        self.assertEqual(self.report()["shadow_fingerprint"], report["shadow_fingerprint"])

    def test_stale_header_runtime_mismatch_and_partial_observer_stay_unknown(self):
        base = copy.deepcopy(self.data)
        for changes, issue in (({"build_start_ms": "999"}, "input_stale"),
                               ({"run_id": "1234"}, "input_stale"),
                               ({"run_attempt": "2"}, "input_stale"),
                               ({"github_sha": "2" * 40}, "input_stale"),
                               ({"jdk_release_sha256": "b" * 64}, "input_stale"),
                               ({"observer_complete": False}, "observer_incomplete"),
                               ({"records_truncated": True}, "observer_truncated")):
            with self.subTest(changes=changes):
                self.data = {**base, **changes}
                report = self.report()
                self.assertIn(issue, report["issues"])
                self.assertIsNone(report["shadow_fingerprint"]["value"])

    def test_lost_observer_callback_and_missing_abi_cannot_claim_complete(self):
        self.data["records"].pop()
        report = self.report()
        self.assertIn("observer_coverage_mismatch", report["issues"])
        self.assertIsNone(report["shadow_fingerprint"]["value"])
        self.data["records"] = self.data["records"][:2]
        self.write_timings()
        report = self.report()
        self.assertIn("abi_coverage_incomplete", report["issues"])
        self.assertIsNone(report["shadow_fingerprint"]["value"])

    def test_unbound_conflicting_and_external_selected_directories_are_rejected(self):
        original = copy.deepcopy(self.data)
        self.data["records"][0]["build_dir"] = None
        self.assertIn("selection_missing", self.report()["issues"])
        self.data = copy.deepcopy(original)
        extra = copy.deepcopy(self.data["records"][0])
        alternate = self.project / ".cxx/RelWithDebInfo/other-config/arm64-v8a"
        alternate.mkdir(parents=True)
        extra["build_dir"] = str(alternate)
        self.data["records"].append(extra)
        self.write_timings()
        report = self.report()
        self.assertIn("selection_ambiguous", report["issues"])
        self.assertIsNone(report["shadow_fingerprint"]["value"])
        self.data = original
        outside = self.root / "private-outside-workspace"
        outside.mkdir()
        self.data["records"][0]["build_dir"] = str(outside)
        self.assertIn("path_untrusted", self.report()["issues"])

    def test_cache_alias_conflicts_and_duplicate_compiler_info_remain_unknown(self):
        _, values = self.caches[(self.project, "arm64-v8a")]
        values["CMAKE_ANDROID_ARCH_ABI"] = "x86_64"
        self.write_cache(self.project, "arm64-v8a")
        self.assertIn("selected_cache_invalid", self.report()["issues"])
        values["CMAKE_ANDROID_ARCH_ABI"] = "arm64-v8a"
        self.write_cache(self.project, "arm64-v8a")
        selected = self.caches[(self.project, "arm64-v8a")][0]
        (selected / "CMakeFiles/3.22.1").mkdir()
        self.assertIn("selection_ambiguous", self.report()["issues"])

    def test_preexisting_selected_cache_is_valid_but_header_must_be_current(self):
        for selected, _ in self.caches.values():
            os.utime(selected / "CMakeCache.txt", (0, 0))
        self.assertEqual(self.report()["status"], "complete")
        self.data["build_start_ms"] = "1"
        self.assertIn("input_stale", self.report()["issues"])

    def test_active_agp_build_redirection_is_explicitly_unsupported(self):
        selected = self.caches[(self.project, "arm64-v8a")][0]
        (selected / "build.ninja").unlink()
        (selected / "build.ninja.txt").write_text("/private/redirected/build.ninja\n")
        report = self.report()
        self.assertIn("selection_redirected", report["issues"])
        self.assertIsNone(report["shadow_fingerprint"]["value"])
        self.assertNotIn("/private/redirected", json.dumps(report))

    def test_selected_ninja_file_must_be_regular_and_local(self):
        selected = self.caches[(self.project, "arm64-v8a")][0]
        (selected / "build.ninja").unlink()
        (selected / "build.ninja").symlink_to(self.ninja)
        report = self.report()
        self.assertIn("toolchain_file_untrusted", report["issues"])
        self.assertIsNone(report["shadow_fingerprint"]["value"])

    def test_private_malformed_oversized_duplicate_and_missing_inputs_are_safe(self):
        for value in ('{"schema_version":1,"schema_version":1}', '["secretToken"]', '{bad json', "x" * (1024 * 1024 + 1)):
            with self.subTest(length=len(value)):
                self.private.write_text(value)
                report = self.report(write_input=False)
                self.assertNotEqual(report["status"], "complete")
                self.assertIsNone(report["shadow_fingerprint"]["value"])
                self.assertNotIn("secretToken", json.dumps(report))
        self.private.unlink()
        self.assertIn("input_missing", self.report(write_input=False)["issues"])

    def test_symlink_escapes_and_hash_limits_are_rejected(self):
        outside = self.root / "private-binary"
        outside.write_bytes(b"privateTokenDoNotExport")
        self.cxx_compiler.unlink()
        self.cxx_compiler.symlink_to(outside)
        report = self.report()
        self.assertIn("toolchain_file_untrusted", report["issues"])
        self.assertNotIn("privateTokenDoNotExport", json.dumps(report))
        self.cxx_compiler.unlink(); self.cxx_compiler.symlink_to(self.c_compiler)
        with patch("android_ci_toolchain.MAX_BINARY", 1):
            self.assertIn("hash_limit_exceeded", self.report()["issues"])
        self.private.unlink()
        self.private.symlink_to(outside)
        self.assertIn("toolchain_file_untrusted", self.report(write_input=False)["issues"])

    def test_selected_binary_hashes_are_memoized_for_compiler_aliases(self):
        hashes = BinaryHashes(self.sdk)
        first = hashes.file(str(self.c_compiler))
        self.assertEqual(hashes.file(str(self.cxx_compiler)), first)
        self.assertEqual(len(hashes.cache), 1)
        self.assertEqual(hashes.total, self.c_compiler.stat().st_size)

    def test_changed_binary_cannot_reuse_an_old_memoized_digest(self):
        hashes = BinaryHashes(self.sdk)
        first = hashes.file(str(self.c_compiler))
        self.c_compiler.write_bytes(b"a changed compiler")
        self.assertNotEqual(hashes.file(str(self.cxx_compiler)), first)

    def test_binary_mutation_during_hash_is_rejected_even_at_same_size(self):
        original_open = Path.open
        target = self.c_compiler.resolve()

        class MutatingReader:
            def __init__(self, stream):
                self.stream = stream
                self.mutated = False

            def __enter__(self):
                return self

            def __exit__(self, *args):
                self.stream.close()

            def read(self, maximum):
                result = self.stream.read(maximum)
                if result and not self.mutated:
                    self.mutated = True
                    with original_open(target, "wb") as writer:
                        writer.write(b"x" * len(result))
                return result

        def opening(path, *args, **kwargs):
            stream = original_open(path, *args, **kwargs)
            return MutatingReader(stream) if path == target and args == ("rb",) else stream

        with patch.object(Path, "open", opening):
            report = self.report()
        self.assertIn("toolchain_file_invalid", report["issues"])
        self.assertIsNone(report["shadow_fingerprint"]["value"])

    def test_wrong_timing_shapes_and_partial_agp_observation_stay_bounded(self):
        original = json.loads((self.directory / "timings.json").read_text())
        for change in ({"cache": []}, {"cache": {"request": []}}, {"context": []},
                       {"context": {**original["context"], "complete": 1}},
                       {"cmake": []}, {"cmake": {"complete_build_log": True, "truncated": False,
                                                   "observed_outcomes": {"build": []}}}):
            with self.subTest(change=change):
                (self.directory / "timings.json").write_text(json.dumps({**original, **change}))
                report = self.report()
                self.assertNotEqual(report["status"], "complete")
                self.assertIsNone(report["shadow_fingerprint"]["value"])
        (self.directory / "timings.json").write_text(json.dumps(original))
        self.data["agp_versions"] = ["8.12.0", "8.13.0"]
        report = self.report()
        self.assertIn("agp_coverage_incomplete", report["issues"])
        self.assertEqual(report["runtime"]["agp_versions"], ["8.12.0", "8.13.0"])
        self.assertIsNone(report["shadow_fingerprint"]["value"])

    def test_oversized_compiler_directory_enumeration_stops_at_bound(self):
        original_iterdir = Path.iterdir
        seen = []

        def iterate(path):
            if path.name != "CMakeFiles":
                return original_iterdir(path)

            def children():
                for number in range(10000):
                    seen.append(number)
                    yield path / f"unrelated-{number}"
            return children()

        with patch.object(Path, "iterdir", iterate):
            report = self.report()
        self.assertIn("hash_limit_exceeded", report["issues"])
        # Both ABIs are inspected independently; each iterator stops after65.
        self.assertEqual(len(seen), 130)

    def test_raw_global_flags_stay_hash_only_even_for_valid_selected_input(self):
        secret = "privateDefinitionDoNotExport"
        self.caches[(self.project, "arm64-v8a")][1]["CMAKE_CXX_FLAGS"] += " -D" + secret
        self.write_cache(self.project, "arm64-v8a")
        report = self.report()
        self.assertEqual(report["status"], "complete", report["issues"])
        self.assertNotIn(secret, json.dumps(report))

    def test_writer_keeps_schema2_unchanged_and_hides_raw_private_data(self):
        original = (self.directory / "timings.json").read_bytes()
        secret = "privateTokenDoNotExport"
        self.data["gradle_version"] = "8.14.3-" + secret
        self.private.write_text(json.dumps(self.data))
        self.summary.write_text("Prior evidence\n")
        report = write_toolchain_report(self.directory, self.private, self.workspace, self.sdk, self.summary, self.env)
        self.assertEqual((self.directory / "timings.json").read_bytes(), original)
        self.assertEqual(json.loads((self.directory / "native-toolchain.json").read_text()), report)
        for output in (json.dumps(report), self.summary.read_text()):
            self.assertNotIn(secret, output)
            self.assertNotIn(str(self.root), output)
        self.assertTrue(self.summary.read_text().startswith("Prior evidence\n"))


if __name__ == "__main__":
    unittest.main()
