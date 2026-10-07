#!/usr/bin/env python3
"""Inspect the shipped DEX, rather than source text, for Musubi's migrated paths."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import tempfile
import zipfile

ROOTS = (
    "com.facebook.react.views.view.WindowUtilKt",
    "com.facebook.react.modules.statusbar.StatusBarModule",
    "com.google.android.material.internal.EdgeToEdgeUtils",
    "com.google.android.material.bottomsheet.BottomSheetDialog",
    "com.google.android.material.sidesheet.SheetDialog",
)


def selected(name):
    return any(name == root or name.startswith(root + "$") for root in ROOTS)


def audit(artifact, dexdump):
    seen, failures, other_compatibility_calls = set(), [], 0
    with tempfile.TemporaryDirectory(prefix="musubi-system-bars-") as scratch:
        with zipfile.ZipFile(artifact) as archive:
            dex_files = [name for name in archive.namelist() if re.search(r"(?:^|/)classes\d*\.dex$", name)]
            if not dex_files:
                raise ValueError("Artifact contains no classes DEX.")
            for index, name in enumerate(dex_files):
                dex = Path(scratch) / f"classes-{index}.dex"
                dex.write_bytes(archive.read(name))
                with subprocess.Popen([str(dexdump), "-d", str(dex)], stdout=subprocess.PIPE, text=True, errors="replace") as process:
                    current = ""
                    for line in process.stdout:
                        match = re.search(r"Class descriptor\s*:\s*'L([^;]+);'", line)
                        if match:
                            current = match[1].replace("/", ".")
                            if selected(current):
                                seen.add(current)
                        color = "invoke-" in line and re.search(r"Landroid/view/Window;\.(?:get|set)(?:Status|Navigation)BarColor:", line)
                        cutout = "iput" in line and "Landroid/view/WindowManager$LayoutParams;.layoutInDisplayCutoutMode:" in line
                        if selected(current) and (color or cutout):
                            failures.append({"class": current, "instruction": line.strip()})
                        elif color:
                            other_compatibility_calls += 1
                    if process.wait() != 0:
                        raise ValueError(f"dexdump failed on {name}.")
    missing = set(ROOTS) - seen
    if missing:
        raise ValueError(f"Missing expected classes (check the library versions/minification): {sorted(missing)}")
    if failures:
        raise ValueError(json.dumps({"unmigrated_calls": failures}, indent=2))
    return {
        "artifact": str(artifact),
        "dex_files": len(dex_files),
        "migrated_classes": sorted(seen),
        "unmigrated_calls": 0,
        # AndroidX and unrelated windows keep their version-specific compatibility code.
        "other_compatibility_color_calls": other_compatibility_calls,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--dexdump", required=True, type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(audit(args.artifact, args.dexdump), indent=2))
    except (ValueError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        parser.exit(1, f"System bar verification failed: {error}\n")
