package com.kepler.bucketmg.apk.ui

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import java.util.TimeZone

/**
 * 时间与数值格式化。
 *
 * 重点覆盖 [formatTime] 的时区换算——这正是 P1 轮修掉的缺陷：
 * 旧实现把 ISO8601 末尾的 `Z` 当作字面量、未按 UTC 解析，
 * 导致东八区下显示值比真实时间早 8 小时。
 */
class FormattersTest {

    private lateinit var originalZone: TimeZone

    @Before
    fun pinTimeZone() {
        originalZone = TimeZone.getDefault()
        // 固定为东八区，使断言与运行机器所在时区无关
        TimeZone.setDefault(TimeZone.getTimeZone("Asia/Shanghai"))
    }

    @After
    fun restoreTimeZone() {
        TimeZone.setDefault(originalZone)
    }

    // ---------------- formatTime ----------------

    @Test
    fun `UTC 时间按本地时区换算`() {
        // 07:00Z == 东八区 15:00 —— 旧实现显示 07:00
        assertEquals("2026-11-03 15:00", formatTime("2026-11-03T07:00:00Z"))
    }

    @Test
    fun `带毫秒的 UTC 时间`() {
        assertEquals("2026-11-03 15:00", formatTime("2026-11-03T07:00:00.123Z"))
    }

    @Test
    fun `带显式偏移的时间按声明时区解析`() {
        // 已是东八区 15:00，不应再被换算一次
        assertEquals("2026-11-03 15:00", formatTime("2026-11-03T15:00:00+08:00"))
        // 同一时刻的零时区写法
        assertEquals("2026-11-03 15:00", formatTime("2026-11-03T07:00:00+00:00"))
    }

    @Test
    fun `无时区的时间视为 UTC`() {
        assertEquals("2026-11-03 15:00", formatTime("2026-11-03 07:00:00"))
        assertEquals("2026-11-03 15:00", formatTime("2026-11-03T07:00:00"))
        // 只有到分钟
        assertEquals("2026-11-03 15:00", formatTime("2026-11-03T07:00"))
    }

    @Test
    fun `RFC1123 时间按 GMT 解析`() {
        assertEquals("2026-11-03 15:00", formatTime("Tue, 03 Nov 2026 07:00:00 GMT"))
    }

    @Test
    fun `仅日期原样返回`() {
        assertEquals("2026-11-03", formatTime("2026-11-03"))
    }

    @Test
    fun `空字符串返回占位符`() {
        assertEquals("—", formatTime(""))
        assertEquals("—", formatTime("   "))
    }

    @Test
    fun `无法解析时保留可读片段而不是丢弃`() {
        assertEquals("unknown", formatTime("unknown"))
        // 超长脏数据截断到 16 字符（恰好切到分钟），且 T 替换为空格
        assertEquals("2026-11-03 07:00", formatTime("2026-11-03T07:00:00+unknown-suffix"))
    }

    // ---------------- formatBytes ----------------

    @Test
    fun `小于 1KB 显示字节`() {
        assertEquals("0 B", formatBytes(0))
        assertEquals("1023 B", formatBytes(1023))
    }

    @Test
    fun `KB 保留一位小数`() {
        // 1536 B 曾被显示成「2 KB」（i == 0 时强制取整），已修正
        assertEquals("1.5 KB", formatBytes(1536))
        assertEquals("1.0 KB", formatBytes(1024))
    }

    @Test
    fun `超过 100 不保留小数`() {
        assertEquals("100 KB", formatBytes(102_400))
    }

    @Test
    fun `单位随量级递进`() {
        assertEquals("1.0 MB", formatBytes(1024L * 1024))
        assertEquals("1.0 GB", formatBytes(1024L * 1024 * 1024))
        assertEquals("1.0 TB", formatBytes(1024L * 1024 * 1024 * 1024))
    }

    // ---------------- 其他 ----------------

    @Test
    fun `配额 0 与负数表示无限制`() {
        assertEquals("无限制", formatQuota(0))
        assertEquals("无限制", formatQuota(-1))
        assertEquals("1.0 KB", formatQuota(1024))
    }

    @Test
    fun `扩展名提取`() {
        assertEquals("gz", extOf("a.tar.gz"))
        assertEquals("png", extOf("PICTURE.PNG"))
        assertEquals("", extOf("noext"))
        assertEquals("", extOf("trailing."))
        assertEquals("", extOf(""))
    }

    @Test
    fun `百分比计算并夹逼到 0 到 100`() {
        assertEquals(0, percent(0, 0))
        assertEquals(0, percent(5, 0))
        assertEquals(50, percent(50, 100))
        assertEquals(33, percent(1, 3))
        // 越界数据不应产生 105% / -10% 这类读数
        assertEquals(100, percent(200, 100))
        assertEquals(0, percent(-10, 100))
    }

    @Test
    fun `速度为 0 表示不限速`() {
        assertEquals("不限速", formatSpeed(0))
        assertEquals("1.0 KB/s", formatSpeed(1024))
    }
}
