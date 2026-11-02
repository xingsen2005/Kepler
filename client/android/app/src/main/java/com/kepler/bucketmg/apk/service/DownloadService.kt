package com.kepler.bucketmg.apk.service

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.provider.MediaStore
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import com.kepler.bucketmg.apk.KeplerApp
import com.kepler.bucketmg.apk.R
import com.kepler.bucketmg.apk.data.SessionManager
import com.kepler.bucketmg.apk.data.net.ApiClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Request
import java.io.IOException

/**
 * 下载前台服务：
 *  - 从 Kepler 流式拉取文件，直接写入 MediaStore「下载/Kepler」目录（无需存储权限）
 *  - 前台通知展示总体进度，支持取消
 *  - API 34：显式 dataSync 前台服务类型
 */
class DownloadService : Service() {

    companion object {
        private const val EXTRA_KEYS = "keys"
        private const val EXTRA_NAMES = "names"
        private const val ACTION_CANCEL = "com.kepler.bucketmg.apk.action.CANCEL_DOWNLOAD"
        private const val NOTIF_ID = 1001

        /** @param items 对象键 → 文件名 */
        fun start(context: Context, items: List<Pair<String, String>>) {
            val intent = Intent(context, DownloadService::class.java).apply {
                putStringArrayListExtra(EXTRA_KEYS, ArrayList(items.map { it.first }))
                putStringArrayListExtra(EXTRA_NAMES, ArrayList(items.map { it.second }))
            }
            context.startService(intent)
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Volatile
    private var canceled = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ServiceCompat.startForeground(
            this, NOTIF_ID, buildNotification("准备下载", 0, 0, false),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_CANCEL) {
            cancel()
            return START_NOT_STICKY
        }
        val keys = intent?.getStringArrayListExtra(EXTRA_KEYS).orEmpty()
        val names = intent?.getStringArrayListExtra(EXTRA_NAMES).orEmpty()
        if (keys.isEmpty()) {
            stopSelf()
            return START_NOT_STICKY
        }
        scope.launch {
            var done = 0
            var failed = 0
            var lastError = ""
            var lastUri: Uri? = null
            var lastMime = "application/octet-stream"
            for (i in keys.indices) {
                if (canceled) break
                val r = downloadOne(keys[i], names.getOrElse(i) { keys[i] }, i, keys.size)
                if (r.ok) {
                    done++
                    lastUri = r.uri
                    lastMime = r.mime
                } else {
                    failed++
                    lastError = names.getOrElse(i) { keys[i] }
                }
            }
            finish(done, failed, lastError, canceled, lastUri, lastMime)
        }
        return START_NOT_STICKY
    }

    private data class OneResult(val ok: Boolean, val uri: Uri? = null, val mime: String = "application/octet-stream")

    /** 下载单个文件 */
    private suspend fun downloadOne(key: String, name: String, index: Int, total: Int): OneResult =
        withContext(Dispatchers.IO) {
            val safeName = name.substringAfterLast('/').ifBlank { "download_$index" }
            var resultUri: Uri? = null
            var mime = "application/octet-stream"
            try {
                val req = Request.Builder()
                    .url("${SessionManager.baseUrl}/api/fs/download?path=${Uri.encode(key)}")
                    .build()
                val resp = ApiClient.transfer().newCall(req).execute()
                resp.use { r ->
                    if (!r.isSuccessful) {
                        val body = r.body?.string().orEmpty()
                        throw IOException(com.kepler.bucketmg.apk.data.net.ApiException
                            .fromBody(r.code, body).message)
                    }
                    val body = r.body ?: throw IOException("空响应")
                    mime = guessMime(safeName)
                    val resolver = applicationContext.contentResolver
                    val values = ContentValues().apply {
                        put(MediaStore.Downloads.DISPLAY_NAME, safeName)
                        put(MediaStore.Downloads.MIME_TYPE, mime)
                        put(
                            MediaStore.Downloads.RELATIVE_PATH,
                            android.os.Environment.DIRECTORY_DOWNLOADS + "/Kepler",
                        )
                        put(MediaStore.Downloads.IS_PENDING, 1)
                    }
                    val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                        ?: throw IOException("无法创建下载文件")
                    resultUri = uri
                    val out = resolver.openOutputStream(uri)
                        ?: throw IOException("无法写入下载文件")
                    val totalBytes = body.contentLength()
                    var copied = 0L
                    out.use { o ->
                        val buf = ByteArray(64 * 1024)
                        val input = body.byteStream()
                        var read = input.read(buf)
                        while (read > 0 && !canceled) {
                            o.write(buf, 0, read)
                            copied += read
                            updateNotification(
                                safeName,
                                copied,
                                if (totalBytes > 0) totalBytes else -1,
                                index,
                                total,
                            )
                            read = input.read(buf)
                        }
                        o.flush()
                    }
                    if (canceled) {
                        // 取消：删除半成品
                        runCatching { resolver.delete(uri, null, null) }
                        return@withContext OneResult(false)
                    }
                    // 落盘完成，解除 pending
                    val doneValues = ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }
                    resolver.update(uri, doneValues, null, null)
                }
                OneResult(true, resultUri, mime)
            } catch (e: Exception) {
                resultUri?.let {
                    runCatching { applicationContext.contentResolver.delete(it, null, null) }
                }
                OneResult(false)
            }
        }

    private fun finish(
        done: Int,
        failed: Int,
        lastError: String,
        wasCanceled: Boolean,
        lastUri: Uri?,
        lastMime: String,
    ) {
        val text = when {
            wasCanceled -> "下载已取消（已完成 $done 个）"
            failed == 0 -> "已下载 $done 个文件至 下载/Kepler"
            else -> "完成 $done 个，失败 $failed 个（$lastError）"
        }
        val builder = NotificationCompat.Builder(this, KeplerApp.CHANNEL_DOWNLOAD)
            .setSmallIcon(R.drawable.ic_stat_download)
            .setContentTitle(if (failed == 0 && !wasCanceled) "下载完成" else "下载结束")
            .setContentText(text)
            .setOngoing(false)
            .setAutoCancel(true)
        // 点击通知打开最后一个文件
        if (lastUri != null) {
            val openIntent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(lastUri, lastMime)
                flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK
            }
            val pi = PendingIntent.getActivity(
                this, 2, openIntent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            builder.setContentIntent(pi)
        }
        notify(builder.build())
        stopForeground(STOP_FOREGROUND_DETACH)
        stopSelf()
    }

    private fun buildNotification(
        title: String,
        progress: Long,
        max: Long,
        indeterminate: Boolean,
    ): Notification {
        val cancelIntent = PendingIntent.getService(
            this, 1,
            Intent(this, DownloadService::class.java).setAction(ACTION_CANCEL),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, KeplerApp.CHANNEL_DOWNLOAD)
            .setSmallIcon(R.drawable.ic_stat_download)
            .setContentTitle(title)
            .setProgress(
                if (max > 0) 100 else 0,
                if (max > 0) ((progress * 100) / max).toInt() else 0,
                indeterminate,
            )
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(0, "取消", cancelIntent)
            .build()
    }

    private fun updateNotification(
        name: String,
        progress: Long,
        total: Long,
        index: Int,
        totalCount: Int,
    ) {
        val title = if (totalCount > 1) "正在下载 ${index + 1}/$totalCount：$name" else "正在下载 $name"
        notify(buildNotification(title, progress, total, total <= 0))
    }

    private fun notify(n: Notification) {
        try {
            NotificationManagerCompat.from(this).notify(NOTIF_ID, n)
        } catch (_: SecurityException) {
            // 未授予通知权限：前台服务通知静默，下载继续
        }
    }

    /** 取消当前下载 */
    private fun cancel() {
        canceled = true
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun guessMime(name: String): String {
        val ext = name.substringAfterLast('.', "").lowercase()
        return android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
            ?: "application/octet-stream"
    }
}
