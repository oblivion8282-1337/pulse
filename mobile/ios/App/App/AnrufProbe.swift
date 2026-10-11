import Foundation
import LiveKit

#if DEBUG
    /// **Prüfpfad für Etappe 4 und die Buchführung des Anruf-Raums — nur in
    /// Debug-Bauten**, nach dem Muster von `SprachePluginProbe.swift`: Kanal
    /// und Anruf ohne Oberfläche und ohne Konto, gegen einen lokalen LiveKit.
    ///
    ///     xcrun simctl launch <sim> com.howispulse.app \
    ///         -PulseAnrufProbe "<wsUrl>|<tokenKanal>|<tokenAnruf>"
    ///
    /// Soll/Ist im Log (`[PulseAnruf] Probe`), am Ende die Zahl der Fehler.
    /// Nach dem Kanal drei Teile:
    ///
    /// 1. **Ende vor dem Raum.** Ein Anruf endet (über `beenden`, dieselbe
    ///    Strecke `anrufZu` wie ein Ende aus CallKit), danach kommt der
    ///    Beitritt noch an — und einmal mitten im Aufbau. Kein Raum darf
    ///    stehen bleiben (`AnrufRaum.Fehler.keinAnruf`). Das Ende durch
    ///    CallKit selbst zeigt im Simulator Teil 3.
    /// 2. **Gespräch ohne CallKit.** CallKit wird absichtlich zum Abweisen
    ///    gebracht (die eine Anrufgruppe ist von einem klingelnden Anruf
    ///    belegt). Das ist im Simulator der einzige Weg, auf dem ein
    ///    Anruf-Raum neben dem Kanal STEHT: Pause, Push, fremdes Ende, Ende.
    /// 3. **Der CallKit-Weg** wie am Gerät. Im Simulator beendet
    ///    `callservicesd` den Anruf nach 65–150 ms („there wont be a UI to
    ///    host the call") — dann gilt die Erwartung aus Teil 1.
    ///
    /// **Was sie NICHT zeigt:** ob CallKit die Session aktiviert und ob man
    /// etwas hört — der Simulator hat dafür weder CallKit-Audio noch ein
    /// Mikrofon.
    enum AnrufProbe {
        private typealias V = Anrufverwaltung
        @MainActor private static var fehler = 0

        static func ausStartargumenten() {
            guard let roh = UserDefaults.standard.string(forKey: "PulseAnrufProbe") else { return }
            let teile = roh.split(separator: "|").map(String.init)
            guard teile.count == 3 else {
                NSLog("[PulseAnruf] Probe: erwartet \"<wsUrl>|<tokenKanal>|<tokenAnruf>\"")
                return
            }
            Task { @MainActor in
                await fahren(wsUrl: teile[0], kanal: teile[1], anruf: teile[2])
                NSLog("[PulseAnruf] Probe ENDE, %d Fehler", fehler)
            }
        }

        @MainActor private static func soll(_ was: String, _ ist: Bool) {
            if !ist { fehler += 1 }
            NSLog("[PulseAnruf] Probe %@ %@", ist ? "OK  " : "FEHL", was)
        }

        private static func warten(_ s: Double) async {
            try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000))
        }

        /// Den Anruf-Raum betreten; der Fehler, falls es keinen Raum gab.
        private static func beitreten(_ kennung: String, _ wsUrl: String, _ token: String,
                                      schluessel: Data? = nil) async -> Error? {
            do {
                try await AnrufRaum.geteilt.nacheinander {
                    try await AnrufRaum.geteilt.beitreten(
                        kennung: kennung, wsUrl: wsUrl, token: token, schluessel: schluessel,
                        stumm: false, kontext: ["art": "dm", "rolle": "eingehend"])
                }
                return nil
            } catch {
                NSLog("[PulseAnruf] Probe Beitritt %@: %@", kennung, error.localizedDescription)
                return error
            }
        }

        @MainActor private static func annehmen(_ kennung: String) async {
            await withCheckedContinuation { (fertig: CheckedContinuation<Void, Never>) in
                V.geteilt.annehmenVomWeb(kennung: kennung, name: "Probe") { fertig.resume() }
            }
        }

        /// Ein Klingel-Push, wie PushKit ihn übergibt; wartet auf die
        /// `completion` und liefert den Ausgang.
        @MainActor private static func klingelPush(_ kennung: String) async -> V.PushAusgang? {
            let inhalt = ["art": "klingelt", "call_id": kennung, "einleiter_name": "Probe",
                          "anruf_art": "dm", "channel_id": "1"]
            await withCheckedContinuation { (fertig: CheckedContinuation<Void, Never>) in
                V.geteilt.pushVerarbeiten(inhalt) { fertig.resume() }
            }
            return V.geteilt.spur.ausgang
        }

        @MainActor private static func fahren(wsUrl: String, kanal: String, anruf: String) async {
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
            let stamm = "probe-\(Int(Date().timeIntervalSince1970))"
            await endeVorDemRaum(stamm, wsUrl, anruf)
            await warten(1.5)
            await ohneCallKit(stamm, wsUrl, anruf)
            await warten(1.5)
            await callKitWeg(stamm, wsUrl, anruf)
        }

        // MARK: - 1. Ende vor dem Raum

        @MainActor private static func endeVorDemRaum(_ stamm: String, _ wsUrl: String,
                                                      _ token: String) async {
            let v = V.geteilt
            let k = stamm + "-vorher"
            v.klingeln(kennung: k, name: "Probe", video: false)
            v.beenden(kennung: k, grund: .gegenseite)
            let abgewiesen = await beitreten(k, wsUrl, token)
            soll("Ende vor dem Raum: Beitritt abgewiesen",
                 (abgewiesen as? AnrufRaum.Fehler) == .keinAnruf)
            soll("Ende vor dem Raum: kein Raum ohne Eintrag", AnrufRaum.geteilt.raum == nil)

            let k2 = stamm + "-aufbau"
            v.klingeln(kennung: k2, name: "Probe", video: false)
            let aufbau = Task { await beitreten(k2, wsUrl, token) }
            await warten(0.02)
            v.beenden(kennung: k2, grund: .gegenseite)
            soll("Ende im Aufbau: Beitritt endet ohne Raum", await aufbau.value != nil)
            await warten(0.5)
            soll("Ende im Aufbau: kein Raum ohne Eintrag", AnrufRaum.geteilt.raum == nil)
        }

        // MARK: - 2. Gespräch ohne CallKit

        @MainActor private static func ohneCallKit(_ stamm: String, _ wsUrl: String,
                                                   _ token: String) async {
            let v = V.geteilt
            let sprache = SpracheRaum.geteilt
            // Kanal-Wunsch Lautsprecher: der Anruf will die Hörmuschel. Nur so
            // ist sichtbar, wessen Wunsch gerade gilt.
            sprache.ausgabe("lautsprecher")
            let belegt = stamm + "-belegt"
            let k = stamm + "-ohne"
            v.klingeln(kennung: belegt, name: "Probe", video: false)
            await annehmen(k)
            guard v.ohneCallKitKennung == k else {
                soll("ohne CallKit: CallKit weist das zweite Gespräch ab — sonst nicht prüfbar", false)
                v.beenden(grund: .lokal)
                return
            }
            soll("ohne CallKit: gebucht, ohne CallKit-Eintrag", v.fuehrt(k) && v.uuid(fuer: k) == nil)
            await warten(0.5)
            // Bis hierher hat der Simulator den klingelnden Anruf meist schon
            // selbst beendet — das fremde Ende, das den Kanal bis zum
            // 2026-10-11 freigab (`letzterAnrufVorbei`).
            soll("ohne CallKit: Kanal angehalten", sprache.anrufPausiert)
            soll("ohne CallKit: Kanal meldet sich taub", sprache.zustand()["taub"] as? Bool == true)
            soll("ohne CallKit: Hörmuschel-Wunsch des Anrufs gilt",
                 AudioManager.shared.isSpeakerOutputPreferred == false)

            let meldungen = v.spur.meldungen
            soll("ohne CallKit: Klingel-Push meldet und klingelt nicht",
                 await klingelPush(k) == .meldenUndSofortBeenden)
            soll("ohne CallKit: genau eine Meldung", v.spur.meldungen == meldungen + 1)
            v.klingeln(kennung: k, name: "Probe", video: false)
            soll("ohne CallKit: Oberfläche meldet es nicht neu", v.spur.meldungen == meldungen + 1)
            soll("ohne CallKit: weiter gebucht, kein CallKit-Eintrag",
                 v.ohneCallKitKennung == k && v.uuid(fuer: k) == nil)

            soll("ohne CallKit: Raum entsteht", await beitreten(k, wsUrl, token) == nil)
            v.beenden(kennung: belegt, grund: .gegenseite)
            await warten(1)
            soll("ohne CallKit: Raum verbunden",
                 AnrufRaum.geteilt.zustand()["zustand"] as? String == "connected")
            soll("fremdes Ende: Gespräch bleibt gebucht, Kanal angehalten",
                 v.ohneCallKitKennung == k && sprache.anrufPausiert)

            v.beenden(grund: .lokal)
            await warten(1)
            soll("Ende: aus der Buchführung, als kürzlich beendet gemerkt",
                 v.ohneCallKitKennung == nil && v.kuerzlichBeendet[k] != nil)
            soll("Ende: Anruf-Raum weg", AnrufRaum.geteilt.raum == nil)
            soll("Ende: Kanal frei", !sprache.anrufPausiert)
            soll("Ende: Kanal-Wunsch Lautsprecher gilt wieder",
                 AudioManager.shared.isSpeakerOutputPreferred == true)
            soll("Ende: ein Push danach klingelt nicht",
                 await klingelPush(k) == .meldenUndSofortBeenden)
        }

        // MARK: - 3. Der CallKit-Weg

        @MainActor private static func callKitWeg(_ stamm: String, _ wsUrl: String,
                                                  _ token: String) async {
            let v = V.geteilt
            let sprache = SpracheRaum.geteilt
            let mikroVorher = sprache.raum?.localParticipant.isMicrophoneEnabled() ?? false
            // Der Kanal-Wunsch: Hörmuschel. Er darf den Anruf nicht berühren
            // und muss ihn überleben.
            sprache.ausgabe("hoermuschel")
            let k = stamm + "-callkit"
            v.klingeln(kennung: k, name: "Probe", video: false)
            await warten(1)
            await annehmen(k)
            await warten(1)
            let traegt = v.fuehrt(k)
            NSLog("[PulseAnruf] Probe angenommen: callkitAktiv=%@ ohneCallKit=%@ gebucht=%@",
                  v.callkitAktiv ? "ja" : "nein", v.ohneCallKit ? "ja" : "nein", traegt ? "ja" : "nein")
            let schluessel = Data((0 ..< 32).map { _ in UInt8.random(in: 0 ... 255) })
            let beitritt = await beitreten(k, wsUrl, token, schluessel: schluessel)
            await warten(2)
            if traegt {
                let z = AnrufRaum.geteilt.zustand()
                soll("CallKit-Weg: einer der beiden Wege führt", v.callkitAktiv != v.ohneCallKit)
                soll("CallKit-Weg: Automatik des SDK aus, wenn CallKit führt",
                     !v.callkitAktiv || !AudioManager.shared.audioSession.isAutomaticConfigurationEnabled)
                soll("CallKit-Weg: Anruf-Raum verbunden", z["zustand"] as? String == "connected")
                soll("CallKit-Weg: Anruf verschlüsselt", z["verschluesselt"] as? Bool == true)
                soll("CallKit-Weg: Kanal angehalten", sprache.anrufPausiert)
                soll("CallKit-Weg: Kanal-Mikrofon zu",
                     sprache.raum?.localParticipant.isMicrophoneEnabled() == false)
                soll("CallKit-Weg: Kanal meldet sich taub", sprache.zustand()["taub"] as? Bool == true)
                soll("CallKit-Weg: Kanal-Wunsch Hörmuschel liegen geblieben",
                     AudioManager.shared.isSpeakerOutputPreferred == false)
            } else {
                NSLog("[PulseAnruf] Probe ---- CallKit hat den Anruf vor dem Raum beendet "
                    + "(Simulator: callservicesd) — erwartet wird Teil 1")
                soll("CallKit-Weg ohne Anruf: Beitritt abgewiesen, kein Raum",
                     beitritt != nil && AnrufRaum.geteilt.raum == nil)
            }

            v.beenden(grund: .lokal)
            await warten(5)
            soll("danach: Anruf-Raum weg", AnrufRaum.geteilt.raum == nil)
            soll("danach: Session zurück an das SDK", !v.callkitAktiv && !v.ohneCallKit)
            soll("danach: Automatik des SDK an",
                 AudioManager.shared.audioSession.isAutomaticConfigurationEnabled)
            soll("danach: Kanal nicht angehalten", !sprache.anrufPausiert)
            soll("danach: Kanal-Mikrofon wie vorher",
                 sprache.raum?.localParticipant.isMicrophoneEnabled() == mikroVorher)
            soll("danach: Kanal-Wunsch Hörmuschel gilt",
                 AudioManager.shared.isSpeakerOutputPreferred == false)
            soll("danach: Kanal steht", sprache.zustand()["verbunden"] as? Bool == true)
        }
    }
#endif
