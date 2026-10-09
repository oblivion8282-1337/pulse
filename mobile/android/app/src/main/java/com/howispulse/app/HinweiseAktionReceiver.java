package com.howispulse.app;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Aktion „Als gelesen markieren“ der Chat-Benachrichtigungen: macht den
 * Lesestand-PUT nativ (PUT basis+pfad, Body last_read_message_id — gleiche
 * Form wie lesestand.ts) und räumt die Meldung weg. Der WebView wäre im
 * Hintergrund gefroren, darum dieser native Weg. Fire-and-forget — ein
 * Fehlschlag kostet nur den blauen Haken, nie die Nachricht (Muster
 * lesestand.ts).
 */
public class HinweiseAktionReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (!"als_gelesen".equals(intent.getAction())) return;
        String basis = intent.getStringExtra("basis");
        String pfad = intent.getStringExtra("pfad");
        String token = intent.getStringExtra("token");
        String mid = intent.getStringExtra("mid");
        int nid = intent.getIntExtra("nid", 0);
        if (basis == null || pfad == null || basis.isEmpty() || pfad.isEmpty()) return;

        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(nid);

        Thread put = new Thread(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(basis + pfad).openConnection();
                c.setRequestMethod("PUT");
                c.setRequestProperty("Authorization", "Bearer " + token);
                c.setRequestProperty("Content-Type", "application/json");
                c.setDoOutput(true);
                byte[] body = ("{\"last_read_message_id\":\"" + mid + "\"}")
                        .getBytes(StandardCharsets.UTF_8);
                try (OutputStream os = c.getOutputStream()) {
                    os.write(body);
                }
                int code = c.getResponseCode();
                Log.i("Hinweise", "als gelesen markiert: " + code);
                c.disconnect();
            } catch (Exception e) {
                Log.w("Hinweise", "als-gelesen fehlgeschlagen", e);
            }
        });
        put.start();
    }
}
