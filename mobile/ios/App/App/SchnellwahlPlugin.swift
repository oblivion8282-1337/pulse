import Capacitor
import UIKit

/// Schnellwahl am App-Symbol (iOS-Liste Punkt 44).
///
/// Langes Drücken auf das Pulse-Symbol zeigt die letzten Gespräche; ein Tipp
/// springt direkt hinein. Die Einträge sind DYNAMISCH — statische aus der
/// `Info.plist` könnten nur „Chats" oder „Räume" anbieten, und das ist ein
/// Tab-Wechsel, den man nach dem Start ohnehin in einem Tipp hat. Der Gewinn
/// liegt im Sprung in eine bestimmte Unterhaltung, und die kennt nur das Web.
///
/// **Warum die Auswahl am `AppDelegate` hängt und nicht hier.** Ein
/// Schnellwahl-Tipp startet die App oft KALT, und dann gibt es zwei
/// Einstiege, die sich ausschliessen: bei laufender App ruft iOS
/// `performActionFor`, bei einem Kaltstart liegt die Wahl in den
/// `launchOptions` und `performActionFor` wird NICHT gerufen. Beide Stellen
/// liegen im `AppDelegate`, lange bevor ein Plugin existiert; hier wird nur
/// aufbewahrt und weitergereicht.
///
/// Der Pfad wird im Web noch einmal geprüft (`tiefenlink.zielPfadIntern`) —
/// er hat die App verlassen und in einem System-verwalteten Bereich gelegen,
/// der einen Neustart überdauert. Damit ist er eine Eingabe, auch wenn wir
/// ihn selbst geschrieben haben.
public enum Schnellwahl {
    /// Ein Ziel, das eintraf, bevor das Web zuhörte (Kaltstart).
    static var ausstehend: String?
    static weak var bruecke: SchnellwahlPlugin?

    /// Vom `AppDelegate` gerufen, aus beiden Einstiegen.
    public static func gewaehlt(_ eintrag: UIApplicationShortcutItem) {
        guard let pfad = eintrag.userInfo?["pfad"] as? String else { return }
        if let bruecke {
            bruecke.zielMelden(pfad)
        } else {
            ausstehend = pfad
        }
    }
}

@objc(SchnellwahlPlugin)
public class SchnellwahlPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SchnellwahlPlugin"
    public let jsName = "Schnellwahl"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setzen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "addListener", returnType: CAPPluginReturnCallback),
        CAPPluginMethod(name: "removeAllListeners", returnType: CAPPluginReturnPromise)
    ]

    public override func load() {
        Schnellwahl.bruecke = self
        if let offen = Schnellwahl.ausstehend {
            Schnellwahl.ausstehend = nil
            zielMelden(offen)
        }
    }

    /// Einträge ersetzen. Eine leere Liste räumt die Schnellwahl ab — das ist
    /// der Abmelde-Fall: die Namen der letzten Gespräche haben am Symbol eines
    /// abgemeldeten Kontos nichts zu suchen.
    @objc func setzen(_ call: CAPPluginCall) {
        let roh = call.getArray("eintraege", JSObject.self) ?? []
        let eintraege: [UIApplicationShortcutItem] = roh.enumerated().compactMap { stelle, e in
            guard let titel = e["titel"] as? String,
                  let pfad = e["pfad"] as? String
            else { return nil }
            return UIApplicationShortcutItem(
                // Die Stelle als Typ: iOS verlangt eine Kennung, und der Pfad
                // taugt nicht dafür (er kann sich ändern, während derselbe
                // Platz gemeint ist).
                type: "pulse.gespraech.\(stelle)",
                localizedTitle: titel,
                localizedSubtitle: e["untertitel"] as? String,
                icon: UIApplicationShortcutIcon(type: .message),
                userInfo: ["pfad": pfad as NSSecureCoding]
            )
        }
        DispatchQueue.main.async {
            UIApplication.shared.shortcutItems = eintraege
            call.resolve()
        }
    }

    func zielMelden(_ pfad: String) {
        // Aufbewahrt, weil ein Kaltstart die Wahl liefert, lange bevor die
        // entfernte Web-App geladen ist.
        notifyListeners("gewaehlt", data: ["pfad": pfad], retainUntilConsumed: true)
    }
}
