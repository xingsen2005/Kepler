package com.kepler.bucketmg.apk.ui.login

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kepler.bucketmg.apk.data.model.UserInfo
import com.kepler.bucketmg.apk.data.net.ApiException
import com.kepler.bucketmg.apk.data.prefs.SettingsStore
import com.kepler.bucketmg.apk.data.repo.AuthRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

/** 连接测试状态 */
sealed interface TestState {
    data object Idle : TestState
    data object Testing : TestState
    data class Ok(val siteName: String) : TestState
    data class Failed(val message: String) : TestState
}

/** 原生验证码挑战（服务端开启验证码且本客户端被要求作答时） */
data class CaptchaChallenge(
    val token: String,
    val question: String,
    /** 最近一次作答错误的提示（答案不正确 / 已过期）；首次无 */
    val error: String? = null,
)

class LoginViewModel : ViewModel() {

    private val repo = AuthRepository()

    val domain = MutableStateFlow("")
    val username = MutableStateFlow("")
    val password = MutableStateFlow("")
    val remember = MutableStateFlow(false)

    val loading = MutableStateFlow(false)
    val error = MutableStateFlow<String?>(null)
    val testState = MutableStateFlow<TestState>(TestState.Idle)
    /** 站点名称（连接测试成功后展示） */
    val siteName = MutableStateFlow("")

    /** Windows Hello 拒绝提示（账户已开启二次验证，本 App 不支持） */
    val helloDialog = MutableStateFlow(false)
    /** 封禁提示：原因 + 解封时间 */
    val banDialog = MutableStateFlow<Pair<String, String>?>(null)

    /** 原生验证码挑战；非空表示服务端要求先完成人机验证 */
    val captcha = MutableStateFlow<CaptchaChallenge?>(null)
    val captchaAnswer = MutableStateFlow("")
    val captchaLoading = MutableStateFlow(false)

    init {
        viewModelScope.launch {
            val (url, user, pw) = repo.prefill()
            domain.value = url
            username.value = user
            password.value = pw.orEmpty()
            remember.value = pw != null
        }
    }

    fun onDomainChange(v: String) {
        domain.value = v
        testState.value = TestState.Idle
    }

    /** 连接测试：GET /api/site/info（公开接口，无需登录） */
    fun testConnection() {
        val raw = domain.value.trim()
        if (raw.isEmpty()) {
            testState.value = TestState.Failed("请先填写服务器地址")
            return
        }
        testState.value = TestState.Testing
        viewModelScope.launch {
            try {
                val base = SettingsStore.normalizeBaseUrl(raw)
                com.kepler.bucketmg.apk.data.SessionManager.configure(base)
                val info = com.kepler.bucketmg.apk.data.SessionManager.api().siteInfo()
                siteName.value = info.siteName
                testState.value = TestState.Ok(info.siteName)
            } catch (e: Exception) {
                val msg = (e as? ApiException)?.message ?: "连接失败：${e.message}"
                testState.value = TestState.Failed(msg)
            }
        }
    }

    fun login(onSuccess: () -> Unit) {
        if (loading.value || captchaLoading.value) return
        val u = username.value.trim()
        val p = password.value
        when {
            domain.value.isBlank() -> {
                error.value = "请填写服务器地址（域名）"
                return
            }
            u.isEmpty() -> {
                error.value = "请填写用户名"
                return
            }
            p.isEmpty() -> {
                error.value = "请填写密码"
                return
            }
        }
        error.value = null
        loading.value = true
        viewModelScope.launch {
            try {
                repo.login(domain.value, u, p, remember.value)
                loading.value = false
                onSuccess()
            } catch (e: ApiException) {
                loading.value = false
                when {
                    // 服务端要求先完成原生人机验证：展示题目，等待用户作答后重试
                    e.needCaptcha && e.captchaToken != null ->
                        captcha.value = CaptchaChallenge(e.captchaToken, e.captchaQuestion ?: "", e.captchaError)
                    // 账户已开启 Windows Hello：直接拒绝登录并明确提示
                    e.webauthnRequired -> helloDialog.value = true
                    e.banned -> banDialog.value = (e.banReason.ifBlank { "未说明原因" }) to
                        (e.banUntil.ifBlank { "永久" })
                    else -> error.value = e.message
                }
            } catch (e: Exception) {
                loading.value = false
                error.value = e.message ?: "登录失败"
            }
        }
    }

    /** 提交原生验证码答案，重试登录 */
    fun submitCaptcha(onSuccess: () -> Unit) {
        val ch = captcha.value ?: return
        if (loading.value || captchaLoading.value) return
        captchaLoading.value = true
        viewModelScope.launch {
            try {
                repo.login(
                    domain.value, username.value.trim(), password.value, remember.value,
                    ch.token, captchaAnswer.value.trim(),
                )
                captchaLoading.value = false
                captchaAnswer.value = ""
                captcha.value = null
                onSuccess()
            } catch (e: ApiException) {
                captchaLoading.value = false
                captchaAnswer.value = ""
                when {
                    // 答案错误或已过期：服务端换了一张新题，带着新 token 回来
                    e.needCaptcha && e.captchaToken != null ->
                        captcha.value = CaptchaChallenge(e.captchaToken, e.captchaQuestion ?: ch.question, e.captchaError)
                    e.webauthnRequired -> {
                        captcha.value = null
                        helloDialog.value = true
                    }
                    e.banned -> {
                        captcha.value = null
                        banDialog.value = (e.banReason.ifBlank { "未说明原因" }) to
                            (e.banUntil.ifBlank { "永久" })
                    }
                    else -> captcha.value = ch.copy(error = e.message)
                }
            } catch (e: Exception) {
                captchaLoading.value = false
                captcha.value = ch.copy(error = e.message ?: "验证失败")
            }
        }
    }

    /** 换一张原生验证码 */
    fun refreshCaptcha() {
        if (captchaLoading.value) return
        captchaLoading.value = true
        viewModelScope.launch {
            try {
                val c = repo.fetchNativeCaptcha()
                captcha.value = CaptchaChallenge(c.token, c.question, null)
                captchaAnswer.value = ""
            } catch (e: Exception) {
                val cur = captcha.value
                if (cur != null) captcha.value = cur.copy(error = e.message ?: "获取验证码失败")
            }
            captchaLoading.value = false
        }
    }

    /** 放弃验证码，回到普通登录 */
    fun dismissCaptcha() {
        captcha.value = null
        captchaAnswer.value = ""
        captchaLoading.value = false
    }

    fun dismissDialogs() {
        helloDialog.value = false
        banDialog.value = null
    }

    fun dismissError() {
        error.value = null
    }
}
