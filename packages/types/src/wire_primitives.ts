import { z } from "zod";

// These patterns are part of Musubi's 0.2.0 wire contract. Keep them stable
// across Zod upgrades; changing a library's preferred spelling or ISO policy
// must not change what an installed client can send or read.
//
// The email language is unchanged by Zod 4.6's segment-based rewrite: both
// allow nonempty dot-separated local segments, with no leading/consecutive/
// trailing dot and no trailing apostrophe. Retaining the promised pattern also
// keeps its emitted JSON Schema stable, using Zod's supported custom pattern.
export const WireEmailSchema = z.email({
  pattern: /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/,
});

// Calendar-aware dates retain leap-year and month-length validation. The time
// language deliberately permits minute-only UTC/offset timestamps, as Zod
// 4.4.3 did. Zod 4.6 requires seconds on qualified times; that would refuse
// previously valid event writes and occurrence identities.
const date = String.raw`(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))`;
const time = String.raw`(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?`;

function dateTime(zone: string) {
  return z.string().regex(new RegExp(`^${date}T(?:${time}(?:${zone}))$`))
    .meta({ format: "date-time" });
}

export const WireInstantSchema = dateTime("Z");
export const WireOffsetDateTimeSchema = dateTime(String.raw`Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)`);

// CivilDateTimeSchema adds its existing seconds/no-offset/precision refinement.
// Preserve this primitive's historical local-or-Z pattern and date-time schema
// metadata too; the full runtime refinement remains stricter than that metadata.
export const WireLocalDateTimeSchema = dateTime("Z|");
