#!/usr/bin/env python3
"""Compile real widget logic using the Android project's existing offline Gradle cache."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

module = Path(__file__).resolve().parents[1]
cache = Path(os.environ.get("GRADLE_USER_HOME", Path.home() / ".gradle")) / "caches/modules-2/files-2.1"


def jar(group, artifact, version):
    candidates = sorted((cache / group / artifact / version).glob(f"*/{artifact}-{version}.jar"))
    if not candidates:
        raise SystemExit(f"Missing cached {artifact} {version}; first compile the existing Android project offline.")
    return str(candidates[0])


compiler = [jar("org.jetbrains.kotlin", name, "2.1.20") for name in
            ["kotlin-compiler-embeddable", "kotlin-stdlib", "kotlin-script-runtime", "kotlin-reflect"]]
compiler += [jar("org.jetbrains.intellij.deps", "trove4j", "1.0.20200330"),
             jar("org.jetbrains.kotlinx", "kotlinx-coroutines-core-jvm", "1.8.0"),
             jar("org.jetbrains", "annotations", "13.0")]
sdk = Path(os.environ.get("ANDROID_HOME", os.environ.get("ANDROID_SDK_ROOT", Path.home() / "Android/Sdk")))
android = sdk / "platforms/android-36/android.jar"
resources = module / "build/intermediates/compile_r_class_jar/debug/generateDebugRFile/R.jar"
if not android.is_file() or not resources.is_file():
    raise SystemExit("Android 36 SDK and the module's generated debug R.jar are needed. Run :musubi-agenda-widget:compileDebugKotlin first.")
java = shutil.which("java")
if not java:
    raise SystemExit("Java is needed; use the project's configured JDK.")
# Put concrete org.json ahead of the SDK's Android-only stubs at runtime.
classpath = os.pathsep.join([jar("org.json", "json", "20180813"), compiler[1], str(android), str(resources)])
source = module / "src/main/java/dev/frgtn/musubi/widget"
sources = [str(source / name) for name in ["WidgetInvariants.kt", "AgendaWidgetData.kt", "AgendaWidgetStorage.kt", "CalendarWidgetPreferences.kt"]]
sources.append(str(module / "tests/WidgetSnapshotSpec.kt"))
with tempfile.TemporaryDirectory(prefix="musubi-widget-tests-") as output:
    subprocess.run([java, "-cp", os.pathsep.join(compiler), "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler",
                    "-no-stdlib", "-no-reflect", "-jvm-target", "17", "-classpath", classpath,
                    "-d", output, *sources], check=True)
    subprocess.run([java, "-cp", os.pathsep.join([output, classpath]), "dev.frgtn.musubi.widget.WidgetSnapshotSpecKt"], check=True)
