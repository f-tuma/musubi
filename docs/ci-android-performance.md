# Android CI build time

The 15 October 2026 audit compared Quality runs
[38648695477](https://github.com/f-tuma/musubi/actions/runs/38648695477),
[38699859322](https://github.com/f-tuma/musubi/actions/runs/38699859322),
[38705288280](https://github.com/f-tuma/musubi/actions/runs/38705288280), and the
Quality jobs inside publication run
[38699939142](https://github.com/f-tuma/musubi/actions/runs/38699939142).
The Android system bars job took 17:40–19:35; the combined Gradle build accounted
for 16:30–18:13. Dependency installation took 11–14 seconds and Expo prebuild
6–7 seconds. The observed Gradle summary was 946 executed tasks and no tasks
restored from the build cache.

Database integration and web end-to-end tests already run in four shards each.
Android is the current critical path. Splitting APK and AAB into separate jobs
would repeat their shared native compilation. Keep the combined build and both
`arm64-v8a` and `x86_64` ABIs while measuring cache reuse first. This change
preserves the 21 expanded Quality jobs, their check names and release gates.

## Cache contents and keys

After the unchanged frozen pnpm installation and Expo prebuild, restore only
`~/.gradle/caches` and `~/.gradle/wrapper`. Gradle's `--build-cache` lets cacheable
tasks validate their own inputs and reuse outputs. The generated Android project,
`.cxx` directories, project `build` directories, APK and AAB files are not archived
as GitHub cache paths. Every run still builds both artifacts and runs the real DEX
scanner against each. The local `--profile` report does not upload a build scan.

The compatibility prefix includes hosted runner OS/architecture and image version,
the actual JDK 17 release-file checksum, the Gradle wrapper configuration and the
custom system-bars ASM script. The full key also hashes these public inputs:

- pnpm lock/workspace files, client package manifest and Expo configuration;
- client Expo plugins and local module sources;
- generated Gradle build/properties/wrapper configuration and app sources.

Compute that hash after prebuild; never hash the environment, `.env`, signing
files, `local.properties`, or the entire generated project. Append the source
commit to produce an immutable archive entry. Restore first tries the complete
native contract without that commit, then the compatibility prefix. An API-only
release's app version change can therefore reuse the previous archive. A different
runner image, JDK, wrapper or custom ASM script starts cold. Other native-contract
changes may restore an archive, but Gradle must validate each task's inputs before
reusing outputs. Neither outer cache key is proof that a task result is current;
this change does not force any non-cacheable task to become cacheable.

## Trust and failures

Use SHA-pinned official `actions/cache/restore` and `actions/cache/save`
(v5.0.4). PR jobs restore without an explicit save step. Only successful builds
in `f-tuma/musubi`, on `refs/heads/main`, triggered by `push` can save, after
both APK/AAB DEX checks pass. A reusable Quality call retains its caller's GitHub
event context, so a release dispatched on main only restores an existing entry.
Forks and PR merge refs cannot populate main's cache scope; GitHub's branch
isolation is an additional boundary.

Do not place credentials or signing material in the cache paths. Checkout Git
credentials remain outside those paths. Cache misses and service failures leave
the full build and DEX checks in place. Explicit Bash `pipefail` preserves Gradle
failure through the diagnostic `tee` pipeline, and its exit trap still records the
build end time.

## Cold and warm acceptance

`android-build-timings` is uploaded on success or failure, with seven-day
retention. It contains the Gradle log, local profile when available, start/end
markers and `timings.json`. The job summary records archive exact/partial hits,
restore/build/save wall time, Gradle executed/from-cache/up-to-date counts and
build/DEX outcomes. A skipped or unavailable duration stays unknown.

The first PR may be cold because PRs do not seed this cache. After a green merge,
a trusted main build seeds it. Compare a subsequent clean hosted runner using
the same compatible toolchain with the cold baseline. Record the actual
matched key, task cache hits, profile and total job time, including restore/save
overhead. Confirm both artifact scans still pass. A restored archive alone does
not prove that CMake/native tasks reused outputs or that elapsed time improved.
Measured savings are pending that comparison.

If native CMake work still dominates warm builds, use the profiles to evaluate
ABI sharding separately; retain both ABIs, both artifact types and DEX coverage
in every resulting matrix. For database/web shard balancing, use the existing
[timing artifacts](ci-shards.md) before increasing parallelism.

Sources: [Gradle build cache](https://docs.gradle.org/current/userguide/build_cache.html),
[local profiling](https://docs.gradle.org/current/userguide/performance.html),
[cache restore/save actions](https://github.com/actions/cache), and
[GitHub cache scope and trust](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching).
