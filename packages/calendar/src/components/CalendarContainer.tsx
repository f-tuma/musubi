import dayjs from 'dayjs'
import React, { useLayoutEffect, useRef } from 'react'
import type { AccessibilityProps, TextStyle, ViewStyle } from 'react-native'
import InfinitePager, { type InfinitePagerImperativeApi } from 'react-native-infinite-pager'
import { ScrollView } from 'react-native-gesture-handler'

import { ALL_DAY_EVENT_HEIGHT, MIN_HEIGHT } from '../commonStyles'
import type {
  AllDayEventCellStyle,
  CalendarCellStyle,
  CalendarCellTextStyle,
  DateRangeHandler,
  EventCellStyle,
  EventRenderer,
  HeaderRenderer,
  HorizontalDirection,
  HourRenderer,
  ICalendarEventBase,
  Mode,
  MonthHeaderRenderer,
  WeekNum,
} from '../interfaces'
import { useTheme } from '../theme/ThemeContext'
import {
  getDatesInMonth,
  getDatesInNextCustomDays,
  getDatesInNextOneDay,
  getDatesInNextThreeDays,
  getDatesInWeek,
  isAllDayEvent,
  maxAllDayRows,
  modeToNum,
} from '../utils/datetime'
import { typedMemo } from '../utils/react'
import { CalendarBody } from './CalendarBody'
import { CalendarBodyForMonthView } from './CalendarBodyForMonthView'
import { CalendarHeader } from './CalendarHeader'
import { CalendarHeaderForMonthView } from './CalendarHeaderForMonthView'
import { Schedule } from './Schedule'

export interface CalendarContainerProps<T extends ICalendarEventBase> {
  hideHours?: boolean
  events: T[]
  /** Cheap render-time visibility filter (e.g. by calendar). Applied per-cell so
   *  toggling it does NOT rebuild the day grid. */
  eventFilter?: (event: T) => boolean
  height: number
  hourRowHeight?: number
  overlapOffset?: number
  eventCellStyle?: EventCellStyle<T>
  eventCellTextColor?: string
  eventCellAccessibilityProps?: AccessibilityProps
  allDayEventCellStyle?: AllDayEventCellStyle<T>
  allDayEventCellTextColor?: string
  allDayEventCellAccessibilityProps?: AccessibilityProps
  calendarCellStyle?: CalendarCellStyle
  calendarCellTextStyle?: CalendarCellTextStyle
  calendarCellAccessibilityProps?: AccessibilityProps
  calendarCellAccessibilityPropsForMonthView?: AccessibilityProps
  calendarContainerStyle?: ViewStyle
  headerContainerStyle?: ViewStyle
  headerContainerAccessibilityProps?: AccessibilityProps
  headerContentStyle?: ViewStyle
  headerCellAccessibilityProps?: AccessibilityProps
  dayHeaderStyle?: ViewStyle
  dayHeaderHighlightColor?: string
  weekDayHeaderHighlightColor?: string
  bodyContainerStyle?: ViewStyle
  renderEvent?: EventRenderer<T>
  renderHeader?: HeaderRenderer<T>
  renderHeaderForMonthView?: MonthHeaderRenderer
  renderCustomDateForMonth?: (date: Date) => React.ReactElement | null
  ampm?: boolean
  date?: Date
  locale?: string
  hideNowIndicator?: boolean
  showAdjacentMonths?: boolean
  mode?: Mode
  scrollOffsetMinutes?: number
  showTime?: boolean
  minHour?: number
  maxHour?: number
  swipeEnabled?: boolean
  weekStartsOn?: WeekNum
  onChangeDate?: DateRangeHandler
  onLongPressCell?: (date: Date) => void
  onPressCell?: (date: Date) => void
  resetPageOnPressCell?: boolean
  onPressDateHeader?: (date: Date) => void
  onPressEvent?: (event: T) => void
  weekEndsOn?: WeekNum
  maxVisibleEventCount?: number
  eventMinHeightForMonthView?: number
  activeDate?: Date
  headerComponent?: React.ReactElement | null
  headerComponentStyle?: ViewStyle
  hourStyle?: TextStyle
  showAllDayEventCell?: boolean
  sortedMonthView?: boolean
  moreLabel?: string
  isEventOrderingEnabled?: boolean
  showWeekNumber?: boolean
  showSixWeeks?: boolean
  weekNumberPrefix?: string
  onPressMoreLabel?: (event: T[]) => void
  disableMonthEventCellPress?: boolean
  showVerticalScrollIndicator?: boolean
  verticalScrollEnabled?: boolean
  itemSeparatorComponent?: React.ComponentType<{ highlighted: boolean }> | null | undefined
  onSwipeEnd?: (date: Date) => void
  enrichedEventsByDate?: Record<string, T[]>
  enableEnrichedEvents?: boolean
  eventsAreSorted?: boolean
  timeslots?: number
  hourComponent?: HourRenderer
  scheduleMonthSeparatorStyle?: TextStyle
  /** RefreshControl element for the scrollable timeline (week/day view). */
  refreshControl?: React.ReactElement
}

// Stable empty default so a memoized event cell's accessibility prop doesn't get
// a fresh {} each render (which would defeat its React.memo on every toggle).
const EMPTY_ACCESSIBILITY_PROPS: AccessibilityProps = {}

function _CalendarContainer<T extends ICalendarEventBase>({
  events,
  eventFilter,
  height,
  hourRowHeight,
  ampm = false,
  date,
  allDayEventCellStyle = {},
  allDayEventCellTextColor = '',
  allDayEventCellAccessibilityProps = {},
  eventCellStyle,
  eventCellTextColor = '',
  eventCellAccessibilityProps = EMPTY_ACCESSIBILITY_PROPS,
  calendarCellAccessibilityPropsForMonthView = {},
  calendarCellStyle,
  calendarCellTextStyle,
  calendarCellAccessibilityProps = {},
  locale = 'en',
  hideNowIndicator = false,
  mode = 'week',
  overlapOffset,
  scrollOffsetMinutes = 0,
  showTime = true,
  headerContainerStyle = {},
  headerContainerAccessibilityProps = {},
  headerContentStyle = {},
  headerCellAccessibilityProps = {},
  dayHeaderStyle = {},
  dayHeaderHighlightColor = '',
  weekDayHeaderHighlightColor = '',
  bodyContainerStyle = {},
  swipeEnabled = true,
  weekStartsOn = 0,
  onChangeDate,
  onLongPressCell,
  onPressCell,
  resetPageOnPressCell = false,
  onPressDateHeader,
  onPressEvent,
  renderEvent,
  renderHeader: HeaderComponent = CalendarHeader,
  renderHeaderForMonthView: HeaderComponentForMonthView = CalendarHeaderForMonthView,
  weekEndsOn = 6,
  maxVisibleEventCount = 3,
  eventMinHeightForMonthView = 22,
  activeDate,
  headerComponent = null,
  headerComponentStyle = {},
  hourStyle = {},
  showAllDayEventCell = true,
  moreLabel = '{moreCount} More',
  showAdjacentMonths = true,
  sortedMonthView = true,
  hideHours = false,
  minHour = 0,
  maxHour = 23,
  isEventOrderingEnabled,
  showWeekNumber = false,
  showSixWeeks = false,
  weekNumberPrefix = '',
  onPressMoreLabel,
  renderCustomDateForMonth,
  disableMonthEventCellPress = false,
  showVerticalScrollIndicator = false,
  verticalScrollEnabled = true,
  itemSeparatorComponent = null,
  enrichedEventsByDate,
  enableEnrichedEvents = false,
  eventsAreSorted = false,
  onSwipeEnd,
  timeslots = 0,
  hourComponent,
  scheduleMonthSeparatorStyle = {},
  refreshControl,
}: CalendarContainerProps<T>) {
  const dateString = date?.toString()
  const calendarRef = useRef<InfinitePagerImperativeApi>(null)
  const [targetDate, setTargetDate] = React.useState(() => dayjs(date))

  React.useEffect(() => {
    if (dateString) setTargetDate(dayjs(dateString))
  }, [dateString])

  // biome-ignore lint/correctness/useExhaustiveDependencies: mode is a prop and we need to reset when it changes
  useLayoutEffect(() => {
    if (calendarRef.current) calendarRef.current.setPage(0, { animated: false })
  }, [mode])

  // biome-ignore lint/correctness/useExhaustiveDependencies: targetDate changes should reset the page
  React.useEffect(() => {
    calendarRef.current?.setPage(0, { animated: false })
  }, [targetDate])

  // Prefer the event's explicit isAllDay flag (timezone-agnostic); fall back to
  // the midnight heuristic only for events that don't carry one.
  const allDayEvents = React.useMemo(
    () => events.filter((event) => event.isAllDay ?? isAllDayEvent(event.start, event.end)),
    [events],
  )
  const daytimeEvents = React.useMemo(
    () => events.filter((event) => !(event.isAllDay ?? isAllDayEvent(event.start, event.end))),
    [events],
  )
  const allEvents = React.useMemo(
    () => [...daytimeEvents, ...allDayEvents],
    [daytimeEvents, allDayEvents],
  )

  const getDateRange = React.useCallback(
    (date: string | dayjs.Dayjs) => {
      switch (mode) {
        case 'month': return getDatesInMonth(date, locale)
        case 'week': return getDatesInWeek(date, weekStartsOn, locale)
        case '3days': return getDatesInNextThreeDays(date, locale)
        case 'day': return getDatesInNextOneDay(date, locale)
        case 'custom': return getDatesInNextCustomDays(date, weekStartsOn, weekEndsOn, locale)
        case 'schedule': return getDatesInMonth(date, locale)
        default:
          throw new Error(`[musubi/calendar] Unknown mode: "${mode}"`)
      }
    },
    [mode, locale, weekEndsOn, weekStartsOn],
  )

  if (minHour < 0) throw new Error('minHour should be 0 or greater')
  if (maxHour > 23) throw new Error('maxHour should be less than 24')
  if (minHour >= maxHour) throw new Error('minHour should be less than maxHour')

  const cellHeight = React.useMemo(
    () => hourRowHeight || Math.max(height - 30, MIN_HEIGHT) / 24,
    [height, hourRowHeight],
  )

  const theme = useTheme()

  const onSwipeHorizontal = React.useCallback(
    (direction: HorizontalDirection) => {
      if (!swipeEnabled) return
      let nextTargetDate: dayjs.Dayjs
      if ((direction === 'LEFT' && !theme.isRTL) || (direction === 'RIGHT' && theme.isRTL)) {
        nextTargetDate = targetDate.add(modeToNum(mode, targetDate), 'day')
      } else {
        if (mode === 'month') nextTargetDate = targetDate.add(targetDate.date() * -1, 'day')
        else nextTargetDate = targetDate.add(modeToNum(mode, targetDate) * -1, 'day')
      }
      setTargetDate(nextTargetDate)
      onSwipeEnd?.(nextTargetDate.toDate())
    },
    [swipeEnabled, theme.isRTL, onSwipeEnd, targetDate, mode],
  )

  React.useEffect(() => {
    if (dateString && onChangeDate) {
      const timeoutId = setTimeout(() => {
        const dateRange = getDateRange(dateString)
        onChangeDate([dateRange[0].toDate(), dateRange[dateRange.length - 1].toDate()])
      }, 50)
      return () => clearTimeout(timeoutId)
    }
    return undefined
  }, [dateString, onChangeDate, getDateRange])

  const getCurrentDate = React.useCallback(
    (page: number) => targetDate.add(modeToNum(mode, targetDate, page), 'day'),
    [mode, targetDate],
  )

  const handlePageChange = React.useCallback(
    (page: number) => { onSwipeEnd?.(getCurrentDate(page).toDate()) },
    [onSwipeEnd, getCurrentDate],
  )

  const handlePressCell = React.useCallback(
    (date: Date) => {
      onPressCell?.(date)
      // Don't reset the pager in day mode (matches the old timeline handler).
      // month mode is never 'day', so the month view's reset is unaffected.
      if (mode !== 'day' && resetPageOnPressCell) calendarRef.current?.setPage(0, { animated: true })
    },
    [onPressCell, resetPageOnPressCell, mode],
  )

  const commonProps = { cellHeight, dateRange: getDateRange(targetDate), mode, onPressEvent, hideHours, showWeekNumber }

  if (mode === 'month') {
    const headerProps = {
      style: headerContainerStyle,
      headerContainerAccessibilityProps,
      locale,
      weekStartsOn,
      headerContentStyle,
      headerCellAccessibilityProps,
      dayHeaderStyle,
      dayHeaderHighlightColor,
      weekDayHeaderHighlightColor,
      showAllDayEventCell,
      showWeekNumber,
      weekNumberPrefix,
    }
    return (
      <InfinitePager
        ref={calendarRef}
        style={{ flex: 1 }}
        pageWrapperStyle={{ flex: 1 }}
        renderPage={({ index }) => {
          const monthBody = (
            <CalendarBodyForMonthView<T>
              {...commonProps}
              style={bodyContainerStyle}
              containerHeight={height}
              events={allEvents}
              eventCellStyle={eventCellStyle}
              eventCellAccessibilityProps={eventCellAccessibilityProps}
              calendarCellStyle={calendarCellStyle}
              calendarCellAccessibilityProps={calendarCellAccessibilityProps}
              calendarCellAccessibilityPropsForMonthView={calendarCellAccessibilityPropsForMonthView}
              calendarCellTextStyle={calendarCellTextStyle}
              weekStartsOn={weekStartsOn}
              hideNowIndicator={hideNowIndicator}
              showAdjacentMonths={showAdjacentMonths}
              onLongPressCell={onLongPressCell}
              onPressCell={handlePressCell}
              onPressDateHeader={onPressDateHeader}
              onPressEvent={onPressEvent}
              renderEvent={renderEvent}
              targetDate={getCurrentDate(index)}
              eventFilter={eventFilter}
              maxVisibleEventCount={maxVisibleEventCount}
              eventMinHeightForMonthView={eventMinHeightForMonthView}
              sortedMonthView={sortedMonthView}
              moreLabel={moreLabel}
              onPressMoreLabel={onPressMoreLabel}
              renderCustomDateForMonth={renderCustomDateForMonth}
              disableMonthEventCellPress={disableMonthEventCellPress}
              showSixWeeks={showSixWeeks}
            />
          )
          return (
            <React.Fragment>
              <HeaderComponentForMonthView {...headerProps} dateRange={getDateRange(getCurrentDate(index))} />
              {refreshControl ? (
                // The month grid can't host a RefreshControl itself, so wrap it in
                // a ScrollView. The grid keeps its explicit containerHeight, so it
                // renders as before; alwaysBounceVertical lets the pull register on
                // iOS even though the grid doesn't really scroll.
                <ScrollView
                  style={{ flex: 1 }}
                  contentContainerStyle={{ flexGrow: 1 }}
                  refreshControl={refreshControl}
                  alwaysBounceVertical
                  showsVerticalScrollIndicator={false}
                >
                  {monthBody}
                </ScrollView>
              ) : (
                monthBody
              )}
            </React.Fragment>
          )
        }}
        onPageChange={handlePageChange}
        pageBuffer={1}
      />
    )
  }

  const headerProps = {
    ...commonProps,
    eventFilter,
    style: headerContainerStyle,
    headerContainerAccessibilityProps,
    locale,
    allDayEventCellStyle,
    allDayEventCellTextColor,
    allDayEvents,
    allDayEventCellAccessibilityProps,
    onPressDateHeader,
    activeDate,
    headerContentStyle,
    headerCellAccessibilityProps,
    dayHeaderStyle,
    dayHeaderHighlightColor,
    weekDayHeaderHighlightColor,
    showAllDayEventCell,
    weekNumberPrefix,
  }

  if (mode === 'schedule') {
    return (
      <Schedule
        events={[...daytimeEvents, ...allDayEvents]}
        {...headerProps}
        style={bodyContainerStyle}
        containerHeight={height}
        eventCellStyle={eventCellStyle}
        calendarCellStyle={calendarCellStyle}
        calendarCellAccessibilityProps={calendarCellAccessibilityProps}
        hideNowIndicator={hideNowIndicator}
        overlapOffset={overlapOffset}
        scrollOffsetMinutes={scrollOffsetMinutes}
        ampm={ampm}
        showTime={showTime}
        onLongPressCell={onLongPressCell}
        onPressCell={onPressCell}
        onPressEvent={onPressEvent}
        onSwipeHorizontal={onSwipeHorizontal}
        renderEvent={renderEvent}
        headerComponent={headerComponent}
        headerComponentStyle={headerComponentStyle}
        hourStyle={hourStyle}
        isEventOrderingEnabled={isEventOrderingEnabled}
        showVerticalScrollIndicator={showVerticalScrollIndicator}
        itemSeparatorComponent={itemSeparatorComponent}
        scheduleMonthSeparatorStyle={scheduleMonthSeparatorStyle}
      />
    )
  }

  return (
    <InfinitePager
      ref={calendarRef}
      renderPage={({ index }) => {
        const dr = getDateRange(getCurrentDate(index))
        // All-day bar grows with the busiest visible day; the timeline subtracts
        // the same height below so nothing gets pushed off the bottom.
        const allDayRows = showAllDayEventCell ? maxAllDayRows(dr, allDayEvents, eventFilter) : 0
        const allDayHeight = allDayRows > 0 ? allDayRows * (ALL_DAY_EVENT_HEIGHT + 2) + 4 : 0
        return (
        <React.Fragment>
          <HeaderComponent {...headerProps} dateRange={dr} allDayEventCellHeight={allDayHeight} />
          <CalendarBody
            {...commonProps}
            dateRange={dr}
            allDayEventCellHeight={allDayHeight}
            style={bodyContainerStyle}
            containerHeight={height}
            events={daytimeEvents}
            eventCellStyle={eventCellStyle}
            eventCellAccessibilityProps={eventCellAccessibilityProps}
            eventCellTextColor={eventCellTextColor}
            calendarCellStyle={calendarCellStyle}
            calendarCellAccessibilityProps={calendarCellAccessibilityProps}
            hideNowIndicator={hideNowIndicator}
            overlapOffset={overlapOffset}
            scrollOffsetMinutes={scrollOffsetMinutes}
            ampm={ampm}
            minHour={minHour}
            maxHour={maxHour}
            showTime={showTime}
            onLongPressCell={onLongPressCell}
            onPressCell={handlePressCell}
            onPressEvent={onPressEvent}
            renderEvent={renderEvent}
            headerComponent={headerComponent}
            headerComponentStyle={headerComponentStyle}
            hourStyle={hourStyle}
            isEventOrderingEnabled={isEventOrderingEnabled}
            showVerticalScrollIndicator={showVerticalScrollIndicator}
            scrollEnabled={verticalScrollEnabled}
            refreshControl={refreshControl}
            eventFilter={eventFilter}
            enrichedEventsByDate={enrichedEventsByDate}
            enableEnrichedEvents={enableEnrichedEvents}
            eventsAreSorted={eventsAreSorted}
            timeslots={timeslots}
            hourComponent={hourComponent}
          />
        </React.Fragment>
        )
      }}
      onPageChange={handlePageChange}
      pageBuffer={2}
    />
  )
}

export const CalendarContainer = typedMemo(_CalendarContainer)
