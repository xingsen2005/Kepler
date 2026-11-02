package com.kepler.bucketmg.apk.ui.main

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.kepler.bucketmg.apk.data.model.UserInfo
import com.kepler.bucketmg.apk.ui.files.FilesScreen

/** 顶级导航目的地（本客户端为「浏览器」，仅文件与「我的」） */
enum class Dest(
    val label: String,
    val icon: ImageVector,
) {
    FILES("文件", Icons.Filled.Folder),
    MINE("我的", Icons.Filled.Person),
}

/**
 * 主界面：自适应导航。
 *
 *  - 窄屏（手机）：底部导航栏（底栏）—— 内容在上、导航栏在下的纵向布局
 *  - 宽屏 ≥ 600dp（平板 / 折叠屏展开 / 大屏）：左侧导航栏（左侧栏）—— 导航栏在左、内容在右的横向布局
 */
@Composable
fun MainScreen(
    user: UserInfo,
    onLogout: () -> Unit,
) {
    var current by rememberSaveable { mutableStateOf(Dest.FILES) }

    // 返回键：非首页先回首页
    BackHandler(enabled = current != Dest.FILES) { current = Dest.FILES }

    val destinations = Dest.entries

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val useRail = maxWidth >= 600.dp
        if (useRail) {
            Row(Modifier.fillMaxSize()) {
                NavigationRail {
                    destinations.forEach { dest ->
                        NavigationRailItem(
                            selected = current == dest,
                            onClick = { current = dest },
                            icon = { Icon(dest.icon, contentDescription = dest.label) },
                            label = { Text(dest.label) },
                        )
                    }
                }
                Box(Modifier.weight(1f).fillMaxSize()) {
                    when (current) {
                        Dest.FILES -> FilesScreen(user = user, onLogout = onLogout)
                        Dest.MINE -> MineScreen(user = user, onLogout = onLogout)
                    }
                }
            }
        } else {
            Column(Modifier.fillMaxSize()) {
                Box(Modifier.weight(1f).fillMaxSize()) {
                    when (current) {
                        Dest.FILES -> FilesScreen(user = user, onLogout = onLogout)
                        Dest.MINE -> MineScreen(user = user, onLogout = onLogout)
                    }
                }
                NavigationBar {
                    destinations.forEach { dest ->
                        NavigationBarItem(
                            selected = current == dest,
                            onClick = { current = dest },
                            icon = { Icon(dest.icon, contentDescription = dest.label) },
                            label = { Text(dest.label) },
                        )
                    }
                }
            }
        }
    }
}
