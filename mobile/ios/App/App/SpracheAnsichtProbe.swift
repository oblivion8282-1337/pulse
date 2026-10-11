import LiveKit
import SwiftUI
import UIKit

#if DEBUG
    /// **Prüfpfad für die native Kanalansicht — nur in Debug-Bauten**: Thema
    /// und Admin-Stummschaltung, ohne Oberfläche und ohne Konto, gegen einen
    /// lokalen LiveKit (Muster: `SprachePluginProbe.swift`).
    ///
    ///     xcrun simctl launch <sim> com.howispulse.app \
    ///         -PulseAnsichtProbe "<wsUrl>|<token>|<light|dark|system>"
    ///
    /// Tritt bei, schaltet den eigenen Nutzer so, wie es das Web nach einem
    /// `voice_override` tut (`SprachePlugin.erzwungen` → `SpracheStand`), und
    /// öffnet die Ansicht mit dem Thema (`SprachePlugin.stil`, derselbe Weg wie
    /// `ansichtOeffnen`). Soll/Ist im Log (`[PulseSprache] AnsichtProbe`);
    /// wie es AUSSIEHT, zeigt ein Bildschirmfoto von aussen
    /// (`xcrun simctl io <sim> screenshot`).
    enum SpracheAnsichtProbe {
        static func ausStartargumenten() {
            guard let roh = UserDefaults.standard.string(forKey: "PulseAnsichtProbe") else { return }
            let teile = roh.split(separator: "|").map(String.init)
            guard teile.count == 3 else {
                NSLog("[PulseSprache] AnsichtProbe: erwartet \"<wsUrl>|<token>|<thema>\"")
                return
            }
            Task { @MainActor in await fahren(wsUrl: teile[0], token: teile[1], thema: teile[2]) }
        }

        private static func soll(_ was: String, _ ist: Bool) {
            NSLog("[PulseSprache] AnsichtProbe %@ %@", ist ? "OK  " : "FEHL", was)
        }

        @MainActor private static func fahren(wsUrl: String, token: String, thema: String) async {
            let sprache = SpracheRaum.geteilt
            do {
                try await sprache.nacheinander {
                    try await sprache.beitreten(wsUrl: wsUrl, token: token, kanalId: "probe",
                                                kanalName: "Probe-Kanal", stumm: true, taubStart: false)
                }
            } catch {
                NSLog("[PulseSprache] AnsichtProbe Beitritt gescheitert: %@", error.localizedDescription)
                return
            }
            guard let raum = sprache.raum,
                  let selbst = SpracheRaum.nutzerId(aus: raum.localParticipant.identity?.stringValue ?? "")
            else {
                soll("eigene Nutzer-Id aus der Identität", false)
                return
            }
            SpracheStand.geteilt.erzwungenSetzen(stumm: [selbst], taub: [selbst])
            let zwang = SpracheStand.geteilt.erzwungen(fuer: raum.localParticipant)
            soll("eigener Teilnehmer gilt als stumm- und taubgeschaltet", zwang.stumm && zwang.taub)

            guard let wurzel = await fensterWurzel() else {
                soll("Fensterwurzel gefunden", false)
                return
            }
            let stil = SprachePlugin.stil(thema)
            SpracheAnsichtHalter.geteilt.zeigen(ueber: wurzel, raum: raum, kanalName: "Probe-Kanal",
                                               stil: stil)
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard let blatt = wurzel.presentedViewController else {
                soll("Ansicht offen", false)
                return
            }
            // `.unspecified` erbt vom Fenster — dann muss das Blatt aussehen wie das Telefon.
            let erwartet = stil == .unspecified ? wurzel.traitCollection.userInterfaceStyle : stil
            let ist = blatt.traitCollection.userInterfaceStyle
            soll("Thema '\(thema)': Blatt \(ist.rawValue), erwartet \(erwartet.rawValue)", ist == erwartet)
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
            UIColor(SpracheFarben.grund).resolvedColor(with: blatt.traitCollection)
                .getRed(&r, green: &g, blue: &b, alpha: &a)
            NSLog("[PulseSprache] AnsichtProbe Grund aufgelöst: %.3f %.3f %.3f", r, g, b)
            soll("Grund hell, wenn hell, sonst dunkel", (r > 0.5) == (ist == .light))
        }

        @MainActor private static func fensterWurzel() async -> UIViewController? {
            for _ in 0 ..< 40 {
                let wurzel = UIApplication.shared.connectedScenes
                    .compactMap { ($0 as? UIWindowScene)?.windows.first { $0.isKeyWindow } }
                    .first?.rootViewController
                if let wurzel { return wurzel }
                try? await Task.sleep(nanoseconds: 250_000_000)
            }
            return nil
        }
    }
#endif
