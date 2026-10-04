package com.howispulse.app;

import android.content.Intent;
import android.net.Uri;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import android.Manifest;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;

/**
 * Native Video-Aufnahme (Testrunde 2026-09-11): startet die SYSTEM-Kamera im
 * Videomodus (ACTION_VIDEO_CAPTURE) und liefert das Ergebnis als Base64 an
 * das Web. Warum so: die WebView-Variante (getUserMedia + MediaRecorder im
 * Canvas) zeigt beim Kamera-Start das graue Kästchen und die System-Kamera
 * liefert bessere Qualität mit Hardware-Kodierung. Fotos laufen parallel dazu
 * über das @capacitor/camera-Plugin.
 *
 * Das Video wird aus der MediaStore-URI in den App-Cache kopiert und als
 * Base64 (NO_WRAP) zurückgegeben — der WebView lädt remote (PULSE_DEV_URL /
 * Produktion), ein file://-Fetch aus dem Web heraus wäre dort nicht machbar.
 * Grenze bewusst: sehr lange Videos erzeugen große Base64-Strings im Bridge-
 * Speicher; für Messenger-Kurzclips (≤ ~1 min) ist das ausreichend.
 */
@CapacitorPlugin(name = "VideoCapture", permissions = {
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA })
})
public class VideoCapturePlugin extends Plugin {

    /** Der Call, dessen Ergebnis der ActivityCallback liefert. */
    private PluginCall aktiverCall;

    @PluginMethod
    public void aufnehmen(PluginCall call) {
        // Die Samsung-Kamera-App verlangt, dass der AUFRUFENDE die CAMERA-
        // Berechtigung hält (SecurityException sonst — Crash der App,
        // Testrunde 2026-09-11). Erst anfragen, dann starten.
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            requestPermissionForAlias("camera", call, "cameraPermResult");
            return;
        }
        startAufnahme(call);
    }

    @PermissionCallback
    private void cameraPermResult(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED) {
            startAufnahme(call);
        } else {
            call.reject("kamera_berechtigung_fehlt");
        }
    }

    private void startAufnahme(PluginCall call) {
        Intent intent = new Intent(MediaStore.ACTION_VIDEO_CAPTURE);
        // Messenger-Clip: kompakte Qualität. Das Instanz-Limit
        // (ablage_anhang_max_bytes) wurde in der Testumgebung auf 50 MiB
        // angehoben — das Größenlimit hier bleibt als hartes Sicherheitsnetz
        // kurz darunter. Grenze bewusst: 180 s Deckel, längere Clips sind
        // ein eigenes Thema (Testrunde 2026-09-11).
        intent.putExtra(MediaStore.EXTRA_VIDEO_QUALITY, 0);
        intent.putExtra(MediaStore.EXTRA_SIZE_LIMIT, 50_000_000L);
        intent.putExtra(MediaStore.EXTRA_DURATION_LIMIT, 180);
        aktiverCall = call;
        startActivityForResult(call, intent, "videoResultat");
    }

    @ActivityCallback
    private void videoResultat(PluginCall call, androidx.activity.result.ActivityResult result) {
        aktiverCall = null;
        if (call == null) return;
        // Capacitor 8 liefert ein ActivityResult-Objekt (nicht das alte Intent) —
        // der Intent-Parameter crashte beim Ergebnis-Delivery (Testrunde).
        Intent data = result.getData();
        if (result.getResultCode() != android.app.Activity.RESULT_OK
                || data == null
                || data.getData() == null) {
            // Nutzer hat in der Kamera-App abgebrochen — kein Fehler, kein Video.
            call.resolve();
            return;
        }
        try (InputStream in = getContext().getContentResolver().openInputStream(data.getData())) {
            File aus = new File(getContext().getCacheDir(),
                    "kamera-video-" + System.currentTimeMillis() + ".mp4");
            try (FileOutputStream out = new FileOutputStream(aus)) {
                byte[] block = new byte[8192];
                int n;
                while ((n = in.read(block)) > 0) out.write(block, 0, n);
            }
            byte[] bytes = readAll(aus);
            JSObject ergebnis = new JSObject();
            ergebnis.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
            ergebnis.put("mime", "video/mp4");
            ergebnis.put("pfad", aus.getAbsolutePath());
            ergebnis.put("groesse", bytes.length);
            call.resolve(ergebnis);
        } catch (Exception e) {
            call.reject("video_kopieren_fehlgeschlagen", e);
        }
    }

    private static byte[] readAll(File datei) throws Exception {
        try (InputStream in = new java.io.FileInputStream(datei)) {
            ByteArrayOutputStream puffer = new ByteArrayOutputStream();
            byte[] block = new byte[8192];
            int n;
            while ((n = in.read(block)) > 0) puffer.write(block, 0, n);
            return puffer.toByteArray();
        }
    }
}
