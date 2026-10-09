package com.howispulse.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * JS↔nativ-Brücke für Chat-Benachrichtigungen im APK (WhatsApp-Stil): das Web
 * feuert bei dm_bump/mention_added aus dem WS-Lauf, solange die App im
 * Hintergrund bzw. gesperrt ist — dieselben Gates wie der Desktop-Weg (DND,
 * Sichtschutz, Server-Stummschaltung, Sub-Toggles; notifications/inPage.ts).
 * Der Android-WebView kennt kein `new Notification()`, darum dieser Weg.
 *
 * Heads-up (Popup über der aktuellen App) braucht einen IMPORTANCE_HIGH-Channel;
 * ab Android 13 zusätzlich die POST_NOTIFICATIONS-Runtime-Genehmigung
 * ({@link #anfordern} — das Web ruft es beim ersten Zustellversuch). Tipp öffnet
 * die App; gezieltes Hinspringen zum Kanal wäre der Nachzieher (target_url
 * über einen Intent-Extra → WebView-Brücke durchreichen).
 */
@CapacitorPlugin(name = "Hinweise", permissions = {
        @Permission(strings = {Manifest.permission.POST_NOTIFICATIONS}, alias = "hinweise")
})
public class HinweisePlugin extends Plugin {

    private static final String CHANNEL_ID = "chat-nachrichten";
    private static final String PERMISSION_ALIAS = "hinweise";
    private PluginCall permissionCall;

    /** Von MainActivity beim Tipp auf eine Nachricht gesetztes SPA-Ziel
     *  ('/app/@me/<id>' o. ä.) — das Web holt es per zielUrl() ab. */
    private static volatile String zielUrlWartend;

    static void setzeZielUrl(String url) {
        zielUrlWartend = url;
    }

    @Override
    public void load() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel kanal = new NotificationChannel(CHANNEL_ID,
                    "Nachrichten", NotificationManager.IMPORTANCE_HIGH);
            kanal.setDescription("Direktnachrichten und Erwähnungen");
            kanal.enableVibration(true);
            NotificationManager nm = (NotificationManager) getContext()
                    .getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.createNotificationChannel(kanal);
        }
    }

    /** Web → nativ: Heads-up-Notification zeigen (id = message_id → Collapse). */
    @PluginMethod
    public void zeigen(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(getContext(),
                Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            call.reject("keine Berechtigung");
            return;
        }
        String titel = call.getString("titel", "Pulse");
        String text = call.getString("text", "");
        String mid = call.getString("id", "");
        Context ctx = getContext();
        Intent rein = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        PendingIntent intent = PendingIntent.getActivity(ctx, mid.hashCode(), rein,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle(titel)
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setAutoCancel(true)
                .setContentIntent(intent);
        NotificationManager nm = (NotificationManager) ctx
                .getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) {
            call.reject("kein NotificationManager");
            return;
        }
        nm.notify(mid.isEmpty() ? 1 : mid.hashCode(), b.build());
        call.resolve();
    }

    /** Runtime-Genehmigung (Android 13+); darunter immer erteilt. */
    @PluginMethod
    public void anfordern(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33) {
            call.resolve();
            return;
        }
        permissionCall = call;
        requestPermissionForAlias(PERMISSION_ALIAS, call, "permissionCallback");
    }

    /**
     * WhatsApp-Stil: MessagingStyle-Notification je CHAT (chatId gruppier­tic­kt
     * mehrere Nachrichten desselben Chats auf einen Zettel-Eintrag), Absender
     * mit Kontaktbild (avatar — wird nebenläufig geladen), Badge-Zähler
     * (anzahl), Zeitstempel. ziel = SPA-Pfad, den das Web beim Tippen per
     * zielUrl() abholt und hin-navigiert. Avatar-Fehler degraden bewusst auf
     * den Standard-Kreis, statt die Meldung zu verlieren.
     */
    @PluginMethod
    public void nachricht(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(getContext(),
                Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            call.reject("keine Berechtigung");
            return;
        }
        final Context ctx = getContext();
        final String chatId = call.getString("chatId", "");
        final String absender = call.getString("absender", "Pulse");
        final String text = call.getString("text", "");
        final String mid = call.getString("id", "");
        final String avatarUrl = call.getString("avatar", "");
        final String ziel = call.getString("ziel", "");
        final int anzahl = call.getInt("anzahl", 1);
        NotificationManager nm = (NotificationManager) ctx
                .getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) {
            call.reject("kein NotificationManager");
            return;
        }
        final NotificationManager nmF = nm;
        Thread laden = new Thread(() -> {
            try {
                android.graphics.Bitmap avatar = null;
                if (!avatarUrl.isEmpty()) {
                    try {
                        java.net.URL u = new java.net.URL(avatarUrl);
                        avatar = android.graphics.BitmapFactory.decodeStream(u.openConnection().getInputStream());
                    } catch (Exception e) {
                        Log.w("Hinweise", "Avatar nicht ladbar — Standard-Kreis", e);
                    }
                }
                Person sender = new Person.Builder().setName(absender)
                        .setIcon(avatar != null
                                ? androidx.core.graphics.drawable.IconCompat.createWithBitmap(avatar)
                                : null)
                        .setKey(absender).build();
                NotificationCompat.MessagingStyle style = new NotificationCompat.MessagingStyle(
                        new Person.Builder().setName("Du").build());
                style.addMessage(new NotificationCompat.MessagingStyle.Message(
                        text, System.currentTimeMillis(), sender));
                Intent rein = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
                if (!ziel.isEmpty()) rein.putExtra("pulse_ziel", ziel);
                PendingIntent intent = PendingIntent.getActivity(ctx,
                        (chatId + ziel).hashCode(), rein,
                        PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
                NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                        .setSmallIcon(android.R.drawable.stat_notify_chat)
                        .setStyle(style)
                        .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                        .setAutoCancel(true)
                        .setContentIntent(intent)
                        .setNumber(anzahl)
                        .setGroup("chat-" + chatId)
                        .setWhen(System.currentTimeMillis())
                        .setShowWhen(true);
                nmF.notify(chatId.isEmpty() ? mid.hashCode() : chatId.hashCode(), b.build());
                Log.i("Hinweise", "nachricht gepostet: chat=" + chatId + " absender=" + absender);
            } catch (Exception e) {
                Log.e("Hinweise", "nachricht FEHLGESCHLAGEN", e);
            }
        });
        laden.start();
        call.resolve();
    }

    /** Web holt das beim letzten Tipp gesetzte SPA-Ziel (und räumt es ab). */
    @PluginMethod
    public void zielUrl(PluginCall call) {
        JSObject r = new JSObject();
        String url = zielUrlWartend;
        zielUrlWartend = null;
        r.put("url", url);
        call.resolve(r);
    }

    /** Web fragt vor dem ersten Zustellversuch — ohne die Methode wirft der
     *  Proxy "not implemented" und der Wrapper verschluckt JEDE Meldung. */
    @PluginMethod
    public void erlaubt(PluginCall call) {
        boolean ok = Build.VERSION.SDK_INT < 33
                || ContextCompat.checkSelfPermission(getContext(),
                        Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        JSObject r = new JSObject();
        r.put("erlaubt", ok);
        call.resolve(r);
    }

    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        permissionCall = null;
        call.resolve();
    }
}
