package dev.frgtn.musubi.widget

import android.appwidget.AppWidgetManager
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class MusubiAgendaWidgetModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MusubiAgendaWidget")

    AsyncFunction("updateSnapshot") { snapshot: String ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      AgendaWidgetStorage.write(context, snapshot)
      MusubiAgendaWidgetProvider.updateAll(context)
      MusubiCalendarWidgetProvider.updateAll(context)
    }

    AsyncFunction("clearSnapshot") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      AgendaWidgetStorage.markSignedOut(context)
      MusubiAgendaWidgetProvider.updateAll(context)
      MusubiCalendarWidgetProvider.updateAll(context)
    }

    AsyncFunction("getCalendarWidgetSelection") { widgetId: Int ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      CalendarWidgetPreferences.read(context, widgetId)?.toList()
    }

    AsyncFunction("setCalendarWidgetSelection") { widgetId: Int, calendarIds: List<String> ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      CalendarWidgetPreferences.write(context, widgetId, calendarIds.toSet())
      MusubiCalendarWidgetProvider.update(context, AppWidgetManager.getInstance(context), widgetId)
    }
  }
}
