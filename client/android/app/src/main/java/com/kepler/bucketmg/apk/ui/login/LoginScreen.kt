package com.kepler.bucketmg.apk.ui.login

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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Fingerprint
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Storage
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.kepler.bucketmg.apk.data.prefs.SettingsStore

/**
 * 登录界面：服务器地址（域名）+ 用户名 + 密码。
 *
 * 需求要点：
 *  - 连接信息持久化（下次自动带出）
 *  - 连接测试（公开接口 /site/info）
 *  - 账户若已开启 Windows Hello → 直接拒绝登录并给出明确提示
 */
@Composable
fun LoginScreen(
    onLoggedIn: () -> Unit,
    vm: LoginViewModel = viewModel(),
) {
    val domain by vm.domain.collectAsStateWithLifecycle()
    val username by vm.username.collectAsStateWithLifecycle()
    val password by vm.password.collectAsStateWithLifecycle()
    val remember by vm.remember.collectAsStateWithLifecycle()
    val loading by vm.loading.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()
    val testState by vm.testState.collectAsStateWithLifecycle()
    val helloDialog by vm.helloDialog.collectAsStateWithLifecycle()
    val banDialog by vm.banDialog.collectAsStateWithLifecycle()
    val captcha by vm.captcha.collectAsStateWithLifecycle()
    val captchaAnswer by vm.captchaAnswer.collectAsStateWithLifecycle()
    val captchaLoading by vm.captchaLoading.collectAsStateWithLifecycle()
    val hasCaptcha = captcha != null

    var passwordVisible by rememberSaveable { mutableStateOf(false) }

    val isHttp = domain.trim().let { it.startsWith("http://", true) }
    val focusManager = androidx.compose.ui.platform.LocalFocusManager.current

    Box(Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .align(Alignment.Center)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 32.dp)
                .widthIn(max = 480.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Icon(
                Icons.Filled.Storage,
                contentDescription = null,
                modifier = Modifier.size(64.dp),
                tint = MaterialTheme.colorScheme.primary,
            )
            Spacer(Modifier.height(12.dp))
            Text(
                "Kepler",
                style = MaterialTheme.typography.headlineMedium,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Text(
                "多云对象存储管理",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(32.dp))

            // 服务器地址（域名）
            OutlinedTextField(
                value = domain,
                onValueChange = vm::onDomainChange,
                label = { Text("服务器地址") },
                placeholder = { Text("kepler.example.com") },
                leadingIcon = { Icon(Icons.Filled.Link, contentDescription = null) },
                supportingText = {
                    when (val t = testState) {
                        is TestState.Ok -> Text(
                            "已连接：${t.siteName.ifBlank { "Kepler 服务器" }}",
                            color = MaterialTheme.colorScheme.primary,
                        )
                        is TestState.Failed -> Text(
                            t.message,
                            color = MaterialTheme.colorScheme.error,
                        )
                        else -> Text("请输入 Kepler 服务器的域名或 IP")
                    }
                },
                singleLine = true,
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrect = false,
                    keyboardType = KeyboardType.Ascii,
                    imeAction = ImeAction.Next,
                ),
                modifier = Modifier.fillMaxWidth(),
            )

            if (isHttp) {
                Spacer(Modifier.height(4.dp))
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        Icons.Filled.Warning,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp),
                        tint = MaterialTheme.colorScheme.error,
                    )
                    Spacer(Modifier.size(6.dp))
                    Text(
                        "当前为明文 HTTP 连接，账号密码存在被窃听风险，建议使用 HTTPS",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }

            Spacer(Modifier.height(12.dp))

            // 用户名
            OutlinedTextField(
                value = username,
                onValueChange = { vm.username.value = it },
                label = { Text("用户名") },
                leadingIcon = { Icon(Icons.Filled.Person, contentDescription = null) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrect = false,
                    imeAction = ImeAction.Next,
                ),
                modifier = Modifier.fillMaxWidth(),
            )

            Spacer(Modifier.height(12.dp))

            // 密码
            OutlinedTextField(
                value = password,
                onValueChange = { vm.password.value = it },
                label = { Text("密码") },
                leadingIcon = { Icon(Icons.Filled.Lock, contentDescription = null) },
                trailingIcon = {
                    IconButton(onClick = { passwordVisible = !passwordVisible }) {
                        Icon(
                            if (passwordVisible) Icons.Filled.Visibility
                            else Icons.Filled.VisibilityOff,
                            contentDescription = if (passwordVisible) "隐藏密码" else "显示密码",
                        )
                    }
                },
                visualTransformation = if (passwordVisible) VisualTransformation.None
                else PasswordVisualTransformation(),
                singleLine = true,
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Password,
                    imeAction = ImeAction.Done,
                ),
                keyboardActions = KeyboardActions(
                    onDone = { focusManager.clearFocus(); vm.login(onLoggedIn) },
                ),
                modifier = Modifier.fillMaxWidth(),
            )

            Spacer(Modifier.height(4.dp))

            // 记住我 + 连接测试
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = remember, onCheckedChange = { vm.remember.value = it })
                    Text("记住密码", style = MaterialTheme.typography.bodyMedium)
                }
                TextButton(
                    onClick = vm::testConnection,
                    enabled = !loading && testState !is TestState.Testing,
                ) {
                    if (testState is TestState.Testing) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp),
                            strokeWidth = 2.dp)
                        Spacer(Modifier.size(6.dp))
                    }
                    Text("连接测试")
                }
            }

            // 错误提示
            if (error != null) {
                Spacer(Modifier.height(8.dp))
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        Icons.Filled.Warning,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp),
                        tint = MaterialTheme.colorScheme.error,
                    )
                    Spacer(Modifier.size(6.dp))
                    Text(
                        error!!,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }

            // —— 原生验证码（服务端开启验证码且本客户端被要求作答）——
            val cap = captcha
            if (hasCaptcha && cap != null) {
                Spacer(Modifier.height(16.dp))
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(
                            MaterialTheme.colorScheme.surfaceVariant,
                            shape = MaterialTheme.shapes.medium,
                        )
                        .padding(16.dp),
                ) {
                    Text(
                        "请完成人机验证",
                        style = MaterialTheme.typography.titleSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(8.dp))
                    Text(
                        cap.question.ifBlank { "请回答下方问题" },
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    cap.error?.let {
                        Spacer(Modifier.height(6.dp))
                        Text(
                            it,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                    Spacer(Modifier.height(12.dp))
                    OutlinedTextField(
                        value = captchaAnswer,
                        onValueChange = { vm.captchaAnswer.value = it },
                        label = { Text("答案") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Number,
                            imeAction = ImeAction.Done,
                        ),
                        keyboardActions = KeyboardActions(
                            onDone = { focusManager.clearFocus(); vm.submitCaptcha(onLoggedIn) },
                        ),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(8.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        TextButton(
                            onClick = vm::refreshCaptcha,
                            enabled = !captchaLoading,
                        ) { Text("换一张") }
                        TextButton(onClick = vm::dismissCaptcha) { Text("返回") }
                    }
                }
            }

            Spacer(Modifier.height(20.dp))

            Button(
                onClick = {
                    focusManager.clearFocus()
                    if (hasCaptcha) vm.submitCaptcha(onLoggedIn) else vm.login(onLoggedIn)
                },
                enabled = !loading && !captchaLoading,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(50.dp),
            ) {
                if (loading || captchaLoading) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(20.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                } else {
                    Text(
                        if (hasCaptcha) "验证并登录" else "登 录",
                        style = MaterialTheme.typography.titleMedium,
                    )
                }
            }

            Spacer(Modifier.height(16.dp))
            Text(
                "登录即表示同意服务器的使用政策\n密码仅提交至您所填写的服务器",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
    }

    // —— Windows Hello 拒绝提示 ——
    if (helloDialog) {
        AlertDialog(
            onDismissRequest = vm::dismissDialogs,
            icon = {
                Icon(
                    Icons.Filled.Fingerprint,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.error,
                )
            },
            title = { Text("无法登录") },
            text = {
                Text(
                    "该账户已开启 Windows Hello（指纹 / 面容 / PIN）二次验证，本应用暂不支持该验证方式，已拒绝登录。\n\n" +
                        "如需在手机上使用，请先前往网页端在该账户的「个人资料」中关闭 Windows Hello，或改用其他账户。",
                )
            },
            confirmButton = {
                TextButton(onClick = vm::dismissDialogs) { Text("我知道了") }
            },
        )
    }

    // —— 账户封禁提示 ——
    val ban = banDialog
    if (ban != null) {
        AlertDialog(
            onDismissRequest = vm::dismissDialogs,
            icon = {
                Icon(
                    Icons.Filled.Warning,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.error,
                )
            },
            title = { Text("账户已被封禁") },
            text = {
                Text(
                    "封禁原因：${ban.first}\n解封时间：${ban.second}",
                )
            },
            confirmButton = {
                TextButton(onClick = vm::dismissDialogs) { Text("我知道了") }
            },
        )
    }
}
