package com.hitl.inbox

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.provider.MediaStore
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/** Opens the system camera without requesting camera permission ourselves.
 * Scanning returns through the existing hitl-inbox://connect deep link. */
@TauriPlugin
class ConnectionPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun openQrScanner(invoke: Invoke) {
    try {
      activity.startActivity(Intent(MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA))
      invoke.resolve()
    } catch (_: ActivityNotFoundException) {
      invoke.reject("No camera app is available. Open your camera manually, scan the desktop QR, and tap the HITL Inbox link.")
    }
  }
}
