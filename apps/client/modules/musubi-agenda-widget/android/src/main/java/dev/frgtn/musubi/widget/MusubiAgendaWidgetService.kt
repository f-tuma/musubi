package dev.frgtn.musubi.widget

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.widget.RemoteViews
import android.widget.RemoteViewsService

class MusubiAgendaWidgetService : RemoteViewsService() {
  override fun onGetViewFactory(intent: Intent): RemoteViewsFactory =
    AgendaRemoteViewsFactory(
      applicationContext,
      intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID),
    )
}

private class AgendaRemoteViewsFactory(
  private val context: Context,
  private val widgetId: Int,
) : RemoteViewsService.RemoteViewsFactory {
  private var snapshot = WidgetSnapshot(null, "24h", emptyList())
  private var events = emptyList<WidgetEvent>()
  private var wide = false

  override fun onCreate() = Unit

  override fun onDataSetChanged() {
    snapshot = AgendaWidgetData.read(context)
    events = AgendaWidgetData.upcoming(snapshot)
    val options = AppWidgetManager.getInstance(context).getAppWidgetOptions(widgetId)
    val landscape = context.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
    val width = options.getInt(
      if (landscape) AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH
      else AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH,
      110,
    )
    wide = width >= 280
  }

  override fun onDestroy() {
    events = emptyList()
  }

  override fun getCount(): Int = events.size

  override fun getViewAt(position: Int): RemoteViews? {
    val event = events.getOrNull(position) ?: return null
    val layout = if (wide) R.layout.musubi_agenda_widget_event_wide else R.layout.musubi_agenda_widget_event
    return RemoteViews(context.packageName, layout).apply {
      setTextViewText(R.id.musubi_widget_time, AgendaWidgetData.eventTime(event, snapshot.timeFormat, wide))
      setTextViewText(R.id.musubi_widget_day, AgendaWidgetData.eventDateLabel(event, compact = !wide))
      setTextViewText(
        R.id.musubi_widget_title,
        event.title.ifBlank { context.getString(R.string.musubi_agenda_widget_untitled) },
      )
      setTextViewText(R.id.musubi_widget_meta, AgendaWidgetData.eventMeta(event, showLocation = wide))
      setInt(R.id.musubi_widget_stripe, "setBackgroundColor", AgendaWidgetData.parseColor(event.color))
      val eventUri = Uri.Builder()
        .scheme("musubi")
        .authority("agenda")
        .appendQueryParameter("eventId", event.id)
        .appendQueryParameter("occurrenceStart", event.start.toString())
        .build()
      setOnClickFillInIntent(R.id.musubi_widget_event, Intent().setData(eventUri))
    }
  }

  override fun getLoadingView(): RemoteViews? = null
  override fun getViewTypeCount(): Int = 2
  override fun getItemId(position: Int): Long = events.getOrNull(position)?.start ?: position.toLong()
  override fun hasStableIds(): Boolean = true
}
