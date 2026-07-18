package dev.frgtn.musubi.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.Spannable
import android.text.SpannableString
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StyleSpan
import android.view.View
import android.widget.RemoteViews
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone

class MusubiCalendarWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetIds: IntArray,
  ) {
    appWidgetIds.forEach { update(context, appWidgetManager, it) }
  }

  override fun onAppWidgetOptionsChanged(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetId: Int,
    newOptions: Bundle,
  ) {
    update(context, appWidgetManager, appWidgetId)
  }

  override fun onDeleted(context: Context, appWidgetIds: IntArray) {
    appWidgetIds.forEach { CalendarWidgetPreferences.remove(context, it) }
    super.onDeleted(context, appWidgetIds)
  }

  override fun onReceive(context: Context, intent: Intent) {
    super.onReceive(context, intent)
    if (intent.action in TIME_CHANGE_ACTIONS) updateAll(context)
  }

  companion object {
    private val TIME_CHANGE_ACTIONS = setOf(
      Intent.ACTION_DATE_CHANGED,
      Intent.ACTION_CONFIGURATION_CHANGED,
      Intent.ACTION_LOCALE_CHANGED,
      Intent.ACTION_TIMEZONE_CHANGED,
      Intent.ACTION_TIME_CHANGED,
    )

    private val compactDayIds = intArrayOf(
      R.id.musubi_calendar_day_1,
      R.id.musubi_calendar_day_2,
      R.id.musubi_calendar_day_3,
      R.id.musubi_calendar_day_4,
      R.id.musubi_calendar_day_5,
      R.id.musubi_calendar_day_6,
      R.id.musubi_calendar_day_7,
      R.id.musubi_calendar_day_8,
      R.id.musubi_calendar_day_9,
      R.id.musubi_calendar_day_10,
      R.id.musubi_calendar_day_11,
      R.id.musubi_calendar_day_12,
      R.id.musubi_calendar_day_13,
      R.id.musubi_calendar_day_14,
      R.id.musubi_calendar_day_15,
      R.id.musubi_calendar_day_16,
      R.id.musubi_calendar_day_17,
      R.id.musubi_calendar_day_18,
      R.id.musubi_calendar_day_19,
      R.id.musubi_calendar_day_20,
      R.id.musubi_calendar_day_21,
      R.id.musubi_calendar_day_22,
      R.id.musubi_calendar_day_23,
      R.id.musubi_calendar_day_24,
      R.id.musubi_calendar_day_25,
      R.id.musubi_calendar_day_26,
      R.id.musubi_calendar_day_27,
      R.id.musubi_calendar_day_28,
      R.id.musubi_calendar_day_29,
      R.id.musubi_calendar_day_30,
      R.id.musubi_calendar_day_31,
      R.id.musubi_calendar_day_32,
      R.id.musubi_calendar_day_33,
      R.id.musubi_calendar_day_34,
      R.id.musubi_calendar_day_35,
      R.id.musubi_calendar_day_36,
      R.id.musubi_calendar_day_37,
      R.id.musubi_calendar_day_38,
      R.id.musubi_calendar_day_39,
      R.id.musubi_calendar_day_40,
      R.id.musubi_calendar_day_41,
      R.id.musubi_calendar_day_42,
    )

    private val largeDayViews = listOf(
      LargeDayViews(
        R.id.musubi_calendar_large_day_1,
        R.id.musubi_calendar_large_number_1,
        R.id.musubi_calendar_large_pill_1_1,
        R.id.musubi_calendar_large_pill_2_1,
        R.id.musubi_calendar_large_overflow_1,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_2,
        R.id.musubi_calendar_large_number_2,
        R.id.musubi_calendar_large_pill_1_2,
        R.id.musubi_calendar_large_pill_2_2,
        R.id.musubi_calendar_large_overflow_2,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_3,
        R.id.musubi_calendar_large_number_3,
        R.id.musubi_calendar_large_pill_1_3,
        R.id.musubi_calendar_large_pill_2_3,
        R.id.musubi_calendar_large_overflow_3,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_4,
        R.id.musubi_calendar_large_number_4,
        R.id.musubi_calendar_large_pill_1_4,
        R.id.musubi_calendar_large_pill_2_4,
        R.id.musubi_calendar_large_overflow_4,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_5,
        R.id.musubi_calendar_large_number_5,
        R.id.musubi_calendar_large_pill_1_5,
        R.id.musubi_calendar_large_pill_2_5,
        R.id.musubi_calendar_large_overflow_5,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_6,
        R.id.musubi_calendar_large_number_6,
        R.id.musubi_calendar_large_pill_1_6,
        R.id.musubi_calendar_large_pill_2_6,
        R.id.musubi_calendar_large_overflow_6,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_7,
        R.id.musubi_calendar_large_number_7,
        R.id.musubi_calendar_large_pill_1_7,
        R.id.musubi_calendar_large_pill_2_7,
        R.id.musubi_calendar_large_overflow_7,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_8,
        R.id.musubi_calendar_large_number_8,
        R.id.musubi_calendar_large_pill_1_8,
        R.id.musubi_calendar_large_pill_2_8,
        R.id.musubi_calendar_large_overflow_8,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_9,
        R.id.musubi_calendar_large_number_9,
        R.id.musubi_calendar_large_pill_1_9,
        R.id.musubi_calendar_large_pill_2_9,
        R.id.musubi_calendar_large_overflow_9,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_10,
        R.id.musubi_calendar_large_number_10,
        R.id.musubi_calendar_large_pill_1_10,
        R.id.musubi_calendar_large_pill_2_10,
        R.id.musubi_calendar_large_overflow_10,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_11,
        R.id.musubi_calendar_large_number_11,
        R.id.musubi_calendar_large_pill_1_11,
        R.id.musubi_calendar_large_pill_2_11,
        R.id.musubi_calendar_large_overflow_11,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_12,
        R.id.musubi_calendar_large_number_12,
        R.id.musubi_calendar_large_pill_1_12,
        R.id.musubi_calendar_large_pill_2_12,
        R.id.musubi_calendar_large_overflow_12,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_13,
        R.id.musubi_calendar_large_number_13,
        R.id.musubi_calendar_large_pill_1_13,
        R.id.musubi_calendar_large_pill_2_13,
        R.id.musubi_calendar_large_overflow_13,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_14,
        R.id.musubi_calendar_large_number_14,
        R.id.musubi_calendar_large_pill_1_14,
        R.id.musubi_calendar_large_pill_2_14,
        R.id.musubi_calendar_large_overflow_14,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_15,
        R.id.musubi_calendar_large_number_15,
        R.id.musubi_calendar_large_pill_1_15,
        R.id.musubi_calendar_large_pill_2_15,
        R.id.musubi_calendar_large_overflow_15,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_16,
        R.id.musubi_calendar_large_number_16,
        R.id.musubi_calendar_large_pill_1_16,
        R.id.musubi_calendar_large_pill_2_16,
        R.id.musubi_calendar_large_overflow_16,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_17,
        R.id.musubi_calendar_large_number_17,
        R.id.musubi_calendar_large_pill_1_17,
        R.id.musubi_calendar_large_pill_2_17,
        R.id.musubi_calendar_large_overflow_17,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_18,
        R.id.musubi_calendar_large_number_18,
        R.id.musubi_calendar_large_pill_1_18,
        R.id.musubi_calendar_large_pill_2_18,
        R.id.musubi_calendar_large_overflow_18,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_19,
        R.id.musubi_calendar_large_number_19,
        R.id.musubi_calendar_large_pill_1_19,
        R.id.musubi_calendar_large_pill_2_19,
        R.id.musubi_calendar_large_overflow_19,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_20,
        R.id.musubi_calendar_large_number_20,
        R.id.musubi_calendar_large_pill_1_20,
        R.id.musubi_calendar_large_pill_2_20,
        R.id.musubi_calendar_large_overflow_20,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_21,
        R.id.musubi_calendar_large_number_21,
        R.id.musubi_calendar_large_pill_1_21,
        R.id.musubi_calendar_large_pill_2_21,
        R.id.musubi_calendar_large_overflow_21,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_22,
        R.id.musubi_calendar_large_number_22,
        R.id.musubi_calendar_large_pill_1_22,
        R.id.musubi_calendar_large_pill_2_22,
        R.id.musubi_calendar_large_overflow_22,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_23,
        R.id.musubi_calendar_large_number_23,
        R.id.musubi_calendar_large_pill_1_23,
        R.id.musubi_calendar_large_pill_2_23,
        R.id.musubi_calendar_large_overflow_23,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_24,
        R.id.musubi_calendar_large_number_24,
        R.id.musubi_calendar_large_pill_1_24,
        R.id.musubi_calendar_large_pill_2_24,
        R.id.musubi_calendar_large_overflow_24,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_25,
        R.id.musubi_calendar_large_number_25,
        R.id.musubi_calendar_large_pill_1_25,
        R.id.musubi_calendar_large_pill_2_25,
        R.id.musubi_calendar_large_overflow_25,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_26,
        R.id.musubi_calendar_large_number_26,
        R.id.musubi_calendar_large_pill_1_26,
        R.id.musubi_calendar_large_pill_2_26,
        R.id.musubi_calendar_large_overflow_26,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_27,
        R.id.musubi_calendar_large_number_27,
        R.id.musubi_calendar_large_pill_1_27,
        R.id.musubi_calendar_large_pill_2_27,
        R.id.musubi_calendar_large_overflow_27,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_28,
        R.id.musubi_calendar_large_number_28,
        R.id.musubi_calendar_large_pill_1_28,
        R.id.musubi_calendar_large_pill_2_28,
        R.id.musubi_calendar_large_overflow_28,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_29,
        R.id.musubi_calendar_large_number_29,
        R.id.musubi_calendar_large_pill_1_29,
        R.id.musubi_calendar_large_pill_2_29,
        R.id.musubi_calendar_large_overflow_29,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_30,
        R.id.musubi_calendar_large_number_30,
        R.id.musubi_calendar_large_pill_1_30,
        R.id.musubi_calendar_large_pill_2_30,
        R.id.musubi_calendar_large_overflow_30,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_31,
        R.id.musubi_calendar_large_number_31,
        R.id.musubi_calendar_large_pill_1_31,
        R.id.musubi_calendar_large_pill_2_31,
        R.id.musubi_calendar_large_overflow_31,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_32,
        R.id.musubi_calendar_large_number_32,
        R.id.musubi_calendar_large_pill_1_32,
        R.id.musubi_calendar_large_pill_2_32,
        R.id.musubi_calendar_large_overflow_32,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_33,
        R.id.musubi_calendar_large_number_33,
        R.id.musubi_calendar_large_pill_1_33,
        R.id.musubi_calendar_large_pill_2_33,
        R.id.musubi_calendar_large_overflow_33,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_34,
        R.id.musubi_calendar_large_number_34,
        R.id.musubi_calendar_large_pill_1_34,
        R.id.musubi_calendar_large_pill_2_34,
        R.id.musubi_calendar_large_overflow_34,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_35,
        R.id.musubi_calendar_large_number_35,
        R.id.musubi_calendar_large_pill_1_35,
        R.id.musubi_calendar_large_pill_2_35,
        R.id.musubi_calendar_large_overflow_35,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_36,
        R.id.musubi_calendar_large_number_36,
        R.id.musubi_calendar_large_pill_1_36,
        R.id.musubi_calendar_large_pill_2_36,
        R.id.musubi_calendar_large_overflow_36,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_37,
        R.id.musubi_calendar_large_number_37,
        R.id.musubi_calendar_large_pill_1_37,
        R.id.musubi_calendar_large_pill_2_37,
        R.id.musubi_calendar_large_overflow_37,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_38,
        R.id.musubi_calendar_large_number_38,
        R.id.musubi_calendar_large_pill_1_38,
        R.id.musubi_calendar_large_pill_2_38,
        R.id.musubi_calendar_large_overflow_38,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_39,
        R.id.musubi_calendar_large_number_39,
        R.id.musubi_calendar_large_pill_1_39,
        R.id.musubi_calendar_large_pill_2_39,
        R.id.musubi_calendar_large_overflow_39,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_40,
        R.id.musubi_calendar_large_number_40,
        R.id.musubi_calendar_large_pill_1_40,
        R.id.musubi_calendar_large_pill_2_40,
        R.id.musubi_calendar_large_overflow_40,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_41,
        R.id.musubi_calendar_large_number_41,
        R.id.musubi_calendar_large_pill_1_41,
        R.id.musubi_calendar_large_pill_2_41,
        R.id.musubi_calendar_large_overflow_41,
      ),
      LargeDayViews(
        R.id.musubi_calendar_large_day_42,
        R.id.musubi_calendar_large_number_42,
        R.id.musubi_calendar_large_pill_1_42,
        R.id.musubi_calendar_large_pill_2_42,
        R.id.musubi_calendar_large_overflow_42,
      ),
    )

    private val weekdayIds = intArrayOf(
      R.id.musubi_calendar_weekday_1,
      R.id.musubi_calendar_weekday_2,
      R.id.musubi_calendar_weekday_3,
      R.id.musubi_calendar_weekday_4,
      R.id.musubi_calendar_weekday_5,
      R.id.musubi_calendar_weekday_6,
      R.id.musubi_calendar_weekday_7,
    )

    fun updateAll(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      val component = ComponentName(context, MusubiCalendarWidgetProvider::class.java)
      manager.getAppWidgetIds(component).forEach { update(context, manager, it) }
    }

    internal fun update(context: Context, manager: AppWidgetManager, widgetId: Int) {
      val (width, height) = widgetSize(context, manager.getAppWidgetOptions(widgetId))
      val usePills = width >= 280 && height >= 420
      val dayCellHeight = ((height - CALENDAR_CHROME_HEIGHT_DP) / 6f).coerceAtLeast(0f)
      val pillLimit = ((dayCellHeight - DAY_NUMBER_AREA_HEIGHT_DP) / EVENT_PILL_SLOT_HEIGHT_DP)
        .toInt()
        .coerceIn(0, MAX_EVENT_PILLS)
      val showOverflow = dayCellHeight - DAY_NUMBER_AREA_HEIGHT_DP -
        pillLimit * EVENT_PILL_SLOT_HEIGHT_DP >= EVENT_OVERFLOW_HEIGHT_DP
      val inlineDots = height < 230
      val layout = if (usePills) {
        R.layout.musubi_calendar_widget_large_v4
      } else {
        R.layout.musubi_calendar_widget_v4
      }
      val views = RemoteViews(context.packageName, layout)
      val snapshot = AgendaWidgetData.read(context)
      val lightPalette = widgetPalette(context, Configuration.UI_MODE_NIGHT_NO)
      val darkPalette = widgetPalette(context, Configuration.UI_MODE_NIGHT_YES)
      val currentPalette = if (
        context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
          Configuration.UI_MODE_NIGHT_YES
      ) darkPalette else lightPalette
      val now = Calendar.getInstance()
      val firstOfMonth = (now.clone() as Calendar).apply {
        set(Calendar.DAY_OF_MONTH, 1)
        set(Calendar.HOUR_OF_DAY, 0)
        set(Calendar.MINUTE, 0)
        set(Calendar.SECOND, 0)
        set(Calendar.MILLISECOND, 0)
      }
      val mondayFirst = snapshot.weekStartsOn != "sunday"
      val weekStart = if (mondayFirst) Calendar.MONDAY else Calendar.SUNDAY
      val leadingDays = (firstOfMonth.get(Calendar.DAY_OF_WEEK) - weekStart + 7) % 7
      val gridStart = (firstOfMonth.clone() as Calendar).apply {
        add(Calendar.DAY_OF_MONTH, -leadingDays)
      }

      views.setTextViewText(
        R.id.musubi_calendar_month,
        SimpleDateFormat("MMMM", Locale.UK).format(firstOfMonth.time),
      )
      views.setTextViewText(
        R.id.musubi_calendar_year,
        firstOfMonth.get(Calendar.YEAR).toString().takeLast(2),
      )
      views.setTextViewText(
        R.id.musubi_calendar_kanji,
        MONTH_KANJI[firstOfMonth.get(Calendar.MONTH)],
      )
      views.setViewVisibility(
        R.id.musubi_calendar_kanji,
        if (snapshot.showKanji) View.VISIBLE else View.GONE,
      )
      views.setTextViewText(
        R.id.musubi_calendar_today,
        context.getString(R.string.musubi_calendar_widget_calendars),
      )
      setAdaptiveTextColor(
        views,
        R.id.musubi_calendar_month,
        lightPalette.foreground,
        darkPalette.foreground,
        currentPalette.foreground,
      )
      listOf(
        R.id.musubi_calendar_year,
        R.id.musubi_calendar_kanji,
        R.id.musubi_calendar_today,
      ).forEach { id ->
        setAdaptiveTextColor(
          views,
          id,
          lightPalette.muted,
          darkPalette.muted,
          currentPalette.muted,
        )
      }
      views.setOnClickPendingIntent(
        R.id.musubi_calendar_today,
        openCalendarSettingsIntent(context, widgetId),
      )

      val weekdayLabels = if (mondayFirst) {
        listOf("M", "T", "W", "T", "F", "S", "S")
      } else {
        listOf("S", "M", "T", "W", "T", "F", "S")
      }
      weekdayIds.forEachIndexed { index, id ->
        views.setTextViewText(id, weekdayLabels[index])
        setAdaptiveTextColor(
          views,
          id,
          lightPalette.muted,
          darkPalette.muted,
          currentPalette.muted,
        )
      }

      val dateKeyFormat = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
        timeZone = TimeZone.getDefault()
      }
      val fullDateFormat = SimpleDateFormat("EEEE, d MMMM yyyy", Locale.UK)
      val selectedCalendars = CalendarWidgetPreferences.read(context, widgetId)

      repeat(42) { index ->
        val date = (gridStart.clone() as Calendar).apply { add(Calendar.DAY_OF_MONTH, index) }
        val key = dateKeyFormat.format(date.time)
        val summary = snapshot.calendarDays[key]
        val visibleEvents = summary?.events.orEmpty().filter { event ->
          selectedCalendars == null || event.calendarIds.isEmpty() ||
            event.calendarIds.any(selectedCalendars::contains)
        }
        val visibleCount = if (
          selectedCalendars == null && visibleEvents.size < (summary?.count ?: 0)
        ) summary?.count ?: 0 else visibleEvents.size
        val inMonth = date.get(Calendar.MONTH) == firstOfMonth.get(Calendar.MONTH)
          && date.get(Calendar.YEAR) == firstOfMonth.get(Calendar.YEAR)
        val isToday = sameDay(date, now)
        val number = date.get(Calendar.DAY_OF_MONTH).toString()
        val click = openDayIntent(context, widgetId, date)
        val description = fullDateFormat.format(date.time) +
          when (visibleCount) {
            0 -> ""
            1 -> ", 1 event"
            else -> ", $visibleCount events"
          }

        if (usePills) {
          val day = largeDayViews[index]
          views.setTextViewText(day.number, number)
          setAdaptiveTextColor(
            views,
            day.number,
            when {
              isToday -> lightPalette.onAccent
              inMonth -> lightPalette.foreground
              else -> lightPalette.muted
            },
            when {
              isToday -> darkPalette.onAccent
              inMonth -> darkPalette.foreground
              else -> darkPalette.muted
            },
            when {
              isToday -> currentPalette.onAccent
              inMonth -> currentPalette.foreground
              else -> currentPalette.muted
            },
          )
          views.setInt(
            day.number,
            "setBackgroundResource",
            if (isToday) R.drawable.musubi_calendar_today_filled else 0,
          )
          views.setOnClickPendingIntent(day.container, click)
          views.setContentDescription(day.container, description)
          views.setInt(
            day.container,
            "setBackgroundResource",
            if (index % 7 == 6) R.drawable.musubi_calendar_cell_last
            else R.drawable.musubi_calendar_cell,
          )

          val displayed = visibleEvents.take(pillLimit)
          listOf(day.pillOne, day.pillTwo).forEachIndexed { pillIndex, pillId ->
            val event = displayed.getOrNull(pillIndex)
            views.setViewVisibility(pillId, if (event == null) View.GONE else View.VISIBLE)
            if (event != null) {
              views.setTextViewText(
                pillId,
                event.title.ifBlank { context.getString(R.string.musubi_agenda_widget_untitled) },
              )
              val pillColor = AgendaWidgetData.parseColor(event.color)
              tintPill(views, pillId, pillColor)
              views.setTextColor(pillId, pillTextColor(context, pillColor))
            }
          }
          val overflow = visibleCount - displayed.size
          views.setViewVisibility(
            day.overflow,
            if (showOverflow && overflow > 0) View.VISIBLE else View.GONE,
          )
          if (showOverflow && overflow > 0) views.setTextViewText(day.overflow, "+$overflow")
        } else {
          val id = compactDayIds[index]
          val colors = visibleEvents.map { it.color }
            .distinct()
            .take(if (inlineDots) 2 else 3)
          val dots = colors.joinToString(if (inlineDots) "" else " ") { "●" }
          val labelText = when {
            dots.isEmpty() -> number
            inlineDots -> "$number $dots"
            else -> "$number\n$dots"
          }
          val label = SpannableString(labelText)
          setAdaptiveTextColor(
            views,
            id,
            when {
              isToday -> lightPalette.accent
              inMonth -> lightPalette.foreground
              else -> lightPalette.muted
            },
            when {
              isToday -> darkPalette.accent
              inMonth -> darkPalette.foreground
              else -> darkPalette.muted
            },
            when {
              isToday -> currentPalette.accent
              inMonth -> currentPalette.foreground
              else -> currentPalette.muted
            },
          )
          if (isToday) {
            label.setSpan(
              StyleSpan(Typeface.BOLD),
              0,
              number.length,
              Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
            )
          }
          val dotsStart = number.length + 1
          if (dots.isNotEmpty()) {
            label.setSpan(
              RelativeSizeSpan(0.78f),
              dotsStart,
              label.length,
              Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
            )
            var dotOffset = dotsStart
            colors.forEach { color ->
              label.setSpan(
                ForegroundColorSpan(AgendaWidgetData.parseColor(color)),
                dotOffset,
                dotOffset + 1,
                Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
              )
              dotOffset += if (inlineDots) 1 else 2
            }
          }
          views.setTextViewText(id, label)
          views.setInt(
            id,
            "setBackgroundResource",
            if (isToday) R.drawable.musubi_calendar_today else 0,
          )
          views.setContentDescription(id, description)
          views.setOnClickPendingIntent(id, click)
        }
      }

      manager.updateAppWidget(widgetId, views)
    }

    private fun widgetSize(context: Context, options: Bundle): Pair<Int, Int> {
      val landscape =
        context.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
      val width = options.getInt(
        if (landscape) AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH
        else AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH,
        250,
      )
      val height = options.getInt(
        if (landscape) AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT
        else AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT,
        180,
      )
      return width to height
    }

    private const val CALENDAR_CHROME_HEIGHT_DP = 69f
    private const val DAY_NUMBER_AREA_HEIGHT_DP = 19f
    private const val EVENT_PILL_SLOT_HEIGHT_DP = 13f
    private const val EVENT_OVERFLOW_HEIGHT_DP = 10f
    private const val MAX_EVENT_PILLS = 2

    private fun widgetPalette(context: Context, nightMode: Int): WidgetPalette {
      val configuration = Configuration(context.resources.configuration).apply {
        uiMode = (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or nightMode
      }
      val themed = context.createConfigurationContext(configuration)
      return WidgetPalette(
        foreground = themed.getColor(R.color.musubi_widget_foreground),
        muted = themed.getColor(R.color.musubi_widget_foreground_muted),
        accent = themed.getColor(R.color.musubi_widget_accent),
        onAccent = themed.getColor(R.color.musubi_widget_on_accent),
      )
    }

    private fun setAdaptiveTextColor(
      views: RemoteViews,
      viewId: Int,
      light: Int,
      dark: Int,
      current: Int,
    ) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        views.setColorInt(viewId, "setTextColor", light, dark)
      } else {
        views.setTextColor(viewId, current)
      }
    }

    private fun tintPill(views: RemoteViews, viewId: Int, color: Int) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        views.setColorStateList(
          viewId,
          "setBackgroundTintList",
          ColorStateList.valueOf(color),
        )
      } else {
        views.setInt(viewId, "setBackgroundColor", color)
      }
    }

    private fun pillTextColor(context: Context, background: Int): Int {
      val dark = context.getColor(R.color.musubi_widget_pill_ink)
      val light = context.getColor(R.color.musubi_widget_on_accent)
      return if (contrast(background, dark) >= contrast(background, light)) dark else light
    }

    private fun contrast(first: Int, second: Int): Double {
      val lighter = maxOf(luminance(first), luminance(second))
      val darker = minOf(luminance(first), luminance(second))
      return (lighter + 0.05) / (darker + 0.05)
    }

    private fun luminance(color: Int): Double {
      fun channel(value: Int): Double {
        val normalized = value / 255.0
        return if (normalized <= 0.04045) normalized / 12.92
        else Math.pow((normalized + 0.055) / 1.055, 2.4)
      }
      return 0.2126 * channel(Color.red(color)) +
        0.7152 * channel(Color.green(color)) +
        0.0722 * channel(Color.blue(color))
    }

    private fun sameDay(a: Calendar, b: Calendar): Boolean =
      a.get(Calendar.YEAR) == b.get(Calendar.YEAR)
        && a.get(Calendar.DAY_OF_YEAR) == b.get(Calendar.DAY_OF_YEAR)

    private fun openDayIntent(
      context: Context,
      widgetId: Int,
      date: Calendar,
    ): PendingIntent {
      val epoch = date.timeInMillis
      val uri = Uri.parse("musubi:///?time=$epoch")
      val intent = Intent(Intent.ACTION_VIEW, uri).apply {
        setPackage(context.packageName)
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
      }
      val dateCode = date.get(Calendar.YEAR) * 10_000 +
        (date.get(Calendar.MONTH) + 1) * 100 +
        date.get(Calendar.DAY_OF_MONTH)
      return PendingIntent.getActivity(
        context,
        widgetId * 100_000 + dateCode,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }

    private fun openCalendarSettingsIntent(context: Context, widgetId: Int): PendingIntent {
      val uri = Uri.parse("musubi:///?calendarWidgetId=$widgetId")
      val intent = Intent(Intent.ACTION_VIEW, uri).apply {
        setPackage(context.packageName)
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
      }
      return PendingIntent.getActivity(
        context,
        5300 + widgetId,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }
  }
}

private data class LargeDayViews(
  val container: Int,
  val number: Int,
  val pillOne: Int,
  val pillTwo: Int,
  val overflow: Int,
)

private data class WidgetPalette(
  val foreground: Int,
  val muted: Int,
  val accent: Int,
  val onAccent: Int,
)

private val MONTH_KANJI = listOf(
  "一月", "二月", "三月", "四月", "五月", "六月",
  "七月", "八月", "九月", "十月", "十一月", "十二月",
)
