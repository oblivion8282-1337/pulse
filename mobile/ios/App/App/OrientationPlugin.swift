import Capacitor
import UIKit

/// Lagen-Riegel der iOS-Hülle.
///
/// Regel (Nutzerwunsch, unverändert seit der Android-Fassung): Querformat gibt
/// es in der App NUR fürs Stream-Vollbild. Chat, Listen und Einstellungen
/// bleiben hochkant, auch wenn man das Gerät dreht.
///
/// **Warum der Riegel nicht in der `Info.plist` steht.** Dort stand bis zum
/// 2026-10-08 ausschliesslich `UIInterfaceOrientationPortrait` — und damit
/// drehte auch das Video-Vollbild nicht, denn iOS stellt das Vollbild eines
/// `<video>` nur in Lagen dar, die die App DEKLARIERT. Die Plist erlaubt dem
/// iPhone deshalb jetzt alle drei Lagen (das ist die Erlaubnis zu drehen), und
/// die Entscheidung fällt zur Laufzeit im `AppDelegate`.
///
/// Android-Pendant: `OrientationLockPlugin.java` — gleicher JS-Name, gleiche
/// Signatur, gleiche Bedeutung von `portrait`. Der Weg dahin unterscheidet
/// sich: Android SETZT die Lage (`setRequestedOrientation`), iOS lässt sich die
/// erlaubten Lagen nur ABFRAGEN. Deshalb ein Schalter plus ein Anstoss zur
/// Neubewertung statt eines einzelnen Aufrufs.
public enum Lagen {
    /// Vom Web gesetzt, gelesen vom `AppDelegate`. `false` = nur Hochformat.
    /// Nur auf dem Haupt-Thread anfassen (siehe `lock`) — der Delegate wird
    /// vom UI-Thread befragt.
    public static var querErlaubt = false

    /// iOS fragt die erlaubten Lagen nicht von selbst erneut ab. Ohne diesen
    /// Anstoss wirkte eine Freigabe erst, wenn das System aus einem anderen
    /// Grund nachfragt (etwa nach dem nächsten App-Wechsel) — die Freigabe
    /// käme also irgendwann, nur nicht beim Drehen.
    /// Wie `querErlaubt` nur auf dem Haupt-Thread aufrufen.
    static func neuBewerten() {
        guard let szene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene }).first else { return }
        for fenster in szene.windows {
            fenster.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
        }
        // Beim Zurücknehmen der Freigabe genügt die Neubewertung nicht: hält
        // man das Gerät weiter quer, bleibt die Oberfläche quer stehen, weil
        // das System ohne Lagewechsel keinen Anlass zum Drehen sieht. Die
        // Geometrie-Anforderung dreht aktiv zurück — das Android-Gegenstück
        // tut dasselbe implizit über `SCREEN_ORIENTATION_USER_PORTRAIT`.
        if !querErlaubt {
            szene.requestGeometryUpdate(.iOS(interfaceOrientations: .portrait))
        }
    }
}

@objc(OrientationLockPlugin)
public class OrientationLockPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OrientationLockPlugin"
    public let jsName = "OrientationLock"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "lock", returnType: CAPPluginReturnPromise)
    ]

    @objc func lock(_ call: CAPPluginCall) {
        let portrait = call.getBool("portrait") ?? true
        DispatchQueue.main.async {
            Lagen.querErlaubt = !portrait
            Lagen.neuBewerten()
            call.resolve()
        }
    }
}
