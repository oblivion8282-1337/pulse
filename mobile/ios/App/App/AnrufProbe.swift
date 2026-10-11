import Foundation
import LiveKit

#if DEBUG
    /// **Prüfpfad für Etappe 4 — nur in Debug-Bauten**, nach dem Muster von
    /// `SprachePluginProbe.swift`: Kanal und Anruf ohne Oberfläche und ohne
    /// Konto, gegen einen lokalen LiveKit.
    ///
    ///     xcrun simctl launch <sim> com.howispulse.app \
    ///         -PulseAnrufProbe "<wsUrl>|<tokenKanal>|<tokenAnruf>"
    ///
    /// Fährt die Übergabe der Audio-Session ab und schreibt Soll/Ist ins Log
    /// (`[PulseAnruf] Probe`): Kanal betreten → Anruf klingeln lassen und
    /// annehmen → Anruf-Raum betreten (mit Schlüssel) → Kanal angehalten? →
    /// auflegen → Kanal zurück? **Was sie NICHT zeigt:** ob CallKit die
    /// Session aktiviert und ob man etwas hört — der Simulator hat dafür
    /// weder CallKit-Audio noch ein Mikrofon. Ob CallKit dort überhaupt
    /// mitspielt, steht im Log (`ohneCallKit`).
    enum AnrufProbe {
        static func ausStartargumenten() {
            guard let roh = UserDefaults.standard.string(forKey: "PulseAnrufProbe") else { return }
            let teile = roh.split(separator: "|").map(String.init)
            guard teile.count == 3 else {
                NSLog("[PulseAnruf] Probe: erwartet \"<wsUrl>|<tokenKanal>|<tokenAnruf>\"")
                return
            }
            Task { await fahren(wsUrl: teile[0], kanal: teile[1], anruf: teile[2]) }
        }

        private static func soll(_ was: String, _ ist: Bool) {
            NSLog("[PulseAnruf] Probe %@ %@", ist ? "OK  " : "FEHL", was)
        }

        private static func warten(_ s: Double) async {
            try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000))
        }

        private static func fahren(wsUrl: String, kanal: String, anruf: String) async {
            let sprache = SpracheRaum.geteilt
            do {
                try await sprache.nacheinander {
                    try await sprache.beitreten(
                        wsUrl: wsUrl, token: kanal, kanalId: "probe-kanal", kanalName: "Probe",
                        stumm: false, taubStart: false)
                }
            } catch {
                NSLog("[PulseAnruf] Probe Kanal-Beitritt gescheitert: %@", error.localizedDescription)
                return
            }
            let mikroVorher = sprache.raum?.localParticipant.isMicrophoneEnabled() ?? false
            NSLog("[PulseAnruf] Probe Kanal steht (Mikrofon %@)", mikroVorher ? "offen" : "zu")
            // Der Kanal-Wunsch: Hörmuschel. Er darf den Anruf nicht berühren
            // und muss ihn überleben.
            sprache.ausgabe("hoermuschel")

            let kennung = "probe-\(Int(Date().timeIntervalSince1970))"
            await MainActor.run {
                Anrufverwaltung.geteilt.klingeln(kennung: kennung, name: "Probe", video: false)
            }
            await warten(1)
            await withCheckedContinuation { (fertig: CheckedContinuation<Void, Never>) in
                DispatchQueue.main.async {
                    Anrufverwaltung.geteilt.annehmenVomWeb(kennung: kennung, name: "Probe") {
                        fertig.resume()
                    }
                }
            }
            await warten(1)
            let (callkit, ohne) = await MainActor.run {
                (Anrufverwaltung.geteilt.callkitAktiv, Anrufverwaltung.geteilt.ohneCallKit)
            }
            NSLog("[PulseAnruf] Probe angenommen: callkitAktiv=%@ ohneCallKit=%@",
                  callkit ? "ja" : "nein", ohne ? "ja" : "nein")
            soll("einer der beiden Wege führt", callkit != ohne)
            soll("Automatik des SDK aus, wenn CallKit führt",
                 !callkit || !AudioManager.shared.audioSession.isAutomaticConfigurationEnabled)

            let schluessel = Data((0 ..< 32).map { _ in UInt8.random(in: 0 ... 255) })
            do {
                try await AnrufRaum.geteilt.nacheinander {
                    try await AnrufRaum.geteilt.beitreten(
                        kennung: kennung, wsUrl: wsUrl, token: anruf, schluessel: schluessel,
                        stumm: false, kontext: ["art": "dm", "rolle": "eingehend"])
                }
            } catch {
                NSLog("[PulseAnruf] Probe Anruf-Beitritt gescheitert: %@", error.localizedDescription)
            }
            await warten(2)
            let z = AnrufRaum.geteilt.zustand()
            NSLog("[PulseAnruf] Probe Anruf-Raum: %@", "\(z)")
            soll("Anruf-Raum verbunden", z["zustand"] as? String == "connected")
            soll("Anruf verschlüsselt", z["verschluesselt"] as? Bool == true)
            soll("Kanal angehalten", sprache.anrufPausiert)
            soll("Kanal-Mikrofon zu", sprache.raum?.localParticipant.isMicrophoneEnabled() == false)
            soll("Kanal meldet sich taub", sprache.zustand()["taub"] as? Bool == true)
            soll("Kanal-Wunsch Hörmuschel liegen geblieben",
                 ohne || AudioManager.shared.isSpeakerOutputPreferred == false)

            await MainActor.run { Anrufverwaltung.geteilt.beenden(grund: .lokal) }
            await warten(5)
            let (callkitDanach, ohneDanach) = await MainActor.run {
                (Anrufverwaltung.geteilt.callkitAktiv, Anrufverwaltung.geteilt.ohneCallKit)
            }
            soll("Anruf-Raum weg", AnrufRaum.geteilt.raum == nil)
            soll("Session zurück an das SDK", !callkitDanach && !ohneDanach)
            soll("Automatik des SDK wieder an",
                 AudioManager.shared.audioSession.isAutomaticConfigurationEnabled)
            soll("Kanal nicht mehr angehalten", !sprache.anrufPausiert)
            soll("Kanal-Mikrofon wie vorher",
                 sprache.raum?.localParticipant.isMicrophoneEnabled() == mikroVorher)
            soll("Kanal-Wunsch Hörmuschel gilt wieder",
                 AudioManager.shared.isSpeakerOutputPreferred == false)
            soll("Kanal steht noch", sprache.zustand()["verbunden"] as? Bool == true)
            NSLog("[PulseAnruf] Probe ENDE")
        }
    }
#endif
