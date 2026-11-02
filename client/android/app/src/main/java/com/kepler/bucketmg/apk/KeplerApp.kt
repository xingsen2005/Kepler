package com.kepler.bucketmg.apk

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import com.kepler.bucketmg.apk.data.SessionManager
import com.kepler.bucketmg.apk.data.net.ApiClient
import com.kepler.bucketmg.apk.data.prefs.SecureStore
import com.kepler.bucketmg.apk.data.prefs.SettingsStore

class KeplerApp : Application() {

    lateinit var secureStore: SecureStore
        private set
    lateinit var settingsStore: SettingsStore
        private set

    override fun onCreate() {
        super.onCreate()
        instance = this
        secureStore = SecureStore(this)
        settingsStore = SettingsStore(this)
        ApiClient.init(secureStore)
        ApiClient.onSessionExpired = { SessionManager.handleSessionExpired() }
        createDownloadChannel()
    }

    private fun createDownloadChannel() {
        val channel = NotificationChannel(
            CHANNEL_DOWNLOAD,
            getString(R.string.channel_download_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.channel_download_desc)
            setShowBadge(false)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    companion object {
        lateinit var instance: KeplerApp
            private set

        const val CHANNEL_DOWNLOAD = "download"

        val secure: SecureStore get() = instance.secureStore
        val settings: SettingsStore get() = instance.settingsStore

        fun context(): Context = instance
    }
}
