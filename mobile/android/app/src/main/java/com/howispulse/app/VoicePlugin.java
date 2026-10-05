package com.howispulse.app;

import android.Manifest;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Brücke zum nativen Voice-Motor (docs/UEBERGABE-MOBILE-VOICE-NATIV.md).
 * Bewusst dünn — alle Logik steckt in {@link VoiceEngine}. Join mit
 * USAGE_VOICE_COMMUNICATION (Anruf-Regler), Mic über das SDK, Zustands-
 * Snapshots zurück ans Web als 'voice'-Events (JSON-String-Contract in
 * nativeVoice.ts).
 */
@CapacitorPlugin(name = "Voice", permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
})
public class VoicePlugin extends Plugin {

    @Override
    public void load() {
        // Snapshots der Engine als Bridge-Events durchreichen — das Web hängt
        // sich per addListener('voice', …) daran (Muster: alle anderen Plugins).
        VoiceEngine.setListener(json -> {
            JSObject data = new JSObject();
            data.put("snapshot", json);
            notifyListeners("voice", data);
        });
    }

    @PluginMethod
    public void join(PluginCall call) {
        String wsUrl = call.getString("ws_url");
        String token = call.getString("token");
        if (wsUrl == null || token == null) {
            call.reject("ws_url/token fehlen");
            return;
        }
        boolean echoCancellation = Boolean.TRUE.equals(call.getBoolean("echoCancellation", false));
        boolean noiseSuppression = Boolean.TRUE.equals(call.getBoolean("noiseSuppression", false));
        VoiceEngine.join(getContext().getApplicationContext(), wsUrl, token,
                echoCancellation, noiseSuppression, error -> {
                    if (error == null) {
                        call.resolve();
                    } else {
                        call.reject(error);
                    }
                });
    }

    @PluginMethod
    public void leave(PluginCall call) {
        VoiceEngine.leave();
        call.resolve();
    }

    @PluginMethod
    public void setMicEnabled(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestAllPermissions(call, "micPermResult");
            return;
        }
        enableMic(call);
    }

    @PermissionCallback
    private void micPermResult(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            enableMic(call);
        } else {
            call.reject("Mikrofon-Zugriff verweigert");
        }
    }

    private void enableMic(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        VoiceEngine.setMicEnabled(on, error -> {
            if (error == null) {
                call.resolve();
            } else {
                call.reject(error);
            }
        });
    }

    @PluginMethod
    public void setDeafened(PluginCall call) {
        VoiceEngine.setDeafened(Boolean.TRUE.equals(call.getBoolean("on", false)));
        call.resolve();
    }

    @PluginMethod
    public void state(PluginCall call) {
        JSObject r = new JSObject();
        r.put("connected", VoiceEngine.isConnected());
        call.resolve(r);
    }

    @PluginMethod
    public void snapshot(PluginCall call) {
        VoiceEngine.emitSnapshot();
        call.resolve();
    }
}
