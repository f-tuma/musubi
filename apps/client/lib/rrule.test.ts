// Runnable self-check (no framework): `npx tsx lib/rrule.test.ts`.
import assert from "node:assert";
import { buildRRule, parseRRule, parseAdvanced, describeAdvanced, AdvancedRRuleConfig } from "./rrule";

const wed = new Date(2026, 6, 8); // Wednesday

// buildRRule presets
assert.equal(buildRRule('none', wed, parseAdvanced(null)), null);
assert.equal(buildRRule('daily', wed, parseAdvanced(null)), 'FREQ=DAILY');
assert.equal(buildRRule('weekly', wed, parseAdvanced(null)), 'FREQ=WEEKLY;BYDAY=WE');
assert.equal(buildRRule('weekdays', wed, parseAdvanced(null)), 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');

// custom: interval + BYDAY (sorted) + COUNT
const custom: AdvancedRRuleConfig = { freq: 'WEEKLY', interval: 2, days: new Set([3, 1]), endType: 'count', count: 5 };
assert.equal(buildRRule('custom', wed, custom), 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=5');

// parseRRule presets vs complex → custom
assert.equal(parseRRule(null), 'none');
assert.equal(parseRRule('FREQ=DAILY'), 'daily');
assert.equal(parseRRule('FREQ=WEEKLY;BYDAY=WE'), 'weekly');
assert.equal(parseRRule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'), 'weekdays');
assert.equal(parseRRule('FREQ=MONTHLY'), 'monthly');
assert.equal(parseRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE'), 'custom');

// round-trip: buildRRule(custom) → parseAdvanced recovers the config
const rt = parseAdvanced('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=5');
assert.equal(rt.freq, 'WEEKLY');
assert.equal(rt.interval, 2);
assert.deepEqual([...rt.days].sort(), [1, 3]);
assert.equal(rt.endType, 'count');
assert.equal(rt.count, 5);

// describeAdvanced
assert.equal(describeAdvanced(custom), 'Every 2 weeks on Mon, Wed, 5 times');
assert.equal(describeAdvanced(parseAdvanced(null)), 'Every week on Mon');

console.log("rrule.test.ts: all assertions passed");
