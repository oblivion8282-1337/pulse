package com.howispulse.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.room.Room
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** Rückruf für [VoiceEngine.join] — null bedeutet „verbunden", sonst Fehlermeldung. */
fun interface JoinCallback {
    fun onResult(error: String?)
}

/**
 * Nativer Voice-Motor — P1-Kernprobe aus docs/UEBERGABE-MOBILE-VOICE-NATIV.md.
 *
 * Nur-Zuhören-Join über das LiveKit-Android-SDK. Der springende Punkt ist der
 * „Stempel": das SDK erzeugt seine AudioTracks selbst mit
 * USAGE_VOICE_COMMUNICATION, der Ton folgt damit dem Anruf-Regler — auch am
 * eingebauten Lautsprecher. Genau das kann die Web-Engine nicht (kein Web-API
 * dafür, Übergabe §2.2), deshalb diese Engine.
 *
 * Mode/Playout gehören hier dem SDK (AudioSwitch/ModeHandler) — der
 * SpeakerphoneRouter wird auf dem nativen Pfad bewusst NICHT angerufen
 * (Übergabe §5 Punkt 2: ein Eigentümer, sonst Mode-Ping-Pong).
 *
 * P1 ist bewusst ohne Mikrofon — der Publish kommt mit P2. Der Webview-Prozess
 * überlebt einen Reload; join() rechnet deshalb einen noch lebenden Alt-Raum
 * selbstständig ab, bevor ein neuer gebaut wird.
 */
object VoiceEngine {

    private const val TAG = "VoiceEngine"

    private val mainHandler = Handler(Looper.getMainLooper())
    private var initialized = false
    private var scope: CoroutineScope? = null
    private var room: Room? = null
    private var eventJob: Job? = null

    /** Setzt, sobald room.connect() auflöst; zurück auf false bei Disconnected. */
    @Volatile
    private var connected = false

    @Synchronized
    private fun ensureInit(appContext: Context) {
        if (initialized) return
        LiveKit.init(appContext.applicationContext)
        initialized = true
    }

    /** Join (nur Zuhören). [done] wird genau einmal gerufen. */
    @JvmStatic
    fun join(appContext: Context, wsUrl: String, token: String, done: JoinCallback) {
        mainHandler.post {
            try {
                ensureInit(appContext)
                leaveInternal()
                val s = scope ?: CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
                    .also { scope = it }
                val r = LiveKit.create(appContext.applicationContext)
                room = r
                eventJob = s.launch {
                    r.events.events.collect { ev ->
                        when (ev) {
                            is RoomEvent.Connected -> connected = true
                            is RoomEvent.Disconnected -> connected = false
                            else -> {}
                        }
                        Log.i(TAG, "room event: ${ev::class.simpleName}")
                    }
                }
                Log.i(TAG, "join (nur Zuhören)")
                s.launch {
                    try {
                        r.connect(wsUrl, token)
                        Log.i(TAG, "verbunden")
                        done.onResult(null)
                    } catch (e: Exception) {
                        Log.w(TAG, "join fehlgeschlagen", e)
                        leaveInternal()
                        done.onResult(e.message ?: "Verbindung fehlgeschlagen")
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "join fehlgeschlagen (Setup)", e)
                done.onResult(e.message ?: "Verbindung fehlgeschlagen")
            }
        }
    }

    /** Raum freigeben — fire-and-forget, auch während eines laufenden Joins ok. */
    @JvmStatic
    fun leave() {
        mainHandler.post { leaveInternal() }
    }

    private fun leaveInternal() {
        val r = room ?: return
        room = null
        eventJob?.cancel()
        eventJob = null
        connected = false
        val s = scope ?: return
        s.launch {
            try {
                r.disconnect()
            } catch (_: Exception) {
            }
            try {
                r.release()
            } catch (_: Exception) {
            }
        }
    }

    @JvmStatic
    fun isConnected(): Boolean = connected
}
