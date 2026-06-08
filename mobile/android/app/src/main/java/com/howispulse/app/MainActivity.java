package com.howispulse.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

import java.util.ArrayList;
import java.util.List;

/**
 * Capacitor-Host-Activity. Erweitert um:
 *  - Runtime-Anfrage von RECORD_AUDIO (+ POST_NOTIFICATIONS ab API 33). Capacitor
 *    reicht die WebView-getUserMedia-Permission selbst durch, sobald RECORD_AUDIO
 *    granted ist (BridgeWebChromeClient.onPermissionRequest).
 *  - Start des microphone-Foreground-Service, solange die Activity sichtbar ist
 *    (while-in-use-Regel ab API 34). Der FGS läuft danach durchgehend und soll
 *    die Mic-Aufnahme bei Screen-Lock am Leben halten — die Test-Hypothese.
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

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        speakerRouter = new SpeakerphoneRouter(this, ContextCompat.getMainExecutor(this));
        speakerRouter.start();
        ensurePermissionsThenStartMicService();
    }

    @Override
    public void onResume() {
        super.onResume();
        // Chromium kann den Audio-Modus zwischen Sessions umstellen; bei jeder
        // Rückkehr in den Vordergrund den Lautsprecher erneut erzwingen.
        if (speakerRouter != null) speakerRouter.apply();
    }

    @Override
    public void onDestroy() {
        if (speakerRouter != null) {
            speakerRouter.stop();
            speakerRouter = null;
        }
        super.onDestroy();
    }

    private void ensurePermissionsThenStartMicService() {
        List<String> need = new ArrayList<>();
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.RECORD_AUDIO);
        }
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (need.isEmpty()) {
            startMicService();
        } else {
            ActivityCompat.requestPermissions(this, need.toArray(new String[0]), REQ_VOICE_PERMS);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_VOICE_PERMS) {
            startMicService();
        }
    }

    private void startMicService() {
        // Ohne Mic-Permission ist ein microphone-FGS sinnlos (und würde ab API 34
        // mit SecurityException starten).
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        Intent i = new Intent(this, MicForegroundService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(i);
        } else {
            startService(i);
        }
    }
}
