package com.hitl.inbox

import android.content.Intent
import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    applySystemBarInsets()
    stashImport(intent)
  }

  // Edge-to-edge is enforced on current Android versions. Pad the native content
  // container rather than the WebView document so fullscreen controls stay above
  // the status/navigation bars. Freeform windows (including DeX) report no such
  // insets, so their existing layout is unchanged.
  private fun applySystemBarInsets() {
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, windowInsets ->
      val bars = windowInsets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      windowInsets
    }
    ViewCompat.requestApplyInsets(content)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    stashImport(intent)
  }

  // A scanned hitl-inbox:// link carries the whole connection (server, topic,
  // key). Tauri's Android app_data_dir is the private app-data root (the parent
  // of filesDir), which is also where Rust keeps the HITL config. Park the link
  // there for the WebView to claim exactly once via take_pending_import. It is
  // deleted on read, and this file is the only place the link ever touches disk;
  // nothing is logged.
  private fun stashImport(intent: Intent?) {
    if (intent?.action != Intent.ACTION_VIEW) return
    val uri = intent.dataString ?: return
    if (!uri.startsWith("hitl-inbox://connect?")) return
    if (uri.length > 2048) return
    val appDataDir = filesDir.parentFile ?: return
    File(appDataDir, "pending-connection-import").writeText(uri)
  }
}
