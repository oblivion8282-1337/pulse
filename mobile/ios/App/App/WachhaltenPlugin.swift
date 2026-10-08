import Capacitor
import UIKit

/// Bildschirm wach halten, solange ein Video läuft (Punkt 31 der iOS-Liste).
///
/// **Warum nativ und nicht `navigator.wakeLock`.** Die Web-App hat den
/// Browser-Weg schon (`web/src/lib/platform/wakeLock.ts`), und auf dem Mac und
/// unter Windows trägt er. Ob er in einer WKWebView greift, ist eine offene
/// Frage — Safari kann die Schnittstelle seit iOS 16.4, für die eingebettete
/// WebView ist das damit NICHT belegt, und **gemessen habe ich es nicht**.
/// Dieses Plugin macht die Frage gegenstandslos: `isIdleTimerDisabled` ist der
/// dokumentierte Weg der Plattform und hängt an keiner Browser-Freigabe.
///
/// Ein Fehlschlag des Browser-Wegs wäre ausserdem der unangenehme Fall: Er
/// wirft nicht, er tut nur nichts. Der Bildschirm ginge mitten im Zuschauen
/// aus, und nichts im Log sagte warum.
///
/// **Der Zähler bleibt im Web.** Mehrere Kacheln können gleichzeitig wach
/// halten wollen; `wakeLock.ts` zählt die Pächter und ruft hier nur die beiden
/// Flanken. Ein zweiter Zähler hier wäre eine zweite Wahrheit.
@objc(WachhaltenPlugin)
public class WachhaltenPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WachhaltenPlugin"
    public let jsName = "Wachhalten"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "wachHalten", returnType: CAPPluginReturnPromise)
    ]

    @objc func wachHalten(_ call: CAPPluginCall) {
        let an = call.getBool("an") ?? false
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = an
            call.resolve()
        }
    }
}
