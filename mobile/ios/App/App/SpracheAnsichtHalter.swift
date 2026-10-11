import LiveKit
import SwiftUI
import UIKit

/// Präsentiert die native Kanalansicht ÜBER der WebView und nimmt sie zurück.
///
/// **Vorgehängt, nicht eingebettet** (Entwurf §5). Die Web-App bleibt darunter
/// stehen, mitsamt ihrer Navigation — sie weiss nur, dass die Ansicht offen
/// ist. Der verworfene Gegenentwurf, native Videoflächen UNTER die WebView zu
/// legen, hätte deren Positionen laufend nachrechnen müssen; dasselbe Muster
/// hat das Projekt beim AirPlay-Knopf schon einmal verworfen.
///
/// **Warum ein Blatt (`.pageSheet`) und nicht `.fullScreen`.** Der Entwurf
/// verlangt, dass ein Wischen nach unten die ANSICHT schliesst und nicht den
/// Raum. Nur eine Blatt-Präsentation bringt diese Geste mitsamt
/// Griff-Anzeiger vom System mit; `.fullScreen` hätte einen eigenen
/// Wischerkenner gebraucht, und jeder selbst gebaute Erkenner ist eine
/// Gelegenheit, versehentlich aufzulegen. Ein Nebeneffekt passt genau:
/// am oberen Rand bleibt die Web-App sichtbar — man SIEHT, dass sie darunter
/// weiterläuft.
///
/// **Eine iOS-Eigenheit, die der Entwurf nicht kennt:** für ein Modal gibt es
/// keine System-Zurück-Geste (die Kantenwisch-Geste gehört einem
/// Navigations-Stapel). Die Geste ist hier also das Wischen nach unten, und
/// NICHTS in dieser Datei verbindet eine Geste mit dem Verlassen des Raums.
final class SpracheAnsichtHalter: NSObject, UISheetPresentationControllerDelegate {
    static let geteilt = SpracheAnsichtHalter()

    /// Der Nutzer hat die Ansicht geschlossen — Wischen oder Knopf. Wird NICHT
    /// gerufen, wenn der Raum sie mitnimmt (dort entscheidet der Rufer, s.
    /// `schliessen(melden:)`). Setzt das Plugin.
    var geschlossen: (() -> Void)?

    /// Nur auf dem Hauptthread angefasst.
    private weak var offen: UIViewController?

    /// Derselbe Stand als einfacher Merker, damit `zustand()` ihn mitschicken
    /// kann: das Vollbild des Zustands wird aus einem `Task` heraus gebildet,
    /// also nicht verlässlich auf dem Hauptthread. Ein `NSLock` dafür statt
    /// eines ungeschützten Lesens — es kostet nichts und die Frage „ist es
    /// richtig?" stellt sich dann nicht.
    private let sperre = NSLock()
    private var offenFlag = false

    var istOffenSynchron: Bool {
        sperre.lock()
        defer { sperre.unlock() }
        return offenFlag
    }

    private func flagSetzen(_ an: Bool) {
        sperre.lock()
        offenFlag = an
        sperre.unlock()
    }

    // MARK: - Zeigen und schliessen

    /// **Idempotent.** Der Griff „zurück in den Kanal" in der Web-Leiste darf
    /// mehrfach kommen (Doppeltipp, zwei Leisten auf verschiedenen
    /// Bildschirmen) — ein zweites Blatt über dem ersten wäre eine Sackgasse.
    /// Ein erneutes Zeigen stellt nur das Thema nach.
    ///
    /// `stil`: das Thema der Web-App (`SprachePlugin.stil`). Als
    /// `overrideUserInterfaceStyle` gesetzt, gilt es für das Blatt samt
    /// Hintergrund; die Farben lösen sich daran auf (`SpracheFarben`).
    @MainActor
    func zeigen(ueber wurzel: UIViewController, raum: Room, kanalName: String,
                stil: UIUserInterfaceStyle) {
        if let offen {
            offen.overrideUserInterfaceStyle = stil
            return
        }
        let inhalt = SpracheAnsicht(
            raum: raum,
            kanalName: kanalName,
            schliessen: { [weak self] in self?.schliessen(melden: true) }
        )
        let halter = UIHostingController(rootView: inhalt)
        halter.overrideUserInterfaceStyle = stil
        halter.modalPresentationStyle = .pageSheet
        halter.view.backgroundColor = UIColor(SpracheFarben.grund)
        if let blatt = halter.sheetPresentationController {
            blatt.detents = [.large()]
            blatt.prefersGrabberVisible = true
            blatt.preferredCornerRadius = 20
            blatt.delegate = self
        }
        // **Vom obersten Präsentierenden aus, nicht von der Wurzel.** Liegt
        // schon ein Modal über der WebView (QR-Scanner, ein System-Blatt),
        // tut `wurzel.present` nichts ausser einer Laufzeit-Warnung — die
        // Ansicht erschiene einfach nicht.
        var oben: UIViewController = wurzel
        while let weiter = oben.presentedViewController { oben = weiter }
        oben.present(halter, animated: true)
        offen = halter
        flagSetzen(true)
    }

    /// `melden: true` schickt `ansichtGeschlossen` ans Web — das ist der Fall
    /// „der Nutzer wollte weg". `false` ist der Fall „der Raum ist weg": dann
    /// hat das Web den Abbau selbst angestossen und räumt seinen Zustand
    /// ohnehin auf; eine Meldung sähe dort wie eine Nutzergeste aus.
    @MainActor
    func schliessen(melden: Bool) {
        guard let vc = offen else { return }
        offen = nil
        flagSetzen(false)
        vc.dismiss(animated: true)
        if melden { geschlossen?() }
    }

    // MARK: - UIAdaptivePresentationControllerDelegate

    /// Feuert ausschliesslich bei der GESTE (Wischen nach unten) —
    /// ein programmatisches `dismiss()` läuft hier nicht durch. Genau deshalb
    /// steht die Meldung hier und nicht in `schliessen`: beide Wege bleiben
    /// unterscheidbar, ohne einen Merker dafür.
    func presentationControllerDidDismiss(_ controller: UIPresentationController) {
        guard controller.presentedViewController === offen else { return }
        offen = nil
        flagSetzen(false)
        NSLog("[PulseSprache] Ansicht weggewischt — Raum bleibt")
        geschlossen?()
    }
}
