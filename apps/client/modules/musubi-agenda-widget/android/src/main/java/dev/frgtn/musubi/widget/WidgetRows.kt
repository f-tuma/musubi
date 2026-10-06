package dev.frgtn.musubi.widget

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.View
import android.widget.RemoteViews

internal object WidgetRows {
  fun agenda(context: Context, event: WidgetEvent, format: String, wide: Boolean, direct: Boolean,
    highlight: Boolean = false): RemoteViews {
    val uri = if (event.taskId != null) Uri.Builder().scheme("musubi").authority("tasks")
      .appendQueryParameter("taskId", event.taskId).build()
    else Uri.Builder().scheme("musubi").authority("agenda").appendQueryParameter("eventId", event.id)
      .appendQueryParameter("occurrenceStart", event.start.toString()).build()
    return RemoteViews(context.packageName, if (wide) R.layout.musubi_agenda_widget_event_wide_v3 else R.layout.musubi_agenda_widget_event_v3).apply {
      val title = event.title.ifBlank { context.getString(R.string.musubi_agenda_widget_untitled) }
      val time = if (event.allDay) context.getString(R.string.musubi_widget_all_day)
        else AgendaWidgetData.eventTime(event, format, wide && context.resources.configuration.fontScale < 1.5f)
      val day = AgendaWidgetData.eventDateLabel(event, compact = !wide)
      val meta = AgendaWidgetData.eventMeta(event, wide)
      setTextViewText(R.id.musubi_widget_title, title)
      setTextViewText(R.id.musubi_widget_time, time)
      setTextViewText(R.id.musubi_widget_day, day)
      setViewVisibility(R.id.musubi_widget_day, if (day.isEmpty()) View.INVISIBLE else View.VISIBLE)
      setTextViewText(R.id.musubi_widget_meta, meta)
      setViewVisibility(R.id.musubi_widget_meta, if (meta.isNotBlank()) View.VISIBLE else View.GONE)
      setInt(R.id.musubi_widget_stripe, "setBackgroundColor", AgendaWidgetData.parseColor(event.color))
      setInt(R.id.musubi_widget_event, "setBackgroundResource", if (highlight) R.drawable.musubi_widget_next_event else 0)
      setContentDescription(R.id.musubi_widget_event, listOf(title, time, day, meta).filter { it.isNotBlank() }.joinToString(", "))
      click(this, context, R.id.musubi_widget_event, uri, direct)
    }
  }

  fun task(context: Context, task: WidgetTask, snapshot: WidgetSnapshot, group: Int?, direct: Boolean): RemoteViews {
    val title = task.title.ifBlank { context.getString(R.string.musubi_tasks_widget_untitled) }
    val due = AgendaWidgetData.taskDue(task, context, snapshot.timeFormat)
    val uri = Uri.Builder().scheme("musubi").authority("tasks").appendQueryParameter("taskId", task.id).build()
    val token = AgendaWidgetStorage.taskCompletion(context, snapshot.scope, task)
    return RemoteViews(context.packageName, R.layout.musubi_tasks_widget_row_v2).apply {
      setTextViewText(R.id.musubi_widget_title, title)
      setTextViewText(R.id.musubi_widget_meta, listOf(due, task.calendarName).filter { it.isNotBlank() }.joinToString(" · "))
      WidgetPresentation.textColor(context, this, R.id.musubi_widget_meta, if (AgendaWidgetData.taskBucket(task) == 0)
        R.color.musubi_widget_accent_text else R.color.musubi_widget_foreground_muted)
      setViewVisibility(R.id.musubi_widget_task_shared, if (task.shared) View.VISIBLE else View.GONE)
      setImageViewResource(R.id.musubi_widget_task_check, if (token != null) R.drawable.musubi_widget_check else R.drawable.musubi_widget_lock)
      setContentDescription(R.id.musubi_widget_task_check, context.getString(if (token != null)
        R.string.musubi_widget_complete_task else R.string.musubi_widget_read_only_task, title))
      setViewVisibility(R.id.musubi_widget_group, if (group != null) View.VISIBLE else View.GONE)
      if (group != null) setTextViewText(R.id.musubi_widget_group_label, context.getString(when (group) {
        0 -> R.string.musubi_widget_overdue
        1 -> R.string.musubi_widget_today
        else -> R.string.musubi_widget_later
      }))
      setContentDescription(R.id.musubi_widget_event, listOf(title, due, task.calendarName).filter { it.isNotBlank() }.joinToString(", "))
      click(this, context, R.id.musubi_widget_event, uri, direct)
      // Read-only rows open details; no fake completion action is advertised.
      click(this, context, R.id.musubi_widget_task_check,
        if (token != null) uri.buildUpon().appendQueryParameter("widgetComplete", token).build() else uri, direct)
    }
  }

  private fun click(views: RemoteViews, context: Context, id: Int, uri: Uri, direct: Boolean) {
    if (direct) views.setOnClickPendingIntent(id, WidgetPresentation.route(context, uri))
    else views.setOnClickFillInIntent(id, Intent().setData(uri))
  }
}
