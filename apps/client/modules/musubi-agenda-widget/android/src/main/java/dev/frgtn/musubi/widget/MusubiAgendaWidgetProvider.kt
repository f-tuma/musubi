package dev.frgtn.musubi.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.widget.RemoteViews

class MusubiAgendaWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    ids.forEach { WidgetCollection.update(context, manager, it, false) }
  }
  override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
    WidgetCollection.update(context, manager, id, false)
  }
  override fun onReceive(context: Context, intent: Intent) {
    super.onReceive(context, intent)
    if (intent.action in WidgetPresentation.TIME_ACTIONS) updateAll(context)
  }
  companion object {
    fun updateAll(context: Context) = WidgetCollection.updateAll(context, MusubiAgendaWidgetProvider::class.java, false)
  }
}

class MusubiTasksWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    ids.forEach { WidgetCollection.update(context, manager, it, true) }
  }
  override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
    WidgetCollection.update(context, manager, id, true)
  }
  override fun onDeleted(context: Context, ids: IntArray) {
    ids.forEach { CalendarWidgetPreferences.remove(context, it, "tasks") }
    super.onDeleted(context, ids)
  }
  override fun onReceive(context: Context, intent: Intent) {
    super.onReceive(context, intent)
    if (intent.action in WidgetPresentation.TIME_ACTIONS) updateAll(context)
  }
  companion object {
    fun updateAll(context: Context) = WidgetCollection.updateAll(context, MusubiTasksWidgetProvider::class.java, true)
  }
}

internal object WidgetCollection {
  const val MAX_VISIBLE_ROWS = 128
  fun updateAll(context: Context, provider: Class<*>, tasks: Boolean) {
    val manager = AppWidgetManager.getInstance(context)
    manager.getAppWidgetIds(ComponentName(context, provider)).forEach { update(context, manager, it, tasks) }
  }

  fun width(context: Context, options: Bundle): Int = options.getInt(
    if (context.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE)
      AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH else AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 220)

  fun height(context: Context, options: Bundle): Int = options.getInt(
    if (context.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE)
      AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT else AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 220)

  fun taskGroup(rows: List<WidgetTask>, index: Int, showGroups: Boolean): Int? {
    if (!showGroups) return null
    val bucket = AgendaWidgetData.taskBucket(rows[index]).coerceAtMost(2)
    return bucket.takeIf { index == 0 || AgendaWidgetData.taskBucket(rows[index - 1]).coerceAtMost(2) != bucket }
  }

  fun update(context: Context, manager: AppWidgetManager, id: Int, tasks: Boolean) = synchronized(AgendaWidgetStorage) {
    val snapshot = AgendaWidgetData.read(context)
    val options = manager.getAppWidgetOptions(id)
    val width = width(context, options)
    val groups = height(context, options) >= WidgetPresentation.dp(context, R.dimen.musubi_widget_min_grouped_list_height)
    val selection = CalendarWidgetPreferences.read(context, id, "tasks")
    val wide = width >= 320
    val taskRows = if (tasks) AgendaWidgetData.tasks(snapshot, selection) else emptyList()
    val eventRows = if (!tasks) AgendaWidgetData.upcoming(snapshot) else emptyList()
    val keys = if (tasks) taskRows.map { it.id } else eventRows.map { it.key }
    val count = keys.size
    val empty = WidgetPresentation.empty(context, snapshot, tasks, count)
    val views = RemoteViews(context.packageName, R.layout.musubi_agenda_widget_v4)
    WidgetPresentation.shell(context, views, snapshot, tasks, empty, width, count > MAX_VISIBLE_ROWS)
    views.setOnClickPendingIntent(R.id.musubi_widget_settings, WidgetPresentation.route(context,
      "musubi://tasks?tasksWidgetId=$id"))
    views.setViewVisibility(R.id.musubi_widget_settings, if (tasks) android.view.View.VISIBLE else android.view.View.GONE)
    if (tasks) {
      if (empty == null && width >= 280 && context.resources.configuration.fontScale < 1.5f) {
        val title = context.getString(R.string.musubi_tasks_widget_label)
        views.setTextViewText(R.id.musubi_widget_label, "$title $count")
      }
      views.setContentDescription(R.id.musubi_widget_header, "${context.getString(R.string.musubi_tasks_widget_label)}, $count")
      views.setTextViewText(R.id.musubi_widget_date, context.getString(if (selection == null)
        R.string.musubi_widget_all_calendars else R.string.musubi_widget_selected_calendars))
      views.setOnClickPendingIntent(R.id.musubi_widget_date, WidgetPresentation.route(context, "musubi://tasks?tasksWidgetId=$id"))
    }
    val nextEvent = eventRows.indexOfFirst { !it.allDay }
    views.setEmptyView(R.id.musubi_widget_events, R.id.musubi_widget_empty)
    views.setPendingIntentTemplate(R.id.musubi_widget_events, template(context, id, tasks))
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val collection = RemoteViews.RemoteCollectionItems.Builder().setHasStableIds(true).setViewTypeCount(2)
      if (empty == null) {
        val ids = WidgetInvariants.stableIds(keys.take(MAX_VISIBLE_ROWS))
        ids.forEachIndexed { index, itemId ->
          val row = if (tasks) WidgetRows.task(context, taskRows[index], snapshot, taskGroup(taskRows, index, groups), false)
            else WidgetRows.agenda(context, eventRows[index], snapshot.timeFormat, wide, false, index == nextEvent)
          collection.addItem(itemId, row)
        }
      }
      views.setRemoteAdapter(R.id.musubi_widget_events, collection.build())
    } else {
      val intent = Intent(context, MusubiAgendaWidgetService::class.java).apply {
        putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
        putExtra("tasks", tasks)
        data = Uri.parse(toUri(Intent.URI_INTENT_SCHEME))
      }
      views.setRemoteAdapter(R.id.musubi_widget_events, intent)
    }
    manager.updateAppWidget(id, views)
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) manager.notifyAppWidgetViewDataChanged(id, R.id.musubi_widget_events)
  }

  private fun template(context: Context, widgetId: Int, tasks: Boolean): PendingIntent {
    val intent = Intent(Intent.ACTION_VIEW).apply {
      component = context.packageManager.getLaunchIntentForPackage(context.packageName)?.component
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    return PendingIntent.getActivity(context, (if (tasks) 6200 else 4200) + widgetId, intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
  }
}
