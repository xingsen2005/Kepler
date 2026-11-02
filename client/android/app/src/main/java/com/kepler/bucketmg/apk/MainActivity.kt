package com.kepler.bucketmg.apk

import android.app.Application
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.kepler.bucketmg.apk.data.SessionManager
import com.kepler.bucketmg.apk.data.model.UserInfo
import com.kepler.bucketmg.apk.data.repo.AuthRepository
import com.kepler.bucketmg.apk.ui.login.LoginScreen
import com.kepler.bucketmg.apk.ui.main.MainScreen
import com.kepler.bucketmg.apk.ui.theme.KeplerTheme
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 全面屏：内容延伸至系统栏区域（状态栏 / 导航栏）
        enableEdgeToEdge()
        setContent {
            KeplerTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background,
                ) {
                    AppRoot()
                }
            }
        }
    }
}

/** 应用根状态：加载中 / 未登录 / 已登录 */
sealed interface AppState {
    data object Loading : AppState
    data object LoggedOut : AppState
    data class LoggedIn(val user: UserInfo) : AppState
}

class AppViewModel(app: Application) : AndroidViewModel(app) {

    private val repo = AuthRepository()

    private val _state = MutableStateFlow<AppState>(AppState.Loading)
    val state: StateFlow<AppState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            // 会话过期广播（401 / 被踢 / 密码被改）
            launch {
                SessionManager.expired.collect { expired ->
                    if (expired) {
                        SessionManager.consumeExpired()
                        _state.value = AppState.LoggedOut
                    }
                }
            }
            repo.restore()
            val u = SessionManager.currentUser.value
            _state.value = if (u != null) AppState.LoggedIn(u) else AppState.LoggedOut
        }
    }

    fun onLoggedIn() {
        val u = SessionManager.currentUser.value ?: return
        _state.value = AppState.LoggedIn(u)
    }

    fun logout() {
        viewModelScope.launch {
            repo.logout()
            _state.value = AppState.LoggedOut
        }
    }
}

@Composable
fun AppRoot(vm: AppViewModel = viewModel()) {
    val state by vm.state.collectAsStateWithLifecycle()
    when (val s = state) {
        is AppState.Loading -> com.kepler.bucketmg.apk.ui.components.LoadingBox(text = "正在恢复会话…")
        is AppState.LoggedOut -> LoginScreen(onLoggedIn = vm::onLoggedIn)
        is AppState.LoggedIn -> MainScreen(user = s.user, onLogout = vm::logout)
    }
}
