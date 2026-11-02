package com.kepler.bucketmg.apk.ui.main

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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.kepler.bucketmg.apk.data.model.UserInfo
import com.kepler.bucketmg.apk.ui.components.GroupCard
import com.kepler.bucketmg.apk.ui.components.InfoRow
import com.kepler.bucketmg.apk.ui.components.SectionHeader
import com.kepler.bucketmg.apk.ui.formatTime

/**
 * 「我的」页面：展示当前账户的「我的资料」。
 * 注意：本客户端刻意不包含「启用 Windows Hello 验证」开关——
 * 若账户已开启 Windows Hello，此处仅作只读提示（拒绝登录的原因说明）。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MineScreen(
    user: UserInfo,
    onLogout: () -> Unit,
) {
    val roleLabel = if (user.isAdmin) "管理员" else "普通用户"

    Scaffold(
        topBar = {
            TopAppBar(title = { Text("我的") })
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
        ) {
            // 账户头部
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(
                    Icons.Filled.Person,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(56.dp),
                )
                Spacer(Modifier.width(14.dp))
                Column {
                    Text(
                        user.username.ifBlank { "未命名用户" },
                        style = MaterialTheme.typography.titleLarge,
                    )
                    Spacer(Modifier.height(2.dp))
                    Text(
                        roleLabel,
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
            }

            Spacer(Modifier.height(20.dp))

            // 我的资料
            SectionHeader("我的资料")
            GroupCard {
                InfoRow("用户名", user.username)
                InfoRow("角色", roleLabel)
                InfoRow("邮箱", user.email.ifBlank { "未设置" })
                InfoRow("注册时间", formatTime(user.createdAt))
            }

            // 只读提示：账户已开启 Windows Hello（非开关，仅说明拒绝登录原因）
            if (user.webauthnEnabled) {
                Spacer(Modifier.height(12.dp))
                Card(
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.errorContainer,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Row(
                        modifier = Modifier.padding(14.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Icon(
                            Icons.Filled.Warning,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.error,
                            modifier = Modifier.size(20.dp),
                        )
                        Spacer(Modifier.width(10.dp))
                        Column {
                            Text(
                                "该账户已开启 Windows Hello 验证",
                                style = MaterialTheme.typography.titleSmall,
                                color = MaterialTheme.colorScheme.onErrorContainer,
                            )
                            Spacer(Modifier.height(4.dp))
                            Text(
                                "本应用不支持 Windows Hello（指纹 / 面容 / PIN）二次验证，已拒绝登录此账户。如需在手机端使用，请前往网页端关闭该验证。",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onErrorContainer,
                            )
                        }
                    }
                }
            }

            Spacer(Modifier.height(24.dp))

            // 退出登录
            Button(
                onClick = onLogout,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.Filled.Logout, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text("退出登录")
            }
        }
    }
}
