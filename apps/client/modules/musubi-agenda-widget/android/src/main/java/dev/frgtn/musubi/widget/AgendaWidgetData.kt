package dev.frgtn.musubi.widget

import android.content.Context
import android.graphics.Color
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

internal object AgendaWidgetData {
  private val UTC: TimeZone = TimeZone.getTimeZone("UTC")

  fun read(context: Context): WidgetSnapshot {
    val raw = AgendaWidgetStorage.read(context)
      ?: return WidgetSnapshot(null, "24h", emptyList())
    return try {
      val json = JSONObject(raw)
      val array = json.optJSONArray("events")
      val events = buildList {
        if (array != null) {
          for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            add(
              WidgetEvent(
                id = item.optString("id"),
                title = item.optString("title"),
                start = item.optLong("start"),
                end = item.optLong("end"),
                allDay = item.optBoolean("allDay"),
                color = item.optString("color"),
                calendarName = item.optString("calendarName"),
                location = item.optString("location"),
              ),
            )
          }
        }
      }
      val calendarDays = buildMap {
        val days = json.optJSONArray("calendarDays")
        if (days != null) {
          for (index in 0 until days.length()) {
            val item = days.optJSONObject(index) ?: continue
            val date = item.optString("date")
            val colors = item.optJSONArray("colors")
            if (date.isBlank() || colors == null) continue
            val parsedColors = buildList {
              for (colorIndex in 0 until colors.length()) {
                val color = colors.optString(colorIndex)
                if (color.isNotBlank()) add(color)
              }
            }
            val parsedEvents = buildList {
              val events = item.optJSONArray("events")
              if (events != null) {
                for (eventIndex in 0 until events.length()) {
                  val event = events.optJSONObject(eventIndex) ?: continue
                  add(
                    CalendarWidgetChip(
                      title = event.optString("title"),
                      color = event.optString("color"),
                      calendarIds = buildList {
                        val ids = event.optJSONArray("calendarIds")
                        if (ids != null) {
                          for (idIndex in 0 until ids.length()) {
                            val id = ids.optString(idIndex)
                            if (id.isNotBlank()) add(id)
                          }
                        }
                      },
                    ),
                  )
                }
              }
            }
            put(
              date,
              CalendarWidgetDay(
                colors = parsedColors,
                events = parsedEvents,
                count = item.optInt("count", parsedEvents.size),
              ),
            )
          }
        }
      }
      WidgetSnapshot(
        signedIn = if (json.has("signedIn")) json.optBoolean("signedIn") else null,
        timeFormat = json.optString("timeFormat", "24h"),
        events = events,
        weekStartsOn = json.optString("weekStartsOn", "monday"),
        showKanji = json.optBoolean("showKanji", true),
        calendarDays = calendarDays,
      )
    } catch (_: Exception) {
      WidgetSnapshot(null, "24h", emptyList())
    }
  }

  fun upcoming(snapshot: WidgetSnapshot, now: Long = System.currentTimeMillis()): List<WidgetEvent> =
    snapshot.events
      .filter { event ->
        if (event.allDay) dateKey(event.end, UTC) > dateKey(now, TimeZone.getDefault())
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
    val formatter = SimpleDateFormat(pattern, Locale.UK)
    val start = formatter.format(Date(event.start))
    if (!showEnd) return start
    if (timeFormat == "12h") {
      val meridiem = SimpleDateFormat("a", Locale.UK)
      if (meridiem.format(Date(event.start)) == meridiem.format(Date(event.end))) {
        val startWithoutMeridiem = SimpleDateFormat("h:mm", Locale.UK).format(Date(event.start))
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
      today -> "TODAY"
      tomorrow -> if (compact) "TMRW" else "TOMORROW"
      else -> SimpleDateFormat(if (compact) "EEE d" else "EEE d MMM", Locale.UK)
        .format(date)
        .uppercase(Locale.UK)
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
    Color.parseColor("#c8553d")
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

internal data class WidgetSnapshot(
  val signedIn: Boolean?,
  val timeFormat: String,
  val events: List<WidgetEvent>,
  val weekStartsOn: String = "monday",
  val showKanji: Boolean = true,
  val calendarDays: Map<String, CalendarWidgetDay> = emptyMap(),
)

internal data class CalendarWidgetDay(
  val colors: List<String>,
  val events: List<CalendarWidgetChip>,
  val count: Int,
)

internal data class CalendarWidgetChip(
  val title: String,
  val color: String,
  val calendarIds: List<String> = emptyList(),
)

internal data class WidgetEvent(
  val id: String,
  val title: String,
  val start: Long,
  val end: Long,
  val allDay: Boolean,
  val color: String,
  val calendarName: String,
  val location: String,
)
