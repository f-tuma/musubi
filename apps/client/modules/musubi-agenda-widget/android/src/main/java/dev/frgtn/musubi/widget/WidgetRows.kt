package dev.frgtn.musubi.widget

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.View
import android.widget.RemoteViews

internal object WidgetRows {
  fun agenda(context: Context, event: WidgetEvent, format: String, wide: Boolean, direct: Boolean): RemoteViews {
    val uri = if (event.taskId != null) Uri.Builder().scheme("musubi").authority("tasks")
      .appendQueryParameter("taskId", event.taskId).build()
    else Uri.Builder().scheme("musubi").authority("agenda").appendQueryParameter("eventId", event.id)
      .appendQueryParameter("occurrenceStart", event.start.toString()).build()
    return row(context, event.title, AgendaWidgetData.eventTime(event, format, wide),
      AgendaWidgetData.eventDateLabel(event, compact = !wide), AgendaWidgetData.eventMeta(event, wide),
      event.color, wide, uri, direct)
  }

  fun task(context: Context, task: WidgetTask, wide: Boolean, direct: Boolean): RemoteViews =
    row(context, task.title.ifBlank { context.getString(R.string.musubi_tasks_widget_untitled) }, AgendaWidgetData.taskDue(task, context), "", task.calendarName, task.color,
      wide, Uri.Builder().scheme("musubi").authority("tasks").appendQueryParameter("taskId", task.id).build(), direct)

  private fun row(context: Context, title: String, time: String, day: String, meta: String,
    color: String, wide: Boolean, uri: Uri, direct: Boolean): RemoteViews =
    RemoteViews(context.packageName, if (wide) R.layout.musubi_agenda_widget_event_wide_v2 else R.layout.musubi_agenda_widget_event_v2).apply {
      val text = title.ifBlank { context.getString(R.string.musubi_agenda_widget_untitled) }
      setTextViewText(R.id.musubi_widget_title, text)
      setTextViewText(R.id.musubi_widget_time, time)
      setTextViewText(R.id.musubi_widget_day, day)
      setViewVisibility(R.id.musubi_widget_day, if (day.isEmpty()) View.GONE else View.VISIBLE)
      setTextViewText(R.id.musubi_widget_meta, meta)
      setViewVisibility(R.id.musubi_widget_meta, if (wide && meta.isNotBlank()) View.VISIBLE else View.GONE)
      setInt(R.id.musubi_widget_stripe, "setBackgroundColor", AgendaWidgetData.parseColor(color))
      setContentDescription(R.id.musubi_widget_event, listOf(text, time, day, meta).filter { it.isNotBlank() }.joinToString(", "))
      if (direct) setOnClickPendingIntent(R.id.musubi_widget_event, WidgetPresentation.route(context, uri))
      else setOnClickFillInIntent(R.id.musubi_widget_event, Intent().setData(uri))
    }
}
