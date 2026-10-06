package dev.frgtn.musubi.widget

import org.json.JSONObject
import java.util.UUID

internal data class WidgetTaskAction(val taskId: String, val revision: Long, val scope: String, val providerReadRetiredGeneration: Long)
internal data class IssuedWidgetAction(val raw: String, val token: String)
internal data class TakenWidgetAction(val raw: String, val action: WidgetTaskAction?)

/** An arbitrary deep link cannot authorize a write. Only a bounded, single-use
 * ticket issued for an actual widget control can ask the app to complete a task. */
internal object WidgetTaskActions {
  const val MAX_ACTIONS = 512
  const val LIFETIME_MS = 86_400_000L
  private fun entries(raw: String?): JSONObject = try { JSONObject(raw ?: "{}") } catch (_: Exception) { JSONObject() }
  private fun live(item: JSONObject, scope: String, now: Long): Boolean {
    val issued = item.optLong("issued", -1)
    return item.optString("scope") == scope && issued >= 0 && now >= issued && now - issued < LIFETIME_MS
      && item.optLong("revision") > 0 && item.optString("taskId").isNotBlank()
  }
  fun issue(raw: String?, scope: String, taskId: String, revision: Long, now: Long, retiredGeneration: Long = 0): IssuedWidgetAction {
    require(scope.isNotBlank() && taskId.isNotBlank() && revision > 0)
    val old = entries(raw)
    val next = JSONObject()
    for (token in old.keys()) {
      val item = old.optJSONObject(token) ?: continue
      if (live(item, scope, now)) next.put(token, item)
    }
    for (token in next.keys()) {
      val item = next.getJSONObject(token)
      if (item.getString("taskId") == taskId && item.getLong("revision") == revision && item.optLong("retiredGeneration") == retiredGeneration)
        return IssuedWidgetAction(next.toString(), token)
    }
    while (next.length() >= MAX_ACTIONS) {
      val oldest = next.keys().asSequence().minByOrNull { next.getJSONObject(it).getLong("issued") } ?: break
      next.remove(oldest)
    }
    val token = UUID.randomUUID().toString()
    next.put(token, JSONObject().put("scope", scope).put("taskId", taskId).put("revision", revision).put("retiredGeneration", retiredGeneration).put("issued", now))
    return IssuedWidgetAction(next.toString(), token)
  }
  fun take(raw: String?, token: String, currentScope: String?, requestedScope: String, now: Long): TakenWidgetAction {
    val next = entries(raw)
    val item = next.optJSONObject(token)
    val valid = currentScope == requestedScope && item != null && live(item, requestedScope, now)
    if (valid) next.remove(token)
    return TakenWidgetAction(next.toString(), if (valid) WidgetTaskAction(item!!.getString("taskId"),
      item.getLong("revision"), requestedScope, item.optLong("retiredGeneration")) else null)
  }
}
