import dayjs from 'dayjs'
import duration from 'dayjs/plugin/duration'
import isBetween from 'dayjs/plugin/isBetween'
import isoWeek from 'dayjs/plugin/isoWeek'

dayjs.extend(duration)
dayjs.extend(isBetween)
dayjs.extend(isoWeek)

// Re-export everything from the calendar — components, types, utils, theme.
// Consumers import from '@musubi/calendar' and never touch react-native-big-calendar.
export * from './components/Calendar'
export * from './components/CalendarBody'
export * from './components/CalendarBodyForMonthView'
export * from './components/CalendarEvent'
export * from './components/CalendarEventForMonthView'
export * from './components/CalendarHeader'
export * from './components/CalendarHeaderForMonthView'
export * from './components/DefaultCalendarEventRenderer'

export * from './commonStyles'
export * from './interfaces'
export * from './theme/ThemeContext'
export * from './theme/ThemeInterface'
export * from './theme/defaultTheme'
export * from './utils/color'
export * from './utils/datetime'
export * from './utils/object'
export * from './utils/react'

// Recurrence expansion — call this before passing events to Calendar when you
// have events with an `recurrence` rrule string.
export { expandRecurringEvents } from './recurrence'
