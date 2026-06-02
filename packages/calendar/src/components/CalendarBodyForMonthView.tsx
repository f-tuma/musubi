import calendarize from 'calendarize'
import dayjs from 'dayjs'
import * as React from 'react'
import {
  type AccessibilityProps,
  Animated,
  Platform,
  Text,
  TouchableHighlight,
  TouchableOpacity,
  View,
  type ViewStyle,
} from 'react-native'

import { u } from '../commonStyles'
import { useNow } from '../hooks/useNow'
import type {
  CalendarCellStyle,
  CalendarCellTextStyle,
  EventCellStyle,
  EventRenderer,
  HorizontalDirection,
  ICalendarEventBase,
  WeekNum,
} from '../interfaces'
import { useTheme } from '../theme/ThemeContext'
import { SIMPLE_DATE_FORMAT, getWeeksWithAdjacentMonths } from '../utils/datetime'
import { typedMemo } from '../utils/react'
import { CalendarEventForMonthView } from './CalendarEventForMonthView'

interface CalendarBodyForMonthViewProps<T extends ICalendarEventBase> {
  containerHeight: number
  targetDate: dayjs.Dayjs
  events: T[]
  style: ViewStyle
  eventCellStyle?: EventCellStyle<T>
  eventCellAccessibilityProps?: AccessibilityProps
  calendarCellStyle?: CalendarCellStyle
  calendarCellAccessibilityPropsForMonthView?: AccessibilityProps
  calendarCellAccessibilityProps?: AccessibilityProps
  calendarCellTextStyle?: CalendarCellTextStyle
  hideNowIndicator?: boolean
  showAdjacentMonths: boolean
  onLongPressCell?: (date: Date) => void
  onPressCell?: (date: Date) => void
  onPressDateHeader?: (date: Date) => void
  onPressEvent?: (event: T) => void
  onSwipeHorizontal?: (d: HorizontalDirection) => void
  renderEvent?: EventRenderer<T>
  maxVisibleEventCount: number
  weekStartsOn: WeekNum
  eventMinHeightForMonthView: number
  moreLabel: string
  onPressMoreLabel?: (events: T[], date: Date) => void
  sortedMonthView: boolean
  showWeekNumber?: boolean
  renderCustomDateForMonth?: (date: Date) => React.ReactElement | null
  disableMonthEventCellPress?: boolean
  showSixWeeks?: boolean
}

function _CalendarBodyForMonthView<T extends ICalendarEventBase>({
  containerHeight,
  targetDate,
  style,
  onLongPressCell,
  onPressCell,
  onPressDateHeader,
  events,
  onPressEvent,
  eventCellStyle,
  eventCellAccessibilityProps = {},
  calendarCellStyle,
  calendarCellAccessibilityPropsForMonthView = {},
  calendarCellAccessibilityProps = {},
  calendarCellTextStyle,
  hideNowIndicator,
  showAdjacentMonths,
  renderEvent,
  maxVisibleEventCount,
  weekStartsOn,
  eventMinHeightForMonthView,
  moreLabel,
  onPressMoreLabel,
  sortedMonthView,
  showWeekNumber = false,
  renderCustomDateForMonth,
  disableMonthEventCellPress,
  showSixWeeks = false,
}: CalendarBodyForMonthViewProps<T>) {
  const { now } = useNow(!hideNowIndicator)
  const [calendarWidth, setCalendarWidth] = React.useState<number>(0)
  const [calendarCellHeight, setCalendarCellHeight] = React.useState<number>(0)

  const weeks = showAdjacentMonths
    ? getWeeksWithAdjacentMonths(targetDate, weekStartsOn, showSixWeeks)
    : calendarize(targetDate.toDate(), weekStartsOn)

  const minCellHeight = showSixWeeks ? containerHeight / 6 - 30 : containerHeight / 5 - 30
  const theme = useTheme()

  const getCalendarCellStyle = React.useMemo(
    () => (typeof calendarCellStyle === 'function' ? calendarCellStyle : () => calendarCellStyle),
    [calendarCellStyle],
  )

  const getCalendarCellTextStyle = React.useMemo(
    () => typeof calendarCellTextStyle === 'function' ? calendarCellTextStyle : () => calendarCellTextStyle,
    [calendarCellTextStyle],
  )

  const handleDateHeaderPress = React.useCallback(
    (date: dayjs.Dayjs | null) => {
      if (!date) return
      const dateObj = date.toDate()
      if (onPressDateHeader) onPressDateHeader(dateObj)
      else if (onPressCell) onPressCell(dateObj)
    },
    [onPressDateHeader, onPressCell],
  )

  const handleCellPress = React.useCallback(
    (date: dayjs.Dayjs | null) => {
      if (!date) return
      onPressCell?.(date.toDate())
    },
    [onPressCell],
  )

  const handleDateHeaderLongPress = React.useCallback(
    (date: dayjs.Dayjs | null) => {
      if (!date) return
      const dateObj = date.toDate()
      if (onPressDateHeader) onPressDateHeader(dateObj)
      else if (onLongPressCell) onLongPressCell(dateObj)
    },
    [onPressDateHeader, onLongPressCell],
  )

  const handleCellLongPress = React.useCallback(
    (date: dayjs.Dayjs | null) => {
      if (!date || !onLongPressCell) return
      onLongPressCell(date.toDate())
    },
    [onLongPressCell],
  )

  const eventsByDate = React.useMemo(() => {
    const eventDict: { [date: string]: T[] } = {}

    if (!sortedMonthView) {
      const gridStart = dayjs(targetDate).startOf('month').startOf('week')
      const gridEnd = dayjs(targetDate).endOf('month').endOf('week')
      let d = gridStart.clone()
      while (d.isBefore(gridEnd, 'day')) {
        const key = d.format(SIMPLE_DATE_FORMAT)
        eventDict[key] = events.filter(({ start, end }) =>
          d.isBetween(dayjs(start).startOf('day'), dayjs(end).endOf('day'), null, '[)'),
        )
        d = d.add(1, 'day')
      }
      return eventDict
    }

    let dateToCompare = dayjs(targetDate).startOf('month').startOf('week').startOf('day')
    let startDateOfWeek = dateToCompare.startOf('week')
    let lastDateOfWeek = dateToCompare.endOf('week')
    const multipleDayEventsOrder: Map<T, number> = new Map()
    // dayjs endOf('week') returns Saturday regardless of weekStartsOn. For
    // Monday-start calendars the last grid cell is Sunday, so +2 days ensures
    // that cell is always included in the eventsByDate map.
    const lastDateOfMonth = dayjs(targetDate).endOf('month').endOf('week').endOf('day').add(2, 'day')

    while (dateToCompare.isBefore(lastDateOfMonth, 'day')) {
      if (dateToCompare.isAfter(lastDateOfWeek)) {
        multipleDayEventsOrder.clear()
        startDateOfWeek = dayjs(dateToCompare).startOf('week')
        lastDateOfWeek = dayjs(dateToCompare).endOf('week')
      }

      const todayStartsEvents = events
        .filter(
          (event) =>
            dateToCompare.isSame(dayjs(event.start).startOf('day'), 'day') ||
            (dateToCompare.isSame(startDateOfWeek, 'day') &&
              dateToCompare.isBetween(dayjs(event.start).startOf('day'), dayjs(event.end).startOf('day'), 'day', '[]')),
        )
        .sort((a, b) => a.start.getTime() - b.start.getTime())

      const todayStartsEventsSet = new Set(todayStartsEvents)
      const finalEvents = [...todayStartsEvents]

      const todayIncludedEvents = events
        .filter(
          (event) =>
            dateToCompare.isBetween(dayjs(event.start).startOf('day'), dayjs(event.end).startOf('day'), 'day', '[]') &&
            !todayStartsEventsSet.has(event),
        )
        .sort((a, b) => (multipleDayEventsOrder.get(a) ?? 0) - (multipleDayEventsOrder.get(b) ?? 0))

      for (const event of todayIncludedEvents) {
        if (!multipleDayEventsOrder.has(event)) continue
        const order = multipleDayEventsOrder.get(event)
        if (order === undefined) continue
        finalEvents.splice(order, 0, event)
      }

      eventDict[dateToCompare.format(SIMPLE_DATE_FORMAT)] = finalEvents

      for (let i = 0; i < finalEvents.length; i++) {
        const event = finalEvents[i]
        if (!dayjs(event.start).isSame(dayjs(event.end), 'day')) {
          multipleDayEventsOrder.set(event, i)
        }
      }

      dateToCompare = dateToCompare.add(1, 'day')
    }
    return eventDict
  }, [events, sortedMonthView, targetDate])

  const renderDateCell = (date: dayjs.Dayjs | null, index: number) => {
    if (date && renderCustomDateForMonth) return renderCustomDateForMonth(date.toDate())
    return (
      <Text
        style={[
          { textAlign: 'center' },
          theme.typography.sm,
          {
            color:
              date?.format(SIMPLE_DATE_FORMAT) === now.format(SIMPLE_DATE_FORMAT)
                ? theme.palette.primary.main
                : date?.month() !== targetDate.month()
                  ? theme.palette.gray['500']
                  : theme.palette.gray['800'],
          },
          { ...getCalendarCellTextStyle(date?.toDate(), index) },
        ]}
      >
        {date?.format('D')}
      </Text>
    )
  }

  return (
    <View
      style={[
        { height: containerHeight },
        u['flex-column'],
        u['flex-1'],
        u['border-b'],
        u['border-l'],
        u['border-r'],
        u.rounded,
        { borderColor: theme.palette.gray['200'] },
        style,
      ]}
      onLayout={({ nativeEvent: { layout } }) => setCalendarWidth(layout.width)}
    >
      {weeks.map((week, i) => (
        <View
          key={`${i}-${week.join('-')}`}
          style={[
            u['flex-1'],
            theme.isRTL ? u['flex-row-reverse'] : u['flex-row'],
            Platform.OS === 'android' && style,
            { minHeight: minCellHeight },
          ]}
        >
          {showWeekNumber ? (
            <View
              style={[
                i > 0 && u['border-t'],
                { borderColor: theme.palette.gray['200'] },
                u['p-2'],
                u['w-20'],
                u['flex-column'],
                { minHeight: minCellHeight },
              ]}
              key={'weekNumber'}
              {...calendarCellAccessibilityProps}
            >
              <Text style={[{ textAlign: 'center' }, theme.typography.sm, { color: theme.palette.gray['800'] }]}>
                {week.length > 0 ? targetDate.date(week[0]).startOf('week').add(4, 'days').isoWeek() : ''}
              </Text>
            </View>
          ) : null}
          {week
            .map((d) => showAdjacentMonths ? targetDate.date(d) : d > 0 ? targetDate.date(d) : null)
            .map((date, ii) => (
              <TouchableOpacity
                onLongPress={() => handleCellLongPress(date)}
                onPress={() => handleCellPress(date)}
                style={[
                  i > 0 && u['border-t'],
                  theme.isRTL && (ii > 0 || showWeekNumber) && u['border-r'],
                  !theme.isRTL && (ii > 0 || showWeekNumber) && u['border-l'],
                  { borderColor: theme.palette.gray['200'] },
                  u['p-2'],
                  u['flex-1'],
                  u['flex-column'],
                  { minHeight: minCellHeight },
                  { ...getCalendarCellStyle(date?.toDate(), i) },
                ]}
                key={`${ii}-${date?.toDate()}`}
                onLayout={({ nativeEvent: { layout } }) =>
                  i === 0 && ii === 0 && disableMonthEventCellPress && setCalendarCellHeight(layout.height)
                }
                {...calendarCellAccessibilityPropsForMonthView}
              >
                <TouchableOpacity
                  onPress={() => handleDateHeaderPress(date)}
                  onLongPress={() => handleDateHeaderLongPress(date)}
                  {...calendarCellAccessibilityProps}
                >
                  {renderDateCell(date, i)}
                </TouchableOpacity>
                {calendarWidth > 0 &&
                  (!disableMonthEventCellPress || calendarCellHeight > 0) &&
                  date &&
                  (eventsByDate[date.format('YYYY-MM-DD')] ?? []).reduce(
                    (elements, event, index, events) => [
                      // biome-ignore lint/performance/noAccumulatingSpread: Acceptable
                      ...elements,
                      index > maxVisibleEventCount ? null : index === maxVisibleEventCount ? (
                        <Text
                          key={`${index}-${event.start}-${event.title}-${event.end}`}
                          style={[theme.typography.moreLabel, { marginTop: 2, color: theme.palette.moreLabel }]}
                          onPress={() => onPressMoreLabel?.(events, date.toDate())}
                        >
                          {moreLabel.replace('{moreCount}', `${events.length - maxVisibleEventCount}`)}
                        </Text>
                      ) : (
                        <CalendarEventForMonthView
                          key={`${index}-${event.start}-${event.title}-${event.end}`}
                          event={event}
                          eventCellStyle={eventCellStyle}
                          eventCellAccessibilityProps={eventCellAccessibilityProps}
                          onPressEvent={onPressEvent}
                          renderEvent={renderEvent}
                          date={date}
                          dayOfTheWeek={ii}
                          calendarWidth={calendarWidth}
                          isRTL={theme.isRTL}
                          eventMinHeightForMonthView={eventMinHeightForMonthView}
                          showAdjacentMonths={showAdjacentMonths}
                        />
                      ),
                    ],
                    [] as (null | JSX.Element)[],
                  )}
                {disableMonthEventCellPress && calendarCellHeight > 0 && (
                  <TouchableGradually
                    style={{
                      height: calendarCellHeight,
                      width: Math.floor(calendarWidth / 7),
                      position: 'absolute',
                      top: 0,
                      left: 0,
                    }}
                    onLongPress={() => date && onLongPressCell && onLongPressCell(date.toDate())}
                    onPress={() => date && onPressCell && onPressCell(date.toDate())}
                    {...calendarCellAccessibilityProps}
                  />
                )}
              </TouchableOpacity>
            ))}
        </View>
      ))}
    </View>
  )
}

export const CalendarBodyForMonthView = typedMemo(_CalendarBodyForMonthView)

function TouchableGradually({
  onLongPress,
  onPress,
  style,
}: {
  style?: ViewStyle
  onLongPress: () => void
  onPress: () => void
}) {
  const backgroundColor = React.useRef(new Animated.Value(0)).current

  const handlePressIn = () => {
    Animated.timing(backgroundColor, { toValue: 1, duration: 200, useNativeDriver: false }).start()
  }

  const handlePressOut = () => {
    Animated.timing(backgroundColor, { toValue: 0, duration: 200, useNativeDriver: false }).start()
  }

  return (
    <TouchableHighlight
      onLongPress={onLongPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onPress={onPress}
      underlayColor="transparent"
      style={style}
    >
      <Animated.View
        style={[
          {
            backgroundColor: backgroundColor.interpolate({
              inputRange: [0, 1],
              outputRange: ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0.2)'],
            }),
          },
          style,
        ]}
      />
    </TouchableHighlight>
  )
}
