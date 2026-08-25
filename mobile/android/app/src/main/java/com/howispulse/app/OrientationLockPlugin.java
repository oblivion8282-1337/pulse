package com.howispulse.app;

import android.content.pm.ActivityInfo;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * JS↔nativ-Brücke für die Bildschirm-Orientierung.
 *
 * Regel (2026-08-25, Nutzerwunsch): Querformat gibt es in der App NUR während
 * ein Stream läuft. Standardmäßig ist die Activity auf Hochformat gesperrt —
 * Kippen bewirkt nichts. Das Web ruft {@code lock({ portrait: true })} beim
 * Start und immer dann, wenn kein Stream mehr offen ist; während ein Stream
 * läuft, ruft es {@code lock({ portrait: false })} (Freigabe auf Sensor),
 * damit das Kippen den Vollbild-Stream zeigt. Nach dem Stream wird wieder
 * gesperrt — Android dreht dabei von selbst zurück ins Hochformat.
 */
@CapacitorPlugin(name = "OrientationLock")
public class OrientationLockPlugin extends Plugin {

    @PluginMethod
    public void lock(PluginCall call) {
        boolean portrait = call.getBoolean("portrait", Boolean.TRUE);
        final int orientation = portrait
                ? ActivityInfo.SCREEN_ORIENTATION_USER_PORTRAIT
                : ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR;
        getActivity().runOnUiThread(() ->
                getActivity().setRequestedOrientation(orientation)
        );
        call.resolve();
    }
}
