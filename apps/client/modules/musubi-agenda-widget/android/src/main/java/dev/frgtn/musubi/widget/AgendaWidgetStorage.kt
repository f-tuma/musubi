package dev.frgtn.musubi.widget

import android.content.Context
import org.json.JSONObject

/** One persisted session fence shared by every provider and bridge operation. */
internal object AgendaWidgetStorage {
  private const val PREFERENCES = "musubi_agenda_widget"
  private const val SNAPSHOT = "snapshot"
  private const val SCOPE = "scope"
  private const val LIFECYCLE = "lifecycle"
  private const val GENERATION = "generation"
  private const val ACTIONS = "task_actions"
  const val MAX_BYTES = 2_097_152

  private fun preferences(context: Context) = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
  @Synchronized fun read(context: Context): String? = preferences(context).getString(SNAPSHOT, null)
  @Synchronized fun scope(context: Context): String? = preferences(context).getString(SCOPE, null)
  @Synchronized fun revision(context: Context): WidgetRevision = preferences(context).let {
    WidgetRevision(it.getString(SCOPE, null), it.getLong(LIFECYCLE, 0), it.getLong(GENERATION, 0))
  }

  @Synchronized fun beginSession(context: Context, scope: String): Long {
    require(scope.isNotBlank()) { "Widget scope must be nonempty" }
    val preferences = preferences(context)
    val changed = preferences.getString(SCOPE, null) != scope
    val lifecycle = preferences.getLong(LIFECYCLE, 0) + 1
    val edit = preferences.edit().putString(SCOPE, scope).putLong(LIFECYCLE, lifecycle).putLong(GENERATION, 0)
    if (changed) {
      edit.remove(SNAPSHOT)
      edit.remove(ACTIONS)
      CalendarWidgetPreferences.clear(context)
    }
    check(edit.commit()) { "Could not persist widget session" }
    return lifecycle
  }

  @Synchronized fun taskCompletion(context: Context, scope: String, task: WidgetTask): String? {
    if (AgendaWidgetStorage.scope(context) != scope || !task.canComplete || task.revision <= 0) return null
    val preferences = preferences(context)
    val previous = preferences.getString(ACTIONS, null)
    val issued = WidgetTaskActions.issue(previous, scope, task.id, task.revision, System.currentTimeMillis(), task.providerReadRetiredGeneration)
    return if (previous == issued.raw || preferences.edit().putString(ACTIONS, issued.raw).commit()) issued.token else null
  }

  @Synchronized fun consumeTaskCompletion(context: Context, token: String, scope: String): WidgetTaskAction? {
    val preferences = preferences(context)
    val taken = WidgetTaskActions.take(preferences.getString(ACTIONS, null), token, AgendaWidgetStorage.scope(context), scope, System.currentTimeMillis())
    return if (preferences.edit().putString(ACTIONS, taken.raw).commit()) taken.action else null
  }

  @Synchronized fun write(context: Context, raw: String): Boolean {
    require(raw.toByteArray(Charsets.UTF_8).size <= MAX_BYTES) { "Widget snapshot exceeds byte budget" }
    val incoming = AgendaWidgetData.parse(raw)
    require(incoming.problem == null && incoming.signedIn == true) { "Invalid widget snapshot" }
    val preferences = preferences(context)
    if (!WidgetInvariants.accepts(preferences.getString(SCOPE, null), preferences.getLong(LIFECYCLE, 0),
        preferences.getLong(GENERATION, 0), incoming.scope, incoming.lifecycle, incoming.generation)) return false
    val merged = mergeSnapshot(raw, preferences.getString(SNAPSHOT, null))
    check(preferences.edit().putString(SNAPSHOT, merged).putLong(GENERATION, incoming.generation).commit()) {
      "Could not persist widget snapshot"
    }
    return true
  }

  /** Pure JSON reconciliation, also exercised by the JVM regression runner. */
  internal fun mergeSnapshot(raw: String, previousRaw: String?): String {
    val next = JSONObject(raw)
    val previous = previousRaw?.let { stored ->
      AgendaWidgetData.parse(stored).takeIf { it.problem == null && it.scope == next.getString("scope") }
        ?.let { JSONObject(stored) }
    }
    if (previous != null) {
      retainSection(next, previous, "events", "eventsStatus", listOf("calendarDays"))
      retainSection(next, previous, "tasks", "tasksStatus")
    }
    pruneMemberships(next)
    val tasksStatus = next.getJSONObject("tasksStatus")
    if (tasksStatus.getString("state") == "unavailable" && !tasksStatus.optBoolean("preservePrevious", false)) {
      next.put("tasks", org.json.JSONArray())
      val events = next.getJSONArray("events")
      val removed = HashSet<String>()
      val safe = org.json.JSONArray()
      for (index in 0 until events.length()) {
        val event = events.getJSONObject(index)
        if (event.optString("taskId").isNotBlank()) removed.add(event.getString("key")) else safe.put(event)
      }
      next.put("events", safe)
      val days = next.getJSONArray("calendarDays")
      for (index in 0 until days.length()) {
        val day = days.getJSONObject(index)
        val keys = day.getJSONArray("eventKeys")
        val safeKeys = org.json.JSONArray()
        for (keyIndex in 0 until keys.length()) {
          val key = keys.getString(keyIndex)
          if (key !in removed) safeKeys.put(key)
        }
        day.put("eventKeys", safeKeys)
      }
    }
    fitBudget(next)
    val merged = next.toString()
    require(merged.toByteArray(Charsets.UTF_8).size <= MAX_BYTES) { "Retained snapshot exceeds byte budget" }
    require(AgendaWidgetData.parse(merged).problem == null) { "Invalid retained widget snapshot" }
    return merged
  }

  private fun pruneMemberships(next: JSONObject) {
    val readable = next.getJSONArray("readableCalendarIds").let { ids ->
      (0 until ids.length()).map { ids.getString(it) }.toSet()
    }
    val tasksStatus = next.getJSONObject("tasksStatus")
    val preserveTasks = tasksStatus.optBoolean("preservePrevious", false)
    val retainedEvents = next.getJSONObject("eventsStatus").optBoolean("preservePrevious", false)
    val taskIds = next.getJSONArray("tasks").let { rows ->
      (0 until rows.length()).map { rows.getJSONObject(it).getString("id") }.toSet()
    }
    val keptKeys = HashSet<String>()
    for (section in listOf("events", "tasks")) {
      val rows = next.getJSONArray(section)
      val safe = org.json.JSONArray()
      for (index in 0 until rows.length()) {
        val row = rows.getJSONObject(index)
        val memberships = row.getJSONArray("calendarIds")
        val allowed = (0 until memberships.length()).map { memberships.getString(it) }.filter(readable::contains)
        val taskId = row.optString("taskId")
        if (allowed.isEmpty() || (section == "events" && retainedEvents && taskId.isNotBlank() && !preserveTasks && taskId !in taskIds)) continue
        if (allowed.size != memberships.length()) row.put("calendarName", "")
        row.put("calendarIds", org.json.JSONArray(allowed))
        safe.put(row)
        if (section == "events") keptKeys.add(row.getString("key"))
      }
      next.put(section, safe)
    }
    pruneDayReferences(next, keptKeys)
  }

  private fun pruneDayReferences(next: JSONObject, keys: Set<String>) {
    val days = next.getJSONArray("calendarDays")
    val safe = org.json.JSONArray()
    for (index in 0 until days.length()) {
      val day = days.getJSONObject(index)
      val references = day.getJSONArray("eventKeys")
      val kept = (0 until references.length()).map { references.getString(it) }.filter(keys::contains)
      if (kept.isNotEmpty()) safe.put(day.put("eventKeys", org.json.JSONArray(kept)))
    }
    next.put("calendarDays", safe)
  }

  /** Budget pressure can trim cached display rows; it cannot veto a newer removal. */
  private fun fitBudget(next: JSONObject) {
    while (next.toString().toByteArray(Charsets.UTF_8).size > MAX_BYTES) {
      val section = if (next.getJSONObject("eventsStatus").optBoolean("preservePrevious", false) &&
        next.getJSONArray("events").length() > 0) "events"
      else if (next.getJSONObject("tasksStatus").optBoolean("preservePrevious", false) &&
        next.getJSONArray("tasks").length() > 0) "tasks"
      else if (next.getJSONArray("events").length() > 0) "events" else "tasks"
      val rows = next.getJSONArray(section)
      require(rows.length() > 0) { "Widget metadata exceeds byte budget" }
      val keep = (rows.length() - maxOf(1, rows.length() / 8)).coerceAtLeast(0)
      val trimmed = org.json.JSONArray()
      for (index in 0 until keep) trimmed.put(rows.get(index))
      next.put(section, trimmed)
      next.getJSONObject("${section}Status").put("complete", false).put("truncated", true)
      if (section == "events") pruneDayReferences(next,
        (0 until trimmed.length()).map { trimmed.getJSONObject(it).getString("key") }.toSet())
    }
  }

  private fun retainSection(next: JSONObject, previous: JSONObject, data: String, status: String,
    related: List<String> = emptyList()) {
    val nextStatus = next.getJSONObject(status)
    if (!nextStatus.optBoolean("preservePrevious", false) || next.getJSONArray(data).length() != 0) return
    val previousStatus = previous.getJSONObject(status)
    if (previous.getJSONArray(data).length() == 0 && previousStatus.getString("state") != "ready") return
    next.put(data, previous.getJSONArray(data))
    related.forEach { next.put(it, previous.getJSONArray(it)) }
    val retained = JSONObject(previousStatus.toString()).put("state", nextStatus.getString("state"))
      .put("preservePrevious", true)
    retained.put("timeZone", previousStatus.optString("timeZone", previous.getString("timeZone")))
    next.put(status, retained)
  }

  @Synchronized fun markSignedOut(context: Context) {
    val preferences = preferences(context)
    check(preferences.edit().remove(SCOPE).remove(ACTIONS).putLong(LIFECYCLE, preferences.getLong(LIFECYCLE, 0) + 1)
      .putLong(GENERATION, 0).putString(SNAPSHOT, "{\"version\":2,\"signedIn\":false}").commit()) {
      "Could not clear widget snapshot"
    }
    CalendarWidgetPreferences.clear(context)
  }
}
