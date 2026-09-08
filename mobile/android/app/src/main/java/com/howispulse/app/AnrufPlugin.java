package com.howispulse.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * JS↔nativ-Brücke für eingehende Anrufe (Anrufe-Epic E). Das Web signalisiert
 * „klingelt" (WS call_klingelt im Anruf-Store angekommen) und „beendet"
 * (angenommen/abgelehnt/beendet); wir halten bzw. nehmen die Sperrbildschirm-
 * Notification über {@link CallForegroundService}. Annehmen/Ablehnen aus der
 * Notification kommen als „aktion"-Event zurück in die WebView — die
 * Signalisierung (anrufAnnehmen/anrufAblehnen-POSTs) lebt im Klienten.
 */
@CapacitorPlugin(name = "Anruf")
public class AnrufPlugin extends Plugin {

    private static AnrufPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    /** Web → nativ: eingehender Anruf klingelt → Sperrbildschirm-Notification zeigen. */
    @PluginMethod
    public void ankommen(PluginCall call) {
        CallForegroundService.ankommen(getContext(),
                call.getString("callId", ""),
                call.getString("gegenstelle", ""));
        call.resolve();
    }

    /** Web → nativ: angenommen/abgelehnt/beendet → Notification entfernen. */
    @PluginMethod
    public void beenden(PluginCall call) {
        CallForegroundService.beenden(getContext());
        call.resolve();
    }

    /** Nativ → Web (aus {@link CallForegroundService.AktionsEmpfaenger}):
     *  Entscheidung aus der Notification, {@code aktion} ist „annehmen" oder
     *  „ablehnen". */
    public static void aktion(String aktion, String callId) {
        AnrufPlugin p = instance;
        if (p == null) return;
        JSObject d = new JSObject();
        d.put("aktion", aktion);
        d.put("callId", callId);
        p.notifyListeners("aktion", d);
    }
}
