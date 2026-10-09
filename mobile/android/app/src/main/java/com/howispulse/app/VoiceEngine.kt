package com.howispulse.app

import android.content.Context
import android.media.AudioAttributes
import android.media.SoundPool
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.howispulse.app.R
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
import livekit.org.webrtc.AudioTrackSink
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

    /**
     * Wiedergabe-Boost für ferne Stimmen (1.0 = neutral): OneUI dämpft
     * USAGE_VOICE_COMMUNICATION am Lautsprecher gegenüber Medien-Ton spürbar
     * (Telephonie-Lautstärkekurve), der Boost gleicht das an — der Ton bleibt
     * im Anruf-Regler. ponytail: fester Wert statt Settings-Hook; wenn der
     * Nutzer regeln will, Master-Lautstärke (web) nativ an setVolume anbinden.
     */
    private const val PLAYBACK_BOOST = 5.0

    /** Pegel-Tap: Sprech-Schwelle (RMS) und Nachhall — siehe trackSinks.
     *  0.002, weil die Gegenstellen-Kette (Chrome-NS, AGC aus) schon bei
     *  ~0.008 normale Sprache liefert und Stille exakt 0 ist. */
    private const val SPEAK_THRESHOLD = 0.002
    private const val SPEAK_HANGOVER_MS = 600L

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

    /** Identitäten der aktuellen Sprecher. Main-Thread-only. Quelle ist der
     *  eigene Pegel-Tap (trackSinks) — die Server-Active-Speaker kamen am
     *  Gerät nie an (Nutzerbefund 2026-10-09: kein Sprech-Ring vom PC aus). */
    private val speakers = mutableSetOf<String>()

    /** Subscribed fernem Audio-Tracks (für Deafen). Main-Thread-only. */
    private val remoteAudio = mutableSetOf<RemoteAudioTrack>()

    /** Pegel-Tap für die Sprech-Anzeige: je fernem Audio-Track ein
     *  AudioTrackSink, der PCM-RMS in [sinkLevels] schreibt (Sink-Thread);
     *  ein 200-ms-Ticker auf dem Main-Thread leitet daraus das Sprech-Set
     *  ab (Schwelle + Nachhall) und emittiert bei Änderung. Serverunabhängig
     *  — der §8-Upgrade-Weg "eigener Level-Tap am Android-Track". */
    private val trackSinks = mutableMapOf<RemoteAudioTrack, Pair<String, AudioTrackSink>>()
    private val sinkLevels = java.util.concurrent.ConcurrentHashMap<String, Double>()
    private val lastLoudAt = java.util.concurrent.ConcurrentHashMap<String, Long>()
    private var levelTicker: Runnable? = null

    /** Raum-Etikett aus dem Web ('voice' | 'anruf:<id>') — läuft in jedem
     *  Snapshot mit, damit die beiden Web-Konsumenten (Sprachkanal-Fassade,
     *  Anruf-Store) die Events auseinanderhalten können. */
    @Volatile
    private var tag: String = ""

    /** voice.*-Klänge im ANRUF-Kanal (SoundPool mit Voice-Communication-Usage) —
     *  im WebView-<audio> würden sie im Medien-Regler landen, genau der Bug.
     *  Name (Web-Katalog) → SoundPool-Id. Main-Thread-only. */
    private var soundPool: SoundPool? = null
    private val soundIds = mutableMapOf<String, Int>()

    @Synchronized
    private fun ensureInit(appContext: Context) {
        if (initialized) return
        LiveKit.init(appContext.applicationContext)
        ensureSounds(appContext.applicationContext)
        initialized = true
    }

    private fun ensureSounds(ctx: Context) {
        if (soundPool != null) return
        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
        val sp = SoundPool.Builder().setMaxStreams(2).setAudioAttributes(attrs).build()
        val names = mapOf(
            "voice.user_join" to R.raw.voice_user_join,
            "voice.user_leave" to R.raw.voice_user_leave,
            "voice.self_join" to R.raw.voice_self_join,
            "voice.self_leave" to R.raw.voice_self_leave,
            "voice.self_mute" to R.raw.voice_self_mute,
            "voice.self_unmute" to R.raw.voice_self_unmute,
            "voice.self_deafen" to R.raw.voice_self_deafen,
            "voice.self_undeafen" to R.raw.voice_self_undeafen
        )
        for ((key, res) in names) {
            soundIds[key] = sp.load(ctx, res, 1)
        }
        soundPool = sp
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
        roomTag: String,
        done: JoinCallback
    ) {
        mainHandler.post {
            try {
                ensureInit(appContext)
                // Der WebView-Prozess überlebt einen Reload — ein alter Raum
                // (Resume nach Refresh) wird zuerst abgerechnet.
                leaveInternal()
                tag = roomTag
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
                                startLevelTicker()
                                state = "connected"
                            }
                            is RoomEvent.Reconnected -> {
                                state = "connected"
                                // Nach dem Resubscribe die Lautstärke neu
                                // behaupten: je nach Reconnect-Pfad kommen
                                // dieselben Track-Objekte zurück, ohne dass
                                // TrackSubscribed je Track feuert — sonst
                                // war der Pegel nach Connect Zufall
                                // (Nutzerbefund: teils leise Teilnehmer,
                                // App-Neustart half). Der Nachlauf fängt den
                                // Fall ab, in dem die Tracks erst NACH dem
                                // Event wieder da sind.
                                applyRemoteVolumes()
                                mainHandler.postDelayed({ applyRemoteVolumes() }, 1000)
                            }
                            is RoomEvent.Reconnecting -> state = "reconnecting"
                            is RoomEvent.Disconnected, is RoomEvent.FailedToConnect -> {
                                connected = false
                                stopLevelTicker()
                                speakers.clear()
                                trackSinks.clear()
                                sinkLevels.clear()
                                lastLoudAt.clear()
                                remoteAudio.clear()
                                state = "disconnected"
                            }
                            is RoomEvent.TrackSubscribed -> {
                                val t = ev.track
                                if (t is RemoteAudioTrack) {
                                    remoteAudio.add(t)
                                    val id = ev.participant.identity?.value ?: ""
                                    if (id.isNotEmpty()) {
                                        val sink = levelSinkFor(id)
                                        trackSinks[t] = Pair(id, sink)
                                        t.addSink(sink)
                                    }
                                    applyRemoteVolumes()
                                }
                            }
                            is RoomEvent.TrackUnsubscribed -> {
                                val t = ev.track
                                if (t is RemoteAudioTrack) {
                                    trackSinks.remove(t)?.let { (id, sink) ->
                                        t.removeSink(sink)
                                        sinkLevels.remove(id)
                                        lastLoudAt.remove(id)
                                        speakers.remove(id)
                                    }
                                    remoteAudio.remove(t)
                                }
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

    /** Eine Lautstärke für alle fernen Tracks — deterministisch bei JEDEM
     *  (Wieder-)Verbinden, Taub inklusive. Ohne explizites Setzen hing der
     *  Pegel am SDK-Zustand des jeweiligen Pfads (Erstsubscribe vs. Reconnect)
     *  und konnte leise ausfallen. */
    private fun applyRemoteVolumes() {
        val v = if (deafened) 0.0 else PLAYBACK_BOOST
        remoteAudio.forEach { t ->
            try {
                t.setVolume(v)
            } catch (_: Exception) {
            }
        }
        Log.i(TAG, "remote volume -> $v (${remoteAudio.size} tracks)")
    }

    /** PCM-Sink für einen fernem Track: RMS je Frame in [sinkLevels], samt
     *  Nachhall-Zeitstempel. Läuft im RTC-Thread — nur die Maps berühren. */
    private fun levelSinkFor(identity: String): AudioTrackSink = AudioTrackSink { buf, _, _, _, _, _ ->
        try {
            buf.order(java.nio.ByteOrder.LITTLE_ENDIAN)
            buf.rewind()
            var sum = 0.0
            var n = 0
            while (buf.remaining() >= 2) {
                val v = buf.short / 32768.0
                sum += v * v
                n++
            }
            if (n > 0) {
                val rms = Math.sqrt(sum / n)
                sinkLevels[identity] = rms
                if (rms > SPEAK_THRESHOLD) lastLoudAt[identity] = SystemClock.elapsedRealtime()
            }
        } catch (_: Exception) {
        }
    }

    /** 200-ms-Ticker: Sprech-Set aus Pegel + Nachhall ableiten, bei Änderung
     *  Snapshot emittieren — die UI (Sprech-Ring) sieht dasselbe Feld wie im
     *  Web-Pfad. Main-Thread-only. */
    private fun startLevelTicker() {
        stopLevelTicker()
        val run = object : Runnable {
            override fun run() {
                if (!connected) return
                val now = SystemClock.elapsedRealtime()
                val neu = mutableSetOf<String>()
                for ((id, _) in sinkLevels) {
                    val laut = (sinkLevels[id] ?: 0.0) > SPEAK_THRESHOLD
                    val nachhall = now - (lastLoudAt[id] ?: 0L) < SPEAK_HANGOVER_MS
                    if (laut || nachhall) neu.add(id)
                }
                if (neu != speakers) {
                    speakers.clear()
                    speakers.addAll(neu)
                    emitSnapshot()
                }
                mainHandler.postDelayed(this, 200)
            }
        }
        levelTicker = run
        mainHandler.postDelayed(run, 200)
    }

    private fun stopLevelTicker() {
        levelTicker?.let { mainHandler.removeCallbacks(it) }
        levelTicker = null
    }

    /** Tauchschaltung: Wiedergabe aller fernem Tracks stummschalten (Mic koppelt
     *  das Web selbst mit). Neue Tracks kommen bei [deafened] direkt stumm an. */
    @JvmStatic
    fun setDeafened(on: Boolean) {
        mainHandler.post {
            deafened = on
            applyRemoteVolumes()
        }
    }

    @JvmStatic
    fun isConnected(): Boolean = connected

    /** Klang aus dem Web-Katalog abspielen (ignoriert Unbekanntes still). */
    @JvmStatic
    fun playSound(name: String) {
        val sp = soundPool ?: return
        val id = soundIds[name] ?: return
        sp.play(id, 1f, 1f, 1, 0, 1f)
    }

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
                // SDK-audioLevel bleibt am Gerät 0 (keine Server-Speaker) —
                // der Pegel-Tap liefert das Level für den UI-Glow: RMS 0..0.125
                // auf 0..1 gemappt (0.008 = leise Sprache → ~0.06, 0.1 = laut).
                val tap = sinkLevels[identity]
                o.put("audioLevel", if (tap != null) Math.min(1.0, tap * 8) else p.audioLevel.toDouble())
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
        if (tag.isNotEmpty()) root.put("tag", tag)
        return root.toString()
    }
}
