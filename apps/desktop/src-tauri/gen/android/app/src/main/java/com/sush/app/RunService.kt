package com.sush.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.toBitmap

/**
 * Keeps the process alive while runs work, so leaving the app doesn't cut a reply short. It does
 * nothing itself: runs are in Rust. Up only while something is working; a run waiting for an
 * answer is saved, so it needs a notification but not the service. Main thread only.
 */
class RunService : Service() {
  private var wake: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    instance = this
    // Always first: Android ends an app whose service doesn't go to the foreground once started.
    val type = if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0
    try {
      ServiceCompat.startForeground(this, WORKING_ID, workingNotification(this), type)
    } catch (e: Exception) {
      // The day's background time is used up: runs still work while the app is open.
      Log.w("Sush", "couldn't keep runs going in the background", e)
      stopSelf()
      return START_NOT_STICKY
    }
    if (working.isEmpty()) end() else hold()
    return START_NOT_STICKY
  }

  /** Android 15+ limits this kind of service to 6 hours a day. */
  override fun onTimeout(startId: Int, fgsType: Int) {
    end()
  }

  override fun onDestroy() {
    wake?.let { if (it.isHeld) it.release() }
    wake = null
    if (instance === this) instance = null
    super.onDestroy()
  }

  private fun hold() {
    val lock = wake ?: (getSystemService(Context.POWER_SERVICE) as PowerManager)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sush:runs")
      .apply { setReferenceCounted(false) }
      .also { wake = it }
    // Renewed as runs change; a stuck one can't hold it for good.
    lock.acquire(30 * 60 * 1000L)
  }

  private fun end() {
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    stopSelf()
    if (instance === this) instance = null
  }

  companion object {
    private const val WORKING = "working"
    private const val ANSWERS = "answers"
    private const val WORKING_ID = 1
    private const val ANSWER_ID = 2
    private const val DONE_ID = 3

    private var instance: RunService? = null
    private var working: List<String> = emptyList()
    private var waiting: Set<String> = emptySet()

    fun update(context: Context, runs: RunsArgs) {
      working = runs.working.toList()
      channels(context)
      val service = instance
      when {
        service != null && working.isEmpty() -> service.end()
        service != null -> {
          service.hold()
          notify(context, WORKING_ID, workingNotification(context))
        }
        working.isNotEmpty() -> try {
          context.startForegroundService(Intent(context, RunService::class.java))
        } catch (e: Exception) {
          // Not allowed from the background (an automation, say): the run goes on while Android lets it.
          Log.w("Sush", "couldn't start the run service", e)
        }
      }

      val now = runs.waiting.map { it.id }.toSet()
      val new = runs.waiting.filter { it.id !in waiting }
      waiting = now
      if (now.isEmpty()) manager(context).cancel(ANSWER_ID)
      else if (new.isNotEmpty() && !MainActivity.visible) {
        notify(context, ANSWER_ID, notification(context, ANSWERS, "Sush needs your answer", new.last().title).build())
      }
      runs.finished?.let {
        if (!MainActivity.visible) {
          val title = if (it.failed) "Sush ran into a problem" else "Sush is done"
          notify(context, DONE_ID, notification(context, ANSWERS, title, it.title).build())
        }
      }
    }

    /** The app is on screen, which shows all of this. */
    fun appShown(context: Context) {
      manager(context).cancel(ANSWER_ID)
      manager(context).cancel(DONE_ID)
    }

    private fun workingNotification(context: Context): Notification =
      notification(context, WORKING, "Sush is working", if (working.size > 1) "${working.size} sessions" else working.firstOrNull() ?: "")
        .setOngoing(true)
        .setAutoCancel(false)
        .setOnlyAlertOnce(true)
        .build()

    private fun notification(context: Context, channel: String, title: String, text: String): NotificationCompat.Builder {
      val open = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      val tap = PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      // The lock screen shows what happened ("Sush is done"), not which session.
      val locked = NotificationCompat.Builder(context, channel)
        .setSmallIcon(R.drawable.ic_notification)
        .setColor(SALMON)
        .setLargeIcon(sushi(context))
        .setContentTitle(title)
        .setContentIntent(tap)
        .build()
      return NotificationCompat.Builder(context, channel)
        .setSmallIcon(R.drawable.ic_notification)
        .setColor(SALMON)
        .setLargeIcon(sushi(context))
        .setContentTitle(title)
        .setContentText(text)
        .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        .setPublicVersion(locked)
        .setContentIntent(tap)
        .setAutoCancel(true)
    }

    private const val SALMON = 0xFFF0533F.toInt()
    private var sushiIcon: Bitmap? = null

    /** The mascot, drawn at a whole number of pixels per sprite pixel so its edges stay sharp. */
    private fun sushi(context: Context): Bitmap? = sushiIcon ?: try {
      ContextCompat.getDrawable(context, R.drawable.notification_sushi)?.toBitmap(176, 176)?.also { sushiIcon = it }
    } catch (e: Exception) {
      Log.w("Sush", "couldn't draw the notification icon", e)
      null
    }

    private fun manager(context: Context) = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    private fun notify(context: Context, id: Int, notification: Notification) = manager(context).notify(id, notification)

    private fun channels(context: Context) {
      manager(context).createNotificationChannel(NotificationChannel(WORKING, "Working", NotificationManager.IMPORTANCE_LOW))
      manager(context).createNotificationChannel(NotificationChannel(ANSWERS, "Answers and approvals", NotificationManager.IMPORTANCE_DEFAULT))
    }
  }
}
