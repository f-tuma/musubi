import type dayjs from 'dayjs'
import * as React from 'react'
import type { AccessibilityProps } from 'react-native'
import { Text, TouchableOpacity, View } from 'react-native'
import { u } from '../commonStyles'
import { useCalendarTouchableOpacityProps } from '../hooks/useCalendarTouchableOpacityProps'
import type { EventCellStyle, EventRenderer, ICalendarEventBase } from '../interfaces'
import { useTheme } from '../theme/ThemeContext'
import { getContrastColor } from '../utils/color'
import { eventDay, getEventSpanningInfo } from '../utils/datetime'
import { typedMemo } from '../utils/react'

interface CalendarEventProps<T extends ICalendarEventBase> {
  event: T
  onPressEvent?: (event: T) => void
  eventCellStyle?: EventCellStyle<T>
  eventCellAccessibilityProps?: AccessibilityProps
  renderEvent?: EventRenderer<T>
  date: dayjs.Dayjs
  dayOfTheWeek: number
  calendarWidth: number
  isRTL: boolean
  eventMinHeightForMonthView: number
  showAdjacentMonths: boolean
}

function _CalendarEventForMonthView<T extends ICalendarEventBase>({
  event,
  onPressEvent,
  eventCellStyle,
  eventCellAccessibilityProps = {},
  renderEvent,
  date,
  dayOfTheWeek,
  calendarWidth,
  isRTL,
  eventMinHeightForMonthView,
  showAdjacentMonths,
}: CalendarEventProps<T>) {
  const theme = useTheme()

  // Readable title color against the event's own background (falls back to the
  // month cell's default primary background when no per-event color is set).
  const eventBg = ((typeof eventCellStyle === 'function' ? eventCellStyle(event) : eventCellStyle) as { backgroundColor?: string } | undefined)?.backgroundColor
  const textColor = getContrastColor(eventBg ?? theme.palette.primary.main)

  const { eventWidth, isMultipleDays, isMultipleDaysStart, eventWeekDuration } = React.useMemo(
    () => getEventSpanningInfo(event, date, dayOfTheWeek, calendarWidth, showAdjacentMonths),
    // Key on the day string — `date` is a fresh dayjs object each parent render.
    [date.format('YYYY-MM-DD'), dayOfTheWeek, event, calendarWidth, showAdjacentMonths],
  )

  const touchableOpacityProps = useCalendarTouchableOpacityProps({
    event,
    eventCellStyle,
    eventCellAccessibilityProps,
    onPressEvent,
    injectedStyles: [
      { backgroundColor: theme.palette.primary.main },
      isMultipleDaysStart && eventWeekDuration > 1
        ? { position: 'absolute', width: eventWidth, zIndex: 10000 }
        : {},
      isRTL ? { right: 0 } : { left: 0 },
    ],
  })

  const handlePress = React.useCallback(() => {
    if (!event.disabled && onPressEvent) onPressEvent(event)
  }, [event, onPressEvent])

  return (
    <TouchableOpacity
      style={[{ minHeight: eventMinHeightForMonthView }, u['mt-2']]}
      onPress={handlePress}
    >
      {(!isMultipleDays && date.isSame(eventDay(event.start, event.isAllDay), 'day')) ||
      (isMultipleDays && isMultipleDaysStart) ? (
        renderEvent ? (
          renderEvent(event, touchableOpacityProps)
        ) : (
          <View {...(({ key: _k, ...rest }) => rest)(touchableOpacityProps)}>
            <Text
              style={[
                { color: textColor },
                theme.typography.xs,
                u.truncate,
                isRTL && { textAlign: 'right' },
              ]}
              numberOfLines={1}
            >
              {event.title}
            </Text>
          </View>
        )
      ) : null}
    </TouchableOpacity>
  )
}

export const CalendarEventForMonthView = typedMemo(_CalendarEventForMonthView)
