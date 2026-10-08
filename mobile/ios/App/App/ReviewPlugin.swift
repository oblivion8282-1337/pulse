import Capacitor
import StoreKit

/// Die System-Bewertungsfrage („Wie gefaellt dir Pulse?"), Roadmap 20b.
///
/// **Bewusst ein eigenes Plugin statt eines Fremdpakets** (Entscheid
/// 2026-10-08): Der ganze Inhalt ist ein Systemaufruf, und CLAUDE.md
/// bevorzugt fuer so etwas den Eigenbau gegenueber einer Abhaengigkeit.
/// Muster wie `AudioSessionPlugin`.
///
/// **Was iOS daraus macht, entscheidet iOS.** `requestReview` ist eine BITTE,
/// kein Befehl: das System zeigt die Frage hoechstens dreimal im Jahr je
/// Nutzer, unterdrueckt sie in Entwickler-Builds haeufig ganz und sagt nie,
/// ob sie erschienen ist. Deshalb loest der Aufruf immer auf (`resolve`) und
/// die Oberflaeche darf daraus NICHTS schliessen — ein „Danke fuer deine
/// Bewertung" danach waere eine Luege.
@objc(ReviewPlugin)
public class ReviewPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ReviewPlugin"
    public let jsName = "ReviewPlugin"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "anfragen", returnType: CAPPluginReturnPromise)
    ]

    @objc func anfragen(_ call: CAPPluginCall) {
        // Auf dem Haupt-Thread: die Frage ist Oberflaeche, und der Aufruf
        // kommt aus der WebView-Bruecke.
        DispatchQueue.main.async {
            guard
                let szene = UIApplication.shared.connectedScenes
                    .first(where: { $0.activationState == .foregroundActive })
                    as? UIWindowScene
            else {
                // Keine aktive Szene (App gerade im Hintergrund): still
                // aufloesen. Ein Fehler waere hier irrefuehrend — es ist
                // schlicht kein Moment zum Fragen.
                call.resolve()
                return
            }
            SKStoreReviewController.requestReview(in: szene)
            call.resolve()
        }
    }
}
