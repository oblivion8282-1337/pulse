package com.howispulse.app;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * JS↔nativ-Brücke für die Audio-Ausgabe: manuelle Lautsprecher-/Hörmuschel-Wahl
 * und (default deaktivierter) Diagnose-Snapshot für das „Bluetooth zu leise"-
 * Szenario.
 *
 * Das Web-Frontend (remote von howispulse.com geladen) ruft
 * ``AudioRoute.setRoute({route})`` bzw. ``AudioRoute.snapshot()`` auf; wir geben
 * Ersteres an den {@link SpeakerphoneRouter} weiter, Letzteres sammelt die
 * Audio-Routing-States (Mode, Ausgabegerät, Stream-Lautstärken) — ohne
 * Audio-Inhalt — zur Fern-Diagnose. Ob der Snapshot jemals versendet wird,
 * entscheidet allein das Web (Feature-Gate), nicht dieses Plugin.
 */
@CapacitorPlugin(name = "AudioRoute")
public class AudioRoutePlugin extends Plugin {

    @PluginMethod
    public void setRoute(PluginCall call) {
        String route = call.getString("route", "auto");
        SpeakerphoneRouter r = router();
        if (r == null) {
            call.reject("audio router unavailable");
            return;
        }
        final int mode;
        if ("speaker".equals(route)) {
            mode = SpeakerphoneRouter.ROUTE_SPEAKER;
        } else if ("earpiece".equals(route)) {
            mode = SpeakerphoneRouter.ROUTE_EARPIECE;
        } else {
            mode = SpeakerphoneRouter.ROUTE_AUTO;
        }
        // AudioManager-Calls auf den Main-Thread (Listener-Registrierung etc.).
        getActivity().runOnUiThread(() -> r.setRoute(mode));
        call.resolve();
    }

    /**
     * Voice-Join/-Leave-Signal aus dem Web. Lässt den {@link SpeakerphoneRouter}
     * den Comm-Modus aktiv halten, damit Voice über den Telefon-Kanal (BT-SCO)
     * statt den Medien-Kanal (A2DP) läuft. Siehe {@link SpeakerphoneRouter#setVoiceActive}.
     */
    @PluginMethod
    public void setVoiceActive(PluginCall call) {
        boolean active = call.getBoolean("active", false);
        SpeakerphoneRouter r = router();
        if (r == null) {
            call.reject("audio router unavailable");
            return;
        }
        getActivity().runOnUiThread(() -> r.setVoiceActive(active));
        call.resolve();
    }

    @PluginMethod
    public void getRoute(PluginCall call) {
        SpeakerphoneRouter r = router();
        JSObject ret = new JSObject();
        ret.put("route", r == null ? "auto" : r.routeName());
        call.resolve(ret);
    }

    /**
     * Sammelt die Audio-Routing-States (KEIN Audio-Inhalt) zur Fern-Diagnose des
     * „Bluetooth/Car zu leise"-Bugs. Wird erst versendet, wenn das Web-Frontend
     * es entscheidet (dort hinter einem Feature-Gate, default aus).
     */
    @PluginMethod
    public void snapshot(PluginCall call) {
        AudioManager am = (AudioManager) getActivity()
                .getSystemService(Context.AUDIO_SERVICE);
        JSObject ret = new JSObject();
        if (am == null) {
            call.reject("AudioManager unavailable");
            return;
        }
        ret.put("androidSdk", Build.VERSION.SDK_INT);
        ret.put("androidRelease", Build.VERSION.RELEASE);
        ret.put("mode", modeName(am.getMode()));
        SpeakerphoneRouter r = router();
        ret.put("route", r == null ? "auto" : r.routeName());
        ret.put("bluetoothScoOn", am.isBluetoothScoOn());

        AudioDeviceInfo comm = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
                ? am.getCommunicationDevice() : null;
        if (comm != null) {
            JSObject cd = new JSObject();
            cd.put("type", deviceTypeName(comm.getType()));
            cd.put("name", String.valueOf(comm.getProductName()));
            ret.put("communicationDevice", cd);
        } else {
            ret.put("communicationDevice", JSObject.NULL);
        }

        JSObject vols = new JSObject();
        putStream(vols, am, "voiceCall", AudioManager.STREAM_VOICE_CALL);
        putStream(vols, am, "music", AudioManager.STREAM_MUSIC);
        ret.put("streams", vols);

        JSArray outs = new JSArray();
        for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            JSObject o = new JSObject();
            o.put("type", deviceTypeName(d.getType()));
            outs.put(o);
        }
        ret.put("outputDevices", outs);

        call.resolve(ret);
    }

    private void putStream(JSObject vols, AudioManager am, String name, int streamType) {
        JSObject s = new JSObject();
        s.put("volume", am.getStreamVolume(streamType));
        s.put("max", am.getStreamMaxVolume(streamType));
        vols.put(name, s);
    }

    private static String modeName(int mode) {
        switch (mode) {
            case AudioManager.MODE_NORMAL: return "NORMAL";
            case AudioManager.MODE_IN_COMMUNICATION: return "IN_COMMUNICATION";
            case AudioManager.MODE_RINGTONE: return "RINGTONE";
            case AudioManager.MODE_IN_CALL: return "IN_CALL";
            default: return String.valueOf(mode);
        }
    }

    private static String deviceTypeName(int type) {
        switch (type) {
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER: return "BUILTIN_SPEAKER";
            case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE: return "BUILTIN_EARPIECE";
            case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP: return "BLUETOOTH_A2DP";
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO: return "BLUETOOTH_SCO";
            case AudioDeviceInfo.TYPE_WIRED_HEADSET: return "WIRED_HEADSET";
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES: return "WIRED_HEADPHONES";
            case AudioDeviceInfo.TYPE_USB_HEADSET: return "USB_HEADSET";
            case AudioDeviceInfo.TYPE_HEARING_AID: return "HEARING_AID";
            default: return String.valueOf(type);
        }
    }

    private SpeakerphoneRouter router() {
        if (getActivity() instanceof MainActivity) {
            return ((MainActivity) getActivity()).getSpeakerphoneRouter();
        }
        return null;
    }
}
