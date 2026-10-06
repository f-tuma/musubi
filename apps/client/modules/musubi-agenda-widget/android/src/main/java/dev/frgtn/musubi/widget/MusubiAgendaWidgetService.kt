package dev.frgtn.musubi.widget

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import android.widget.RemoteViewsService

/** Older launchers use the same projection/rows as the inline Android 12+ collection. */
class MusubiAgendaWidgetService : RemoteViewsService() {
  override fun onGetViewFactory(intent: Intent): RemoteViewsFactory = WidgetRemoteViewsFactory(applicationContext,
    intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID),
    intent.getBooleanExtra("tasks", false))
}

private class WidgetRemoteViewsFactory(private val context: Context, private val widgetId: Int,
  private val tasks: Boolean) : RemoteViewsService.RemoteViewsFactory {
  private var snapshot = WidgetSnapshot()
  private var events = emptyList<WidgetEvent>()
  private var taskRows = emptyList<WidgetTask>()
  private var ids = emptyList<Long>()
  private var wide = false
  private var groups = false
  private var nextEvent = -1
  private var revision = WidgetRevision(null, 0, 0)
  override fun onCreate() = Unit
  override fun onDataSetChanged() = synchronized(AgendaWidgetStorage) {
    revision = AgendaWidgetStorage.revision(context)
    snapshot = AgendaWidgetData.read(context)
    events = if (!tasks) AgendaWidgetData.upcoming(snapshot).take(WidgetCollection.MAX_VISIBLE_ROWS) else emptyList()
    taskRows = if (tasks) AgendaWidgetData.tasks(snapshot, CalendarWidgetPreferences.read(context, widgetId, "tasks"))
      .take(WidgetCollection.MAX_VISIBLE_ROWS) else emptyList()
    if (WidgetPresentation.empty(context, snapshot, tasks, if (tasks) taskRows.size else events.size) != null) {
      events = emptyList(); taskRows = emptyList()
    }
    ids = WidgetInvariants.stableIds(if (tasks) taskRows.map { it.id } else events.map { it.key })
    val options = AppWidgetManager.getInstance(context).getAppWidgetOptions(widgetId)
    wide = WidgetCollection.width(context, options) >= 320
    groups = WidgetCollection.height(context, options) >= WidgetPresentation.dp(context, R.dimen.musubi_widget_min_grouped_list_height)
    nextEvent = events.indexOfFirst { !it.allDay }
  }
  override fun onDestroy() { events = emptyList(); taskRows = emptyList(); ids = emptyList() }
  override fun getCount(): Int = synchronized(AgendaWidgetStorage) {
    if (revision == AgendaWidgetStorage.revision(context)) ids.size else 0
  }
  override fun getViewAt(position: Int): RemoteViews? = synchronized(AgendaWidgetStorage) {
    if (revision != AgendaWidgetStorage.revision(context)) return@synchronized getLoadingView()
    if (tasks) taskRows.getOrNull(position)?.let {
    WidgetRows.task(context, it, snapshot, WidgetCollection.taskGroup(taskRows, position, groups), false)
  } else events.getOrNull(position)?.let { WidgetRows.agenda(context, it, snapshot.timeFormat, wide, false, position == nextEvent) }
  }
  override fun getLoadingView(): RemoteViews = RemoteViews(context.packageName, R.layout.musubi_widget_loading_row)
  override fun getViewTypeCount(): Int = 2
  override fun getItemId(position: Int): Long = synchronized(AgendaWidgetStorage) {
    if (revision == AgendaWidgetStorage.revision(context)) ids.getOrNull(position) ?: position.toLong()
    else position.toLong()
  }
  override fun hasStableIds(): Boolean = true
}
