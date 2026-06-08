package com.howispulse.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * JS↔nativ-Brücke für die manuelle Lautsprecher/Hörmuschel-Wahl.
 *
 * Das Web-Frontend (remote von howispulse.com geladen) ruft
 * ``AudioRoute.setRoute({route})`` auf; wir geben das an den {@link
 * SpeakerphoneRouter} weiter, der den Override hält und gegen Chromiums
 * Re-Routing durchsetzt. ``route`` ∈ {auto, speaker, earpiece}.
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

    @PluginMethod
    public void getRoute(PluginCall call) {
        SpeakerphoneRouter r = router();
        JSObject ret = new JSObject();
        ret.put("route", r == null ? "auto" : r.routeName());
        call.resolve(ret);
    }

    private SpeakerphoneRouter router() {
        if (getActivity() instanceof MainActivity) {
            return ((MainActivity) getActivity()).getSpeakerphoneRouter();
        }
        return null;
    }
}
