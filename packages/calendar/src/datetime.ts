import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'

dayjs.extend(utc)

export const SIMPLE_DATE_FORMAT = 'YYYY-MM-DD'

/**
 * Day-anchored dayjs for an event boundary. All-day events are stored as UTC
 * midnight of a timezone-invariant DATE (à la Google `date`); reinterpret that
 * UTC calendar date in the LOCAL frame so all the (local) day math elsewhere
 * lands on the same calendar day regardless of device timezone. Timed events
 * pass through as local (unchanged).
 */
export function eventDay(date: Date, isAllDay?: boolean): dayjs.Dayjs {
  return isAllDay ? dayjs(dayjs.utc(date).format(SIMPLE_DATE_FORMAT)) : dayjs(date)
}
