Run from the repository root after the Android module has been compiled:

```sh
python3 apps/client/modules/musubi-agenda-widget/android/tests/run_native_tests.py
```

This runner compiles the production snapshot parser, reconciliation, preferences references, and Android-free invariants with Kotlin and JSON jars already cached by the Android project. It adds no dependencies, uses a temporary output directory, and runs without an emulator. It covers receipt fences, malformed input, stable occurrence identities, retained-section metadata, calendar and task membership removal, timezone/coverage boundaries, lane gaps, and merged byte-budget trimming. Actual launcher rendering, resizing, TalkBack, app-opening actions, and the pre-Android-12 collection factory's same-account clear/adoption fence still require Android device or emulator QA.
