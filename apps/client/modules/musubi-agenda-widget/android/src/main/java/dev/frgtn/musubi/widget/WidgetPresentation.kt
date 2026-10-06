package dev.frgtn.musubi.widget

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Paint
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.appwidget.AppWidgetManager
import android.util.SizeF
import android.net.Uri
import android.text.format.DateUtils
import android.view.View
import android.widget.RemoteViews
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

internal object WidgetPresentation {
  val TIME_ACTIONS = setOf(Intent.ACTION_DATE_CHANGED, Intent.ACTION_LOCALE_CHANGED,
    Intent.ACTION_TIMEZONE_CHANGED, Intent.ACTION_TIME_CHANGED)

  // Hosts can rotate without changing their persisted min/max size options or
  // calling the provider again. Supply both layouts so the host can choose.
  fun responsive(options: Bundle, fallbackWidth: Float, fallbackHeight: Float,
    render: (Int, Int) -> RemoteViews): RemoteViews {
    val portraitWidth = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, fallbackWidth.toInt())
    val portraitHeight = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, fallbackHeight.toInt())
    val landscapeWidth = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, portraitWidth)
    val landscapeHeight = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, portraitHeight)
    val portrait = render(portraitWidth, portraitHeight)
    val landscape = if (portraitWidth == landscapeWidth && portraitHeight == landscapeHeight) portrait
      else render(landscapeWidth, landscapeHeight)
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) RemoteViews(linkedMapOf(
      // Some letterboxed launchers allocate less than either reported size.
      // A minimal fallback must explain the shortage instead of clipping rows.
      SizeF(1f, 1f) to render(portraitWidth, 1),
      SizeF(portraitWidth.toFloat(), portraitHeight.toFloat()) to portrait,
      SizeF(landscapeWidth.toFloat(), landscapeHeight.toFloat()) to landscape))
      else RemoteViews(landscape, portrait)
  }

  fun route(context: Context, uri: Uri): PendingIntent = PendingIntent.getActivity(context, 0,
    Intent(Intent.ACTION_VIEW, uri).setPackage(context.packageName).apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

  fun route(context: Context, uri: String): PendingIntent = route(context, Uri.parse(uri))

  fun empty(context: Context, snapshot: WidgetSnapshot, tasks: Boolean, count: Int): String? {
    if (snapshot.signedIn == false) return context.getString(R.string.musubi_widget_signed_out)
    if (snapshot.problem != null) return context.getString(when (snapshot.problem) {
      SnapshotProblem.NOT_LOADED -> R.string.musubi_widget_not_loaded
      else -> R.string.musubi_widget_reload
    })
    val section = if (tasks) snapshot.tasksStatus else snapshot.eventsStatus
    if (!AgendaWidgetData.sameZone(section.timeZone)) return context.getString(R.string.musubi_widget_timezone)
    if (!tasks && !AgendaWidgetData.eventsUsable(snapshot)) return context.getString(R.string.musubi_widget_expired)
    if (count > 0) return null
    return context.getString(when {
      section.state == "loading" -> R.string.musubi_widget_loading
      section.state == "error" -> R.string.musubi_widget_error
      section.state == "unavailable" -> R.string.musubi_widget_not_loaded
      !section.complete || section.truncated -> R.string.musubi_widget_incomplete
      tasks -> R.string.musubi_tasks_widget_empty
      else -> R.string.musubi_agenda_widget_empty
    })
  }

  fun status(context: Context, snapshot: WidgetSnapshot, tasks: Boolean, more: Boolean = false): String {
    if (snapshot.signedIn != true || snapshot.problem != null) return ""
    val section = if (tasks) snapshot.tasksStatus else snapshot.eventsStatus
    if (!AgendaWidgetData.sameZone(section.timeZone)) return context.getString(R.string.musubi_widget_timezone_status)
    if (!tasks && !AgendaWidgetData.eventsUsable(snapshot)) return context.getString(R.string.musubi_widget_expired_status)
    if (section.state == "loading") return context.getString(R.string.musubi_widget_loading_status)
    if (section.state == "error") return context.getString(R.string.musubi_widget_error_status)
    if (section.state == "unavailable") return context.getString(R.string.musubi_widget_cached)
    if (!section.complete || section.truncated || more) return context.getString(R.string.musubi_widget_more)
    val synced = section.lastSyncAt ?: return context.getString(R.string.musubi_widget_cached)
    return context.getString(R.string.musubi_widget_updated,
      DateUtils.getRelativeTimeSpanString(synced, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS,
        DateUtils.FORMAT_ABBREV_RELATIVE))
  }

  fun shell(context: Context, views: RemoteViews, snapshot: WidgetSnapshot, tasks: Boolean,
    empty: String?, width: Int, more: Boolean = false) {
    val target = if (tasks) "musubi://tasks" else "musubi://agenda"
    views.setTextViewText(R.id.musubi_widget_label, if (tasks) context.getString(R.string.musubi_tasks_widget_label)
      else SimpleDateFormat("EEE d MMM", Locale.getDefault()).format(Date()))
    views.setTextViewText(R.id.musubi_widget_date, context.getString(if (tasks)
      R.string.musubi_widget_all_calendars else R.string.musubi_agenda_widget_label))
    views.setViewVisibility(R.id.musubi_widget_add, if (snapshot.signedIn == true && width >= 280 &&
      context.resources.configuration.fontScale < 1.5f) View.VISIBLE else View.GONE)
    views.setContentDescription(R.id.musubi_widget_add, context.getString(if (tasks)
      R.string.musubi_widget_add_task else R.string.musubi_widget_add_event))
    views.setOnClickPendingIntent(R.id.musubi_widget_add, route(context,
      if (tasks) "musubi://tasks?widgetAdd=1" else "musubi:///?widgetAdd=1"))
    views.setOnClickPendingIntent(R.id.musubi_widget_header, route(context, target))
    views.setOnClickPendingIntent(R.id.musubi_widget_refresh, route(context, "$target?widgetRefresh=1"))
    views.setContentDescription(R.id.musubi_widget_refresh, context.getString(R.string.musubi_widget_refresh))
    views.setOnClickPendingIntent(R.id.musubi_widget_empty, route(context, "$target?widgetRefresh=1"))
    views.setTextViewText(R.id.musubi_widget_status, status(context, snapshot, tasks, more))
    if (empty != null) views.setTextViewText(R.id.musubi_widget_empty, empty)
    views.setViewVisibility(R.id.musubi_widget_events, if (empty == null) View.VISIBLE else View.GONE)
    views.setViewVisibility(R.id.musubi_widget_empty, if (empty == null) View.GONE else View.VISIBLE)
  }

  fun dp(context: Context, resource: Int): Float = context.resources.getDimension(resource) / context.resources.displayMetrics.density

  fun textColor(context: Context, views: RemoteViews, id: Int, resource: Int) {
    fun color(mode: Int) = context.createConfigurationContext(Configuration(context.resources.configuration).apply {
      uiMode = (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or mode
    }).getColor(resource)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) views.setColorInt(id, "setTextColor",
      color(Configuration.UI_MODE_NIGHT_NO), color(Configuration.UI_MODE_NIGHT_YES))
    else views.setTextColor(id, context.getColor(resource))
  }

  fun textHeight(context: Context, resource: Int): Float = Paint().apply {
    textSize = context.resources.getDimension(resource)
  }.fontMetrics.let { kotlin.math.ceil((it.descent - it.ascent).toDouble()).toFloat() / context.resources.displayMetrics.density }

  fun dateWidth(context: Context): Float = Paint().apply {
    textSize = context.resources.getDimension(R.dimen.musubi_widget_calendar_day_size)
  }.measureText("28") / context.resources.displayMetrics.density
}
