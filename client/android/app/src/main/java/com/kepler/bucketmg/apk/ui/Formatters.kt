package com.kepler.bucketmg.apk.ui

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.roundToInt

/** 人类可读的文件大小 */
fun formatBytes(bytes: Long): String {
    if (bytes < 1024) return "$bytes B"
    val units = listOf("KB", "MB", "GB", "TB", "PB")
    var v = bytes.toDouble() / 1024
    var i = 0
    while (v >= 1024 && i < units.size - 1) {
        v /= 1024
        i++
    }
    return if (v >= 100 || i == 0) {
        String.format(Locale.CHINA, "%.0f %s", v, units[i])
    } else {
        String.format(Locale.CHINA, "%.1f %s", v, units[i])
    }
}

private val dateFormat = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.CHINA)

/** 解析服务端时间（ISO8601 / RFC1123 均有可能）并格式化；失败原样返回 */
fun formatTime(raw: String): String {
    if (raw.isBlank()) return "—"
    val patterns = listOf(
        "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
        "yyyy-MM-dd'T'HH:mm:ss'Z'",
        "yyyy-MM-dd'T'HH:mm:ss",
        "yyyy-MM-dd HH:mm:ss",
        "EEE, dd MMM yyyy HH:mm:ss zzz",
    )
    for (p in patterns) {
        try {
            val sdf = SimpleDateFormat(p, Locale.US)
            val d = sdf.parse(raw)
            if (d != null) return dateFormat.format(Date(d.time))
        } catch (_: Exception) {
        }
    }
    // 兜底：只取日期部分
    return raw.take(16).replace('T', ' ')
}

/** 配额展示：0 = 无限制 */
fun formatQuota(bytes: Long): String = if (bytes <= 0) "无限制" else formatBytes(bytes)

/** 从对象键提取文件扩展名（不含点，小写） */
fun extOf(name: String): String {
    val i = name.lastIndexOf('.')
    return if (i in 0 until name.length - 1) name.substring(i + 1).lowercase(Locale.ROOT) else ""
}

/** 速度限制展示：0 = 不限速 */
fun formatSpeed(bytesPerSec: Long): String =
    if (bytesPerSec <= 0) "不限速" else "${formatBytes(bytesPerSec)}/s"

/** 百分比（保留整数） */
fun percent(part: Long, total: Long): Int =
    if (total <= 0) 0 else ((part.toDouble() / total) * 100).roundToInt().coerceIn(0, 100)
