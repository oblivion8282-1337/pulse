package com.howispulse.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import io.livekit.android.LiveKit
import io.livekit.android.RoomOptions
import io.livekit.android.events.RoomEvent
import io.livekit.android.room.Room
import io.livekit.android.room.participant.Participant
import io.livekit.android.room.track.LocalAudioTrackOptions
import io.livekit.android.room.track.RemoteAudioTrack
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/** Rückruf für [VoiceEngine.join]/[VoiceEngine.setMicEnabled] — null bedeutet „erledigt", sonst Fehlermeldung. */
fun interface JoinCallback {
    fun onResult(error: String?)
}

/** Einmaliger Empfänger der Zustands-Snapshots (JSON-String, Contract siehe nativeVoice.ts). */
fun interface SnapshotListener {
    fun onSnapshot(json: String)
}

/**
 * Nativer Voice-Motor aus docs/UEBERGABE-MOBILE-VOICE-NATIV.md.
 *
 * Der springende Punkt ist der „Stempel": das SDK erzeugt seine AudioTracks
 * selbst mit USAGE_VOICE_COMMUNICATION, der Ton folgt damit dem Anruf-Regler —
 * auch am eingebauten Lautsprecher. Genau das kann die Web-Engine nicht (kein
 * Web-API dafür, Übergabe §2.2), deshalb diese Engine.
 *
 * Mode/Playout gehören hier dem SDK (AudioSwitch/ModeHandler) — der
 * SpeakerphoneRouter wird auf dem nativen Pfad bewusst NICHT angerufen
 * (Übergabe §5 Punkt 2: ein Eigentümer, sonst Mode-Ping-Pong). Nur der
 * Mic-Foreground-Service wird vom Web separat gestrichelt (AudioRoute.
 * setMicService) — Screen-Lock-Schutz für die Aufnahme.
 *
 * Die UI läuft unverändert im Web: die Engine wirft auf jedes relevante
 * Room-Event einen Teilnehmer-Snapshot an den [SnapshotListener]; das Web
 * schreibt ihn in dieselben Stores wie bisher (#applyNativeSnapshot).
 *
 * ponytail: Sprech-Indikator/Level kommen serverseitig (ActiveSpeakers +
 * audioLevel) — die Web-Seite nutzt dort ihren eigenen RMS-Detektor, weil
 * Server-Speaker-Daten bei AGC-Aus zappelig sind. Besser erst, wenn sich das
 * Feld meldet; Upgrade-Weg: eigener Level-Tap am Android-Track.
 */
object VoiceEngine {

    private const val TAG = "VoiceEngine"

    private val mainHandler = Handler(Looper.getMainLooper())
    private var initialized = false
    private var scope: CoroutineScope? = null
    private var room: Room? = null
    private var eventJob: Job? = null

    @Volatile
    private var listener: SnapshotListener? = null

    /** Setzt, sobald room.connect() auflöst; zurück auf false bei Disconnected. */
    @Volatile
    private var connected = false

    /** Taub-Schaltung: nur Wiedergabe — alle fernem Audio-Tracks auf Volume 0. */
    @Volatile
    private var deafened = false

    /** Identitäten der aktuellen Sprecher (Server-Active-Speaker). Main-Thread-only. */
    private val speakers = mutableSetOf<String>()

    /** Subscribed fernem Audio-Tracks (für Deafen). Main-Thread-only. */
    private val remoteAudio = mutableSetOf<RemoteAudioTrack>()

    @Synchronized
    private fun ensureInit(appContext: Context) {
        if (initialized) return
        LiveKit.init(appContext.applicationContext)
        initialized = true
    }

    /** Join. [echoCancellation]/[noiseSuppression] ersetzen die Web-DSP-Flags
     *  (RNNoise gibt es nativ nicht — Hardware-NS als Ersatz, Übergabe §5.1);
     *  AGC bleibt wie im Web aus. [done] wird genau einmal gerufen. */
    @JvmStatic
    fun join(
        appContext: Context,
        wsUrl: String,
        token: String,
        echoCancellation: Boolean,
        noiseSuppression: Boolean,
        done: JoinCallback
    ) {
        mainHandler.post {
            try {
                ensureInit(appContext)
                // Der WebView-Prozess überlebt einen Reload — ein alter Raum
                // (Resume nach Refresh) wird zuerst abgerechnet.
                leaveInternal()
                val s = scope ?: CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
                    .also { scope = it }
                val opts = RoomOptions(
                    adaptiveStream = true,
                    dynacast = true,
                    audioTrackCaptureDefaults = LocalAudioTrackOptions(
                        echoCancellation = echoCancellation,
                        noiseSuppression = noiseSuppression
                    )
                )
                val r = LiveKit.create(appContext.applicationContext, opts)
                room = r
                eventJob = s.launch {
                    r.events.events.collect { ev ->
                        var state: String? = null
                        when (ev) {
                            is RoomEvent.Connected -> {
                                connected = true
                                state = "connected"
                            }
                            is RoomEvent.Reconnected -> state = "connected"
                            is RoomEvent.Reconnecting -> state = "reconnecting"
                            is RoomEvent.Disconnected, is RoomEvent.FailedToConnect -> {
                                connected = false
                                speakers.clear()
                                remoteAudio.clear()
                                state = "disconnected"
                            }
                            is RoomEvent.ActiveSpeakersChanged -> {
                                speakers.clear()
                                ev.speakers.forEach { sp -> sp.identity?.let { speakers.add(it.value) } }
                            }
                            is RoomEvent.TrackSubscribed -> {
                                val t = ev.track
                                if (t is RemoteAudioTrack) {
                                    remoteAudio.add(t)
                                    if (deafened) t.setVolume(0.0)
                                }
                            }
                            is RoomEvent.TrackUnsubscribed -> {
                                val t = ev.track
                                if (t is RemoteAudioTrack) remoteAudio.remove(t)
                            }
                            else -> {}
                        }
                        Log.i(TAG, "room event: ${ev::class.simpleName}")
                        listener?.onSnapshot(snapshotJson(state))
                    }
                }
                Log.i(TAG, "join")
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
        speakers.clear()
        remoteAudio.clear()
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

    /** Mikrofon publishen/zurückziehen (braucht RECORD_AUDIO — fragt das Plugin ab). */
    @JvmStatic
    fun setMicEnabled(on: Boolean, done: JoinCallback) {
        mainHandler.post {
            val r = room
            val s = scope
            if (r == null || s == null) {
                done.onResult("kein Raum")
                return@post
            }
            s.launch {
                try {
                    r.localParticipant.setMicrophoneEnabled(on)
                    Log.i(TAG, "mikrofon ${if (on) "an" else "aus"}")
                    done.onResult(null)
                } catch (e: Exception) {
                    Log.w(TAG, "mikrofon fehlgeschlagen", e)
                    done.onResult(e.message ?: "Mikrofon fehlgeschlagen")
                }
            }
        }
    }

    /** Tauchschaltung: Wiedergabe aller fernem Tracks stummschalten (Mic koppelt
     *  das Web selbst mit). Neue Tracks kommen bei [deafened] direkt stumm an. */
    @JvmStatic
    fun setDeafened(on: Boolean) {
        mainHandler.post {
            deafened = on
            remoteAudio.forEach { t ->
                try {
                    t.setVolume(if (on) 0.0 else 1.0)
                } catch (_: Exception) {
                }
            }
        }
    }

    @JvmStatic
    fun isConnected(): Boolean = connected

    @JvmStatic
    fun setListener(l: SnapshotListener?) {
        listener = l
    }

    /** Snapshot sofort an den Listener werfen — das Web zieht ihn nach dem
     *  Anhängen des Listeners, sonst würde der beim Connect gefeuerte erste
     *  Snapshot ins Leere laufen (still raum → kein Folge-Event). */
    @JvmStatic
    fun emitSnapshot() {
        mainHandler.post { listener?.onSnapshot(snapshotJson(null)) }
    }

    /** Teilnehmer-Snapshot im Contract von nativeVoice.ts (#applyNativeSnapshot). */
    private fun snapshotJson(state: String?): String {
        val root = JSONObject()
        val r = room
        if (r != null) {
            val arr = JSONArray()
            fun add(p: Participant, isLocal: Boolean) {
                val o = JSONObject()
                val identity: String = p.identity?.value ?: ""
                o.put("identity", identity)
                o.put("name", p.name ?: "")
                o.put("isLocal", isLocal)
                o.put("isSpeaking", identity in speakers)
                o.put("audioLevel", p.audioLevel.toDouble())
                o.put("micMuted", !p.isMicrophoneEnabled)
                o.put("cameraOn", p.isCameraEnabled)
                o.put("connectionQuality", p.connectionQuality.name.lowercase())
                arr.put(o)
            }
            add(r.localParticipant, true)
            for (p in r.remoteParticipants.values) add(p, false)
            root.put("participants", arr)
        }
        if (state != null) root.put("state", state)
        return root.toString()
    }
}
