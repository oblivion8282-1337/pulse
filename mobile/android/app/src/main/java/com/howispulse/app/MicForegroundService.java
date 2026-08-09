package com.howispulse.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

/**
 * Minimaler Foreground Service vom Typ "microphone". Zweck:
 * Auf OS-Ebene die Voraussetzung schaffen, dass die Mikrofon-Aufnahme bei
 * gesperrtem Bildschirm / im Hintergrund während eines Voice-Calls nicht
 * gekappt wird.
 *
 * Gesteuert wird er ausschließlich über {@link MainActivity#setMicServiceActive}
 * (getrieben vom setVoiceActive-Signal aus dem Web): startet beim Voice-Join,
 * stoppt beim Leave. Er läuft also NIE pausenlos ab App-Start — das früher
 * bedingungslose Starten in onCreate erzeugte den Android-Hinweis „läuft im
 * Hintergrund" und kostete Akku, weil der Prozess nie suspendiert wurde.
 *
 * Der Service tut selbst NICHTS mit dem Mikrofon — er öffnet keinen eigenen
 * Aufnahme-Pfad (das würde mit dem WebView um das Mic konkurrieren). Er hält
 * nur die App als "microphone in use" am Leben.
 */
public class MicForegroundService extends Service {
    private static final String CHANNEL_ID = "pulse_voice";
    private static final int NOTIF_ID = 4711;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        createChannel();
        Notification n = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Pulse Voice aktiv")
                .setContentText("Mikrofon bleibt im Hintergrund aktiv")
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } else {
            startForeground(NOTIF_ID, n);
        }
        // START_NOT_STICKY: wird der Service gekillt, soll er NICHT von selbst
        // wiederkommen — ein Start erfolgt nur gezielt bei einem neuen Voice-Join
        // (MainActivity.setMicServiceActive). START_STICKY hätte ihn auch ohne
        // aktiven Call reproduziert → dauerhafter Hintergrund-Prozess + Akku.
        return START_NOT_STICKY;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "Pulse Voice", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Hält das Mikrofon während eines Voice-Calls aktiv");
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
