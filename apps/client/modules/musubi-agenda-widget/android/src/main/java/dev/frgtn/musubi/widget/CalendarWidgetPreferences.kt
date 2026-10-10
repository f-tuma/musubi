package dev.frgtn.musubi.widget

import android.content.Context

internal object CalendarWidgetPreferences {
  private const val PREFERENCES = "musubi_calendar_widget"

  private fun key(widgetId: Int, kind: String) = "${kind}_calendars_$widgetId"

  fun read(context: Context, widgetId: Int, kind: String = "calendar"): Set<String>? {
    val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    val key = key(widgetId, kind)
    if (preferences.getString("${key}_scope", null) != AgendaWidgetStorage.scope(context)) return null
    if (!preferences.contains(key)) return null
    return preferences.getStringSet(key, emptySet())?.toSet() ?: emptySet()
  }

  fun write(context: Context, widgetId: Int, calendarIds: Set<String>, kind: String = "calendar") {
    context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
      .edit()
      .putStringSet(key(widgetId, kind), calendarIds)
      .putString("${key(widgetId, kind)}_scope", AgendaWidgetStorage.scope(context))
      .apply()
  }

  fun remove(context: Context, widgetId: Int, kind: String = "calendar") {
    context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
      .edit()
      .remove(key(widgetId, kind))
      .remove("${key(widgetId, kind)}_scope")
      .apply()
  }

  fun clear(context: Context) {
    check(context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().clear().commit()) {
      "Could not clear widget selections"
    }
  }
}
