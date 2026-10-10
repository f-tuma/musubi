package dev.frgtn.musubi.widget

/** Android-free invariants, exercised by the standalone Kotlin regression runner. */
internal object WidgetInvariants {
  fun accepts(activeScope: String?, lifecycle: Long, generation: Long,
    incomingScope: String, incomingLifecycle: Long, incomingGeneration: Long): Boolean =
    activeScope != null && activeScope == incomingScope && lifecycle == incomingLifecycle && incomingGeneration > generation

  fun stableIds(keys: List<String>): List<Long> {
    val used = HashSet<Long>()
    return keys.map { key ->
      var id = -3750763034362895579L
      key.toByteArray(Charsets.UTF_8).forEach { byte -> id = (id xor (byte.toLong() and 255)) * 1099511628211L }
      while (!used.add(id)) id++
      id
    }
  }

  fun reserveLane(slot: Int, lastOccupiedLane: Int, limit: Int): Boolean = slot < limit && slot <= lastOccupiedLane
}

/** The factory captures storage's active revision, including adoption of same-scope cached data. */
internal data class WidgetRevision(val scope: String?, val lifecycle: Long, val generation: Long)
