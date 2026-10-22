# MUSU-54 — selected toolchain observation

This slice records the toolchain selected by the real Android APK/AAB build and
computes an observation fingerprint. The fingerprint is shadow data only: it is
not a cache key or proof that a whole Gradle archive is compatible across runner
images. Cache keys, restore order, persistence rules and build coverage remain
unchanged.

## Why observe the build

The first MUSU-54 slice found different `ImageVersion` components in baseline,
PR and main requests, excluding known older archives from the new prefixes.
That observation did not establish a cold build, a transport failure, selected
cache IDs, full toolchain equivalence or a performance gain.

A list of installed SDK packages, a wrapper URL and an environment `JAVA_HOME`
describe available or requested tools. They do not establish every tool actually
selected by the build. Local ignored Android output is useful for parser fixtures
and schema discovery, but is never evidence about current CI.

## Same-build evidence

A CI-only Gradle init script observes the same invocation that runs
`:app:assembleRelease` and `:app:bundleRelease`. It records the actual Gradle
runtime, Android plugin version and JVM release identity, and correlates native
configure/build tasks with their module, phase and ABI. Included composite builds
must not overwrite the main Android build's observations. Task callbacks may run
in parallel, so the private handoff must be bounded and synchronized.

The Python collector reads only selected native metadata associated with those
tasks. A directory named `.cxx` is not enough: unrelated configurations, old
variants, ambiguous candidates and incomplete builds remain unknown. Where the
supported AGP task exposes its active ABI model, its selected build folder gives
a direct association; this internal interface is not a cross-version guarantee.
An active AGP `build.ninja.txt` redirection is unsupported in this slice and
produces unknown selection, rather than following a path from that file.

The selected CMake cache supplies the generator, CMake version, ABI, Android API,
build type, STL, NDK location and selected CMake/Ninja executables. Compiler
identity can be in the corresponding `CMakeFiles/<version>/CMakeCCompiler.cmake`
and `CMakeCXXCompiler.cmake`, rather than a cache entry. Parse literal supported
fields; do not evaluate CMake files or execute commands found in them. Duplicate
or contradictory ABI, API, NDK, version or compiler evidence is not accepted as
complete.

Only allowed public values and content digests reach the timing report. Absolute
paths, module/task names, raw flags, arbitrary environment, model files and
commands stay out of the uploaded report. The private path handoff lives outside
the uploaded artifact directory. Selected tool files must resolve inside the
expected SDK roots; unexpected paths or symlinks are rejected. Bounds apply to
input size, record counts and strings before parsing or hashing.

## Fingerprint boundary

The canonical fingerprint includes observed runtime/tool identities, ordered
`arm64-v8a,x86_64` coverage, native contract and selected ABI/build configuration.
`ImageVersion` stays in the normal cache report, but is excluded from this shadow
comparison. Incomplete or contradictory required evidence yields an unavailable
fingerprint with fixed diagnostic reasons, rather than an invented identity.

Global C/C++ flag digests cover their explicitly recorded scope. They do not
cover every target's `add_compile_options`, `target_compile_options`, generated
source or environment dependency. The report therefore states that target flags
are not fully covered. Even equal fingerprints do not authorize cross-image
reuse of cached task outputs. A later implementation must separately review a
cache contract or restrict reuse to dependency/wrapper content.

The observer uses task execution callbacks under the existing configuration.
These callbacks are not configuration-cache compatible. Do not silently change
configuration-cache policy or claim support for a configuration-cache hit.
Observer failure must not conceal the Gradle exit status or manufacture a
successful native build.

## Acceptance and next decision

Fixture coverage must distinguish equivalent observations across image versions
from compiler/NDK/CMake/Ninja/JDK/ABI/API/flag changes. It must reject malformed,
oversized, missing, conflicting, path-escaping and unsupported evidence without
exporting its contents. Exercise the actual workflow shell and preserve its
`pipefail`, timing trap and failure propagation.

Before ordinary squash, require independent final-source approval and all current
PR checks green. Separately verify the resulting main's 21 real jobs, both ABI
APK/AAB builds and both DEX scans. Download actual timing ZIPs, verify their
digests, and bind toolchain reports to the tested checkout, PR head, run and
attempt. Report actual tool identities and unknowns before choosing the next
slice. Broader MUSU-54 retains its cold/warm and before/after acceptance.

This slice adopts no compiler cache, broad `.cxx` restore, forced AGP cacheability,
ABI sharding, artificial cold miss, new release tag or production deployment.

## Primary references

- [Gradle init scripts](https://docs.gradle.org/current/userguide/init_scripts.html)
  describe attaching an init script to an invocation.
- [Gradle task graph API](https://docs.gradle.org/current/javadoc/org/gradle/api/execution/TaskExecutionGraph.html)
  documents task/state callbacks and their configuration-cache limitation.
- [AGP's version checker](https://android.googlesource.com/platform/tools/base/+/studio-master-dev/build-system/gradle-core/src/main/java/com/android/build/gradle/internal/utils/agpVersionChecker.kt)
  demonstrates reading the Android plugin version through its own classloader.
  This historical source does not prove the current CI plugin version.
- [CMake compiler selection](https://cmake.org/cmake/help/v3.22/variable/CMAKE_LANG_COMPILER.html),
  [native build program](https://cmake.org/cmake/help/v3.22/variable/CMAKE_MAKE_PROGRAM.html)
  and [CMake executable](https://cmake.org/cmake/help/v3.22/variable/CMAKE_COMMAND.html)
  define the selected-tool variables.
- [CMake language flags](https://cmake.org/cmake/help/v3.22/variable/CMAKE_LANG_FLAGS.html)
  distinguish global/configuration flags from target-level options.
