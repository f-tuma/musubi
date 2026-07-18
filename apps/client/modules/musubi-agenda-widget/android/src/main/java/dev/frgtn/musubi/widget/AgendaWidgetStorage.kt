package dev.frgtn.musubi.widget

import android.content.Context

internal object AgendaWidgetStorage {
  private const val PREFERENCES = "musubi_agenda_widget"
  private const val SNAPSHOT = "snapshot"
  private const val SIGNED_OUT_SNAPSHOT =
    "{\"version\":1,\"signedIn\":false,\"generatedAt\":0,\"timeFormat\":\"24h\",\"events\":[]}"

  fun read(context: Context): String? =
    context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
      .getString(SNAPSHOT, null)

  fun write(context: Context, snapshot: String) {
    context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
      .edit()
      .putString(SNAPSHOT, snapshot)
      .apply()
  }

  fun markSignedOut(context: Context) = write(context, SIGNED_OUT_SNAPSHOT)
}
