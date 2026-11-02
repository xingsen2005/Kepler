plugins {
    alias(libs.plugins.android.application)
    // AGP 9 内置 Kotlin 支持（Kotlin 2.3.21）：无需显式应用 kotlin-android；
    // Compose 编译器插件随 buildFeatures.compose 由 AGP 自动接入
    alias(libs.plugins.kotlin.compose)
}

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
        // 目标 API 34：遵循 Android 14 开发规范（运行时通知权限、前台服务类型声明等）
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // 应用仅提供中文界面
        resourceConfigurations += setOf("zh")
    }

    buildTypes {
        release {
            optimization {
                enable = true
                packageScope = setOf("androidx.**", "kotlin.**", "kotlinx.**")
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
    implementation(libs.navigation.compose)
    debugImplementation(libs.compose.ui.tooling)

    // 网络 / 序列化 / 持久化
    implementation(libs.okhttp)
    implementation(libs.okhttp.logging)
    implementation(libs.datastore.preferences)
    implementation(libs.security.crypto)

    implementation(libs.androidx.core.ktx)
    // 仅为 XML 主题提供 Material3 DayNight 基类（界面全部为 Compose 实现）
    implementation(libs.material)

    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
}
