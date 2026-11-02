package com.kepler.bucketmg.apk.ui.files

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.CloudDownload
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Sort
import androidx.compose.material.icons.filled.Storage
import androidx.compose.material.icons.filled.TableChart
import androidx.compose.material.icons.filled.InsertDriveFile
import androidx.compose.material.icons.filled.FolderZip
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.kepler.bucketmg.apk.data.model.BucketInfo
import com.kepler.bucketmg.apk.data.model.FsEntry
import com.kepler.bucketmg.apk.data.model.UserInfo
import com.kepler.bucketmg.apk.ui.components.ConfirmDialog
import com.kepler.bucketmg.apk.ui.components.ErrorBox
import com.kepler.bucketmg.apk.ui.components.InfoRow
import com.kepler.bucketmg.apk.ui.formatBytes
import com.kepler.bucketmg.apk.ui.formatTime
import com.kepler.bucketmg.apk.ui.main.AccountAction

/**
 * 文件浏览器：浏览 / 上传 / 下载 / 复制 / 删除。
 * （新建文件夹、重命名等管理操作不在本客户端范围内。）
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun FilesScreen(
    user: UserInfo,
    onLogout: () -> Unit,
    vm: FilesViewModel = viewModel(),
) {
    val context = LocalContext.current
    val entries by vm.entries.collectAsStateWithLifecycle()
    val loading by vm.loading.collectAsStateWithLifecycle()
    val refreshing by vm.refreshing.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()
    val prefix by vm.prefix.collectAsStateWithLifecycle()
    val buckets by vm.buckets.collectAsStateWithLifecycle()
    val activeBucketId by vm.activeBucketId.collectAsStateWithLifecycle()
    val selected by vm.selectedKeys.collectAsStateWithLifecycle()
    val selectionMode by vm.selectionMode.collectAsStateWithLifecycle()
    val uploads by vm.uploads.collectAsStateWithLifecycle()
    val message by vm.message.collectAsStateWithLifecycle()
    val actionTarget by vm.actionTarget.collectAsStateWithLifecycle()
    val clipboard by vm.clipboard.collectAsStateWithLifecycle()

    val snackbarHostState = remember { SnackbarHostState() }
    val listState = rememberLazyListState()
    val sheetState = rememberModalBottomSheetState()

    var showBucketMenu by remember { mutableStateOf(false) }
    var showOverflow by remember { mutableStateOf(false) }
    var showSortMenu by remember { mutableStateOf(false) }
    var deleteConfirm by remember { mutableStateOf<List<String>?>(null) }

    val activeBucket = buckets.firstOrNull { it.id == activeBucketId }

    // 文件选择器（SAF，无需存储权限）
    val pickLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris -> vm.upload(uris) }

    // 通知权限（仅在下载时按需申请）
    val notifLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { /* 无论是否授权，下载均继续；仅影响通知展示 */ }

    fun requestDownload(items: List<FsEntry>) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            notifLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        vm.download(items)
    }

    // 消息提示
    LaunchedEffect(message) {
        message?.let {
            snackbarHostState.showSnackbar(it)
            vm.consumeMessage()
        }
    }

    // 切换目录时回到顶部
    LaunchedEffect(prefix) {
        listState.scrollToItem(0)
    }

    // 全面屏全局返回：在子目录时返回上一级，多选时退出多选；
    // 仅在根目录且无选择时才放行给系统（退出应用）。
    BackHandler(enabled = selectionMode || prefix.isNotEmpty()) {
        if (selectionMode) vm.clearSelection() else vm.navigateUp()
    }

    Scaffold(
        topBar = {
            if (selectionMode) {
                TopAppBar(
                    title = { Text("已选 ${selected.size} 项") },
                    navigationIcon = {
                        IconButton(onClick = vm::clearSelection) {
                            Icon(Icons.Filled.Close, contentDescription = "退出多选")
                        }
                    },
                    actions = {
                        IconButton(
                            onClick = { vm.copySelection() },
                        ) {
                            Icon(Icons.Filled.ContentCopy, contentDescription = "复制")
                        }
                        IconButton(
                            onClick = {
                                val items = entries.filter { it.key in selected }
                                requestDownload(items)
                            },
                            enabled = selected.any { k -> entries.firstOrNull { it.key == k }?.isFolder == false },
                        ) {
                            Icon(Icons.Filled.CloudDownload, contentDescription = "下载")
                        }
                        IconButton(onClick = { deleteConfirm = selected.toList() }) {
                            Icon(Icons.Filled.Delete, contentDescription = "删除")
                        }
                    },
                )
            } else {
                TopAppBar(
                    title = {
                        Column {
                            Text(
                                activeBucket?.displayName ?: "文件",
                                style = MaterialTheme.typography.titleMedium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                prefix.ifEmpty { "根目录" },
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    },
                    actions = {
                        // 存储桶切换
                        Box {
                            IconButton(onClick = { showBucketMenu = true }) {
                                Icon(Icons.Filled.Storage, contentDescription = "切换存储桶")
                            }
                            DropdownMenu(
                                expanded = showBucketMenu,
                                onDismissRequest = { showBucketMenu = false },
                            ) {
                                buckets.forEach { b ->
                                    DropdownMenuItem(
                                        text = { Text(b.displayName) },
                                        leadingIcon = {
                                            if (b.id == activeBucketId) {
                                                Icon(
                                                    Icons.Filled.CheckCircle,
                                                    contentDescription = null,
                                                    tint = MaterialTheme.colorScheme.primary,
                                                )
                                            }
                                        },
                                        onClick = {
                                            showBucketMenu = false
                                            vm.switchBucket(b.id)
                                        },
                                    )
                                }
                            }
                        }
                        IconButton(onClick = { showSortMenu = true }) {
                            Icon(Icons.Filled.Sort, contentDescription = "排序")
                        }
                        DropdownMenu(
                            expanded = showSortMenu,
                            onDismissRequest = { showSortMenu = false },
                        ) {
                            SortMode.entries.forEach { m ->
                                DropdownMenuItem(
                                    text = { Text(m.label) },
                                    onClick = {
                                        showSortMenu = false
                                        vm.setSortMode(m)
                                    },
                                )
                            }
                        }
                        IconButton(onClick = vm::refresh) {
                            Icon(Icons.Filled.Refresh, contentDescription = "刷新")
                        }
                        Box {
                            IconButton(onClick = { showOverflow = true }) {
                                Icon(Icons.Filled.MoreVert, contentDescription = "更多")
                            }
                            DropdownMenu(
                                expanded = showOverflow,
                                onDismissRequest = { showOverflow = false },
                            ) {
                                DropdownMenuItem(
                                    text = { Text("全选") },
                                    onClick = {
                                        showOverflow = false
                                        vm.selectAll()
                                    },
                                )
                            }
                        }
                        AccountAction(user = user, onLogout = onLogout)
                    },
                )
            }
        },
        floatingActionButton = {
            if (!selectionMode) {
                ExtendedFloatingActionButton(
                    onClick = { pickLauncher.launch(arrayOf("*/*")) },
                    icon = { Icon(Icons.Filled.ArrowUpward, contentDescription = null) },
                    text = { Text("上传") },
                )
            }
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            // 复制粘贴提示条
            if (clipboard != null) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        Icons.Filled.ContentPaste,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "已复制 ${clipboard!!.size} 项，前往目标目录后点「粘贴」",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = vm::paste) { Text("粘贴") }
                    TextButton(onClick = vm::clearClipboard) { Text("取消") }
                }
                HorizontalDivider()
            }

            // 面包屑
            BreadcrumbBar(
                prefix = prefix,
                onNavigate = vm::navigateTo,
                onUp = { vm.navigateUp() },
            )
            HorizontalDivider()

            Box(Modifier.weight(1f)) {
                when {
                    loading && entries.isEmpty() -> com.kepler.bucketmg.apk.ui.components.LoadingBox()
                    error != null && entries.isEmpty() -> ErrorBox(
                        message = error!!,
                        onRetry = vm::refresh,
                    )
                    entries.isEmpty() -> com.kepler.bucketmg.apk.ui.components.EmptyBox(
                        title = "当前目录为空",
                        subtitle = "点击「上传」按钮添加文件",
                    )
                    else -> PullToRefreshBox(
                        isRefreshing = refreshing,
                        onRefresh = {
                            vm.refreshing.value = true
                            vm.refresh()
                        },
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        LazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
                            items(entries, key = { it.key }) { entry ->
                                FileRow(
                                    entry = entry,
                                    selected = entry.key in selected,
                                    selectionMode = selectionMode,
                                    onClick = {
                                        if (selectionMode) vm.toggleSelect(entry)
                                        else if (entry.isFolder) vm.enterFolder(entry)
                                        else vm.actionTarget.value =
                                            com.kepler.bucketmg.apk.ui.files.FileActionTarget(entry)
                                    },
                                    onLongClick = { vm.beginSelection(entry) },
                                )
                                HorizontalDivider()
                            }
                        }
                    }
                }
            }

            // 上传进度面板
            if (uploads.isNotEmpty()) {
                UploadPanel(
                    uploads = uploads,
                    onClearFinished = vm::clearFinishedUploads,
                )
            }
        }
    }

    // —— 单文件操作面板 ——
    val target = actionTarget
    if (target != null) {
        ModalBottomSheet(
            onDismissRequest = { vm.actionTarget.value = null },
            sheetState = sheetState,
        ) {
            Column(Modifier.padding(bottom = 24.dp)) {
                Text(
                    target.entry.name,
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp),
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                InfoRow("大小", formatBytes(target.entry.size))
                InfoRow("修改时间", formatTime(target.entry.lastModified))
                if (target.entry.encrypted) {
                    InfoRow("加密", "云端密文（AES-256-GCM）")
                }
                Spacer(Modifier.height(8.dp))
                HorizontalDivider()
                SheetAction(Icons.Filled.CloudDownload, "下载") {
                    vm.actionTarget.value = null
                    requestDownload(listOf(target.entry))
                }
                SheetAction(Icons.Filled.ContentCopy, "复制") {
                    vm.actionTarget.value = null
                    vm.copyEntry(target.entry.key)
                }
                SheetAction(Icons.Filled.Delete, "删除", destructive = true) {
                    vm.actionTarget.value = null
                    deleteConfirm = listOf(target.entry.key)
                }
            }
        }
    }

    // —— 删除确认 ——
    val dc = deleteConfirm
    if (dc != null) {
        ConfirmDialog(
            title = "确认删除",
            text = "将删除选中的 ${dc.size} 项，此操作不可恢复。",
            confirmText = "删除",
            destructive = true,
            onConfirm = {
                deleteConfirm = null
                vm.delete(dc)
            },
            onDismiss = { deleteConfirm = null },
        )
    }
}

@Composable
private fun SheetAction(
    icon: ImageVector,
    text: String,
    destructive: Boolean = false,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 24.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            icon,
            contentDescription = null,
            tint = if (destructive) MaterialTheme.colorScheme.error
            else MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.width(20.dp))
        Text(
            text,
            style = MaterialTheme.typography.bodyLarge,
            color = if (destructive) MaterialTheme.colorScheme.error
            else MaterialTheme.colorScheme.onSurface,
        )
    }
}

/** 面包屑导航 */
@Composable
private fun BreadcrumbBar(
    prefix: String,
    onNavigate: (String) -> Unit,
    onUp: () -> Unit,
) {
    val segments = prefix.trimEnd('/').split('/').filter { it.isNotEmpty() }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(onClick = { onNavigate("") }) { Text("全部文件") }
        segments.forEachIndexed { i, seg ->
            Text(
                "/",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
            )
            val target = segments.take(i + 1).joinToString("/") + "/"
            TextButton(onClick = { onNavigate(target) }) {
                Text(
                    seg,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (segments.isNotEmpty()) {
            Spacer(Modifier.weight(1f))
            IconButton(onClick = onUp) {
                Icon(Icons.Filled.ArrowUpward, contentDescription = "上一级")
            }
        }
    }
}

/** 文件 / 目录行 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun FileRow(
    entry: FsEntry,
    selected: Boolean,
    selectionMode: Boolean,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (selectionMode) {
            Checkbox(checked = selected, onCheckedChange = { onClick() })
        } else {
            Icon(
                imageVector = iconFor(entry),
                contentDescription = null,
                tint = if (entry.isFolder) MaterialTheme.colorScheme.primary
                else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(40.dp),
            )
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    entry.name,
                    style = MaterialTheme.typography.bodyLarge,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (entry.encrypted) {
                    Spacer(Modifier.width(6.dp))
                    Icon(
                        Icons.Filled.Lock,
                        contentDescription = "已加密",
                        tint = MaterialTheme.colorScheme.tertiary,
                        modifier = Modifier.size(14.dp),
                    )
                }
            }
            Text(
                if (entry.isFolder) "文件夹" else formatBytes(entry.size),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Text(
            formatTime(entry.lastModified),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** 按类型选择图标 */
@Composable
private fun iconFor(entry: FsEntry): ImageVector = when {
    entry.isFolder -> Icons.Filled.Folder
    entry.type == "image" -> Icons.Filled.Image
    entry.type == "video" -> Icons.Filled.Movie
    entry.type == "audio" -> Icons.Filled.MusicNote
    entry.type == "doc" || entry.type == "text" -> Icons.Filled.Description
    entry.type == "sheet" -> Icons.Filled.TableChart
    entry.type == "code" -> Icons.Filled.Code
    entry.type == "archive" -> Icons.Filled.FolderZip
    else -> Icons.Filled.InsertDriveFile
}

/** 上传进度面板 */
@Composable
private fun UploadPanel(
    uploads: List<UploadTask>,
    onClearFinished: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                "上传队列（${uploads.count { it.state == UploadState.DONE }}/${uploads.size}）",
                style = MaterialTheme.typography.titleSmall,
            )
            if (uploads.any { it.state == UploadState.DONE || it.state == UploadState.FAILED }) {
                TextButton(onClick = onClearFinished) { Text("清除已完成") }
            }
        }
        uploads.take(4).forEach { t ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(vertical = 3.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val statusColor = when (t.state) {
                    UploadState.FAILED -> MaterialTheme.colorScheme.error
                    UploadState.DONE -> MaterialTheme.colorScheme.primary
                    else -> MaterialTheme.colorScheme.onSurfaceVariant
                }
                Text(
                    text = when (t.state) {
                        UploadState.PENDING -> "等待中"
                        UploadState.RUNNING -> "${formatBytes(t.sentBytes)} / ${formatBytes(t.totalBytes)}"
                        UploadState.DONE -> "已完成"
                        UploadState.FAILED -> "失败：${t.error}"
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = statusColor,
                    modifier = Modifier.width(150.dp),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.width(8.dp))
                if (t.state == UploadState.RUNNING && t.totalBytes > 0) {
                    LinearProgressIndicator(
                        progress = { (t.sentBytes.toFloat() / t.totalBytes).coerceIn(0f, 1f) },
                        modifier = Modifier.weight(1f),
                    )
                } else if (t.state == UploadState.RUNNING) {
                    LinearProgressIndicator(modifier = Modifier.weight(1f))
                } else {
                    Spacer(Modifier.weight(1f))
                }
            }
            Text(
                t.name,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
