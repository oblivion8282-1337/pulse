package com.howispulse.app;

import android.app.Activity;
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
        } else {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    audioManager.clearCommunicationDevice();
                }
            } catch (Exception e) {
                Log.w(TAG, "clearCommunicationDevice failed", e);
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
                // API 24–30: deprecated, aber der einzige Weg. setSpeakerphoneOn
                // deckt nur Speaker/earpiece ab; BT läuft hier ohnehin OS-gesteuert.
                audioManager.setSpeakerphoneOn(targetDeviceType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER);
            }
        } catch (Exception e) {
            Log.w(TAG, "audio routing failed", e);
        }
    }

    /** Wählt das Ziel-Gerät für API 31+: Override → speaker/earpiece; AUTO+BT →
     *  das verbundene BT-SCO-Gerät; AUTO sonst → speaker/earpiece. {@code null},
     *  wenn (AUTO + BT gemeldet, aber SCO-Gerät noch nicht als comm-Gerät verfügbar). */
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
        // Explizite speaker/earpiece-Wahl oder AUTO ohne BT.
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
