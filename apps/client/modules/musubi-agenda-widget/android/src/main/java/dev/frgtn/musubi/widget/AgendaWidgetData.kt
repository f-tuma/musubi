package dev.frgtn.musubi.widget

import android.content.Context
import android.graphics.Color
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

internal object AgendaWidgetData {
  private val UTC: TimeZone = TimeZone.getTimeZone("UTC")
  private val zones = TimeZone.getAvailableIDs().toSet()
  private val states = setOf("ready", "loading", "unavailable", "error")

  fun read(context: Context): WidgetSnapshot {
    val raw = AgendaWidgetStorage.read(context) ?: return WidgetSnapshot(problem = SnapshotProblem.NOT_LOADED)
    val snapshot = parse(raw)
    if (snapshot.signedIn == true && snapshot.scope != AgendaWidgetStorage.scope(context)) {
      return WidgetSnapshot(problem = SnapshotProblem.NOT_LOADED)
    }
    return snapshot
  }

  fun parse(raw: String): WidgetSnapshot = try {
    require(raw.toByteArray(Charsets.UTF_8).size <= AgendaWidgetStorage.MAX_BYTES)
    val json = JSONObject(raw)
    if (json.optInt("version") != 2) WidgetSnapshot(problem = SnapshotProblem.UNSUPPORTED)
    else if (json.has("signedIn") && !json.getBoolean("signedIn")) WidgetSnapshot(signedIn = false)
    else {
      require(json.getBoolean("signedIn"))
      val scope = json.getString("scope").also { require(it.isNotBlank()) }
      val lifecycle = json.getLong("lifecycle").also { require(it > 0) }
      val generation = json.getLong("generation").also { require(it > 0) }
      val generatedAt = json.getLong("generatedAt").also { require(it > 0) }
      val zone = json.getString("timeZone").also { require(it in zones) }
      val readable = strings(json.getJSONArray("readableCalendarIds")).toSet()
      val eventsStatus = status(json.getJSONObject("eventsStatus"), zone, true)
      val tasksStatus = status(json.getJSONObject("tasksStatus"), zone, false)
      val array = json.getJSONArray("events").also { require(it.length() <= 4096) }
      val events = (0 until array.length()).map { index ->
        val item = array.getJSONObject(index)
        WidgetEvent(
          key = item.getString("key").also { require(it.isNotBlank()) },
          id = item.getString("id").also { require(it.isNotBlank()) },
          title = item.getString("title"), start = item.getLong("start"), end = item.getLong("end"),
          allDay = item.getBoolean("allDay"), color = item.getString("color"),
          calendarName = item.optString("calendarName"), location = item.optString("location"),
          calendarIds = strings(item.getJSONArray("calendarIds")),
          startKey = item.getString("startKey"), endKey = item.getString("endKey"),
          taskId = item.optString("taskId").takeIf { it.isNotBlank() },
        ).also { require(it.end >= it.start && it.startKey.matches(DATE_KEY) && it.endKey.matches(DATE_KEY) &&
          it.calendarIds.any(readable::contains)) }
      }
      val byKey = events.associateBy { it.key }
      require(byKey.size == events.size)
      var references = 0
      val days = json.getJSONArray("calendarDays").also { require(it.length() <= 450) }
      val calendarDays = buildMap {
        for (index in 0 until days.length()) {
          val day = days.getJSONObject(index)
          val key = day.getString("date").also { require(it.matches(DATE_KEY) && !containsKey(it)) }
          val keys = strings(day.getJSONArray("eventKeys"))
          references += keys.size
          require(references <= 32768 && keys.size == keys.distinct().size)
          val chips = keys.map { eventKey ->
            val event = byKey[eventKey] ?: error("Unknown calendar event reference")
            CalendarWidgetChip(event.title, event.color, event.calendarIds, event.key, event.allDay,
              event.startKey, event.endKey)
          }
          put(key, CalendarWidgetDay(chips.map { it.color }.distinct(), chips, chips.size))
        }
      }
      val taskArray = json.getJSONArray("tasks").also { require(it.length() <= 2048) }
      val tasks = (0 until taskArray.length()).map { index ->
        val item = taskArray.getJSONObject(index)
        WidgetTask(item.getString("id").also { require(it.isNotBlank()) }, item.getString("title"),
          item.getString("status"), item.optInt("priority"), item.getString("color"),
          item.optString("calendarName"), strings(item.getJSONArray("calendarIds")),
          if (item.isNull("due")) null else item.getLong("due"), item.optBoolean("dueDateOnly"),
          item.optLong("revision", 0), item.optBoolean("canComplete", false), item.optBoolean("shared", false), item.optLong("providerReadRetiredGeneration", 0))
      }
      require(tasks.map { it.id }.distinct().size == tasks.size && tasks.all { it.calendarIds.any(readable::contains) })
      WidgetSnapshot(true, json.getString("timeFormat").also { require(it == "12h" || it == "24h") }, events,
        json.getString("weekStartsOn").also { require(it == "monday" || it == "sunday") }, calendarDays,
        tasks, scope, lifecycle, generation, generatedAt, zone, eventsStatus, tasksStatus, readable)
    }
  } catch (_: Exception) { WidgetSnapshot(problem = SnapshotProblem.INVALID) }

  private val DATE_KEY = Regex("\\d{4}-\\d{2}-\\d{2}")
  private fun strings(array: JSONArray): List<String> = (0 until array.length()).map { array.getString(it) }
  private fun status(json: JSONObject, zone: String, covered: Boolean): WidgetSectionStatus {
    val state = json.getString("state").also { require(it in states) }
    val start = if (covered) json.getLong("coverageStart") else 0L
    val end = if (covered) json.getLong("coverageEnd") else Long.MAX_VALUE
    require(!covered || (start >= 0 && end >= start))
    val sectionZone = json.optString("timeZone", zone).also { require(it in zones) }
    return WidgetSectionStatus(state, if (json.isNull("lastSyncAt")) null else json.getLong("lastSyncAt"),
      start, end, json.getBoolean("complete"), json.getBoolean("truncated"), sectionZone)
  }

  fun sameZone(zone: String): Boolean = zone.isNotBlank() &&
    TimeZone.getTimeZone(zone).hasSameRules(TimeZone.getDefault())

  fun eventsUsable(snapshot: WidgetSnapshot, now: Long = System.currentTimeMillis()): Boolean =
    snapshot.signedIn == true && snapshot.problem == null &&
      sameZone(snapshot.eventsStatus.timeZone) &&
      now >= snapshot.eventsStatus.coverageStart && now < snapshot.eventsStatus.coverageEnd

  fun tasks(snapshot: WidgetSnapshot, selected: Set<String>?): List<WidgetTask> = snapshot.tasks
    .filter { it.status == "needs-action" || it.status == "in-process" }
    .filter { selected == null || it.calendarIds.any(selected::contains) }
    .sortedWith(compareBy<WidgetTask> { taskBucket(it) }.thenBy { it.due ?: Long.MAX_VALUE }
      .thenBy { if (it.priority == 0) 10 else it.priority }.thenBy { it.title.lowercase(Locale.getDefault()) }.thenBy { it.id })

  internal fun taskBucket(task: WidgetTask, now: Long = System.currentTimeMillis()): Int {
    if (task.due == null) return 3
    val day = dateKey(task.due, if (task.dueDateOnly) UTC else TimeZone.getDefault())
    val today = dateKey(now, TimeZone.getDefault())
    return if (day < today) 0 else if (day == today) 1 else 2
  }

  fun taskDue(task: WidgetTask, context: Context, timeFormat: String = "24h"): String {
    val due = task.due ?: return context.getString(R.string.musubi_widget_undated)
    val bucket = taskBucket(task)
    if (bucket == 1) return if (task.dueDateOnly) context.getString(R.string.musubi_widget_today)
      else SimpleDateFormat(if (timeFormat == "12h") "h:mm a" else "H:mm", Locale.getDefault()).format(Date(due))
    val relative = Calendar.getInstance().apply { add(Calendar.DAY_OF_MONTH, if (bucket == 0) -1 else 1) }
    if (dateKey(due, if (task.dueDateOnly) UTC else TimeZone.getDefault()) == dateKey(relative.timeInMillis, TimeZone.getDefault()))
      return context.getString(if (bucket == 0) R.string.musubi_widget_yesterday else R.string.musubi_widget_tomorrow)
    return SimpleDateFormat("d MMM", Locale.getDefault()).apply {
      if (task.dueDateOnly) timeZone = UTC
    }.format(Date(due))
  }

  fun upcoming(snapshot: WidgetSnapshot, now: Long = System.currentTimeMillis()): List<WidgetEvent> =
    snapshot.events
      .filter { event ->
        if (event.allDay) dateKey(event.end, UTC) >= dateKey(now, TimeZone.getDefault())
        else event.end >= now
      }
      .sortedWith(
        compareBy<WidgetEvent> { eventDateKey(it) }
          .thenBy { if (it.allDay) 0 else 1 }
          .thenBy { it.start },
      )

  fun eventTime(event: WidgetEvent, timeFormat: String, showEnd: Boolean): String {
    if (event.allDay) return "ALL"
    val pattern = if (timeFormat == "12h") "h:mm a" else "H:mm"
    val formatter = SimpleDateFormat(pattern, Locale.getDefault())
    val start = formatter.format(Date(event.start))
    if (!showEnd) return start
    if (timeFormat == "12h") {
      val meridiem = SimpleDateFormat("a", Locale.getDefault())
      if (meridiem.format(Date(event.start)) == meridiem.format(Date(event.end))) {
        val startWithoutMeridiem = SimpleDateFormat("h:mm", Locale.getDefault()).format(Date(event.start))
        return "$startWithoutMeridiem–${formatter.format(Date(event.end))}"
      }
    }
    return "$start–${formatter.format(Date(event.end))}"
  }

  fun eventDateLabel(event: WidgetEvent, compact: Boolean): String {
    val date = eventDate(event)
    val today = dateKey(System.currentTimeMillis(), TimeZone.getDefault())
    val tomorrowCalendar = Calendar.getInstance().apply { add(Calendar.DAY_OF_YEAR, 1) }
    val tomorrow = dateKey(tomorrowCalendar.timeInMillis, TimeZone.getDefault())
    val eventKey = dateKey(date.time, TimeZone.getDefault())
    return when (eventKey) {
      today -> ""
      tomorrow -> if (compact) "TMRW" else "TOMORROW"
      else -> SimpleDateFormat(if (compact) "EEE d" else "EEE d MMM", Locale.getDefault())
        .format(date)
        .uppercase(Locale.getDefault())
    }
  }

  fun eventMeta(event: WidgetEvent, showLocation: Boolean): String =
    listOf(event.calendarName, event.location.takeIf { showLocation })
      .filterNotNull()
      .filter { it.isNotBlank() }
      .joinToString("  ·  ")

  fun parseColor(value: String): Int = try {
    Color.parseColor(value)
  } catch (_: IllegalArgumentException) {
    Color.BLACK
  }

  private fun eventDateKey(event: WidgetEvent): Int =
    dateKey(event.start, if (event.allDay) UTC else TimeZone.getDefault())

  private fun eventDate(event: WidgetEvent): Date {
    if (!event.allDay) return Date(event.start)
    val utc = Calendar.getInstance(UTC).apply { timeInMillis = event.start }
    return Calendar.getInstance().apply {
      clear()
      set(utc.get(Calendar.YEAR), utc.get(Calendar.MONTH), utc.get(Calendar.DAY_OF_MONTH))
    }.time
  }

  private fun dateKey(epoch: Long, zone: TimeZone): Int {
    val calendar = Calendar.getInstance(zone).apply { timeInMillis = epoch }
    return calendar.get(Calendar.YEAR) * 10_000 +
      (calendar.get(Calendar.MONTH) + 1) * 100 +
      calendar.get(Calendar.DAY_OF_MONTH)
  }
}

internal enum class SnapshotProblem { NOT_LOADED, INVALID, UNSUPPORTED }

internal data class WidgetSectionStatus(
  val state: String = "unavailable", val lastSyncAt: Long? = null,
  val coverageStart: Long = 0, val coverageEnd: Long = 0,
  val complete: Boolean = false, val truncated: Boolean = false, val timeZone: String = "",
)

internal data class WidgetSnapshot(
  val signedIn: Boolean? = null, val timeFormat: String = "24h", val events: List<WidgetEvent> = emptyList(),
  val weekStartsOn: String = "monday", val calendarDays: Map<String, CalendarWidgetDay> = emptyMap(),
  val tasks: List<WidgetTask> = emptyList(), val scope: String = "", val lifecycle: Long = 0,
  val generation: Long = 0, val generatedAt: Long = 0, val timeZone: String = "",
  val eventsStatus: WidgetSectionStatus = WidgetSectionStatus(),
  val tasksStatus: WidgetSectionStatus = WidgetSectionStatus(), val readableCalendarIds: Set<String> = emptySet(),
  val problem: SnapshotProblem? = null,
)

internal data class CalendarWidgetDay(val colors: List<String>, val events: List<CalendarWidgetChip>, val count: Int)
internal data class CalendarWidgetChip(val title: String, val color: String, val calendarIds: List<String>,
  val id: String, val allDay: Boolean, val startKey: String, val endKey: String)
internal data class WidgetEvent(val key: String, val id: String, val title: String, val start: Long,
  val end: Long, val allDay: Boolean, val color: String, val calendarName: String, val location: String,
  val calendarIds: List<String>, val startKey: String, val endKey: String, val taskId: String? = null)
internal data class WidgetTask(val id: String, val title: String, val status: String, val priority: Int,
  val color: String, val calendarName: String, val calendarIds: List<String>, val due: Long?, val dueDateOnly: Boolean,
  val revision: Long = 0, val canComplete: Boolean = false, val shared: Boolean = false, val providerReadRetiredGeneration: Long = 0)
