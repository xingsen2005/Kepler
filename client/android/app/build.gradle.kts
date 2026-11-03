import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    // AGP 9 内置 Kotlin 支持（Kotlin 2.3.21）：无需显式应用 kotlin-android；
    // Compose 编译器插件随 buildFeatures.compose 由 AGP 自动接入
    alias(libs.plugins.kotlin.compose)
}

/**
 * 读取 release 签名凭据（keystore.properties 已被 .gitignore 排除）。
 * 文件缺失时优雅降级：release 构建不签名，未配置环境仍可 assembleDebug。
 */
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
val hasKeystore = keystoreProps.getProperty("storeFile") != null

android {
    namespace = "com.kepler.bucketmg.apk"
    compileSdk {
        // 依赖（Compose BOM 2026.09.00 解析出的 Compose 1.12.x / navigation 2.10.x /
        // core-ktx 1.19.x / lifecycle 2.11.x）要求 compileSdk >= 37。
        // 本地 SDK 通过 Gradle 内置 SDK Manager 自动下载并安装 android-37 平台。
        version = release(37)
    }

    defaultConfig {
        applicationId = "com.kepler.bucketmg.apk"
        // API 34（Android 14）为最低支持版本：全面拥抱分区存储 / 照片选择器 /
        // 前台服务类型等新规范，无需申请任何 Legacy 存储权限
        minSdk = 34
        // 目标 API 36（Android 16）：与 compileSdk 对齐到当前稳定版本。
        // 注意 API 35+ 强制 edge-to-edge，本应用已使用 enableEdgeToEdge() + Compose
        // Scaffold 自动处理 insets，视觉表现不变。
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // 应用仅提供中文界面
        resourceConfigurations += setOf("zh")
    }

    signingConfigs {
        if (hasKeystore) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            // 有凭据则签名，产出可直接安装/分发的 APK；否则保持未签名但可编译
            if (hasKeystore) {
                signingConfig = signingConfigs.getByName("release")
            }
            optimization {
                enable = true
                packageScope = setOf("androidx.**", "kotlin.**", "kotlinx.**")
                keepRules {
                    // 自定义 keep 规则（org.json / OkHttp / Tink 等反射敏感库）
                    includeDefault = true
                    files.add(file("proguard-rules.pro"))
                }
            }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    buildFeatures {
        compose = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_11)
    }
}

dependencies {
    // Compose（版本由 BOM 统一管理）
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons.extended)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.runtime.ktx)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    // navigation-compose 未纳入：本应用导航为手写 when(dest) 两级状态，无 NavHost
    debugImplementation(libs.compose.ui.tooling)

    // 网络 / 序列化 / 持久化
    implementation(libs.okhttp)
    // okhttp logging-interceptor 未纳入：无调试日志需求，避免把请求体写入 release 包
    implementation(libs.datastore.preferences)
    // security-crypto 未纳入：该库已停止维护（EncryptedSharedPreferences 全系列 deprecated）。
    // 本项目改用 Android Keystore 的 AES-256-GCM 直接实现加密存取，见 data/prefs/SecureStore.kt。

    implementation(libs.androidx.core.ktx)
    // 仅为 XML 主题提供 Material3 DayNight 基类（界面全部为 Compose 实现）
    implementation(libs.material)

    testImplementation(libs.junit)
    testImplementation(libs.json)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
}
