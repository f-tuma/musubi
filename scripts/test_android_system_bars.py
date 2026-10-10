import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("system_bars", ROOT / "scripts/verify-android-system-bars.py")
bars = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bars)


class SystemBarsTest(unittest.TestCase):
    def fixture(self, scratch, instruction="", omit=None):
        artifact = Path(scratch) / "app.apk"
        with zipfile.ZipFile(artifact, "w") as archive:
            archive.writestr("classes.dex", b"fixture")
        output = "\n".join(f"Class descriptor : 'L{name.replace('.', '/')};'" for name in bars.ROOTS if name != omit)
        output += "\n" + instruction
        tool = Path(scratch) / "dexdump"
        tool.write_text("#!/usr/bin/env python3\nprint(" + repr(output) + ")\n")
        tool.chmod(0o755)
        return artifact, tool

    def test_shipped_color_call_is_rejected(self):
        with tempfile.TemporaryDirectory() as scratch:
            artifact, tool = self.fixture(scratch, "0010: invoke-virtual {v0}, Landroid/view/Window;.getStatusBarColor:()I")
            with self.assertRaisesRegex(ValueError, "unmigrated_calls"):
                bars.audit(artifact, tool)

    def test_shipped_legacy_cutout_assignment_is_rejected(self):
        with tempfile.TemporaryDirectory() as scratch:
            artifact, tool = self.fixture(scratch, "0010: iput v0, v1, Landroid/view/WindowManager$LayoutParams;.layoutInDisplayCutoutMode:I")
            with self.assertRaisesRegex(ValueError, "unmigrated_calls"):
                bars.audit(artifact, tool)

    def test_missing_expected_library_does_not_silently_pass(self):
        with tempfile.TemporaryDirectory() as scratch:
            artifact, tool = self.fixture(scratch, omit=bars.ROOTS[0])
            with self.assertRaisesRegex(ValueError, "Missing expected classes"):
                bars.audit(artifact, tool)

    def test_unrelated_compatibility_calls_are_reported_separately(self):
        with tempfile.TemporaryDirectory() as scratch:
            artifact, tool = self.fixture(scratch, "Class descriptor : 'Landroidx/activity/EdgeToEdgeApi23;'\n0010: invoke-virtual {v0, v1}, Landroid/view/Window;.setStatusBarColor:(I)V")
            result = bars.audit(artifact, tool)
            self.assertEqual(result["unmigrated_calls"], 0)
            self.assertEqual(result["other_compatibility_color_calls"], 1)

    def test_native_cutout_helper_preserves_old_platform_and_uses_always_on_new(self):
        with tempfile.TemporaryDirectory() as scratch:
            scratch = Path(scratch)
            sources = {
                "android/os/Build.java": "package android.os; public class Build { public static class VERSION { public static int SDK_INT; } public static class VERSION_CODES { public static final int R=30; } }",
                "android/view/WindowManager.java": "package android.view; public class WindowManager { public static class LayoutParams { public static final int LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS=3; public int layoutInDisplayCutoutMode; } }",
                "Test.java": '''import android.os.Build; import android.view.WindowManager; import dev.frgtn.musubi.compat.DisplayCutout;
public class Test { public static void main(String[] args) {
 for (int api: new int[]{24,28,29,30,35,36}) {
  Build.VERSION.SDK_INT=api;
  WindowManager.LayoutParams p=new WindowManager.LayoutParams(); p.layoutInDisplayCutoutMode=2;
  DisplayCutout.allowContent(p);
  if (p.layoutInDisplayCutoutMode != (api>=30 ? 3:2)) throw new AssertionError("API "+api);
 }
} }''',
            }
            files = []
            for name, source in sources.items():
                file = scratch / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(source)
                files.append(str(file))
            files.append(str(ROOT / "apps/client/plugins/android-system-bars/DisplayCutout.java"))
            subprocess.run(["javac", "--release", "17", "-d", str(scratch), *files], check=True, capture_output=True)
            subprocess.run(["java", "-cp", str(scratch), "Test"], check=True, capture_output=True)


if __name__ == "__main__":
    unittest.main()
