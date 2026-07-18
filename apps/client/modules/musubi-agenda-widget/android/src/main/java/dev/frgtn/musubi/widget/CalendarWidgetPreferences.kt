package dev.frgtn.musubi.widget

import android.content.Context

internal object CalendarWidgetPreferences {
  private const val PREFERENCES = "musubi_calendar_widget"

  private fun key(widgetId: Int) = "calendars_$widgetId"

  fun read(context: Context, widgetId: Int): Set<String>? {
    val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    val key = key(widgetId)
    if (!preferences.contains(key)) return null
    return preferences.getStringSet(key, emptySet())?.toSet() ?: emptySet()
  }

  fun write(context: Context, widgetId: Int, calendarIds: Set<String>) {
    context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
      .edit()
      .putStringSet(key(widgetId), calendarIds)
      .apply()
  }

  fun remove(context: Context, widgetId: Int) {
    context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
      .edit()
      .remove(key(widgetId))
      .apply()
  }
}
