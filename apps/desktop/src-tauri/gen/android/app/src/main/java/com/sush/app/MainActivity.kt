package com.sush.app

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    // Before Tauri starts: its setup reads secrets.
    Vault.unlock(this)
    super.onCreate(savedInstanceState)
    if (loaded) {
      // Tauri can't build a second webview in one process; the page would stay blank.
      startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
      Runtime.getRuntime().exit(0)
    }
    loaded = true
    // Keep the page clear of the status bar, the navigation bar, a cutout and the keyboard.
    ViewCompat.setOnApplyWindowInsetsListener(findViewById<View>(android.R.id.content)) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }

  override fun onResume() {
    super.onResume()
    visible = true
    RunService.appShown(this)
  }

  override fun onPause() {
    visible = false
    super.onPause()
  }

  /**
   * Back asks the page first (`window.__sushBack` in lib/back.ts closes or leaves whatever opened
   * last), and with nothing left leaves Sush in the background, like Home, so runs carry on. This
   * runs for the key and the edge swipe alike (the manifest turns predictive back off).
   */
  @Deprecated("Tauri's back handling still calls this")
  override fun onBackPressed() {
    val web = findWebView(window.decorView)
    if (web == null) {
      moveTaskToBack(true)
      return
    }
    web.evaluateJavascript("window.__sushBack ? window.__sushBack() : false") { handled ->
      if (handled != "true") moveTaskToBack(true)
    }
  }

  private fun findWebView(v: View): WebView? {
    if (v is WebView) return v
    if (v is ViewGroup) for (i in 0 until v.childCount) findWebView(v.getChildAt(i))?.let { return it }
    return null
  }

  companion object {
    /** This process has already built its webview. */
    private var loaded = false

    /** The app is on screen. */
    var visible = false
      private set
  }
}
