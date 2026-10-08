import Capacitor
import LocalAuthentication

/// App-Sperre per Face ID / Touch ID (iOS-Liste Punkt 42).
///
/// **`deviceOwnerAuthentication`, nicht `…WithBiometrics`** — und das ist die
/// ganze Entscheidung dieser Datei. Die erste Fassung erlaubt dem System,
/// selbst auf den Geräte-Code zurückzufallen: wenn Face ID nicht eingerichtet
/// ist, das Gesicht nicht erkannt wird oder die Biometrie nach Fehlversuchen
/// gesperrt ist. Die zweite kann nur Biometrie und liefert sonst einen Fehler
/// — der Nutzer stünde vor seiner eigenen App und käme nicht hinein.
///
/// **Ein eigener Pulse-PIN wäre die schlechtere Wahl** (Eigentümer-Entscheid
/// 2026-10-08): ein zweites Geheimnis, das man vergisst, und das wir speichern
/// müssten. Den Geräte-Code kennt nur der Besitzer, und ihn verwaltet das
/// System.
///
/// **Die Sperre ist KEIN Datenschutz gegen jemanden, der das Gerät hat.** Der
/// lokale Verlauf liegt in der IndexedDB der WebView und ist durch den
/// Dateischutz des Containers geschützt, nicht durch diese Abfrage. Was sie
/// leistet: ein gefundenes, entsperrtes Telefon zeigt Pulse nicht sofort.
@objc(SperrePlugin)
public class SperrePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SperrePlugin"
    public let jsName = "Sperre"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "verfuegbar", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pruefen", returnType: CAPPluginReturnPromise)
    ]

    /// Kann dieses Gerät überhaupt prüfen? Ohne Code und ohne Biometrie nicht
    /// — dann darf die Oberfläche die Sperre nicht anbieten, sonst baut man
    /// einen Schalter, der einen aussperrt.
    @objc func verfuegbar(_ call: CAPPluginCall) {
        let kontext = LAContext()
        var fehler: NSError?
        let ja = kontext.canEvaluatePolicy(.deviceOwnerAuthentication, error: &fehler)
        call.resolve(["verfuegbar": ja])
    }

    @objc func pruefen(_ call: CAPPluginCall) {
        let grund = call.getString("grund") ?? "Pulse entsperren"
        let kontext = LAContext()
        // Kein eigener Rückfall-Knopf: `deviceOwnerAuthentication` bringt den
        // Geräte-Code selbst mit, und ein zweiter Knopf daneben wäre ein
        // zweiter Weg zum selben Ziel.
        kontext.localizedFallbackTitle = ""
        kontext.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: grund) { ok, fehler in
            DispatchQueue.main.async {
                if ok {
                    call.resolve(["ok": true])
                    return
                }
                // **Abbruch ist kein Fehler.** Wer die Abfrage wegtippt, hat
                // nicht „falsch" geantwortet — er hat nicht geantwortet. Die
                // Oberfläche zeigt dann weiter die Sperre mit einem
                // Erneut-Knopf, keine Fehlermeldung.
                let code = (fehler as? LAError)?.code
                let abgebrochen =
                    code == .userCancel || code == .systemCancel || code == .appCancel
                call.resolve([
                    "ok": false,
                    "abgebrochen": abgebrochen,
                    "grund": (fehler as NSError?)?.localizedDescription ?? ""
                ])
            }
        }
    }
}
