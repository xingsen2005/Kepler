package com.kepler.bucketmg.apk.ui.files

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.kepler.bucketmg.apk.data.SessionManager
import com.kepler.bucketmg.apk.data.model.BucketInfo
import com.kepler.bucketmg.apk.data.model.FsEntry
import com.kepler.bucketmg.apk.data.model.FsListResult
import com.kepler.bucketmg.apk.data.net.ApiException
import com.kepler.bucketmg.apk.service.DownloadService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID

/** 排序方式 */
enum class SortMode(val label: String) {
    NAME("名称"), SIZE("大小"), TIME("修改时间")
}

/** 上传任务状态 */
enum class UploadState { PENDING, RUNNING, DONE, FAILED }

data class UploadTask(
    val id: String = UUID.randomUUID().toString(),
    val uri: Uri,
    val name: String,
    val key: String,
    val totalBytes: Long,
    val sentBytes: Long = 0,
    val state: UploadState = UploadState.PENDING,
    val error: String = "",
)

/** 单文件操作面板 */
data class FileActionTarget(val entry: FsEntry)

class FilesViewModel(app: Application) : AndroidViewModel(app) {

    private val api get() = SessionManager.api()

    /* ---- 存储桶 ---- */
    val buckets = MutableStateFlow<List<BucketInfo>>(emptyList())
    val activeBucketId = MutableStateFlow("")

    /* ---- 目录浏览 ---- */
    val prefix = MutableStateFlow("")
    val entries = MutableStateFlow<List<FsEntry>>(emptyList())
    val loading = MutableStateFlow(false)
    val refreshing = MutableStateFlow(false)
    val error = MutableStateFlow<String?>(null)
    val sortMode = MutableStateFlow(SortMode.NAME)

    /* ---- 多选 ---- */
    val selectedKeys = MutableStateFlow<Set<String>>(emptySet())
    val selectionMode = MutableStateFlow(false)

    /* ---- 复制剪贴板（相对键列表；非空时显示粘贴提示） ---- */
    val clipboard = MutableStateFlow<List<String>?>(null)

    /* ---- 上传 ---- */
    val uploads = MutableStateFlow<List<UploadTask>>(emptyList())

    /* ---- 消息（Snackbar） ---- */
    val message = MutableStateFlow<String?>(null)

    /* ---- 单文件操作面板 ---- */
    val actionTarget = MutableStateFlow<FileActionTarget?>(null)

    val activeBucket: BucketInfo?
        get() = buckets.value.firstOrNull { it.id == activeBucketId.value }

    init {
        loadBuckets()
    }

    fun consumeMessage() {
        message.value = null
    }

    /* ============================ 数据加载 ============================ */

    fun loadBuckets() {
        viewModelScope.launch {
            try {
                val r = api.buckets()
                buckets.value = r.buckets
                activeBucketId.value = r.activeBucketId
                if (r.buckets.isEmpty()) {
                    error.value = "没有可访问的存储桶，请联系管理员分配"
                } else {
                    load(prefix.value)
                }
            } catch (e: Exception) {
                error.value = e.displayMessage()
            }
        }
    }

    fun refresh() {
        loadBuckets()
    }

    fun load(p: String, showSpinner: Boolean = true) {
        viewModelScope.launch {
            if (showSpinner) loading.value = true
            error.value = null
            try {
                val r: FsListResult = api.list(prefix = p)
                prefix.value = r.prefix
                entries.value = sortEntries(r.entries)
                loading.value = false
                refreshing.value = false
            } catch (e: Exception) {
                loading.value = false
                refreshing.value = false
                error.value = e.displayMessage()
            }
        }
    }

    private fun sortEntries(list: List<FsEntry>): List<FsEntry> {
        val folders = list.filter { it.isFolder }
        val files = list.filter { !it.isFolder }
        val sortedFiles = when (sortMode.value) {
            SortMode.NAME -> files.sortedBy { it.name.lowercase() }
            SortMode.SIZE -> files.sortedByDescending { it.size }
            SortMode.TIME -> files.sortedByDescending { it.lastModified }
        }
        return folders.sortedBy { it.name.lowercase() } + sortedFiles
    }

    fun setSortMode(mode: SortMode) {
        sortMode.value = mode
        entries.value = sortEntries(entries.value)
    }

    /* ============================ 目录导航 ============================ */

    /** 进入文件夹 */
    fun enterFolder(entry: FsEntry) {
        selectedKeys.value = emptySet()
        selectionMode.value = false
        load(entry.key)
    }

    /** 跳转到指定前缀（面包屑用） */
    fun navigateTo(p: String) {
        selectedKeys.value = emptySet()
        selectionMode.value = false
        load(p)
    }

    /** 返回上一级 */
    fun navigateUp(): Boolean {
        val p = prefix.value
        if (p.isEmpty()) return false
        val trimmed = p.trimEnd('/')
        val idx = trimmed.lastIndexOf('/')
        val parent = if (idx >= 0) trimmed.substring(0, idx + 1) else ""
        load(parent)
        return true
    }

    /* ============================ 存储桶切换 ============================ */

    fun switchBucket(id: String) {
        if (id == activeBucketId.value) return
        viewModelScope.launch {
            try {
                api.setActiveBucket(id)
                activeBucketId.value = id
                prefix.value = ""
                selectedKeys.value = emptySet()
                selectionMode.value = false
                clipboard.value = null
                load("")
                message.value = "已切换存储桶"
            } catch (e: Exception) {
                message.value = e.displayMessage()
            }
        }
    }

    /* ============================ 多选 ============================ */

    fun beginSelection(entry: FsEntry) {
        selectionMode.value = true
        toggleSelect(entry)
    }

    fun toggleSelect(entry: FsEntry) {
        val cur = selectedKeys.value
        selectedKeys.value = if (cur.contains(entry.key)) cur - entry.key else cur + entry.key
        if (selectedKeys.value.isEmpty()) selectionMode.value = false
    }

    fun selectAll() {
        selectedKeys.value = entries.value.map { it.key }.toSet()
    }

    fun clearSelection() {
        selectedKeys.value = emptySet()
        selectionMode.value = false
    }

    /* ============================ 复制 / 粘贴 ============================ */

    /** 将当前多选内容放入复制剪贴板 */
    fun copySelection() {
        val keys = selectedKeys.value.toList()
        if (keys.isEmpty()) return
        clipboard.value = keys
        clearSelection()
        message.value = "已复制 ${keys.size} 项，前往目标目录后点「粘贴」"
    }

    /** 复制单个文件 / 文件夹 */
    fun copyEntry(key: String) {
        clipboard.value = listOf(key)
        message.value = "已复制 1 项，前往目标目录后点「粘贴」"
    }

    /** 粘贴剪贴板内容到当前目录 */
    fun paste() {
        val keys = clipboard.value ?: return
        if (keys.isEmpty()) return
        clipboard.value = null
        viewModelScope.launch {
            try {
                api.copy(keys, prefix.value)
                load(prefix.value, showSpinner = false)
                message.value = "已复制 ${keys.size} 项到当前目录"
            } catch (e: Exception) {
                message.value = e.displayMessage()
            }
        }
    }

    fun clearClipboard() {
        clipboard.value = null
    }

    /* ============================ 文件操作 ============================ */

    fun delete(keys: List<String>) {
        viewModelScope.launch {
            try {
                val results = api.delete(keys)
                val failed = results.filter { !it.ok }
                clearSelection()
                load(prefix.value)
                if (failed.isEmpty()) {
                    message.value = "已删除 ${results.size} 项"
                } else {
                    message.value = "部分删除失败：${failed.first().error}"
                }
            } catch (e: Exception) {
                message.value = e.displayMessage()
            }
        }
    }

    fun download(entries: List<FsEntry>) {
        val files = entries.filter { !it.isFolder }
        if (files.isEmpty()) {
            message.value = "文件夹不支持下载"
            return
        }
        val ctx = getApplication<Application>()
        DownloadService.start(ctx, files.map { it.key to it.name })
        message.value = "开始下载 ${files.size} 个文件"
    }

    /* ============================ 上传 ============================ */

    fun upload(uris: List<Uri>) {
        if (uris.isEmpty()) return
        viewModelScope.launch {
            val newTasks = mutableListOf<UploadTask>()
            for (uri in uris) {
                val (name, size) = queryUri(uri)
                val key = prefix.value + name
                newTasks += UploadTask(uri = uri, name = name, key = key, totalBytes = size)
            }
            uploads.value = uploads.value + newTasks
            for (t in newTasks) {
                runUpload(t)
            }
        }
    }

    private suspend fun queryUri(uri: Uri): Pair<String, Long> = withContext(Dispatchers.IO) {
        var name = "upload_${System.currentTimeMillis()}"
        var size = 0L
        try {
            getApplication<Application>().contentResolver.query(
                uri, null, null, null, null,
            )?.use { c ->
                if (c.moveToFirst()) {
                    val ni = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                    val si = c.getColumnIndex(android.provider.OpenableColumns.SIZE)
                    if (ni >= 0) name = c.getString(ni) ?: name
                    if (si >= 0) size = c.getLong(si)
                }
            }
        } catch (_: Exception) {
        }
        name to size
    }

    private suspend fun runUpload(task: UploadTask) {
        updateTask(task.id) { it.copy(state = UploadState.RUNNING) }
        try {
            val uploader = com.kepler.bucketmg.apk.data.repo.FileUploader(getApplication())
            uploader.upload(
                uri = task.uri,
                key = task.key,
                totalBytes = task.totalBytes,
                onProgress = { sent -> updateTask(task.id) { it.copy(sentBytes = sent) } },
            )
            updateTask(task.id) { it.copy(state = UploadState.DONE, sentBytes = it.totalBytes) }
            load(prefix.value, showSpinner = false)
        } catch (e: Exception) {
            updateTask(task.id) {
                it.copy(state = UploadState.FAILED, error = e.displayMessage())
            }
        }
    }

    fun clearFinishedUploads() {
        uploads.value = uploads.value.filter { it.state == UploadState.RUNNING || it.state == UploadState.PENDING }
    }

    private fun updateTask(id: String, transform: (UploadTask) -> UploadTask) {
        uploads.value = uploads.value.map { if (it.id == id) transform(it) else it }
    }
}

/** 统一错误文案 */
fun Exception.displayMessage(): String = when (this) {
    is ApiException -> message
    else -> message ?: "操作失败"
}
