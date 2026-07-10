// ─── Recurrence (RRULE) ──────────────────────────────────────────────────────
// Hand-rolled RRULE builder/parser for the event composer. The editor UI can
// express a fixed set of presets plus a "custom" advanced config; anything more
// complex round-trips as "custom" (see parseRRule).

export type RecurrenceOption = 'none' | 'daily' | 'weekly' | 'weekdays' | 'monthly' | 'yearly' | 'custom';
export type AdvancedFreq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
export type AdvancedEndType = 'never' | 'count';

export type AdvancedRRuleConfig = {
  freq: AdvancedFreq;
  interval: number;
  days: Set<number>;  // 0=Sun 1=Mon … 6=Sat
  endType: AdvancedEndType;
  count: number;
};

const RRULE_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

export function buildRRule(
  option: RecurrenceOption,
  startDate: Date,
  advanced: AdvancedRRuleConfig,
): string | null {
  switch (option) {
    case 'none': return null;
    case 'daily': return 'FREQ=DAILY';
    case 'weekly': return `FREQ=WEEKLY;BYDAY=${RRULE_DAYS[startDate.getDay()]}`;
    case 'weekdays': return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
    case 'monthly': return 'FREQ=MONTHLY';
    case 'yearly': return 'FREQ=YEARLY';
    case 'custom': {
      const { freq, interval, days, endType, count } = advanced;
      let rule = `FREQ=${freq}`;
      if (interval > 1) rule += `;INTERVAL=${interval}`;
      if (freq === 'WEEKLY' && days.size > 0) {
        rule += `;BYDAY=${[...days].sort().map(d => RRULE_DAYS[d]).join(',')}`;
      }
      if (endType === 'count') rule += `;COUNT=${count}`;
      return rule;
    }
  }
}

export function parseRRule(rrule: string | null | undefined): RecurrenceOption {
  if (!rrule) return 'none';
  if (rrule === 'FREQ=DAILY') return 'daily';
  if (rrule === 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR') return 'weekdays';
  if (/^FREQ=WEEKLY;BYDAY=[A-Z]{2}$/.test(rrule)) return 'weekly';
  if (rrule === 'FREQ=MONTHLY') return 'monthly';
  if (rrule === 'FREQ=YEARLY') return 'yearly';
  return 'custom'; // complex rule — open advanced panel
}

export function parseAdvanced(rrule: string | null | undefined): AdvancedRRuleConfig {
  const defaults: AdvancedRRuleConfig = {
    freq: 'WEEKLY', interval: 1, days: new Set([1]), endType: 'never', count: 10,
  };
  if (!rrule) return defaults;
  const parts: Record<string, string> = {};
  rrule.replace(/^RRULE:/, '').split(';').forEach(p => {
    const [k, v] = p.split('=');
    parts[k] = v;
  });
  const DAY_MAP: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  return {
    freq: (parts.FREQ as AdvancedFreq) ?? 'WEEKLY',
    interval: parts.INTERVAL ? parseInt(parts.INTERVAL, 10) : 1,
    days: parts.BYDAY
      ? new Set(parts.BYDAY.split(',').map(d => DAY_MAP[d] ?? 1))
      : new Set([1]),
    endType: parts.COUNT ? 'count' : 'never',
    count: parts.COUNT ? parseInt(parts.COUNT, 10) : 10,
  };
}

export function describeAdvanced(cfg: AdvancedRRuleConfig): string {
  const FREQ_LABEL: Record<AdvancedFreq, [string, string]> = {
    DAILY: ['day', 'days'], WEEKLY: ['week', 'weeks'],
    MONTHLY: ['month', 'months'], YEARLY: ['year', 'years'],
  };
  const DAY_NAME = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const [sing, plur] = FREQ_LABEL[cfg.freq];
  let s = cfg.interval === 1 ? `Every ${sing}` : `Every ${cfg.interval} ${plur}`;
  if (cfg.freq === 'WEEKLY' && cfg.days.size > 0) {
    s += ` on ${[...cfg.days].sort().map(d => DAY_NAME[d]).join(', ')}`;
  }
  if (cfg.endType === 'count') s += `, ${cfg.count} time${cfg.count !== 1 ? 's' : ''}`;
  return s;
}
