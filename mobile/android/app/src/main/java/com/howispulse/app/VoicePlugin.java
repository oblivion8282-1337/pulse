package com.howispulse.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Brücke zum nativen Voice-Motor (P1-Kernprobe,
 * docs/UEBERGABE-MOBILE-VOICE-NATIV.md). Bewusst dünn — alle Logik steckt in
 * {@link VoiceEngine}. Join nur-Zuhören mit USAGE_VOICE_COMMUNICATION; die
 * Kernprobe ist der Regler-Stempel, nicht das Mikrofon (kommt mit P2).
 */
@CapacitorPlugin(name = "Voice")
public class VoicePlugin extends Plugin {

    @PluginMethod
    public void join(PluginCall call) {
        String wsUrl = call.getString("ws_url");
        String token = call.getString("token");
        if (wsUrl == null || token == null) {
            call.reject("ws_url/token fehlen");
            return;
        }
        VoiceEngine.join(getContext().getApplicationContext(), wsUrl, token, error -> {
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
    public void state(PluginCall call) {
        JSObject r = new JSObject();
        r.put("connected", VoiceEngine.isConnected());
        call.resolve(r);
    }
}
