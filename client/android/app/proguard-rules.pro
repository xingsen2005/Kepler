# ============================================================
# Kepler Android 客户端 R8 / ProGuard 规则
# ============================================================

# ---- 保留行号信息，便于崩溃堆栈定位 ----
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# ---- org.json：通过反射/原生实现，需保留 ----
-keep class org.json.** { *; }

# ---- OkHttp / Okio ----
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
-keepclassmembers class okhttp3.internal.** { *; }

# ---- Kotlin 协程 ----
-keepclassmembers class kotlinx.coroutines.** { volatile <fields>; }
-dontwarn kotlinx.coroutines.**

# ---- 应用内的数据模型：JSON 手工解析，但保留以防后续接入反射序列化 ----
-keep class com.kepler.bucketmg.apk.data.model.** { *; }

# ---- 枚举（R8 默认保留 values/valueOf，这里显式声明更稳妥）----
-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}

# ---- 保留 Parcelable / Serializable 相关 ----
-keepclassmembers class * implements android.os.Parcelable {
    public static final android.os.Parcelable$Creator *;
}
-keepclassmembers class * implements java.io.Serializable {
    static final long serialVersionUID;
    private static final java.io.ObjectStreamField[] serialPersistentFields;
    !static !transient <fields>;
    private void writeObject(java.io.ObjectOutputStream);
    private void readObject(java.io.ObjectInputStream);
    java.lang.Object writeReplace();
    java.lang.Object readResolve();
}

# ---- 移除发布包中的日志调用 ----
-assumenosideeffects class android.util.Log {
    public static *** v(...);
    public static *** d(...);
    public static *** i(...);
}