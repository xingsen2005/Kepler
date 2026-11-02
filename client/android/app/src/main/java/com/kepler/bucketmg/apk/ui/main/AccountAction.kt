package com.kepler.bucketmg.apk.ui.main

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.kepler.bucketmg.apk.data.model.UserInfo

/**
 * 顶栏账户入口：展示当前用户与角色，提供退出登录。
 * 各功能页共用，保证在任何页面都能登出。
 */
@Composable
fun AccountAction(
    user: UserInfo,
    onLogout: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var expanded by remember { mutableStateOf(false) }
    Box(modifier) {
        IconButton(onClick = { expanded = true }) {
            Icon(Icons.Filled.Person, contentDescription = "账户")
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            Text(
                text = user.username,
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
            Text(
                text = if (user.isAdmin) "管理员" else "普通用户",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 0.dp),
            )
            if (user.webauthnEnabled) {
                Text(
                    text = "已开启 Windows Hello",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.tertiary,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 2.dp),
                )
            }
            HorizontalDivider()
            DropdownMenuItem(
                text = { Text("退出登录") },
                leadingIcon = { Icon(Icons.Filled.Logout, contentDescription = null) },
                onClick = {
                    expanded = false
                    onLogout()
                },
            )
        }
    }
}

/** 顶栏右侧对齐容器（图标按钮组） */
@Composable
fun TopBarActions(content: @Composable () -> Unit) {
    Box(contentAlignment = Alignment.CenterEnd) { content() }
}
