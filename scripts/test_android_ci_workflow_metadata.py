"""Exercise the Android workflow metadata bridge without Gradle, caches or network."""

import hashlib
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from android_ci_report import build_report


WORKFLOW = Path(__file__).resolve().parents[1] / ".github/workflows/quality.yml"


def step_text(workflow, identifier):
    return workflow.split(f"        id: {identifier}\n", 1)[1].split("      - name:", 1)[0]


def summary_fields(workflow):
    summary = workflow.split("      - name: Android build and cache summary\n", 1)[1].split("        run: |\n", 1)[0]
    return dict(line.strip().split(": ", 1) for line in summary.split("        env:\n", 1)[1].splitlines())


def run_key_shell(root, checkout_sha, github_sha, ccache_available=False, git_exit=0):
    step = step_text(WORKFLOW.read_text(), "gradle-cache-key")
    script = "\n".join(line[10:] for line in step.split("        run: |\n", 1)[1].splitlines())
    tools = root / "bin"
    tools.mkdir()
    for utility in ("mkdir", "sha256sum", "cut"):
        tools.joinpath(utility).symlink_to(shutil.which(utility))
    jdk = root / "jdk"
    jdk.mkdir()
    release = b'JAVA_VERSION="17.fixture"\n'
    (jdk / "release").write_bytes(release)
    git = tools / "git"
    git.write_text(
        "#!/bin/sh\n"
        'if [ "$#" -ne 2 ] || [ "$1" != rev-parse ] || [ "$2" != HEAD ]; then exit 97; fi\n'
        f"if [ '{git_exit}' -ne 0 ]; then exit {git_exit}; fi\n"
        f"printf '%s\\n' '{checkout_sha}'\n")
    git.chmod(0o755)
    clock = tools / "date"
    clock.write_text("#!/bin/sh\nprintf '1000\\n'\n")
    clock.chmod(0o755)
    if ccache_available:
        ccache = tools / "ccache"
        ccache.write_text("#!/bin/sh\nexit 98\n")
        ccache.chmod(0o755)
    output = root / "outputs"
    environment = {
        "PATH": str(tools), "RUNNER_TEMP": str(root),
        "JAVA_HOME_17_X64": str(jdk), "GITHUB_OUTPUT": str(output),
        "GITHUB_SHA": github_sha, "RUNNER_PLATFORM": "Linux-X64",
        "ImageOS": "ubuntu26", "ImageVersion": "20261012.163.1",
        "CACHE_COMPATIBILITY": "a" * 64, "NATIVE_CONTRACT": "b" * 64,
    }
    result = subprocess.run(
        [shutil.which("bash"), "--noprofile", "--norc", "-eo", "pipefail", "-c", script],
        cwd=root, env=environment, capture_output=True, text=True)
    lines = output.read_text().splitlines()
    return result, lines, dict(line.split("=", 1) for line in lines), hashlib.sha256(release).hexdigest()


class AndroidCiWorkflowMetadataTests(unittest.TestCase):
    def test_actual_key_shell_preserves_key_and_distinguishes_checkout_from_pr_sha(self):
        for ccache_available, git_exit in ((False, 0), (True, 0), (False, 23)):
            with self.subTest(ccache_available=ccache_available, git_exit=git_exit), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                checkout_sha = "1" * 40
                merge_sha = "2" * 40
                result, lines, outputs, jdk_hash = run_key_shell(root, checkout_sha, merge_sha, ccache_available, git_exit)
                self.assertEqual(result.returncode, git_exit, result.stderr)
                self.assertEqual(len(outputs), len(lines), "Each output must be unambiguous")
                if git_exit:
                    self.assertNotIn("checkout_sha", outputs)
                    self.assertFalse((root / "android-ci/restore.start").exists())
                    continue
                compatibility = f"android-gradle-v1-Linux-X64-ubuntu26-20261012.163.1-{jdk_hash}-{'a' * 64}-"
                prefix = f"{compatibility}{'b' * 64}-"
                self.assertEqual(outputs, {
                    "compatibility": compatibility, "prefix": prefix, "key": prefix + merge_sha,
                    "requested_key": prefix + merge_sha, "jdk_hash": jdk_hash,
                    "compatibility_hash": "a" * 64, "native_contract_hash": "b" * 64,
                    "runner_platform": "Linux-X64", "image_os": "ubuntu26",
                    "image_version": "20261012.163.1", "checkout_sha": checkout_sha,
                    "ccache_available": str(ccache_available).lower(),
                })
                self.assertNotEqual(outputs["checkout_sha"], merge_sha)
                self.assertEqual((root / "android-ci/restore.start").read_text(), "1000\n")
                self.assertEqual(result.stdout, "")
                self.assertEqual(result.stderr, "")

    def test_summary_bridges_requested_action_and_source_identities_separately(self):
        workflow = WORKFLOW.read_text()
        fields = summary_fields(workflow)
        expected = {
            "GRADLE_CACHE_REQUESTED_KEY": "steps.gradle-cache-key.outputs.requested_key",
            "GRADLE_CACHE_PREFIX": "steps.gradle-cache-key.outputs.prefix",
            "GRADLE_CACHE_COMPATIBILITY_PREFIX": "steps.gradle-cache-key.outputs.compatibility",
            "GRADLE_CACHE_PRIMARY_KEY": "steps.gradle-cache-restore.outputs.cache-primary-key",
            "GRADLE_CACHE_JDK_HASH": "steps.gradle-cache-key.outputs.jdk_hash",
            "GRADLE_CACHE_COMPATIBILITY_HASH": "steps.gradle-cache-key.outputs.compatibility_hash",
            "GRADLE_CACHE_NATIVE_HASH": "steps.gradle-cache-key.outputs.native_contract_hash",
            "ANDROID_CI_RUNNER_PLATFORM": "steps.gradle-cache-key.outputs.runner_platform",
            "ANDROID_CI_IMAGE_OS": "steps.gradle-cache-key.outputs.image_os",
            "ANDROID_CI_IMAGE_VERSION": "steps.gradle-cache-key.outputs.image_version",
            "ANDROID_CI_CHECKOUT_SHA": "steps.gradle-cache-key.outputs.checkout_sha",
            "ANDROID_CI_CCACHE_AVAILABLE": "steps.gradle-cache-key.outputs.ccache_available",
            "ANDROID_CI_REPOSITORY": "github.repository",
            "ANDROID_CI_RUN_ID": "github.run_id",
            "ANDROID_CI_RUN_ATTEMPT": "github.run_attempt",
            "ANDROID_CI_EVENT_NAME": "github.event_name",
            "ANDROID_CI_REF": "github.ref",
            "ANDROID_CI_GITHUB_SHA": "github.sha",
            "ANDROID_CI_HEAD_SHA": "github.event.pull_request.head.sha || github.sha",
        }
        for name, expression in expected.items():
            with self.subTest(name=name):
                self.assertEqual(fields[name], "${{ " + expression + " }}")
        self.assertIn("python3 -m unittest discover -s scripts -p test_android_ci_workflow_metadata.py", workflow)

    def test_actual_key_summary_bridge_and_report_integrate_for_pr_checkout(self):
        merge_sha, head_sha = "2" * 40, "9" * 40
        # A normal checkout is the PR merge SHA; the separate head is not the
        # checkout or cache-key suffix. Also exercise a real captured mismatch.
        for checkout_sha in (merge_sha, "1" * 40):
            with self.subTest(checkout_sha=checkout_sha), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                result, _, outputs, _ = run_key_shell(root, checkout_sha, merge_sha)
                self.assertEqual(result.returncode, 0, result.stderr)
                matched_key = outputs["prefix"] + "3" * 40
                values = {f"steps.gradle-cache-key.outputs.{name}": value for name, value in outputs.items()}
                # A finite fixture lookup for the actual summary expressions,
                # deliberately not a GitHub expression evaluator.
                values.update({
                    "steps.gradle-cache-restore.outputs.cache-hit": "false",
                    "steps.gradle-cache-restore.outputs.cache-primary-key": outputs["requested_key"],
                    "steps.gradle-cache-restore.outputs.cache-matched-key": matched_key,
                    "steps.gradle-cache-restore.outcome": "success",
                    "steps.gradle-cache-save.outcome": "skipped",
                    "steps.android-build.outcome": "success",
                    "steps.android-dex.outcome": "success",
                    "github.repository": "f-tuma/musubi", "github.run_id": "12345",
                    "github.run_attempt": "1", "github.event_name": "pull_request",
                    "github.ref": "refs/pull/371/merge", "github.sha": merge_sha,
                    "github.event.pull_request.head.sha || github.sha": head_sha,
                })
                environment = {}
                for name, expression in summary_fields(WORKFLOW.read_text()).items():
                    self.assertTrue(expression.startswith("${{ ") and expression.endswith(" }}"))
                    expression = expression[4:-3]
                    self.assertIn(expression, values, "Unexpected workflow expression needs an explicit fixture")
                    environment[name] = values[expression]
                evidence = root / "android-ci"
                (evidence / "gradle.log").write_text(
                    "> Task :app:buildCMakeRelWithDebInfo[arm64-v8a]\n"
                    "> Task :app:buildCMakeRelWithDebInfo[x86_64]\n"
                    "> Task :app:compileReleaseKotlin FROM-CACHE\n"
                    "3 actionable tasks: 2 executed, 1 from cache\n")
                report = build_report(evidence, environment)
                coherent = checkout_sha == merge_sha
                self.assertEqual(report["invalid_metadata_fields"], [])
                self.assertTrue(report["context"]["complete"])
                self.assertEqual(report["context"]["coherent"], coherent)
                self.assertEqual(report["context"]["checkout_sha"], outputs["checkout_sha"])
                self.assertEqual(report["context"]["github_sha"], merge_sha)
                self.assertEqual(report["context"]["head_sha"], head_sha)
                request = report["cache"]["request"]
                self.assertEqual(request["coherent"], coherent)
                self.assertEqual(request["key"], outputs["requested_key"])
                self.assertEqual(request["prefix"], outputs["prefix"])
                self.assertEqual(request["compatibility_prefix"], outputs["compatibility"])
                self.assertEqual(request["components"], {
                    "runner_platform": outputs["runner_platform"], "image_os": outputs["image_os"],
                    "image_version": outputs["image_version"], "jdk_release_hash": outputs["jdk_hash"],
                    "compatibility_hash": outputs["compatibility_hash"],
                    "native_contract_hash": outputs["native_contract_hash"],
                })
                self.assertEqual(report["cache"]["action_primary_key"], outputs["requested_key"])
                self.assertEqual(report["cache"]["matched_key"], matched_key)
                self.assertEqual(report["cache"]["restore_state"], "partial" if coherent else "inconsistent")
                self.assertEqual(report["cache"]["restore_match_scope"], "native_contract" if coherent else None)
                self.assertEqual(report["cache"]["exact_hit"], False if coherent else None)
                self.assertEqual(report["cache"]["save_state"], "skipped")
                self.assertIsNone(report["cache"]["archive_persisted"])
                self.assertEqual(report["ccache"]["executable_on_path"], False)


if __name__ == "__main__":
    unittest.main()
