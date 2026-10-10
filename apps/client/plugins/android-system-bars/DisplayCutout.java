package dev.frgtn.musubi.compat;

import android.os.Build;
import android.view.WindowManager;

/** Edge-to-edge cutouts use ALWAYS on API 30+, older systems retain their safe default. */
public final class DisplayCutout {
  private DisplayCutout() {}

  public static void allowContent(WindowManager.LayoutParams attributes) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      attributes.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS;
    }
  }
}
