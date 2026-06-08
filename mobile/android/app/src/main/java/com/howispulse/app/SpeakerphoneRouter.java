package com.howispulse.app;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.util.List;
import java.util.concurrent.Executor;

/**
 * Routet die WebRTC-/Stream-Wiedergabe auf das gewünschte Ausgabegerät.
 *
 * Das Problem: Sobald die WebView eine {@code RTCPeerConnection} / {@code
 * getUserMedia} öffnet, schaltet Chromium den System-Audio-Modus auf
 * {@link AudioManager#MODE_IN_COMMUNICATION}. In diesem Modus routet Android per
 * Default auf die HÖRMUSCHEL (earpiece, Telefonie) statt auf den lauten Medien-
 * Lautsprecher — der Ton kommt „wie aus dem Telefon-Hörer".
 *
 * Zwei Betriebsarten:
 *  - {@link #ROUTE_AUTO} (Default): erzwingt den Lautsprecher, solange KEIN
 *    Headset/Bluetooth steckt (dann bleibt der Ton dort).
 *  - {@link #ROUTE_SPEAKER}/{@link #ROUTE_EARPIECE}: manueller Override aus dem
 *    UI-Umschalter — die explizite User-Wahl gewinnt, auch über ein Headset.
 *
 * Robustheit gegen den Chromium-Race (das war der Bug der reinen Mode-Gate-
 * Variante): {@code setCommunicationDevice} wirkt nur in
 * {@code MODE_IN_COMMUNICATION}, und Chromium wählt unmittelbar nach dem
 * Mode-Switch SELBST ein Ausgabegerät. Deshalb:
 *  1. {@link AudioManager.OnModeChangedListener} → bei Wechsel auf COMMUNICATION
 *     sofort anwenden.
 *  2. verzögertes Re-Apply (150/500 ms), um einen direkt folgenden Chromium-
 *     Override zu übersteuern.
 *  3. {@link AudioManager.OnCommunicationDeviceChangedListener} → holt unsere
 *     Wahl zurück, falls Chromium das Gerät später wegnimmt („letztes Wort").
 *     Self-Trigger-Schutz: re-asserten nur, wenn das aktuelle Gerät ≠ Ziel ist.
 */
public class SpeakerphoneRouter {

    public static final int ROUTE_AUTO = 0;
    public static final int ROUTE_SPEAKER = 1;
    public static final int ROUTE_EARPIECE = 2;

    private static final String TAG = "PulseAudio";

    private final AudioManager audioManager;
    private final Executor mainExecutor;
    private final Handler handler = new Handler(Looper.getMainLooper());

    /** Aktuelle Routing-Wahl. ``volatile``: vom Plugin-Thread setzbar. */
    private volatile int route = ROUTE_AUTO;

    private AudioManager.OnModeChangedListener modeListener;
    private AudioManager.OnCommunicationDeviceChangedListener commDeviceListener;

    public SpeakerphoneRouter(Context context, Executor mainExecutor) {
        this.audioManager = (AudioManager) context.getApplicationContext()
                .getSystemService(Context.AUDIO_SERVICE);
        this.mainExecutor = mainExecutor;
    }

    /** Einmalig nach Activity-Create: registriert (ab API 31) die Listener und
     *  wendet einmal an. */
    public void start() {
        if (audioManager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (modeListener == null) {
                modeListener = (mode) -> {
                    if (mode == AudioManager.MODE_IN_COMMUNICATION) apply();
                };
                try {
                    audioManager.addOnModeChangedListener(mainExecutor, modeListener);
                } catch (Exception e) {
                    Log.w(TAG, "addOnModeChangedListener failed", e);
                }
            }
            if (commDeviceListener == null) {
                commDeviceListener = (device) -> onCommDeviceChanged();
                try {
                    audioManager.addOnCommunicationDeviceChangedListener(
                            mainExecutor, commDeviceListener);
                } catch (Exception e) {
                    Log.w(TAG, "addOnCommunicationDeviceChangedListener failed", e);
                }
            }
        }
        apply();
    }

    /** Beim Activity-Destroy: Listener abmelden. */
    public void stop() {
        if (audioManager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (modeListener != null) {
                try { audioManager.removeOnModeChangedListener(modeListener); }
                catch (Exception e) { Log.w(TAG, "removeOnModeChangedListener failed", e); }
                modeListener = null;
            }
            if (commDeviceListener != null) {
                try { audioManager.removeOnCommunicationDeviceChangedListener(commDeviceListener); }
                catch (Exception e) { Log.w(TAG, "removeOnCommunicationDeviceChangedListener failed", e); }
                commDeviceListener = null;
            }
        }
        handler.removeCallbacksAndMessages(null);
    }

    /** Manueller Umschalter aus dem UI (AudioRoute-Plugin). ``ROUTE_AUTO`` stellt
     *  das automatische Verhalten (Lautsprecher, sofern kein Headset) wieder her. */
    public void setRoute(int newRoute) {
        this.route = newRoute;
        apply();
        // Gegen den Chromium-Override direkt nach einem Mode-Switch / einer
        // Geräte-Umschaltung noch zwei Mal kurz danach erneut durchsetzen.
        handler.postDelayed(this::apply, 150);
        handler.postDelayed(this::apply, 500);
    }

    public int currentRoute() {
        return route;
    }

    public String routeName() {
        switch (route) {
            case ROUTE_SPEAKER: return "speaker";
            case ROUTE_EARPIECE: return "earpiece";
            default: return "auto";
        }
    }

    private int targetDeviceType() {
        // AUTO + SPEAKER → Lautsprecher; nur EARPIECE → Hörmuschel.
        return route == ROUTE_EARPIECE
                ? AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
                : AudioDeviceInfo.TYPE_BUILTIN_SPEAKER;
    }

    /**
     * Wendet die aktuelle Routing-Wahl an. Idempotent, jederzeit gefahrlos
     * aufrufbar (onResume, Mode-/Device-Change, verzögertes Re-Apply).
     */
    public void apply() {
        if (audioManager == null) return;
        // Nur im AUTO-Modus ein Headset/Bluetooth respektieren; ein MANUELLER
        // Override ist die explizite User-Entscheidung und gewinnt auch dann.
        if (route == ROUTE_AUTO && hasExternalAudioRoute()) {
            return;
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // setCommunicationDevice wirkt NUR in MODE_IN_COMMUNICATION; sonst
                // ist es wirkungslos. Der Mode-/Device-Listener triggert apply()
                // erneut, sobald der Modus tatsächlich auf COMMUNICATION kippt.
                if (audioManager.getMode() != AudioManager.MODE_IN_COMMUNICATION) return;
                applyApi31(targetDeviceType());
            } else {
                // API 24–30: deprecated, aber der einzige Weg. setSpeakerphoneOn
                // deckt nur Speaker/earpiece ab (kein explizites Earpiece-Device).
                audioManager.setSpeakerphoneOn(targetDeviceType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER);
            }
        } catch (Exception e) {
            Log.w(TAG, "audio routing failed", e);
        }
    }

    private void applyApi31(int deviceType) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return;
        AudioDeviceInfo target = null;
        List<AudioDeviceInfo> devices = audioManager.getAvailableCommunicationDevices();
        for (AudioDeviceInfo d : devices) {
            if (d.getType() == deviceType) {
                target = d;
                break;
            }
        }
        if (target != null) {
            boolean ok = audioManager.setCommunicationDevice(target);
            if (!ok) Log.w(TAG, "setCommunicationDevice returned false for type " + deviceType);
        }
    }

    /** Re-Assert, wenn ein anderer (Chromium) das Kommunikationsgerät umgestellt
     *  hat. Self-Trigger-Schutz: passiert nichts, wenn das Gerät schon stimmt. */
    private void onCommDeviceChanged() {
        if (audioManager == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return;
        if (audioManager.getMode() != AudioManager.MODE_IN_COMMUNICATION) return;
        if (route == ROUTE_AUTO && hasExternalAudioRoute()) return;
        AudioDeviceInfo cur = audioManager.getCommunicationDevice();
        if (cur != null && cur.getType() == targetDeviceType()) return; // schon korrekt → kein Loop
        apply();
    }

    /**
     * True, wenn ein echtes externes Audio-AUSGABEGERÄT (kabelgebundenes
     * Headset/Kopfhörer, USB-Headset, Bluetooth A2DP/SCO, Hörgerät) angeschlossen
     * ist. Nur im AUTO-Modus relevant.
     *
     * BEWUSST OHNE {@code TYPE_USB_DEVICE}: dieser generische Typ taucht je nach
     * OEM auch für USB-Peripherie OHNE Audiofunktion auf (OTG-Adapter, Lade-Hubs).
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
