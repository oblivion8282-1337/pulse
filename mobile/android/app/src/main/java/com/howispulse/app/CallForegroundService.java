package com.howispulse.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.content.ContextCompat;

/**
 * Klingelnder Anruf als Sperrbildschirm-Notification (Anrufe-Epic E). Kurz-
 * lebiger Foreground-Service vom Typ "phoneCall" — nur solange ein eingehender
 * Anruf klingelt, nie pausenlos. Er existiert in erster Linie, damit das System
 * die Notification als CallStyle-Call rendert (Sperrbildschirm-Karte mit
 * Annehmen/Ablehnen); ein Full-Screen-Intent startet bei gesperrtem Bildschirm
 * die MainActivity, wo das Web-Overlay (AnrufOverlay.svelte) übernimmt.
 *
 * Gesteuert ausschließlich über {@link AnrufPlugin}: das Web signalisiert
 * „klingelt" ({@link #ankommen}, WS call_klingelt im Anruf-Store angekommen)
 * und „beendet" ({@link #beenden} — angenommen/abgelehnt/call_ende). Ein
 * Annehmen/Ablehnen direkt aus der Notification läuft als Broadcast über
 * {@link AktionsEmpfaenger} zurück in die WebView (die Signalisierung lebt im
 * Klienten), dismissed die Notification und stoppt diesen Service.
 */
public class CallForegroundService extends Service {
    private static final String CHANNEL_ID = "pulse_anrufe";
    private static final int NOTIF_ID = 4712;

    static final String EXTRA_CALL_ID = "callId";
    static final String EXTRA_GEGENSTELLE = "gegenstelle";
    static final String AKTION_ANNEHMEN = "annehmen";
    static final String AKTION_ABLEHNEN = "ablehnen";

    /** Vom {@link AnrufPlugin} (Web: eingehender Anruf klingelt). */
    public static void ankommen(Context ctx, String callId, String gegenstelle) {
        Intent start = new Intent(ctx, CallForegroundService.class)
                .putExtra(EXTRA_CALL_ID, callId)
                .putExtra(EXTRA_GEGENSTELLE, gegenstelle);
        try {
            ContextCompat.startForegroundService(ctx, start);
        } catch (Exception e) {
            // ponytail: App länger im Hintergrund → FGS-Start verweigert
            // (API 31+ ForegroundServiceStartNotAllowedException). Notification
            // trotzdem direkt posten — CallStyle wird dann notfalls zur normalen
            // High-Priority-Notification abgestuft, Full-Screen-Intent und
            // Annehmen/Ablehnen-Buttons bleiben. Upgrade-Pfad: FCM-High-Priority-
            // Push als FGS-Start-Ausnahme.
            kanalAnlegen(ctx);
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            if (nm != null) nm.notify(NOTIF_ID, baue(ctx, callId, gegenstelle));
        }
    }

    /** Vom {@link AnrufPlugin} (Web: angenommen/abgelehnt/beendet) bzw. aus
     *  MainActivity.onResume (App im Vordergrund → Overlay übernimmt). */
    public static void beenden(Context ctx) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(NOTIF_ID);
        ctx.stopService(new Intent(ctx, CallForegroundService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Neustart nach Kill ohne Auftrag (START_NOT_STICKY liefert null) —
        // ohne call_klingelt dahinter gibt es nichts zu zeigen.
        if (intent == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        kanalAnlegen(this);
        Notification n = baue(this,
                intent.getStringExtra(EXTRA_CALL_ID),
                intent.getStringExtra(EXTRA_GEGENSTELLE));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL);
        } else {
            startForeground(NOTIF_ID, n);
        }
        return START_NOT_STICKY;
    }

    private static Notification baue(Context ctx, String callId, String gegenstelle) {
        String name = (gegenstelle == null || gegenstelle.isEmpty()) ? "Unbekannt" : gegenstelle;
        // Full-Screen-Intent: MainActivity (singleTask) nach vorn holen — das
        // Overlay rendert aus dem Store, Extra-Daten braucht es nicht.
        PendingIntent vollbild = PendingIntent.getActivity(ctx, 0,
                new Intent(ctx, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Person anrufer = new Person.Builder().setName(name).build();
        return new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_menu_call)
                .setContentTitle("Eingehender Anruf")
                .setContentText(name)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setFullScreenIntent(vollbild, true)
                // CallStyle-Call-Karte (Android 12+): Plattform rendert eigene
                // Annehmen/Ablehnen-Flächen aus den beiden PendingIntents.
                .setStyle(NotificationCompat.CallStyle.forIncomingCall(anrufer,
                        aktion(ctx, AKTION_ABLEHNEN, callId),
                        aktion(ctx, AKTION_ANNEHMEN, callId)))
                .build();
    }

    private static PendingIntent aktion(Context ctx, String aktion, String callId) {
        Intent i = new Intent(ctx, AktionsEmpfaenger.class)
                .setAction(aktion)
                .putExtra(EXTRA_CALL_ID, callId);
        return PendingIntent.getBroadcast(ctx, aktion.hashCode(), i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Annehmen/Ablehnen direkt aus der Notification — auch über dem
     *  Sperrbildschirm, ganz ohne Activity-Start (Broadcast, also auch kein
     *  Verstoß gegen das Notification-Trampoline-Verbot). */
    public static class AktionsEmpfaenger extends BroadcastReceiver {
        @Override
        public void onReceive(Context ctx, Intent intent) {
            String aktion = intent.getAction();
            boolean gueltig = AKTION_ANNEHMEN.equals(aktion) || AKTION_ABLEHNEN.equals(aktion);
            beenden(ctx);
            if (gueltig) {
                AnrufPlugin.aktion(aktion, intent.getStringExtra(EXTRA_CALL_ID));
            }
        }
    }

    private static void kanalAnlegen(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Eingehende Anrufe",
                NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Vollbild-Benachrichtigung bei eingehenden Anrufen");
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm != null) nm.createNotificationChannel(ch);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
