package com.kepler.bucketmg.apk.ui

import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
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
    // 三位数以上不保留小数，避免「1023.9 KB」这类过长的读数；
    // 原实现在 i == 0 时强制取整，会把 1536 B 显示成「2 KB」，已修正为「1.5 KB」
    return if (v >= 100) {
        String.format(Locale.CHINA, "%.0f %s", v, units[i])
    } else {
        String.format(Locale.CHINA, "%.1f %s", v, units[i])
    }
}

/** 输出格式：本地时区的「年-月-日 时:分」。DateTimeFormatter 不可变，天然线程安全。 */
private val OUTPUT_FORMAT: DateTimeFormatter =
    DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm", Locale.CHINA)

/**
 * 解析服务端返回的时间并格式化为**本地时区**显示。
 *
 * 关键点：旧实现把 ISO8601 里的 `Z` 当作字面量、且未设 UTC 时区解析，
 * 导致 UTC 时间被当成当地时间 → 东八区下显示值比真实时间**早 8 小时**。
 * 同时旧实现共享一个 SimpleDateFormat 实例，在列表并发渲染时非线程安全。
 *
 * 支持（按优先级）：
 *  - `2026-11-03T07:00:00Z` / 带毫秒 / 带 `+08:00` 偏移  → 按声明时区解析后转本地
 *  - `2026-11-03T07:00:00.123456`（无时区）              → 视为 UTC
 *  - `2026-11-03 07:00:00`（无时区）                     → 视为 UTC
 *  - `Tue, 03 Nov 2026 07:00:00 GMT`（RFC1123）          → 按 GMT 解析
 *  - `2026-11-03`（仅日期）                              → 直接原样显示
 *
 * 全部无法解析时原样返回可读片段，避免界面丢失信息。
 */
fun formatTime(raw: String): String {
    val s = raw.trim()
    if (s.isEmpty()) return "—"

    val zone = ZoneId.systemDefault()

    // 1) 带 Z / 偏移的 ISO8601（最准确，按声明时区解析）
    parseInstant(s)?.let { instant ->
        return OUTPUT_FORMAT.format(instant.atZone(zone))
    }

    // 2) 无时区的日期时间：服务端以 UTC 存储，按 UTC 解释
    parseLocalDateTime(s)?.let { ldt ->
        return OUTPUT_FORMAT.format(ldt.toInstant(ZoneOffset.UTC).atZone(zone))
    }

    // 3) 仅日期
    runCatching { LocalDate.parse(s) }.getOrNull()?.let { d -> return d.toString() }

    // 4) 兜底：尽力截取成可读形式
    return s.take(16).replace('T', ' ')
}

/** 依次尝试 Instant / OffsetDateTime / ZonedDateTime / RFC1123 */
private fun parseInstant(s: String): Instant? {
    runCatching { return Instant.parse(s) }
    runCatching { return OffsetDateTime.parse(s).toInstant() }
    runCatching { return ZonedDateTime.parse(s).toInstant() }
    runCatching { return ZonedDateTime.parse(s, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant() }
    return null
}

/** 解析无时区的「日期 时间」，兼容空格与 T 分隔、有无秒/毫秒 */
private fun parseLocalDateTime(s: String): LocalDateTime? {
    val normalized = s.replace(' ', 'T')
    runCatching { return LocalDateTime.parse(normalized) }
    runCatching { return LocalDateTime.parse(normalized, DateTimeFormatter.ISO_LOCAL_DATE_TIME) }
    runCatching {
        return LocalDateTime.parse(normalized, DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm"))
    }
    return null
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
