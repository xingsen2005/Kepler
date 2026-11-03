package com.kepler.bucketmg.apk.ui.files

import com.kepler.bucketmg.apk.data.model.FsEntry

/**
 * 目录排序：**文件夹恒在前**（一律按名称升序），文件随后按 [mode] 排序。
 *
 * 抽成顶层纯函数（不依赖 ViewModel / Android 框架）以便单元测试覆盖。
 *
 * 关于「修改时间」排序：`FsEntry.lastModified` 是服务端原始字符串，这里按字符串降序比较。
 * 服务端统一返回 ISO8601 UTC（如 `2026-11-03T07:00:00Z`），该格式的字典序与时间序一致，
 * 因此结果正确；若将来服务端混用多种时间格式，需改为先解析为 `Instant` 再比较。
 */
fun sortEntries(list: List<FsEntry>, mode: SortMode): List<FsEntry> {
    val (folders, files) = list.partition { it.isFolder }
    val sortedFiles = when (mode) {
        SortMode.NAME -> files.sortedBy { it.name.lowercase() }
        SortMode.SIZE -> files.sortedByDescending { it.size }
        SortMode.TIME -> files.sortedByDescending { it.lastModified }
    }
    return folders.sortedBy { it.name.lowercase() } + sortedFiles
}
