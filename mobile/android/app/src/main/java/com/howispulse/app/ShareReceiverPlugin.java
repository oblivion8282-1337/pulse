package com.howispulse.app;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * Empfangsbrücke für geteilte Inhalte (Übergabe P1.8, Share-Target):
 * MainActivity fängt ACTION_SEND ab, liest Bild-Bytes SOFORT in Base64
 * (die Leserechte des Intents gelten im Activity-Kontext) und legt das
 * Paket hier ab; die WebView holt es per ``getPending`` beim App-Start
 * bzw. nach jedem ``resume`` und leert es damit.
 *
 * ponytail: Bilder blockieren den Hauptthread beim Einlesen (einmalig,
 * typischerweise < 1 s). Wer effizienters Streaming will, baut einen
 * Hintergrund-Read plus Event — für einen Share-Kick ist das zu viel.
 */
@CapacitorPlugin(name = "ShareReceiver")
public class ShareReceiverPlugin extends Plugin {

    private static ShareReceiverPlugin instance;

    private String pendingText;
    /** Base64 des Bildes inkl. Mime-Subtyp-Info via ``pendingImageMime``. */
    private String pendingImageBase64;
    private String pendingImageMime;

    @Override
    public void load() {
        instance = this;
    }

    public static void ankommen(String text, String imageMime, byte[] imageBytes) {
        ShareReceiverPlugin p = instance;
        if (p == null) return;
        if (text != null && !text.isEmpty()) p.pendingText = text;
        if (imageBytes != null && imageBytes.length > 0) {
            p.pendingImageBase64 = Base64.encodeToString(imageBytes, Base64.NO_WRAP);
            p.pendingImageMime = imageMime;
        }
    }

    @PluginMethod
    public void getPending(PluginCall call) {
        JSObject paket = new JSObject();
        if (pendingText != null) paket.put("text", pendingText);
        if (pendingImageBase64 != null) {
            paket.put("imageBase64", pendingImageBase64);
            paket.put("imageMime", pendingImageMime);
        }
        pendingText = null;
        pendingImageBase64 = null;
        pendingImageMime = null;
        call.resolve(paket);
    }
}
