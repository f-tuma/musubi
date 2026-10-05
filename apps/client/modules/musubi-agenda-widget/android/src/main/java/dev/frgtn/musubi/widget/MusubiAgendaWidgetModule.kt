package dev.frgtn.musubi.widget

import android.appwidget.AppWidgetManager
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class MusubiAgendaWidgetModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MusubiAgendaWidget")
    AsyncFunction("beginSession") { scope: String -> synchronized(AgendaWidgetStorage) {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val lifecycle = AgendaWidgetStorage.beginSession(context, scope)
      updateAll(context)
      lifecycle
    } }
    AsyncFunction("updateSnapshot") { snapshot: String -> synchronized(AgendaWidgetStorage) {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val accepted = AgendaWidgetStorage.write(context, snapshot)
      if (accepted) updateAll(context)
      accepted
    } }
    AsyncFunction("clearSnapshot") { synchronized(AgendaWidgetStorage) {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      AgendaWidgetStorage.markSignedOut(context)
      updateAll(context)
    } }
    AsyncFunction("getCalendarWidgetSelection") { widgetId: Int ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      CalendarWidgetPreferences.read(context, widgetId)?.toList()
    }
    AsyncFunction("setCalendarWidgetSelection") { widgetId: Int, calendarIds: List<String> -> synchronized(AgendaWidgetStorage) {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      CalendarWidgetPreferences.write(context, widgetId, calendarIds.toSet())
      MusubiCalendarWidgetProvider.update(context, AppWidgetManager.getInstance(context), widgetId)
    } }
    AsyncFunction("getTasksWidgetSelection") { widgetId: Int ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      CalendarWidgetPreferences.read(context, widgetId, "tasks")?.toList()
    }
    AsyncFunction("setTasksWidgetSelection") { widgetId: Int, calendarIds: List<String> -> synchronized(AgendaWidgetStorage) {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      CalendarWidgetPreferences.write(context, widgetId, calendarIds.toSet(), "tasks")
      MusubiTasksWidgetProvider.updateAll(context)
    } }
  }
  private fun updateAll(context: android.content.Context) {
    MusubiAgendaWidgetProvider.updateAll(context)
    MusubiCalendarWidgetProvider.updateAll(context)
    MusubiTasksWidgetProvider.updateAll(context)
  }
}
