package com.howispulse.app;

import android.app.Activity;
import android.content.Context;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.util.List;
import java.util.concurrent.Executor;

/**
 * Routet die WebRTC-/Stream-Wiedergabe auf das gewünschte Ausgabegerät und lenkt
 * die Hardware-Lautstärketasten auf den Voice-Call-Stream.
 *
 * Den {@link AudioManager#MODE_IN_COMMUNICATION} setzen wir bei Voice-Join SELBST
 * ({@link #setVoiceActive}) — NICHT (mehr) im Vertrauen darauf, dass Chromium das
 * tut. Die System-WebView tut es bei reiner WebRTC-Wiedergabe unzuverlässig; ohne
 * den Modus bleibt der Ton auf {@code STREAM_MUSIC} → im Auto über A2DP-Medien
 * statt den Telefon-Kanal (BT-SCO). Zwei Probleme, die Android in diesem Modus macht:
 *  1. Default-Routing auf die HÖRMUSCHEL (earpiece) statt den lauten Medien-
 *     Lautsprecher — der Ton kommt „wie aus dem Telefon-Hörer".
 *  2. Die Hardware-Lautstärketasten steuern {@link AudioManager#STREAM_MUSIC},
 *     während der Voice-Ton über {@link AudioManager#STREAM_VOICE_CALL} läuft —
 *     der User dreht „voll auf" und hört kaum etwas, weil er den falschen Stream
 *     regelt (klassischer „Bluetooth im Auto zu leise"-Bug; vgl. Jitsi Meet
 *     {@code AudioModeModule}, {@code setVolumeControlStream(STREAM_VOICE_CALL)}).
 *
 * Drei Betriebsarten ({@link #route}):
 *  - {@link #ROUTE_AUTO} (Default): Lautsprecher, sofern KEIN Headset steckt;
 *    ist Bluetooth verbunden, wird das BT-SCO-Gerät aktiv als Communication-Device
 *    gesetzt (deterministisch, statt dem OS das Routing zu überlassen).
 *  - {@link #ROUTE_SPEAKER}/{@link #ROUTE_EARPIECE}: manueller Override aus dem
 *    UI-Umschalter — die explizite User-Wahl gewinnt, auch über ein Headset/BT.
 *
 * Kabel-/USB-Headsets werden in AUTO bewusst in Ruhe gelassen (OS-Default), BT
 * dagegen aktiv geroutet — das ist der Unterschied zum früheren pauschalen
 * „Externe-Gerät-early-return", der im Auto den Router komplett lahmlegte.
 *
 * Robustheit gegen den Chromium-Race (das war der Bug der reinen Mode-Gate-
 * Variante): {@code setCommunicationDevice} wirkt nur in
 * {@code MODE_IN_COMMUNICATION}, und Chromium wählt unmittelbar nach dem
 * Mode-Switch SELBST ein Ausgabegerät. Deshalb:
 *  1. {@link AudioManager.OnModeChangedListener} → bei Wechsel auf COMMUNICATION
 *     sofort anwenden (+ Volume-Stream setzen), bei anderem Mode Stream reseten.
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
    /** Für {@link Activity#setVolumeControlStream}: nur null im diagnostic-only Pfad. */
    private final Activity activity;
    private final Executor mainExecutor;
    private final Handler handler = new Handler(Looper.getMainLooper());

    /** Aktuelle Routing-Wahl. ``volatile``: vom Plugin-Thread setzbar. */
    private volatile int route = ROUTE_AUTO;

    private AudioManager.OnModeChangedListener modeListener;
    private AudioManager.OnCommunicationDeviceChangedListener commDeviceListener;
    /** Feuert, wenn Audio-Geräte erscheinen/verschwinden — der Recovery-Pfad für
     *  das BT-SCO-Gerät, das zum Voice-Join-Zeitpunkt noch nicht in
     *  getAvailableCommunicationDevices() steht (das „im Auto zu leise"-Race).
     *  Auf allen API-Leveln verfügbar (seit API 23), daher nicht ans API-31-Gate geknüpft. */
    private AudioDeviceCallback audioDeviceCallback;
    /** True während eines aktiven Voice-Calls (setVoiceActive(true) … false). Der
     *  modeListener re-assertet COMMUNICATION nur, solange dies true ist. */
    private volatile boolean voiceActive = false;
    /** Zeitstempel (ms) des letzten Mode-Re-Asserts — Schutz gegen einen Ping-Pong-
     *  Loop, falls Chromium den Mode wiederholt wegzieht. */
    private volatile long lastModeReassert = 0;

    public SpeakerphoneRouter(Context context, Activity activity, Executor mainExecutor) {
        this.audioManager = (AudioManager) context.getApplicationContext()
                .getSystemService(Context.AUDIO_SERVICE);
        this.activity = activity;
        this.mainExecutor = mainExecutor;
    }

    /** Einmalig nach Activity-Create: registriert (ab API 31) die Listener und
     *  wendet einmal an. Setzt den Volume-Stream (API-unabhängig). */
    public void start() {
        if (audioManager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (modeListener == null) {
                modeListener = (mode) -> {
                    if (mode == AudioManager.MODE_IN_COMMUNICATION) {
                        setVoiceVolumeStream();
                        apply();
                    } else if (voiceActive) {
                        // Chromium/FGS hat den Mode während eines aktiven Voice-Calls
                        // weggezogen (z.B. bei Mic-Mute/Track-Stop) → re-assert, sonst
                        // fällt das Audio auf den Medien-Pfad (A2DP) und die Lauter-Taste
                        // regelt den falschen Stream. Rate-limit (500 ms) gegen Ping-Pong.
                        long now = System.currentTimeMillis();
                        if (now - lastModeReassert >= 500) {
                            lastModeReassert = now;
                            try {
                                audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
                            } catch (Exception e) {
                                Log.w(TAG, "re-assert MODE_IN_COMMUNICATION failed", e);
                            }
                            setVoiceVolumeStream();
                            apply();
                        }
                    } else {
                        resetVolumeStream();
                    }
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
        if (audioDeviceCallback == null) {
            audioDeviceCallback = new AudioDeviceCallback() {
                @Override
                public void onAudioDevicesAdded(AudioDeviceInfo[] addedDevices) {
                    // Routing neu bewerten, wenn ein Ausgabegerät erscheint — vor
                    // allem das BT-SCO-Gerät, das zum Join-Zeitpunkt noch fehlt.
                    if (!voiceActive
                            || audioManager.getMode() != AudioManager.MODE_IN_COMMUNICATION) return;
                    for (AudioDeviceInfo d : addedDevices) {
                        if (d.isSink() && (d.getType() == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
                                || d.getType() == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP)) {
                            // API<31: apply() hat keinen SCO-Hebel — startBluetoothSco
                            // nachholen, falls BT erst nach dem Join verbindet (sonst
                            // bleibt es trotz Recovery auf dem leisen A2DP).
                            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
                                try {
                                    audioManager.startBluetoothSco();
                                    audioManager.setBluetoothScoOn(true);
                                } catch (Exception e) {
                                    Log.w(TAG, "startBluetoothSco (recovery) failed", e);
                                }
                            }
                            applyWithReassert();
                            break;
                        }
                    }
                }
                @Override
                public void onAudioDevicesRemoved(AudioDeviceInfo[] removedDevices) { /* no-op */ }
            };
            try {
                audioManager.registerAudioDeviceCallback(audioDeviceCallback, handler);
            } catch (Exception e) {
                Log.w(TAG, "registerAudioDeviceCallback failed", e);
            }
        }
        // Falls Chromium den Mode schon vor start() auf COMMUNICATION gestellt hat.
        if (audioManager.getMode() == AudioManager.MODE_IN_COMMUNICATION) {
            setVoiceVolumeStream();
        }
        apply();
    }

    /** Beim Activity-Destroy: Listener abmelden, Volume-Stream zurücksetzen. */
    public void stop() {
        if (audioManager == null) return;
        resetVolumeStream();
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
        if (audioDeviceCallback != null) {
            try { audioManager.unregisterAudioDeviceCallback(audioDeviceCallback); }
            catch (Exception e) { Log.w(TAG, "unregisterAudioDeviceCallback failed", e); }
            audioDeviceCallback = null;
        }
        handler.removeCallbacksAndMessages(null);
    }

    /** Manueller Umschalter aus dem UI (AudioRoute-Plugin). ``ROUTE_AUTO`` stellt
     *  das automatische Verhalten wieder her. */
    public void setRoute(int newRoute) {
        this.route = newRoute;
        applyWithReassert();
    }

    /** {@link #apply()} sofort + zwei Mal kurz danach (150/500 ms), um einen
     *  Chromium-Override direkt nach einem Mode-Switch / einer Geräte-Umschaltung
     *  zu übersteuern. Gemeinsam von {@link #setRoute} und {@link #setVoiceActive}. */
    private void applyWithReassert() {
        apply();
        handler.postDelayed(this::apply, 150);
        handler.postDelayed(this::apply, 500);
    }

    /**
     * Voice-Join/-Leave-Signal aus dem Web (via AudioRoute-Plugin). Der eigentliche
     * Hebel gegen „Voice läuft im Auto über Medien (A2DP) statt Telefon (SCO)":
     *
     * Die gesamte SCO-Routing-Logik in {@link #apply()} wirkt nur in
     * {@code MODE_IN_COMMUNICATION}. Wir haben bisher darauf gewartet, dass Chromium
     * diesen Modus setzt — die Android-System-WebView tut das bei reiner WebRTC-
     * *Wiedergabe* aber nicht zuverlässig, dann bleibt der Ton auf {@code STREAM_MUSIC}
     * → im Auto über A2DP (leise, falscher Lautstärkeregler). Beim Join setzen wir
     * den Modus deshalb SELBST und lassen {@link #apply()} auf BT-SCO routen; beim
     * Leave geben wir Modus + Gerät wieder frei, sonst hängt das Telefon im Call-Modus.
     */
    public void setVoiceActive(boolean active) {
        if (audioManager == null) return;
        // Vor dem Mode-Wechsel setzen: beim Leave (false) darf der modeListener den
        // auf NORMAL gezogenen Mode NICHT wieder nach COMMUNICATION re-asserten.
        this.voiceActive = active;
        if (active) {
            try {
                if (audioManager.getMode() != AudioManager.MODE_IN_COMMUNICATION) {
                    audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
                }
            } catch (Exception e) {
                Log.w(TAG, "setMode(IN_COMMUNICATION) failed", e);
            }
            // Direkt setzen (nicht nur auf den modeListener verlassen): war der
            // Modus schon COMMUNICATION, feuert setMode oben nicht → der Listener
            // auch nicht, dann ist dies der einzige Pfad, der Stream + Routing setzt.
            setVoiceVolumeStream();
            applyWithReassert();
            // API<31 (Android <12) hat kein setCommunicationDevice — startBluetoothSco()
            // ist der einzige Hebel, der Bluetooth tatsächlich auf den Telefonkanal
            // (SCO) lenkt statt auf dem leisen Medienkanal (A2DP) zu lassen.
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S && hasBluetoothAudioRoute()) {
                try {
                    audioManager.startBluetoothSco();
                    audioManager.setBluetoothScoOn(true);
                } catch (Exception e) {
                    Log.w(TAG, "startBluetoothSco failed", e);
                }
            }
        } else {
            // stopBluetoothSco() bedingungslos (auch falls SCO nie lief) — im
            // Gegensatz zum active-Zweig, der hasBluetoothAudioRoute() prüft, weil
            // Start nur bei verbundenem BT Sinn macht, Stopp aber immer sicher ist.
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
                try {
                    audioManager.setBluetoothScoOn(false);
                    audioManager.stopBluetoothSco();
                } catch (Exception e) {
                    Log.w(TAG, "stopBluetoothSco failed", e);
                }
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                try {
                    audioManager.clearCommunicationDevice();
                } catch (Exception e) {
                    Log.w(TAG, "clearCommunicationDevice failed", e);
                }
            }
            try {
                audioManager.setMode(AudioManager.MODE_NORMAL);
            } catch (Exception e) {
                Log.w(TAG, "setMode(NORMAL) failed", e);
            }
            resetVolumeStream();
        }
    }

    public int currentRoute() {
        return route;
    }

    public String routeName() {
        switch (route) {
            case ROUTE_SPEAKER:
            case ROUTE_EARPIECE: return "speaker"; // Legacy: Hörmuschel entfernt
            default: return "auto";
        }
    }

    private int targetDeviceType() {
        // Immer Lautsprecher — der Hörmuschel-Modus ist entfernt (2026-08-25):
        // Voice läuft wie „Anruf auf Lautsprecher". ROUTE_EARPIECE existiert nur
        // noch als Legacy-Konstante und wird wie SPEAKER behandelt.
        return AudioDeviceInfo.TYPE_BUILTIN_SPEAKER;
    }

    /**
     * Wendet die aktuelle Routing-Wahl an. Idempotent, jederzeit gefahrlos
     * aufrufbar (onResume, Mode-/device-Change, verzögertes Re-Apply).
     *
     * Priorität in AUTO: BT-Headset/Car → aktiv als Communication-Device setzen;
     * kabel-/USB-Headset → OS-Default (in Ruhe lassen); sonst Lautsprecher.
     * Override (SPEAKER/EARPIECE) gewinnt immer, auch über BT.
     */
    public void apply() {
        if (audioManager == null) return;
        // Nur kabel-/USB-Headsets (ohne Audio-Möglichkeit-Verwechslung) in AUTO
        // dem OS überlassen — BT wird bewusst ACTIV geroutet (früher early-return
        // für ALLE externen Geräte, was BT im Auto sich selbst überließ).
        if (route == ROUTE_AUTO && hasWiredHeadsetRoute()) {
            return;
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // setCommunicationDevice wirkt NUR in MODE_IN_COMMUNICATION.
                if (audioManager.getMode() != AudioManager.MODE_IN_COMMUNICATION) return;
                AudioDeviceInfo target = pickTargetDevice();
                if (target != null) {
                    boolean ok = audioManager.setCommunicationDevice(target);
                    if (!ok) {
                        Log.w(TAG, "setCommunicationDevice returned false for type " + target.getType());
                    }
                }
            } else {
                // API 24–30: deprecated, aber der einzige Weg. Bei ROUTE_AUTO + BT
                // Speakerphone AUS, damit Bluetooth/SCO das Routing übernimmt (sonst
                // zwei konfligierende Signale an AudioFlinger → unzuverlässig). Bei
                // SPEAKER-Override oder ohne BT wie gewünscht an/aus.
                boolean speakerOn = targetDeviceType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
                        && !(route == ROUTE_AUTO && hasBluetoothAudioRoute());
                audioManager.setSpeakerphoneOn(speakerOn);
            }
        } catch (Exception e) {
            Log.w(TAG, "audio routing failed", e);
        }
    }

    /** Wählt das Ziel-Gerät für API 31+: immer Lautsprecher (Hörmuschel entfernt);
     *  AUTO+BT → das verbundene BT-SCO-Gerät. {@code null}, wenn (AUTO + BT
     *  gemeldet, aber SCO-Gerät noch nicht als comm-Gerät verfügbar). */
    private AudioDeviceInfo pickTargetDevice() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null;
        int type = targetDeviceType();
        if (route == ROUTE_AUTO && type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
                && hasBluetoothAudioRoute()) {
            AudioDeviceInfo bt = findBluetoothCommDevice();
            if (bt != null) return bt;
            // BT gemeldet, aber noch kein comm-fähiges SCO-Gerät → OS-Default
            // nicht anrühren (race beim BT-Verbinden).
            return null;
        }
        // Explizite Lautsprecher-Wahl oder AUTO ohne BT.
        return findDeviceByType(type);
    }

    /** Re-Assert, wenn ein anderer (Chromium) das Kommunikationsgerät umgestellt
     *  hat. Self-Trigger-Schutz: passiert nichts, wenn das Gerät schon stimmt. */
    private void onCommDeviceChanged() {
        if (audioManager == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return;
        if (audioManager.getMode() != AudioManager.MODE_IN_COMMUNICATION) return;
        if (route == ROUTE_AUTO && hasWiredHeadsetRoute()) return;
        AudioDeviceInfo cur = audioManager.getCommunicationDevice();
        AudioDeviceInfo target = pickTargetDevice();
        if (target == null) return;
        if (cur != null && cur.getType() == target.getType()
                && cur.getId() == target.getId()) {
            return; // schon korrekt → kein Loop
        }
        apply();
    }

    private AudioDeviceInfo findDeviceByType(int deviceType) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null;
        for (AudioDeviceInfo d : audioManager.getAvailableCommunicationDevices()) {
            if (d.getType() == deviceType) return d;
        }
        return null;
    }

    /** Das verbundene BT-SCO-Gerät unter den verfügbaren Communication-Devices.
     *  {@code null}, wenn BT (noch) nicht als comm-Gerät gemeldet ist. */
    private AudioDeviceInfo findBluetoothCommDevice() {
        return findDeviceByType(AudioDeviceInfo.TYPE_BLUETOOTH_SCO);
    }

    /** True, wenn ein kabelgebundenes/USB-Headset angeschlossen ist (in AUTO
     *  OS-Default respektieren). Bewusst OHNE USB-Device (generischer OEM-Typ). */
    private boolean hasWiredHeadsetRoute() {
        if (audioManager == null) return false;
        for (AudioDeviceInfo d : audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            switch (d.getType()) {
                case AudioDeviceInfo.TYPE_WIRED_HEADSET:
                case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
                case AudioDeviceInfo.TYPE_USB_HEADSET:
                case AudioDeviceInfo.TYPE_HEARING_AID:
                    return true;
                default:
                    break;
            }
        }
        return false;
    }

    /** True, wenn ein Bluetooth-Audio-Ausgabegerät (A2DP Media oder SCO Telefonie)
     *  verbunden ist. */
    private boolean hasBluetoothAudioRoute() {
        if (audioManager == null) return false;
        for (AudioDeviceInfo d : audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            if (d.getType() == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP
                    || d.getType() == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) {
                return true;
            }
        }
        return false;
    }

    /** Hardware-Lautstärketasten auf den Voice-Call-Stream lenken (statt MEDIA).
     *  Das ist der Hebel gegen „volles Aufdrehen, kaum Ton" — der User regelt
     *  sonst den falschen Stream. */
    private void setVoiceVolumeStream() {
        if (activity != null) {
            try {
                activity.setVolumeControlStream(AudioManager.STREAM_VOICE_CALL);
            } catch (Exception e) {
                Log.w(TAG, "setVolumeControlStream failed", e);
            }
        }
    }

    private void resetVolumeStream() {
        if (activity != null) {
            try {
                activity.setVolumeControlStream(AudioManager.USE_DEFAULT_STREAM_TYPE);
            } catch (Exception e) {
                Log.w(TAG, "resetVolumeControlStream failed", e);
            }
        }
    }
}
