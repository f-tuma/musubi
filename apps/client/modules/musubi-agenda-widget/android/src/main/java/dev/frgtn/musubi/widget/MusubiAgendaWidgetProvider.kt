package dev.frgtn.musubi.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.RemoteViews
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MusubiAgendaWidgetProvider : AppWidgetProvider() {
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

    fun updateAll(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      val component = ComponentName(context, MusubiAgendaWidgetProvider::class.java)
      manager.getAppWidgetIds(component).forEach { update(context, manager, it) }
    }

    private fun update(context: Context, manager: AppWidgetManager, widgetId: Int) {
      val views = RemoteViews(context.packageName, R.layout.musubi_agenda_widget)
      val openAgenda = openAgendaIntent(context)
      val eventTemplate = eventTemplateIntent(context, widgetId)
      val serviceIntent = Intent(context, MusubiAgendaWidgetService::class.java).apply {
        putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
        data = Uri.parse(toUri(Intent.URI_INTENT_SCHEME))
      }
      views.setRemoteAdapter(R.id.musubi_widget_events, serviceIntent)
      views.setEmptyView(R.id.musubi_widget_events, R.id.musubi_widget_empty)
      views.setPendingIntentTemplate(R.id.musubi_widget_events, eventTemplate)
      views.setOnClickPendingIntent(R.id.musubi_widget_header, openAgenda)
      views.setOnClickPendingIntent(R.id.musubi_widget_empty, openAgenda)
      views.setTextViewText(
        R.id.musubi_widget_date,
        SimpleDateFormat("EEE, d MMM", Locale.UK).format(Date()).uppercase(Locale.UK),
      )

      val snapshot = AgendaWidgetData.read(context)
      val events = AgendaWidgetData.upcoming(snapshot)
      val emptyMessage = when {
        snapshot.signedIn == false -> context.getString(R.string.musubi_agenda_widget_signed_out)
        AgendaWidgetStorage.read(context) == null -> context.getString(R.string.musubi_agenda_widget_not_loaded)
        events.isEmpty() -> context.getString(R.string.musubi_agenda_widget_empty)
        else -> null
      }
      if (emptyMessage != null) views.setTextViewText(R.id.musubi_widget_empty, emptyMessage)
      views.setViewVisibility(R.id.musubi_widget_events, if (emptyMessage == null) View.VISIBLE else View.GONE)
      views.setViewVisibility(R.id.musubi_widget_empty, if (emptyMessage == null) View.GONE else View.VISIBLE)

      manager.updateAppWidget(widgetId, views)
      manager.notifyAppWidgetViewDataChanged(widgetId, R.id.musubi_widget_events)
    }

    private fun openAgendaIntent(context: Context): PendingIntent {
      val intent = Intent(Intent.ACTION_VIEW, Uri.parse("musubi://agenda")).apply {
        setPackage(context.packageName)
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
      }
      return PendingIntent.getActivity(
        context,
        4102,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }

    private fun eventTemplateIntent(context: Context, widgetId: Int): PendingIntent {
      val launchComponent = context.packageManager
        .getLaunchIntentForPackage(context.packageName)
        ?.component
      val intent = Intent(Intent.ACTION_VIEW).apply {
        component = launchComponent
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
      }
      return PendingIntent.getActivity(
        context,
        4200 + widgetId,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
      )
    }
  }
}
