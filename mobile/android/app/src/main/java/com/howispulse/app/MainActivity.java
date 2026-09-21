package com.howispulse.app;

import android.Manifest;
import android.app.DownloadManager;
import android.content.Intent;
import android.content.res.Configuration;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;

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
        // Bughunt Runde 45: micStartPending in SharedPreferences — bei
        // Prozess-Neubau während des Permission-Dialogs (Android killt die
        // Activity, das Grant kommt bei der FRISCHEN Activity an) war das
        // Flag weg und der FGS startete nie nach. (onSaveInstanceState
        // steht nicht zur Verfügung: BridgeActivity deklariert es final.)
        micStartPending = getPreferences(MODE_PRIVATE).getBoolean("micStartPending", false);
        // MUSS vor super.onCreate registriert werden, damit die Bridge das Plugin
        // kennt, bevor die WebView lädt (Capacitor-Konvention).
        registerPlugin(AudioRoutePlugin.class);
        registerPlugin(OrientationLockPlugin.class);
        super.onCreate(savedInstanceState);
        // Bughunt Runde 45: Capacitor setzt KEINEN DownloadListener — ein
        // Android-WebView wirft Downloads STILLWEGE weg (Blob-URLs aus
        // `URL.createObjectURL` inklusive). Jeder Download-Knopf in der App
        // (2FA-Backup-Codes, Anhänge, Ablage, .env-Export) tat auf Android
        // schlicht nichts. Umweg über DownloadManager: Blob-URLs kann er
        // nicht laden — dafür ist der Ersatzweg verantwortlich, alles andere
        // (https-Presigns etc.) geht an den System-Download.
        bridge.getWebView().setDownloadListener((url, userAgent, contentDisposition, mimeType, length) -> {
            if (url == null || url.startsWith("blob:")) return;
            try {
                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                if (userAgent != null) req.addRequestHeader("User-Agent", userAgent);
                if (mimeType != null) req.setMimeType(mimeType);
                req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "pulse-download");
                DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                if (dm != null) dm.enqueue(req);
            } catch (Exception ignored) {
                // Nicht abfangbar ohne Toast-Infrastruktur — besser als ein
                // App-Crash; der Web-Seitige Fehlerpfad greift via Download-Feed.
            }
        });
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
            getPreferences(MODE_PRIVATE).edit().putBoolean("micStartPending", false).apply();
            stopService(new Intent(this, MicForegroundService.class));
        }
    }

    /**
     * Bughunt Runde 45: startForegroundService aus dem Hintergrund ist ab
     * API 31 eine ForegroundServiceStartNotAllowedException — uncaught auf
     * dem UI-Thread = App-Crash. Passiert real: der User joint Voice und
     * drückt Home, während der Token-Roundtrip läuft; der setVoiceActive-
     * Plugin-Call landet mit gepauster Activity. Ohne Vordergrund bleibt
     * der Start aus (der WebView-Stream stirbt dort ohnehin); kein Crash.
     */
    private void startFgsSicher() {
        try {
            ContextCompat.startForegroundService(this, new Intent(this, MicForegroundService.class));
        } catch (SecurityException | IllegalStateException ignored) {
            // Activity nicht RESUMED / FGS-Restriktion — bewusst schlucken.
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
            getPreferences(MODE_PRIVATE).edit().putBoolean("micStartPending", true).apply();
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
        startFgsSicher();
        // Bughunt Runde 8: die Laufzeit-Notification-Berechtigung (Android 13+)
        // wurde bisher NUR gekoppelt mit einer fehlenden Mic-Berechtigung
        // erfragt — ab dem zweiten Voice-Join (Mic längst erteilt) wurde sie
        // nie wieder gestellt und der laufende-Call-Hinweis blieb dauerhaft
        // unsichtbar. Jetzt eigenständig nachziehen, wenn sie fehlt.
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                    this,
                    new String[]{Manifest.permission.POST_NOTIFICATIONS},
                    REQ_VOICE_PERMS);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        // Nur nachholen, wenn der Start auf den Permission-Grant gewartet hat.
        if (requestCode == REQ_VOICE_PERMS && micStartPending) {
            micStartPending = false;
            getPreferences(MODE_PRIVATE).edit().putBoolean("micStartPending", false).apply();
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                    == PackageManager.PERMISSION_GRANTED) {
                startFgsSicher();
            }
            // Abgewiesen → kein Service. Der WebView-getUserMedia wird ohnehin
            // fehlschlagen, der User bleibt ohne Mic, aber ohne Hintergrund-Last.
        }
    }
}
