package com.sush.app

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.activity.result.ActivityResult
import androidx.core.app.ActivityCompat
import androidx.core.content.FileProvider
import androidx.core.view.WindowCompat
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import kotlin.concurrent.thread

@InvokeArg
class PickArgs {
  var mimeTypes: Array<String> = arrayOf()
  var multiple: Boolean = false
}

@InvokeArg
class ShareArgs {
  lateinit var path: String
}

@InvokeArg
class BarsArgs {
  var dark: Boolean = false
}

@InvokeArg
class WaitingRun {
  var id: String = ""
  var title: String = ""
}

@InvokeArg
class FinishedRun {
  var id: String = ""
  var title: String = ""
  var failed: Boolean = false
}

@InvokeArg
class RunsArgs {
  var working: Array<String> = arrayOf()
  var waiting: Array<WaitingRun> = arrayOf()
  var finished: FinishedRun? = null
}

/** What Rust asks of Android (`src/android.rs`). Rejections are sentences for the user. */
@TauriPlugin
class SushPlugin(private val activity: Activity) : Plugin(activity) {
  private val picked = File(activity.cacheDir, "picked")

  init {
    // Files picked or shared last time have been read by now.
    thread {
      val old = System.currentTimeMillis() - 24 * 3600 * 1000L
      for (dir in listOf(picked, File(activity.cacheDir, "exports"))) {
        dir.listFiles()?.filter { it.lastModified() < old }?.forEach { it.deleteRecursively() }
      }
    }
  }

  @Command
  fun pickFiles(invoke: Invoke) {
    val args = invoke.parseArgs(PickArgs::class.java)
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
      .addCategory(Intent.CATEGORY_OPENABLE)
      .setType(if (args.mimeTypes.size == 1) args.mimeTypes[0] else "*/*")
      .putExtra(Intent.EXTRA_MIME_TYPES, args.mimeTypes)
      .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, args.multiple)
    try {
      startActivityForResult(invoke, intent, "filesPicked")
    } catch (e: Exception) {
      invoke.reject("This phone has no app to pick files with.")
    }
  }

  @ActivityCallback
  fun filesPicked(invoke: Invoke, result: ActivityResult) {
    val data = result.data
    val uris = mutableListOf<Uri>()
    if (result.resultCode == Activity.RESULT_OK && data != null) {
      val clip = data.clipData
      if (clip != null) for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri)
      else data.data?.let { uris.add(it) }
    }
    // Copying may download from a cloud drive, so not on the main thread.
    thread {
      try {
        val paths = JSArray()
        uris.forEachIndexed { i, uri -> paths.put(copy(uri, i).path) }
        invoke.resolve(JSObject().apply { put("paths", paths) })
      } catch (e: Exception) {
        invoke.reject("Couldn't read that file. If it's in a cloud drive, download it first.")
      }
    }
  }

  private fun copy(uri: Uri, index: Int): File {
    val resolver = activity.contentResolver
    var name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
      if (it.moveToFirst()) it.getString(0) else null
    } ?: "file"
    // The name comes from another app: only its last part, so it can't point elsewhere.
    name = File(name).name.ifEmpty { "file" }
    if (File(name).extension.isEmpty()) {
      MimeTypeMap.getSingleton().getExtensionFromMimeType(resolver.getType(uri))?.let { name = "$name.$it" }
    }
    val dir = File(picked, "${System.nanoTime()}-$index").apply { mkdirs() }
    val file = File(dir, name)
    require(file.canonicalFile.parentFile == dir.canonicalFile)
    resolver.openInputStream(uri)!!.use { input -> file.outputStream().use { input.copyTo(it) } }
    return file
  }

  @Command
  fun shareFile(invoke: Invoke) {
    val file = File(invoke.parseArgs(ShareArgs::class.java).path)
    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
    val type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase()) ?: "application/octet-stream"
    val send = Intent(Intent.ACTION_SEND)
      .setType(type)
      .putExtra(Intent.EXTRA_STREAM, uri)
      .putExtra(Intent.EXTRA_SUBJECT, file.name)
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    send.clipData = ClipData.newRawUri(file.name, uri)
    activity.startActivity(Intent.createChooser(send, file.name))
    invoke.resolve()
  }

  @Command
  fun bars(invoke: Invoke) {
    val dark = invoke.parseArgs(BarsArgs::class.java).dark
    activity.runOnUiThread {
      activity.window.decorView.setBackgroundColor(if (dark) DARK else LIGHT)
      WindowCompat.getInsetsController(activity.window, activity.window.decorView).apply {
        isAppearanceLightStatusBars = !dark
        isAppearanceLightNavigationBars = !dark
      }
      invoke.resolve()
    }
  }

  /** The runs in flight changed: keep the app going while they work, and say when they need the user. */
  @Command
  fun runs(invoke: Invoke) {
    val args = invoke.parseArgs(RunsArgs::class.java)
    activity.runOnUiThread {
      if (args.working.isNotEmpty() && MainActivity.visible) askToNotify()
      RunService.update(activity.applicationContext, args)
      invoke.resolve()
    }
  }

  /** Once, with the first run: without it, Sush can't say a run needs an answer. Runs work either way. */
  private fun askToNotify() {
    if (Build.VERSION.SDK_INT < 33) return
    val permission = android.Manifest.permission.POST_NOTIFICATIONS
    if (ActivityCompat.checkSelfPermission(activity, permission) == PackageManager.PERMISSION_GRANTED) return
    val prefs = activity.getSharedPreferences("notifications", Activity.MODE_PRIVATE)
    if (prefs.getBoolean("asked", false)) return
    prefs.edit().putBoolean("asked", true).apply()
    ActivityCompat.requestPermissions(activity, arrayOf(permission), 71)
  }

  private companion object {
    /** `--background` in index.css, light and dark. */
    val LIGHT = 0xFFFCFEFE.toInt()
    val DARK = 0xFF050708.toInt()
  }
}
