package com.howispulse.app;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.util.Log;

import java.util.List;
import java.util.concurrent.Executor;

/**
 * Zwingt die WebRTC-Wiedergabe auf den lauten Medien-/Freisprech-Lautsprecher.
 *
 * Das Problem: Sobald die WebView ein {@code getUserMedia({audio})} /
 * {@code RTCPeerConnection} öffnet (LiveKit-Voice, aber auch WHEP-Streams mit
 * Audio), schaltet Chromium den System-Audio-Modus auf
 * {@link AudioManager#MODE_IN_COMMUNICATION}. In diesem Modus routet Android die
 * Wiedergabe per Default auf den HÖRMUSCHEL-Lautsprecher (earpiece, Telefonie),
 * nicht auf den lauten Medien-Lautsprecher — der Ton kommt dadurch sehr leise
 * und „wie aus dem Telefon-Hörer".
 *
 * Gegenmittel (Standard-Pattern aus Googles AppRTC / Jitsi-AudioManager):
 *  - API 31+: {@link AudioManager#setCommunicationDevice} mit dem
 *    BUILTIN_SPEAKER. Das ist der von Google ab Android 12 vorgesehene,
 *    nicht-deprecatete Weg.
 *  - API 24–30: das ältere {@link AudioManager#setSpeakerphoneOn}(true).
 *
 * Re-Assert: Chromium setzt den Modus erst, NACHDEM die App schon resumed ist,
 * und kann ihn mitten in einer Session umschalten (z. B. beim Stummschalten des
 * Mics). Deshalb hängen wir uns ab API 31 an
 * {@link AudioManager.OnModeChangedListener} und erzwingen den Lautsprecher
 * jedes Mal neu, wenn der Modus auf COMMUNICATION kippt. Zusätzlich wird
 * {@link #apply()} bei jedem {@code onResume} der Activity gerufen.
 *
 * BEWUSST KONSERVATIV: Wir setzen NICHT den Audio-Modus selbst (das überlässt
 * den Chromium/WebRTC), routen nur das Ausgabegerät. Bei angeschlossenem
 * Headset/Bluetooth fassen wir nichts an — dann soll das Audio dort bleiben.
 *
 * Steckt ein kabelgebundenes/Bluetooth-Audiogerät, wird KEIN Speaker erzwungen.
 */
public class SpeakerphoneRouter {

    private static final String TAG = "PulseAudio";

    private final AudioManager audioManager;
    private final Executor mainExecutor;

    /** API 31+ Mode-Change-Listener; null auf älteren Geräten / wenn nicht registriert. */
    private AudioManager.OnModeChangedListener modeListener;

    public SpeakerphoneRouter(Context context, Executor mainExecutor) {
        this.audioManager = (AudioManager) context.getApplicationContext()
                .getSystemService(Context.AUDIO_SERVICE);
        this.mainExecutor = mainExecutor;
    }

    /** Einmalig nach Activity-Create aufrufen: registriert (ab API 31) den
     *  Mode-Change-Listener und erzwingt einmal den Lautsprecher. */
    public void start() {
        if (audioManager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && modeListener == null) {
            modeListener = (mode) -> {
                if (mode == AudioManager.MODE_IN_COMMUNICATION) {
                    apply();
                }
            };
            try {
                audioManager.addOnModeChangedListener(mainExecutor, modeListener);
            } catch (Exception e) {
                Log.w(TAG, "addOnModeChangedListener failed", e);
            }
        }
        apply();
    }

    /** Beim Activity-Destroy aufrufen: Listener wieder abmelden. */
    public void stop() {
        if (audioManager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && modeListener != null) {
            try {
                audioManager.removeOnModeChangedListener(modeListener);
            } catch (Exception e) {
                Log.w(TAG, "removeOnModeChangedListener failed", e);
            }
            modeListener = null;
        }
    }

    /**
     * Erzwingt — sofern KEIN Headset/Bluetooth steckt — die Wiedergabe auf den
     * eingebauten Lautsprecher. Idempotent; jederzeit gefahrlos aufrufbar
     * (onResume, Mode-Change). No-op ohne AudioManager.
     */
    public void apply() {
        if (audioManager == null) return;
        if (hasExternalAudioRoute()) {
            // Headset / Bluetooth aktiv → Nutzer-Intention respektieren, nichts erzwingen.
            return;
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // Nur eingreifen, wenn tatsächlich ein Kommunikations-Audiomodus
                // läuft (Voice/WHEP-Audio). setCommunicationDevice ist ohnehin nur
                // in MODE_IN_COMMUNICATION wirksam; bei jedem onResume ohne Call
                // (reines Chatten) wäre der Aufruf ein No-op und könnte mit einer
                // anderen App im Kommunikationsmodus kollidieren. Sobald Chromium
                // den Modus tatsächlich auf COMMUNICATION schaltet, ruft der
                // OnModeChangedListener apply() erneut — dann greift es.
                if (audioManager.getMode() != AudioManager.MODE_IN_COMMUNICATION) return;
                applyApi31();
            } else {
                // API 24–30: deprecated, aber auf diesen Versionen der einzige Weg.
                // Hier KEIN Mode-Gate: auf diesen Versionen gibt es keinen
                // OnModeChangedListener (nur ab API 31 registriert), der einen nach
                // onResume gestarteten Call nachträglich abfangen könnte. Daher
                // weiter best-effort proaktiv setzen.
                audioManager.setSpeakerphoneOn(true);
            }
        } catch (Exception e) {
            Log.w(TAG, "speaker routing failed", e);
        }
    }

    private void applyApi31() {
        // BUILTIN_SPEAKER aus der Liste der verfügbaren Kommunikations-Geräte ziehen
        // und als Kommunikations-Ausgabegerät setzen. setCommunicationDevice ist
        // der ab Android 12 vorgesehene Ersatz für setSpeakerphoneOn.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return;
        AudioDeviceInfo speaker = null;
        List<AudioDeviceInfo> devices = audioManager.getAvailableCommunicationDevices();
        for (AudioDeviceInfo d : devices) {
            if (d.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                speaker = d;
                break;
            }
        }
        if (speaker != null) {
            boolean ok = audioManager.setCommunicationDevice(speaker);
            if (!ok) {
                Log.w(TAG, "setCommunicationDevice(speaker) returned false");
            }
        }
    }

    /**
     * True, wenn ein echtes externes Audio-AUSGABEGERÄT (kabelgebundenes
     * Headset/Kopfhörer, USB-Headset, Bluetooth A2DP/SCO, Hörgerät) angeschlossen
     * ist. In dem Fall soll der Ton dort bleiben und NICHT auf den Lautsprecher
     * gezwungen werden.
     *
     * BEWUSST OHNE {@code TYPE_USB_DEVICE}: dieser generische Typ taucht je nach
     * OEM auch für USB-Peripherie OHNE Audiofunktion auf (OTG-Adapter, Lade-Hubs,
     * Tastaturen). Würden wir ihn mitzählen, bräche {@link #apply()} ab und der
     * Voice-Ton bliebe in der leisen Hörmuschel, sobald irgendein USB-Gerät
     * steckt. Ein echtes USB-Audiogerät meldet sich als {@code TYPE_USB_HEADSET}
     * (das bleibt drin) bzw. wird ohnehin zum aktiven Kommunikationsgerät.
     */
    private boolean hasExternalAudioRoute() {
        if (audioManager == null) return false;
        AudioDeviceInfo[] outs = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS);
        if (outs == null) return false;
        for (AudioDeviceInfo d : outs) {
            switch (d.getType()) {
                case AudioDeviceInfo.TYPE_WIRED_HEADSET:
                case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
                case AudioDeviceInfo.TYPE_USB_HEADSET:
                case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
                case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
                case AudioDeviceInfo.TYPE_HEARING_AID:
                    return true;
                default:
                    break;
            }
        }
        return false;
    }
}
