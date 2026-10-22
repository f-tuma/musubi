"""Exercise the real observer and workflow shell without Android, caches or network."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
OBSERVER = ROOT / "scripts/android-ci-toolchain.init.gradle"
WORKFLOW = ROOT / ".github/workflows/quality.yml"

# This fixture dispatches Gradle's callback contract into the unmodified script.
# Groovy compiles these classes in memory; no Gradle daemon or SDK is started.
GROOVY_FIXTURE = r'''
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class FixtureGraph {
    List callbacks = []
    void afterTask(Closure callback) { callbacks.add(callback) }
}
class FixtureGradle {
    String gradleVersion = '9.3.1'
    FixtureGraph taskGraph = new FixtureGraph()
    List settingsCallbacks = [], finishedCallbacks = []
    void settingsEvaluated(Closure callback) { settingsCallbacks.add(callback) }
    void buildFinished(Closure callback) { finishedCallbacks.add(callback) }
}
class FixtureModel {
    File directory
    File getCxxBuildFolder() { directory }
}
class FixtureTask {
    public Object abi
    String name
    Object project
}
class FixtureUnsupportedTask {
    String name
    Object project
}
class FixturePlugins {
    Object plugin
    Object findPlugin(String name) { name == 'com.android.application' ? plugin : null }
}

def loader = new GroovyClassLoader(getClass().classLoader)
loader.parseClass('package com.android; class Version { public static final String ANDROID_GRADLE_PLUGIN_VERSION = "8.12.0" }')
def pluginClass = loader.parseClass('class FixtureAndroidPlugin {}')
def workspace = new File(System.getenv('GITHUB_WORKSPACE'))
def android = new File(workspace, 'apps/client/android')
def destination = System.getenv('MUSUBI_ANDROID_TOOLCHAIN_INPUT')
def scenario = args[1]
def project = new Expando(projectDir: android, plugins: new FixturePlugins(plugin: scenario == 'no-plugin' ? null : pluginClass.newInstance()))
project.rootProject = project
def selected = new File(android, '.cxx/RelWithDebInfo/selected/arm64-v8a')
def state = { failure = null, skipped = false -> new Expando(failure: failure, skipped: skipped) }
def task = { name, supported = true ->
    supported ? new FixtureTask(name: name, project: project, abi: new FixtureModel(directory: selected)) :
        new FixtureUnsupportedTask(name: name, project: project)
}
def gradle = new FixtureGradle()
new GroovyShell(loader, new Binding([gradle: gradle])).evaluate(new File(args[0]))
def settings = new Expando(settingsDir: scenario == 'included' ? new File(workspace, 'included-build') : android)
gradle.settingsCallbacks.each { it.call(settings) }
def dispatch = { current, currentState -> gradle.taskGraph.callbacks.each { it.call(current, currentState) } }
if (scenario == 'concurrent') {
    def workers = Executors.newFixedThreadPool(8)
    def futures = (0..<300).collect { number -> workers.submit({
        dispatch(task("buildCMakeRelWithDebInfo[arm64-v8a][target${number}]"), state())
    } as Runnable) }
    workers.shutdown()
    futures.each { it.get() }
    assert workers.awaitTermination(20, TimeUnit.SECONDS)
} else {
    dispatch(task('configureCMakeRelWithDebInfo[arm64-v8a]', scenario != 'unsupported'), state())
    dispatch(task('buildCMakeRelWithDebInfo[arm64-v8a][target]'), state())
    if (scenario == 'outcomes') {
        dispatch(task('configureCMakeRelWithDebInfo[x86_64]'), state(new Exception('PRIVATE_FAILURE_SENTINEL')))
        dispatch(task('buildCMakeRelWithDebInfo[x86_64]'), state(null, true))
        dispatch(task('compileReleaseKotlin'), state())
        dispatch(task('configureCMakeDebug[x86]'), state())
        def foreign = task('configureCMakeRelWithDebInfo[x86_64]')
        foreign.project = new Expando(rootProject: new Expando(projectDir: new File(workspace, 'included-build')))
        dispatch(foreign, state())
    }
}
gradle.finishedCallbacks.each { it.call(new Expando(failure: null)) }
'''


def groovy_runtime():
    """Use an already installed distribution; never resolve or download Gradle."""
    explicit = os.environ.get("MUSUBI_TEST_GRADLE")
    candidates = ([Path(explicit)] if explicit else
                  sorted((Path.home() / ".gradle/wrapper/dists/gradle-9.3.1-bin").glob("*/gradle-9.3.1/bin/gradle")))
    for executable in candidates:
        library = executable.resolve().parents[1] / "lib"
        core = list(library.glob("groovy-[0-9]*.jar"))
        json_library = list(library.glob("groovy-json-[0-9]*.jar"))
        java = shutil.which("java")
        if len(core) == len(json_library) == 1 and java:
            return str(Path(java).resolve()), os.pathsep.join(map(str, core + json_library))
    if explicit:
        raise AssertionError("MUSUBI_TEST_GRADLE must name an installed distribution with Groovy and Java")
    return None


class AndroidCiToolchainObserverTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runtime = groovy_runtime()
        if cls.runtime is None:
            raise unittest.SkipTest("No installed Gradle9.3.1 Groovy runtime; actual native CI verifies observer")

    def observe(self, scenario):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            android = directory / "apps/client/android"
            android.mkdir(parents=True)
            evidence = directory / "android-ci"
            evidence.mkdir()
            (evidence / "build.start").write_text("1000\n")
            output = directory / "android-toolchain-input.json"
            if scenario == "included":
                output.write_text("PARENT_BUILD_SENTINEL")
            script = directory / "fixture.groovy"
            script.write_text(GROOVY_FIXTURE)
            environment = {
                "PATH": os.defpath, "GITHUB_WORKSPACE": str(directory), "RUNNER_TEMP": str(directory),
                "MUSUBI_ANDROID_TOOLCHAIN_INPUT": str(output), "GITHUB_RUN_ID": "12345",
                "GITHUB_RUN_ATTEMPT": "2", "GITHUB_SHA": "a" * 40,
            }
            result = subprocess.run(
                [self.runtime[0], "-cp", self.runtime[1], "groovy.ui.GroovyMain", str(script), str(OBSERVER), scenario],
                env=environment, capture_output=True, text=True, timeout=40)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "")
            self.assertEqual(result.stderr, "")
            raw = output.read_text()
            if scenario == "included":
                return raw
            report = json.loads(raw)
            self.assertNotIn("PRIVATE_FAILURE_SENTINEL", raw)
            expected = (android / ".cxx/RelWithDebInfo/selected/arm64-v8a").resolve()
            return report, str(android.resolve()), str(expected)

    def test_same_build_headers_agp_classloader_and_exact_selected_model(self):
        report, project, selected = self.observe("success")
        self.assertEqual(report["schema_version"], 1)
        self.assertEqual((report["run_id"], report["run_attempt"], report["github_sha"]), ("12345", "2", "a" * 40))
        self.assertEqual(report["build_start_ms"], "1000")
        self.assertEqual(report["gradle_version"], "9.3.1")
        java_home = Path(self.runtime[0]).parents[1]
        self.assertEqual(report["jdk_release_sha256"], hashlib.sha256((java_home / "release").read_bytes()).hexdigest())
        self.assertTrue(report["jdk_version"])
        self.assertEqual(report["agp_versions"], ["8.12.0"])
        self.assertTrue(report["observer_complete"])
        self.assertFalse(report["records_truncated"])
        self.assertEqual(report["records"], [
            {"project_dir": project, "abi": "arm64-v8a", "phase": "configure", "outcome": "success", "build_dir": selected},
            {"project_dir": project, "abi": "arm64-v8a", "phase": "build", "outcome": "success", "build_dir": None},
        ])

    def test_included_build_cannot_overwrite_parent_observation(self):
        self.assertEqual(self.observe("included"), "PARENT_BUILD_SENTINEL")

    def test_unsupported_model_is_unknown_without_fallback_directory_guess(self):
        report, _, _ = self.observe("unsupported")
        self.assertIsNone(report["records"][0]["build_dir"])
        self.assertEqual(report["records"][0]["outcome"], "success")

    def test_task_outcomes_and_unrelated_tasks_remain_distinct(self):
        report, _, _ = self.observe("outcomes")
        self.assertEqual(len(report["records"]), 4)
        self.assertEqual([r["outcome"] for r in report["records"]], ["success", "success", "failure", "skipped"])
        self.assertEqual([r["abi"] for r in report["records"]], ["arm64-v8a", "arm64-v8a", "x86_64", "x86_64"])

    def test_missing_selected_android_plugin_does_not_claim_complete_identity(self):
        report, _, _ = self.observe("no-plugin")
        self.assertFalse(report["observer_complete"])
        self.assertEqual(report["agp_versions"], [])
        self.assertEqual(len(report["records"]), 2)

    def test_parallel_callbacks_preserve_record_bound_and_overflow_evidence(self):
        report, _, _ = self.observe("concurrent")
        self.assertEqual(len(report["records"]), 256)
        self.assertTrue(report["records_truncated"])
        self.assertEqual(report["agp_versions"], ["8.12.0"])


class AndroidCiToolchainWorkflowTests(unittest.TestCase):
    def test_actual_native_shell_binds_observer_and_preserves_failure_and_private_boundary(self):
        workflow = WORKFLOW.read_text()
        step = workflow.split("        id: android-build\n", 1)[1].split("      - name:", 1)[0]
        shell = "\n".join(line[10:] for line in step.split("        run: |\n", 1)[1].splitlines())
        input_expression = step.split("MUSUBI_ANDROID_TOOLCHAIN_INPUT: ", 1)[1].splitlines()[0]
        upload = workflow.split("          name: android-build-timings\n", 1)[1].split("          retention-days:", 1)[0]
        paths = [line.strip() for line in upload.split("          path: |\n", 1)[1].splitlines()]
        for exit_code in (0, 23):
            with self.subTest(exit_code=exit_code), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                android = root / "apps/client/android"
                android.mkdir(parents=True)
                evidence = root / "android-ci"
                evidence.mkdir()
                tools = root / "bin"
                tools.mkdir()
                (tools / "tee").symlink_to(shutil.which("tee"))
                clock = tools / "date"
                clock.write_text(f"#!/bin/sh\nif [ -f '{root}/clock.started' ]; then printf '2000\\n'; else printf x > '{root}/clock.started'; printf '1000\\n'; fi\n")
                clock.chmod(0o755)
                gradlew = android / "gradlew"
                gradlew.write_text(
                    "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$FIXTURE_ARGS\"\n"
                    "printf '%s\\n' \"$JAVA_HOME\" > \"$FIXTURE_JAVA\"\n"
                    "printf 'private fixture handoff\\n' > \"$MUSUBI_ANDROID_TOOLCHAIN_INPUT\"\n"
                    "printf 'fixture native build\\n'\nexit \"$FIXTURE_EXIT\"\n")
                gradlew.chmod(0o755)
                private = input_expression.replace("${{ runner.temp }}", str(root))
                self.assertNotIn("${{", private, "New workflow expression needs an explicit fixture binding")
                environment = {
                    "PATH": str(tools), "RUNNER_TEMP": str(root), "GITHUB_WORKSPACE": str(root),
                    "JAVA_HOME_17_X64": str(root / "jdk17"), "MUSUBI_ANDROID_TOOLCHAIN_INPUT": private,
                    "FIXTURE_ARGS": str(root / "args"), "FIXTURE_JAVA": str(root / "java"), "FIXTURE_EXIT": str(exit_code),
                }
                result = subprocess.run(
                    [shutil.which("bash"), "--noprofile", "--norc", "-eo", "pipefail", "-c", shell],
                    cwd=android, env=environment, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, exit_code, result.stderr)
                args = (root / "args").read_text().splitlines()
                self.assertEqual(args[:2], [":app:assembleRelease", ":app:bundleRelease"])
                self.assertIn("-PreactNativeArchitectures=arm64-v8a,x86_64", args)
                self.assertIn("--max-workers=2", args)
                self.assertEqual(args[args.index("--init-script") + 1], str(root / "scripts/android-ci-toolchain.init.gradle"))
                self.assertEqual((root / "java").read_text().strip(), str(root / "jdk17"))
                self.assertEqual((evidence / "build.start").read_text(), "1000\n")
                self.assertEqual((evidence / "build.end").read_text(), "2000\n")
                self.assertEqual((evidence / "gradle.log").read_text(), "fixture native build\n")
                self.assertTrue(Path(private).is_file())
                for path in paths:
                    expanded = Path(path.replace("${{ runner.temp }}", str(root)))
                    self.assertNotIn("${{", str(expanded))
                    uploaded = expanded if expanded.is_absolute() else root / expanded
                    self.assertFalse(Path(private).resolve().is_relative_to(uploaded.resolve()), "Private handoff must stay outside every uploaded root")


if __name__ == "__main__":
    unittest.main()
