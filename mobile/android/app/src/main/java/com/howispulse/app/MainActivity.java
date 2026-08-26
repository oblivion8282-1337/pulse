package com.howispulse.app;

import android.Manifest;
import android.content.Intent;
import android.content.res.Configuration;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

import java.util.ArrayList;
import java.util.List;

/**
 * Capacitor-Host-Activity. Erweitert um:
 *  - Runtime-Anfrage von RECORD_AUDIO (+ POST_NOTIFICATIONS ab API 33). Capacitor
 *    reicht die WebView-getUserMedia-Permission selbst durch, sobald RECORD_AUDIO
 *    granted ist (BridgeWebChromeClient.onPermissionRequest).
 *  - Start/Stopp des microphone-Foreground-Service GEBUNDEN an einen aktiven
 *    Voice-Call (while-in-use-Regel ab API 34). {@link #setMicServiceActive}
 *    wird vom {@link AudioRoutePlugin} gerufen, sobald das Web „voice beigetreten"
 *    bzw. „verlassen" signalisiert (setVoiceActive). Der Service läuft also NUR
 *    während eines Calls und soll die Mic-Aufnahme bei Screen-Lock am Leben
 *    halten — beim App-Start wird er bewusst NICHT mehr gezogen (sonst liefe
 *    Pulse dauerhaft im Hintergrund → Akku + „aktive Apps"-Hinweis).
 *  - SpeakerphoneRouter: zwingt die WebRTC-Wiedergabe auf den lauten Medien-
 *    Lautsprecher statt die Hörmuschel (Chromium setzt bei aktivem WebRTC den
 *    Audio-Modus auf MODE_IN_COMMUNICATION → Android routet sonst auf earpiece).
 *
 * Bewusst NICHT: webView.onPause()/pauseTimers() — der WebView muss im
 * Hintergrund weiterlaufen, sonst stoppt der getUserMedia/LiveKit-Stream sowieso.
 * BridgeActivity ruft das per Default nicht auf.
 */
public class MainActivity extends BridgeActivity {

    private static final int REQ_VOICE_PERMS = 9473;

    private SpeakerphoneRouter speakerRouter;

    /** Service-Start steht aus, weil die Mic-Permission erst eingeholt wird.
     *  Setzt voraus, dass der User gerade einen Voice-Join ausgelöst hat. */
    private boolean micStartPending = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // MUSS vor super.onCreate registriert werden, damit die Bridge das Plugin
        // kennt, bevor die WebView lädt (Capacitor-Konvention).
        registerPlugin(AudioRoutePlugin.class);
        registerPlugin(OrientationLockPlugin.class);
        super.onCreate(savedInstanceState);
        speakerRouter = new SpeakerphoneRouter(this, this, ContextCompat.getMainExecutor(this));
        speakerRouter.start();
        // Querformat nur mit Stream (s. OrientationLockPlugin): Start immer
        // hochkant — das Web gibt die Sperre frei, sobald ein Stream läuft.
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_USER_PORTRAIT);
    }

    /** Vom {@link AudioRoutePlugin} genutzt, damit der UI-Umschalter und das
     *  automatische Routing denselben Router-Zustand teilen. */
    public SpeakerphoneRouter getSpeakerphoneRouter() {
        return speakerRouter;
    }

    /**
     * Vom {@link AudioRoutePlugin} gerufen, sobald das Web „voice beigetreten"
     * ({@code active=true}) bzw. „verlassen" ({@code false}) signalisiert.
     * Startet bzw. stoppt den {@link MicForegroundService} passend — er läuft
     * also nur, solange Voice aktiv ist, nie pausenlos ab App-Start.
     */
    public void setMicServiceActive(boolean active) {
        if (active) {
            startMicService();
        } else {
            micStartPending = false;
            stopService(new Intent(this, MicForegroundService.class));
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        // Chromium kann den Audio-Modus zwischen Sessions umstellen; bei jeder
        // Rückkehr in den Vordergrund den Lautsprecher erneut erzwingen.
        if (speakerRouter != null) speakerRouter.apply();
        // Nach Rückkehr gilt die aktuelle Orientierung wieder (z. B. quer
        // gesperrt mit Stream → Leisten bleiben weg).
        wendeLeistenAn(getResources().getConfiguration().orientation);
    }

    /**
     * Immersive Mode im Querformat (Nutzerwunsch 2026-08-26): Status- und
     * Navigationsleiste werden ausgeblendet, sobald das Handy quer liegt —
     * quer gehört dem Inhalt (Stream/Vollbild), hochkant der Navigation.
     * Ein Wischen vom Rand zeigt die Leisten transient (BEHAVIOR_SHOW_…_BY_SWIPE).
     */
    private void wendeLeistenAn(int orientation) {
        WindowInsetsControllerCompat c =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (c == null) return;
        if (orientation == Configuration.ORIENTATION_LANDSCAPE) {
            c.setSystemBarsBehavior(
                    WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            c.hide(WindowInsetsCompat.Type.systemBars());
        } else {
            c.show(WindowInsetsCompat.Type.systemBars());
        }
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // configChanges im Manifest fängt die Drehung ohne Activity-Neubau ab —
        // hier wird nur der Leisten-Zustand nachgezogen.
        wendeLeistenAn(newConfig.orientation);
    }

    @Override
    public void onDestroy() {
        if (speakerRouter != null) {
            speakerRouter.stop();
            speakerRouter = null;
        }
        // Sicherheitsnetz: falls das Web das Leave-Signal nicht (mehr) schicken
        // konnte (Prozess-Wechsel, Absturz). Ohne das könnte der FGS hängenbleiben.
        stopService(new Intent(this, MicForegroundService.class));
        super.onDestroy();
    }

    private void startMicService() {
        // Ohne Mic-Permission ist ein microphone-FGS sinnlos (und würde ab API 34
        // mit SecurityException starten). Noch nicht erteilt → runtime anfragen
        // und den Start zurückstellen, bis der Grant eintrifft.
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            micStartPending = true;
            List<String> need = new ArrayList<>();
            need.add(Manifest.permission.RECORD_AUDIO);
            if (Build.VERSION.SDK_INT >= 33
                    && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                            != PackageManager.PERMISSION_GRANTED) {
                need.add(Manifest.permission.POST_NOTIFICATIONS);
            }
            ActivityCompat.requestPermissions(this, need.toArray(new String[0]), REQ_VOICE_PERMS);
            return;
        }
        // ContextCompat wählt intern startForegroundService (API 26+) bzw.
        // startService (darunter) — entspricht der bisherigen Version-Branch.
        ContextCompat.startForegroundService(this, new Intent(this, MicForegroundService.class));
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        // Nur nachholen, wenn der Start auf den Permission-Grant gewartet hat.
        if (requestCode == REQ_VOICE_PERMS && micStartPending) {
            micStartPending = false;
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                    == PackageManager.PERMISSION_GRANTED) {
                ContextCompat.startForegroundService(this, new Intent(this, MicForegroundService.class));
            }
            // Abgewiesen → kein Service. Der WebView-getUserMedia wird ohnehin
            // fehlschlagen, der User bleibt ohne Mic, aber ohne Hintergrund-Last.
        }
    }
}
