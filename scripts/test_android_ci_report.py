import json
import os
import subprocess
from pathlib import Path
import tempfile
import unittest

from android_ci_report import build_report, elapsed_seconds, write_report


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
        report = build_report(self.directory, {"GRADLE_CACHE_HIT": "false", "GRADLE_CACHE_MATCHED_KEY": "android-gradle-v1-old"})
        self.assertEqual(report["tasks"], {"executed": 600, "from_cache": 300, "up_to_date": 46})
        self.assertFalse(report["cache"]["exact_hit"])
        self.assertEqual(report["cache"]["matched_key"], "android-gradle-v1-old")

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
