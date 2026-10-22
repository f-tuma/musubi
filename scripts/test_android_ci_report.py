import json
import os
import subprocess
from pathlib import Path
import tempfile
import unittest

from android_ci_report import build_report, elapsed_seconds, write_report


def cache_environment(**overrides):
    compatibility = f"android-gradle-v1-Linux-X64-ubuntu26-20261012.163.1-{'a' * 64}-{'b' * 64}-"
    prefix = compatibility + "c" * 64 + "-"
    env = {
        "ANDROID_CI_REPOSITORY": "f-tuma/musubi", "ANDROID_CI_RUN_ID": "39779496281",
        "ANDROID_CI_RUN_ATTEMPT": "1", "ANDROID_CI_EVENT_NAME": "pull_request",
        "ANDROID_CI_REF": "refs/pull/123/merge", "ANDROID_CI_CHECKOUT_SHA": "1" * 40,
        "ANDROID_CI_GITHUB_SHA": "1" * 40, "ANDROID_CI_HEAD_SHA": "9" * 40,
        "ANDROID_CI_RUNNER_PLATFORM": "Linux-X64", "ANDROID_CI_IMAGE_OS": "ubuntu26",
        "ANDROID_CI_IMAGE_VERSION": "20261012.163.1", "GRADLE_CACHE_JDK_HASH": "a" * 64,
        "GRADLE_CACHE_COMPATIBILITY_HASH": "b" * 64, "GRADLE_CACHE_NATIVE_HASH": "c" * 64,
        "GRADLE_CACHE_REQUESTED_KEY": prefix + "1" * 40, "GRADLE_CACHE_PREFIX": prefix,
        "GRADLE_CACHE_COMPATIBILITY_PREFIX": compatibility, "GRADLE_CACHE_PRIMARY_KEY": prefix + "1" * 40,
        "GRADLE_CACHE_MATCHED_KEY": prefix + "2" * 40, "GRADLE_CACHE_HIT": "false",
        "GRADLE_CACHE_RESTORE_OUTCOME": "success", "GRADLE_CACHE_SAVE_OUTCOME": "skipped",
        "ANDROID_BUILD_OUTCOME": "success", "ANDROID_DEX_OUTCOME": "success",
        "ANDROID_CI_CCACHE_AVAILABLE": "false",
    }
    return {**env, **overrides}


class AndroidCiReportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)

    def test_real_workflow_pipeline_preserves_gradle_failure_and_exit_timing(self):
        workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/quality.yml").read_text()
        step = workflow.split("        id: android-build\n", 1)[1].split("      - name:", 1)[0]
        self.assertIn("        shell: bash\n", step)
        script = "\n".join(line[10:] for line in step.split("        run: |\n", 1)[1].splitlines())
        for exit_code in (0, 23):
            with self.subTest(exit_code=exit_code):
                case = self.directory / f"exit-{exit_code}"
                case.mkdir()
                evidence = case / "android-ci"
                evidence.mkdir()
                tools = case / "bin"
                tools.mkdir()
                clock_log = case / "clock-calls"
                clock = tools / "date"
                # Exercise the actual workflow shell, pipefail and EXIT trap
                # without relying on the runner wall clock during a tiny build.
                clock.write_text(
                    "#!/bin/sh\n"
                    "if [ \"$#\" -ne 1 ] || [ \"$1\" != '+%s%3N' ]; then exit 97; fi\n"
                    "if [ -f \"$MUSUBI_FIXTURE_CLOCK_LOG\" ]; then\n"
                    "  printf '%s\\n' \"$1\" >> \"$MUSUBI_FIXTURE_CLOCK_LOG\"\n"
                    "  printf '1250\\n'\n"
                    "else\n"
                    "  printf '%s\\n' \"$1\" > \"$MUSUBI_FIXTURE_CLOCK_LOG\"\n"
                    "  printf '1000\\n'\n"
                    "fi\n")
                clock.chmod(0o755)
                gradlew = case / "gradlew"
                gradlew.write_text(f"#!/bin/sh\nprintf 'fixture Gradle output\\n'\ntouch app-release.apk app-release.aab\nexit {exit_code}\n")
                gradlew.chmod(0o755)
                environment = {**os.environ, "RUNNER_TEMP": str(case), "JAVA_HOME_17_X64": str(case),
                               "PATH": str(tools) + os.pathsep + os.environ["PATH"],
                               "MUSUBI_FIXTURE_CLOCK_LOG": str(clock_log)}
                self.assertFalse((evidence / "build.start").exists())
                self.assertFalse((evidence / "build.end").exists())
                result = subprocess.run(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", script],
                                        cwd=case, env=environment, capture_output=True, text=True)
                self.assertEqual(result.returncode, exit_code, result.stderr)
                self.assertIn("fixture Gradle output", (evidence / "gradle.log").read_text())
                self.assertEqual(clock_log.read_text().splitlines(), ["+%s%3N", "+%s%3N"])
                self.assertEqual((evidence / "build.start").read_text().strip(), "1000")
                self.assertEqual((evidence / "build.end").read_text().strip(), "1250")
                self.assertEqual(elapsed_seconds(evidence, "build"), 0.25)
                self.assertTrue((case / "app-release.apk").exists())
                self.assertTrue((case / "app-release.aab").exists())

    def test_partial_failed_build_does_not_invent_zero_task_totals(self):
        (self.directory / "gradle.log").write_text("> Task :app:compileReleaseKotlin FROM-CACHE\nFAILURE: Build failed\n")
        report = build_report(self.directory, {"ANDROID_BUILD_OUTCOME": "failure"})
        self.assertEqual(report["from_cache_task_lines"], 1)
        self.assertIsNone(report["tasks"]["executed"])
        self.assertEqual(report["build_outcome"], "failure")
        self.assertIsNone(report["seconds"]["save"])

    def test_gradle_totals_and_partial_archive_hit_are_distinct(self):
        (self.directory / "gradle.log").write_text(
            "> Task :app:compileReleaseKotlin FROM-CACHE\n"
            "946 actionable tasks: 600 executed, 300 from cache, 46 up-to-date\n")
        env = cache_environment()
        report = build_report(self.directory, env)
        self.assertEqual(report["tasks"], {"executed": 600, "from_cache": 300, "up_to_date": 46})
        self.assertFalse(report["cache"]["exact_hit"])
        self.assertEqual(report["cache"]["matched_key"], env["GRADLE_CACHE_MATCHED_KEY"])
        self.assertEqual(report["cache"]["restore_state"], "partial")
        self.assertEqual(report["cache"]["restore_match_scope"], "native_contract")

    def test_exact_and_both_ordered_partial_prefixes(self):
        env = cache_environment()
        exact = build_report(self.directory, {**env, "GRADLE_CACHE_HIT": "true",
                                              "GRADLE_CACHE_MATCHED_KEY": env["GRADLE_CACHE_REQUESTED_KEY"]})
        self.assertEqual(exact["cache"]["restore_state"], "exact")
        self.assertIs(exact["cache"]["exact_hit"], True)
        other_native = env["GRADLE_CACHE_COMPATIBILITY_PREFIX"] + "d" * 64 + "-" + "3" * 40
        partial = build_report(self.directory, {**env, "GRADLE_CACHE_MATCHED_KEY": other_native})
        self.assertEqual(partial["cache"]["restore_state"], "partial")
        self.assertEqual(partial["cache"]["restore_match_scope"], "compatibility")

    def test_no_match_is_not_proven_miss_and_unavailable_is_not_false_hit(self):
        env = cache_environment(GRADLE_CACHE_HIT="", GRADLE_CACHE_MATCHED_KEY="")
        report = build_report(self.directory, env)
        self.assertEqual(report["cache"]["restore_state"], "no_match_reported")
        self.assertIsNone(report["cache"]["exact_hit"])
        unavailable = build_report(self.directory, {**env, "GRADLE_CACHE_HIT": "false", "GRADLE_CACHE_PRIMARY_KEY": ""})
        self.assertEqual(unavailable["cache"]["restore_state"], "unavailable")
        self.assertIsNone(unavailable["cache"]["exact_hit"])

    def test_skipped_failure_cancelled_outcomes_do_not_become_hits(self):
        for outcome in ("skipped", "failure", "cancelled"):
            with self.subTest(outcome=outcome):
                env = cache_environment(GRADLE_CACHE_RESTORE_OUTCOME=outcome,
                                        GRADLE_CACHE_PRIMARY_KEY="", GRADLE_CACHE_MATCHED_KEY="", GRADLE_CACHE_HIT="",
                                        GRADLE_CACHE_RESTORE_CONCLUSION="success")
                report = build_report(self.directory, env)
                self.assertEqual(report["cache"]["restore_state"], outcome)
                self.assertIsNone(report["cache"]["exact_hit"])
        contradictory = build_report(self.directory, cache_environment(GRADLE_CACHE_RESTORE_OUTCOME="skipped"))
        self.assertEqual(contradictory["cache"]["restore_state"], "inconsistent")

    def test_inconsistent_sources_keys_and_action_outputs_are_explicit(self):
        base = cache_environment()
        cases = [
            {"ANDROID_CI_CHECKOUT_SHA": "4" * 40},
            {"GRADLE_CACHE_PRIMARY_KEY": base["GRADLE_CACHE_PREFIX"] + "4" * 40},
            {"GRADLE_CACHE_REQUESTED_KEY": base["GRADLE_CACHE_PREFIX"] + "4" * 40},
            {"ANDROID_CI_IMAGE_VERSION": "20261013.1.1"},
            {"ANDROID_CI_EVENT_NAME": "push"},
            {"ANDROID_CI_REF": "refs/heads/main"},
            {"GRADLE_CACHE_HIT": "true", "GRADLE_CACHE_MATCHED_KEY": ""},
            {"GRADLE_CACHE_HIT": "false", "GRADLE_CACHE_MATCHED_KEY": base["GRADLE_CACHE_REQUESTED_KEY"]},
            {"GRADLE_CACHE_MATCHED_KEY": base["GRADLE_CACHE_MATCHED_KEY"].replace("ubuntu26", "ubuntu24")},
            {"GRADLE_CACHE_HIT": "bad"},
            {"GRADLE_CACHE_PRIMARY_KEY": "apiTokenSecret"},
            {"GRADLE_CACHE_PRIMARY_KEY": "a" * 2000},
        ]
        for changes in cases:
            with self.subTest(changes=changes):
                report = build_report(self.directory, {**base, **changes})
                self.assertEqual(report["cache"]["restore_state"], "inconsistent")
                self.assertIsNone(report["cache"]["exact_hit"])

    def test_run_identity_and_pr_merge_checkout_remain_distinct(self):
        report = build_report(self.directory, cache_environment())
        self.assertEqual(report["schema_version"], 2)
        self.assertTrue(report["context"]["complete"])
        self.assertEqual(report["context"]["run_id"], 39779496281)
        self.assertEqual(report["context"]["run_attempt"], 1)
        self.assertEqual(report["context"]["checkout_sha"], "1" * 40)
        self.assertEqual(report["context"]["head_sha"], "9" * 40)
        self.assertTrue(report["cache"]["request"]["coherent"])
        self.assertIs(report["ccache"]["executable_on_path"], False)

    def test_matched_without_primary_and_true_without_outputs_are_inconsistent(self):
        for hit in ("true", "false", ""):
            with self.subTest(hit=hit):
                report = build_report(self.directory, cache_environment(
                    GRADLE_CACHE_PRIMARY_KEY="", GRADLE_CACHE_HIT=hit))
                self.assertEqual(report["cache"]["restore_state"], "inconsistent")
                self.assertIsNone(report["cache"]["exact_hit"])
        report = build_report(self.directory, cache_environment(
            GRADLE_CACHE_PRIMARY_KEY="", GRADLE_CACHE_MATCHED_KEY="", GRADLE_CACHE_HIT="true"))
        self.assertEqual(report["cache"]["restore_state"], "inconsistent")

    def test_structured_oversized_metadata_is_rejected_without_export(self):
        env = cache_environment()
        old_version = env["ANDROID_CI_IMAGE_VERSION"]
        oversized_version = "20261012." + "7" * 1000
        fields = ("GRADLE_CACHE_REQUESTED_KEY", "GRADLE_CACHE_PREFIX", "GRADLE_CACHE_COMPATIBILITY_PREFIX",
                  "GRADLE_CACHE_PRIMARY_KEY", "GRADLE_CACHE_MATCHED_KEY", "ANDROID_CI_IMAGE_VERSION")
        for field in fields:
            env[field] = env[field].replace(old_version, oversized_version)
        env["GRADLE_CACHE_HIT"] = "true"
        env["GRADLE_CACHE_MATCHED_KEY"] = env["GRADLE_CACHE_REQUESTED_KEY"]
        env["ANDROID_CI_REF"] = "refs/pull/" + "8" * 1000 + "/merge"
        summary = self.directory / "summary.md"
        report = write_report(self.directory, summary, env)
        self.assertEqual(report["cache"]["restore_state"], "inconsistent")
        self.assertIsNone(report["cache"]["exact_hit"])
        self.assertIsNone(report["cache"]["action_primary_key"])
        self.assertIsNone(report["cache"]["request"]["key"])
        self.assertIsNone(report["cache"]["request"]["prefix"])
        self.assertIsNone(report["cache"]["request"]["compatibility_prefix"])
        self.assertIsNone(report["cache"]["request"]["components"]["image_version"])
        self.assertIsNone(report["context"]["ref"])
        self.assertTrue(set(fields + ("ANDROID_CI_REF",)).issubset(report["invalid_metadata_fields"]))
        self.assertNotIn("7" * 1000, json.dumps(report) + summary.read_text())
        self.assertNotIn("8" * 1000, json.dumps(report) + summary.read_text())

    def test_save_action_success_never_claims_persistence(self):
        report = build_report(self.directory, cache_environment(GRADLE_CACHE_SAVE_OUTCOME="success"))
        self.assertEqual(report["cache"]["save_state"], "attempted_unverified")
        self.assertIsNone(report["cache"]["archive_persisted"])

    def test_only_allowlisted_metadata_can_reach_json_or_markdown(self):
        secret = "secretTokenDoNotExport"
        env = cache_environment(**{key: secret + "\n## forged" for key in (
            "GRADLE_CACHE_PRIMARY_KEY", "GRADLE_CACHE_MATCHED_KEY", "ANDROID_CI_REPOSITORY",
            "ANDROID_CI_RUN_ID", "ANDROID_CI_RUN_ATTEMPT", "ANDROID_CI_CHECKOUT_SHA",
            "ANDROID_CI_IMAGE_VERSION", "ANDROID_BUILD_OUTCOME", "ANDROID_DEX_OUTCOME",
            "GRADLE_CACHE_RESTORE_OUTCOME", "GRADLE_CACHE_SAVE_OUTCOME", "ANDROID_CI_CCACHE_AVAILABLE")})
        env["UNRELATED_SECRET"] = secret
        summary = self.directory / "summary.md"
        report = write_report(self.directory, summary, env)
        for text in (json.dumps(report), summary.read_text(), (self.directory / "timings.json").read_text()):
            self.assertNotIn(secret, text)
            self.assertNotIn("forged", text)
        self.assertIsNone(report["cache"]["action_primary_key"])
        self.assertEqual(report["build_outcome"], "unknown")
        self.assertIn("ANDROID_BUILD_OUTCOME", report["invalid_metadata_fields"])

    def test_invalid_task_summaries_stay_unknown_and_explicit_zero_is_valid(self):
        for log in ("7 actionable tasks: malformed\n", "7 actionable tasks: 6 executed\n",
                    "7 actionable tasks: 3 executed, 4 executed\n", "7 actionable tasks: 7 executed\n" * 2,
                    "7 actionable tasks: 5 executed, 2 unsupported\n"):
            with self.subTest(log=log):
                (self.directory / "gradle.log").write_text(log)
                report = build_report(self.directory, cache_environment())
                self.assertIsNone(report["tasks"]["executed"])
                self.assertFalse(report["cmake"]["complete_build_log"])
        (self.directory / "gradle.log").write_text("0 actionable tasks: 0 executed\n")
        report = build_report(self.directory, cache_environment())
        self.assertEqual(report["tasks"], {"executed": 0, "from_cache": 0, "up_to_date": 0})

    def test_cmake_outcomes_are_bounded_aggregates_not_paths_or_wall_time(self):
        (self.directory / "gradle.log").write_text(
            "> Task :privateTaskName:buildCMakeRelWithDebInfo[arm64-v8a]\n"
            "> Task :app:configureCMakeRelWithDebInfo[arm64-v8a] UP-TO-DATE\n"
            "> Task :app:buildCMakeRelWithDebInfo[x86_64] FROM-CACHE\n"
            "> Task :app:configureCMakeRelWithDebInfo[x86_64]\n"
            "4 actionable tasks: 2 executed, 1 from cache, 1 up-to-date\n")
        report = build_report(self.directory, cache_environment())
        native = report["cmake"]
        self.assertTrue(native["complete_build_log"])
        self.assertEqual(native["observed_task_count"], 4)
        self.assertEqual(native["observed_outcomes"]["build"]["arm64-v8a"]["executed"], 1)
        self.assertEqual(native["observed_outcomes"]["build"]["x86_64"]["FROM-CACHE"], 1)
        self.assertNotIn("privateTaskName", json.dumps(report))
        failed = build_report(self.directory, cache_environment(ANDROID_BUILD_OUTCOME="failure"))
        self.assertFalse(failed["cmake"]["complete_build_log"])

    def test_cmake_observation_limit_does_not_claim_a_complete_build_profile(self):
        lines = [f"> Task :project{i}:buildCMakeRelWithDebInfo[arm64-v8a]" for i in range(257)]
        (self.directory / "gradle.log").write_text("\n".join(lines) + "\n257 actionable tasks: 257 executed\n")
        report = build_report(self.directory, cache_environment())
        self.assertTrue(report["cmake"]["truncated"])
        self.assertFalse(report["cmake"]["complete_build_log"])
        self.assertEqual(report["cmake"]["observed_task_count"], 256)

    def test_missing_malformed_and_reversed_markers_stay_unknown(self):
        self.assertIsNone(elapsed_seconds(self.directory, "restore"))
        (self.directory / "restore.start").write_text("bad")
        (self.directory / "restore.end").write_text("2000")
        self.assertIsNone(elapsed_seconds(self.directory, "restore"))
        (self.directory / "restore.start").write_text("3000")
        self.assertIsNone(elapsed_seconds(self.directory, "restore"))
        (self.directory / "restore.start").write_text("1001")
        self.assertEqual(elapsed_seconds(self.directory, "restore"), 0.999)

    def test_always_report_exists_without_build_and_keeps_untrusted_key_out(self):
        output = self.directory / "evidence"
        summary = self.directory / "summary.md"
        summary.write_text("Prior evidence\n")
        report = write_report(output, summary, {"GRADLE_CACHE_MATCHED_KEY": "bad\n## forged"})
        self.assertIsNone(report["cache"]["matched_key"])
        self.assertEqual(json.loads((output / "timings.json").read_text()), report)
        self.assertTrue(summary.read_text().startswith("Prior evidence\n"))
        self.assertNotIn("forged", summary.read_text())
        self.assertIn("unavailable / skipped", summary.read_text())


if __name__ == "__main__":
    unittest.main()
