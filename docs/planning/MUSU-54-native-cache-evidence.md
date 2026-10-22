# MUSU-54 — Android cache evidence milestone

This first implementation slice makes normal PR/main builds explain which cache
they requested and what the pinned action actually reported. It does not change
cache keys, paths, restore order, write policy, native build flags or job count.
The broader MUSU-54 remains open until a selected optimization has measured
cold/warm and before/after acceptance.

## Baseline and completion

Main `d734b21fb61a92c78806f3172600db8f990dacca` Quality39779496281/attempt1
completed all21 jobs. Its timing artifact reports native build1082.460s,
restore0.278s and save16.997s;807 executed/139 FROM-CACHE tasks, with all12 build
and12 configure CMake tasks executed. Its old report lacks requested keys and
runner/JDK identities. Empty matched-key metadata does not establish a cold miss
or rule out a failed/unavailable restoration.

A separate read-only cache inventory observed trusted-main archive9341011033,
2,066,134,819 bytes, created after that build. This proves that archive existed
at observation time. It does not establish earlier availability or why the
earlier lookup reported no match. Historical receipts remain unchanged; the
corrected baseline-v2 receipt supersedes the initial overconfident wording.

Completion of this slice requires independently approved source, all current-head
PR checks before ordinary squash, actual successful main21, actual downloaded
timing ZIP digests, and correlation of the new report with GitHub run/attempt,
checkout/PR source and cache inventory. Compare execution, restore and save work
separately. If evidence remains unavailable, retain that fact and specify the
next measurement rather than inventing a cause or performance improvement.

## Report schema2

The report records an allowlisted repository/run/attempt/event/ref, actual
checkout SHA, Actions `GITHUB_SHA` and PR head SHA. PR checkout normally names the
synthetic merge commit; the key continues using the original `GITHUB_SHA` suffix.
Requested key, native prefix, compatibility prefix, runner image/platform, JDK
release hash and native/compatibility hashes come from the original preparation
step. The reporter validates their public grammar and mutual consistency.

| Restore state | Meaning |
| --- | --- |
| exact | Successful action; primary=requested=matched and hit=true |
| partial | Successful action; hit=false and a different matched key shares an allowed native or compatibility prefix |
| no_match_reported | Successful action with the expected primary but no hit/matched result; miss and some restoration failures remain indistinguishable |
| unavailable | Missing evidence, including feature-unavailable false before any primary output |
| skipped / failure / cancelled | The original action outcome; continue-on-error does not turn it into a hit |
| inconsistent | Contradictory, malformed or redacted evidence; never treated as a usable cache hit |

The exact pinned [restore implementation](https://github.com/actions/cache/blob/668228422ae6a00e4ad889ee87cd7109ec5666a7/src/restoreImpl.ts)
and [output provider](https://github.com/actions/cache/blob/668228422ae6a00e4ad889ee87cd7109ec5666a7/src/stateProvider.ts)
explain those output boundaries. The shipped toolkit can suppress some restore
problems as warnings. The [save implementation](https://github.com/actions/cache/blob/668228422ae6a00e4ad889ee87cd7109ec5666a7/src/saveImpl.ts)
also catches errors; successful invocation is `attempted_unverified`, with
archive persistence unknown until independently observed through the API.

No arbitrary environment, outcome strings, URLs or task paths are copied into
JSON/Markdown. Unknown or rejected fields become null/fixed enums; only rejected
field names are listed. Task totals require one complete consistent Gradle
summary. CMake data contains bounded counts by phase/ABI/outcome, not task names
or summed wall times. Incomplete logs remain marked incomplete. Existing native
profile artifacts remain available; this adds no full-log export.

`ccache.executable_on_path` records only executable discovery, not its version,
configuration, actual compiler launcher use or hits. Both real ABIs, fresh
APK/AAB builds and shipped DEX checks remain mandatory. PRs only restore; only
the existing trusted push/main path may save after both DEX scans.

## Next optimization decision

First observe a natural compatible restore against the actual stored archive.
Correlate exact key/version/ref/cache ID and observation times; current inventory
cannot reconstruct historical eviction. Retain unknown causes where necessary.

A candidate next slice is an isolated content-checked compiler object cache,
not whole `.cxx`/generated build directories or forced AGP task cacheability.
The pinned [React Native CMake integration](https://github.com/react/react-native/blob/v0.86.3/packages/react-native/ReactAndroid/cmake-utils/ReactNative-application.cmake)
already discovers ccache. Actual availability, toolchain identity, generated
launcher use and safe configuration must be observed before adopting it. Any
future [ccache configuration](https://ccache.dev/manual/latest.html) keeps compiler
content checks, default safety and trusted-main-only persistence. Measure hit
deltas plus restore/save/native/DEX time on ordinary builds before claiming a gain.
Do not infer savings by adding overlapping task durations or add ABI shards
without their own review and updated coverage contract.

This milestone creates no production publication/tag, provider behavior change,
cache deletion, artificial cold miss or fixed calendar timeline.
