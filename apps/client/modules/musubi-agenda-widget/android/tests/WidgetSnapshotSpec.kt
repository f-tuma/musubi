package dev.frgtn.musubi.widget

import org.json.JSONArray
import org.json.JSONObject
import java.util.TimeZone

/** Executes production parser/reconciliation code; no Android device or test library required. */
fun main() {
  var passed = 0
  fun test(name: String, body: () -> Unit) {
    body()
    passed++
    println("PASS $name")
  }
  fun merged(next: JSONObject, previous: JSONObject? = null) = JSONObject(
    AgendaWidgetStorage.mergeSnapshot(next.toString(), previous?.toString()))

  test("valid versioned receipt and distinct simultaneous occurrence IDs") {
    val raw = snapshot(events = listOf(event("a"), event("b")))
    check(AgendaWidgetData.parse(raw.toString()).problem == null)
    val ids = WidgetInvariants.stableIds(listOf("a:10", "b:10", "a:11"))
    check(ids.distinct().size == 3 && ids == WidgetInvariants.stableIds(listOf("a:10", "b:10", "a:11")))
  }
  test("unsupported malformed duplicate and dangling references fail explicitly") {
    check(AgendaWidgetData.parse("{\"version\":1}").problem == SnapshotProblem.UNSUPPORTED)
    check(AgendaWidgetData.parse("{").problem == SnapshotProblem.INVALID)
    check(AgendaWidgetData.parse(snapshot(events = listOf(event("a"), event("a"))).toString()).problem == SnapshotProblem.INVALID)
    val dangling = snapshot()
    dangling.put("calendarDays", JSONArray().put(JSONObject().put("date", "2026-10-05").put("eventKeys", JSONArray().put("gone"))))
    check(AgendaWidgetData.parse(dangling.toString()).problem == SnapshotProblem.INVALID)
  }
  test("stale account lifecycle and generation receipts are rejected") {
    check(WidgetInvariants.accepts("one", 3, 8, "one", 3, 9))
    check(!WidgetInvariants.accepts("one", 3, 8, "two", 3, 9))
    check(!WidgetInvariants.accepts("one", 3, 8, "one", 2, 99))
    check(!WidgetInvariants.accepts("one", 3, 8, "one", 3, 8))
    check(!WidgetInvariants.accepts(null, 4, 0, "one", 3, 99))
  }
  test("only explicit preserve retains prior rows original zone and sync metadata") {
    val old = snapshot(events = listOf(event("cached")))
    old.put("timeZone", "Europe/Prague")
    old.getJSONObject("eventsStatus").put("lastSyncAt", 99)
    val next = snapshot()
    next.getJSONObject("eventsStatus").put("state", "error").put("complete", false).put("preservePrevious", true)
    val kept = merged(next, old)
    check(kept.getJSONArray("events").length() == 1)
    val state = kept.getJSONObject("eventsStatus")
    check(state.getString("state") == "error" && state.getLong("lastSyncAt") == 99L)
    check(state.getString("timeZone") == "Europe/Prague" && state.getBoolean("preservePrevious"))
    next.getJSONObject("eventsStatus").put("preservePrevious", false)
    check(merged(next, old).getJSONArray("events").length() == 0)
    next.put("scope", "other")
    next.getJSONObject("eventsStatus").put("preservePrevious", true)
    check(merged(next, old).getJSONArray("events").length() == 0)
  }
  test("retained unreadable memberships and their day references are pruned") {
    val old = snapshot(events = listOf(event("removed", listOf("private")), event("mixed", listOf("public", "private"))), readable = listOf("public", "private"))
    val next = snapshot(readable = listOf("public"))
    next.getJSONObject("eventsStatus").put("state", "error").put("preservePrevious", true)
    val safe = merged(next, old)
    val rows = safe.getJSONArray("events")
    check(rows.length() == 1 && rows.getJSONObject(0).getString("key") == "mixed")
    check(rows.getJSONObject(0).getJSONArray("calendarIds").toString() == "[\"public\"]")
    check(rows.getJSONObject(0).getString("calendarName").isEmpty())
    check(safe.getJSONArray("calendarDays").getJSONObject(0).getJSONArray("eventKeys").toString() == "[\"mixed\"]")
  }
  test("retained task markers follow current authoritative task removals") {
    val old = snapshot(events = listOf(event("marker").put("taskId", "task")), tasks = listOf(task("task")))
    val next = snapshot()
    next.getJSONObject("eventsStatus").put("state", "error").put("preservePrevious", true)
    val safe = merged(next, old)
    check(safe.getJSONArray("events").length() == 0 && safe.getJSONArray("calendarDays").length() == 0)
    next.getJSONObject("tasksStatus").put("state", "loading").put("preservePrevious", true)
    check(merged(next, old).getJSONArray("events").length() == 1)
  }
  test("new completed task markers retain app calendar semantics") {
    val next = snapshot(events = listOf(event("completed-marker").put("taskId", "completed")))
    check(merged(next).getJSONArray("events").length() == 1)
  }
  test("unauthorized tasks purge rows and markers even with retained events") {
    val old = snapshot(events = listOf(event("event"), event("marker").put("taskId", "task")), tasks = listOf(task("task")))
    val next = snapshot()
    next.getJSONObject("eventsStatus").put("state", "error").put("preservePrevious", true)
    next.getJSONObject("tasksStatus").put("state", "unavailable").put("preservePrevious", false)
    val safe = merged(next, old)
    check(safe.getJSONArray("tasks").length() == 0)
    check(safe.getJSONArray("events").length() == 1 && safe.getJSONArray("events").getJSONObject(0).getString("key") == "event")
  }
  test("timezone aliases work and expired or mismatched calendar coverage does not") {
    val original = TimeZone.getDefault()
    try {
      TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
      val parsed = AgendaWidgetData.parse(snapshot().toString())
      check(AgendaWidgetData.sameZone("GMT"))
      check(AgendaWidgetData.eventsUsable(parsed, 100))
      check(!AgendaWidgetData.eventsUsable(parsed, 10_000))
      check(!AgendaWidgetData.eventsUsable(parsed.copy(eventsStatus = parsed.eventsStatus.copy(timeZone = "Europe/Prague")), 100))
    } finally { TimeZone.setDefault(original) }
  }
  test("empty all-day lane gaps reserve their vertical slot") {
    check(WidgetInvariants.reserveLane(0, 1, 3))
    check(WidgetInvariants.reserveLane(1, 1, 3))
    check(!WidgetInvariants.reserveLane(2, 1, 3))
    check(!WidgetInvariants.reserveLane(3, 4, 3))
  }
  test("merged payload trims retained display rows without vetoing newer tasks") {
    val huge = "x".repeat(8000)
    val old = snapshot(events = (0 until 170).map { event("e$it").put("title", huge) })
    val next = snapshot(tasks = (0 until 170).map { task("t$it").put("title", huge) })
    check(old.toString().toByteArray().size < AgendaWidgetStorage.MAX_BYTES)
    check(next.toString().toByteArray().size < AgendaWidgetStorage.MAX_BYTES)
    next.getJSONObject("eventsStatus").put("state", "error").put("preservePrevious", true)
    val safe = merged(next, old)
    check(safe.toString().toByteArray().size <= AgendaWidgetStorage.MAX_BYTES)
    check(safe.getJSONArray("events").length() < 170 && safe.getJSONArray("tasks").length() == 170)
    check(!safe.getJSONObject("eventsStatus").getBoolean("complete") && safe.getJSONObject("eventsStatus").getBoolean("truncated"))
    check(AgendaWidgetData.parse(safe.toString()).problem == null)
  }
  println("$passed native widget invariants passed")
}

private fun snapshot(events: List<JSONObject> = emptyList(), tasks: List<JSONObject> = emptyList(),
  readable: List<String> = listOf("public")): JSONObject = JSONObject()
  .put("version", 2).put("signedIn", true).put("scope", "one").put("lifecycle", 3).put("generation", 9)
  .put("generatedAt", 100).put("timeZone", "UTC").put("timeFormat", "24h").put("weekStartsOn", "monday")
  .put("readableCalendarIds", JSONArray(readable)).put("eventsStatus", status(true)).put("tasksStatus", status(false))
  .put("events", JSONArray(events)).put("tasks", JSONArray(tasks))
  .put("calendarDays", if (events.isEmpty()) JSONArray() else JSONArray().put(JSONObject().put("date", "2026-10-05")
    .put("eventKeys", JSONArray(events.map { it.getString("key") }))))

private fun status(events: Boolean) = JSONObject().put("state", "ready").put("lastSyncAt", 100)
  .put("complete", true).put("truncated", false).apply {
    if (events) put("coverageStart", 0).put("coverageEnd", 10_000)
  }

private fun event(key: String, calendars: List<String> = listOf("public")) = JSONObject()
  .put("key", key).put("id", key).put("title", "Meeting").put("start", 100).put("end", 200).put("allDay", false)
  .put("color", "#333333").put("calendarName", "Calendar").put("calendarIds", JSONArray(calendars))
  .put("startKey", "2026-10-05").put("endKey", "2026-10-05")

private fun task(id: String) = JSONObject().put("id", id).put("title", "Task").put("status", "needs-action")
  .put("priority", 0).put("color", "#333333").put("calendarName", "Calendar")
  .put("calendarIds", JSONArray().put("public")).put("due", JSONObject.NULL).put("dueDateOnly", false)
