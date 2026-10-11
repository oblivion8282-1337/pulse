import CallKit
import Foundation

#if DEBUG
    /// Was die Push-Ausgänge getan haben (`Anrufverwaltung.spur`).
    struct PushSpur {
        /// Aufrufe von `reportNewIncomingCall` seit dem Start.
        var meldungen = 0
        /// Der Ausgang des letzten Pushes und CallKits letzte Antwort.
        var ausgang: Anrufverwaltung.PushAusgang?
        var folge: Anrufverwaltung.MeldungsFolge?
        /// Enden, die CallKit von aussen für einen Anruf brachte, den die
        /// Verwaltung noch führte (im Simulator: sein Abbau, s.
        /// `AnrufPushProbe`). Ein verspätetes Ende für einen Anruf, den wir
        /// schon selbst beendet hatten, zählt nicht.
        var fremdEnden = 0
    }

    /// **Prüfpfad für Apples PushKit-Regel — nur in Debug-Bauten**, nach dem
    /// Muster von `AnrufProbe.swift`, aber ohne LiveKit und ohne Konto:
    ///
    ///     xcrun simctl launch <sim> com.howispulse.app -PulseAnrufPushProbe 1
    ///
    /// Ein echter VoIP-Push erreicht den Simulator nicht. Die Probe ruft
    /// deshalb `pushVerarbeiten` — dieselbe Funktion, der der PushKit-Delegat
    /// `payload.dictionaryPayload` übergibt — mit selbst gebauter Nutzlast,
    /// gegen den echten `CXProvider`. Je Push hält sie fest: den Ausgang, die
    /// Zahl der Meldungen, sobald `pushVerarbeiten` zurückkehrt (Soll: genau
    /// EINE im selben Lauf), ob PushKits `completion` lief, und was CallKit
    /// geantwortet hat. Davor die Entscheidungstabelle ohne CallKit. Ergebnis
    /// im Log unter `[PulseAnruf] PushProbe`.
    ///
    /// **Was sie NICHT zeigt:** ob iOS die App am Gerät nicht mehr beendet —
    /// das prüft das System nur bei echten Pushes.
    ///
    /// **Eine Grenze des Simulators bestimmt den Aufbau:** er hat keinen
    /// Anrufbildschirm (`facetime://` lässt sich nicht öffnen), und
    /// `callservicesd` trennt deshalb jeden Anruf, ein- wie ausgehend, rund
    /// 130–150 ms, nachdem er erscheint („disconnect reason: 55", im Log
    /// gemessen 2026-10-11). Den Zustand prüft die Probe deshalb IN PushKits
    /// `completion`, im selben Lauf, in dem CallKits Antwort verarbeitet
    /// wurde — eine spätere Prüfung sähe den Abbau des Simulators statt
    /// unseren. Und wo zwei Pushes einen lebenden Anruf brauchen, gehen sie
    /// im selben Lauf hintereinander hinaus.
    enum AnrufPushProbe {
        private typealias V = Anrufverwaltung
        @MainActor private static var fehler = 0

        static func ausStartargumenten() {
            guard UserDefaults.standard.string(forKey: "PulseAnrufPushProbe") != nil else { return }
            Task { @MainActor in
                await warten(3)
                tabelle()
                await ablauf()
                NSLog("[PulseAnruf] PushProbe ENDE, %d Fehler", fehler)
            }
        }

        @MainActor private static func soll(_ was: String, _ ist: Bool) {
            if !ist { fehler += 1 }
            NSLog("[PulseAnruf] PushProbe %@ %@", ist ? "OK  " : "FEHL", was)
        }

        private static func warten(_ s: Double) async {
            try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000))
        }

        // MARK: - Ohne CallKit

        @MainActor private static func tabelle() {
            let u = UUID()
            // (Art, bekannt, klingelt, kürzlich beendet, ohne CallKit) → Ausgang
            let ausgaenge: [(V.PushArt, UUID?, Bool, Bool, Bool, V.PushAusgang)] = [
                (.klingeln, nil, false, false, false, .neuMelden),
                (.klingeln, nil, false, true, false, .meldenUndSofortBeenden),
                (.abbruch, nil, false, false, false, .meldenUndSofortBeenden),
                (.abbruch, nil, false, true, false, .meldenUndSofortBeenden),
                (.klingeln, u, true, false, false, .erneutMelden(u)),
                (.klingeln, u, false, false, false, .erneutMelden(u)),
                (.klingeln, u, true, true, false, .erneutMelden(u)),
                (.abbruch, u, true, false, false, .erneutMeldenUndBeenden(u)),
                (.abbruch, u, false, false, false, .erneutMelden(u)),
                // Ein Gespräch ohne CallKit klingelt nicht neu und endet nicht.
                (.klingeln, nil, false, false, true, .meldenUndSofortBeenden),
                (.abbruch, nil, false, false, true, .meldenUndSofortBeenden),
            ]
            for (art, bekannt, klingelt, kuerzlich, ohne, erwartet) in ausgaenge {
                let ist = V.pushAusgang(art: art, bekannt: bekannt, klingelt: klingelt,
                                        kuerzlichBeendet: kuerzlich, ohneCallKit: ohne)
                soll("Tabelle \(art) bekannt=\(bekannt != nil) klingelt=\(klingelt) "
                    + "kürzlich=\(kuerzlich) ohneCallKit=\(ohne) → \(erwartet)", ist == erwartet)
            }

            soll("Folge: kein Fehler → angezeigt", V.meldungsFolge(nil) == .angezeigt)
            soll("Folge: callUUIDAlreadyExists → schonBekannt",
                 V.meldungsFolge(CXErrorCodeIncomingCallError(.callUUIDAlreadyExists)) == .schonBekannt)
            soll("Folge: Nicht stören → abgewiesen",
                 V.meldungsFolge(CXErrorCodeIncomingCallError(.filteredByDoNotDisturb)) == .abgewiesen)
            soll("Folge: Code 2 aus fremder Domäne → abgewiesen",
                 V.meldungsFolge(NSError(domain: "fremd", code: 2)) == .abgewiesen)

            let nach: [(V.MeldungsFolge, Bool, V.Phase?, V.NachErneuterMeldung)] = [
                (.schonBekannt, false, .klingelt, .nichts),
                (.angezeigt, false, .klingelt, .nichts),
                (.schonBekannt, true, .klingelt, .beenden),
                (.abgewiesen, true, .klingelt, .beenden),
                (.schonBekannt, true, .angenommen, .nichts),
                (.angezeigt, true, .angenommen, .nichts),
                (.angezeigt, false, .ausgehend, .nichts),
                (.angezeigt, false, nil, .geisterBeenden),
                (.schonBekannt, false, nil, .nichts),
                (.abgewiesen, true, nil, .nichts),
            ]
            for (folge, beenden, phase, erwartet) in nach {
                let ist = V.nachErneuterMeldung(folge, beenden: beenden, phase: phase)
                soll("Nach erneuter Meldung \(folge) beenden=\(beenden) "
                    + "phase=\(phase.map { "\($0)" } ?? "keine") → \(erwartet)", ist == erwartet)
            }
        }

        // MARK: - Gegen CallKit

        /// Ein Push und was für ihn gelten muss (`nil`: nicht geprüft).
        private struct Push {
            let was: String
            let inhalt: [String: String]
            var ausgang: V.PushAusgang?
            var folge: V.MeldungsFolge?
            /// Was in der `completion` gelten muss, mit Beschreibung.
            var stand: (String, () -> Bool)?
        }

        /// Weckt die wartende Probe GENAU EINMAL — aus PushKits letzter
        /// `completion` oder nach der Frist, je nachdem, was zuerst kommt.
        ///
        /// **Eine Klasse mit Sperre statt eines Merkers im Abschluss.** Die
        /// Frist geht über `asyncAfter`, und das verlangt einen
        /// `@Sendable`-Block; ein Abschluss, der eine lokale `var` mitnimmt,
        /// ist das nicht (Compiler-Warnung „non-Sendable function value").
        /// `@unchecked Sendable` hält hier, was es sagt, wegen der Sperre —
        /// nicht, weil beide Rufer heute zufällig auf dem Hauptthread laufen.
        private final class Wecker: @unchecked Sendable {
            private let sperre = NSLock()
            private var weiter: CheckedContinuation<Void, Never>?

            init(_ weiter: CheckedContinuation<Void, Never>) { self.weiter = weiter }

            func wecken() {
                sperre.lock()
                let w = weiter
                weiter = nil
                sperre.unlock()
                w?.resume()
            }
        }

        /// Was bei einem Push tatsächlich geschah.
        private struct Beobachtung {
            var ausgang: V.PushAusgang?
            var gemeldet = 0
            var fertig = false
            var folge: V.MeldungsFolge?
            var stand = false
        }

        /// Stellt die Pushes im selben Lauf hintereinander zu und prüft jeden.
        ///
        /// `false`, wenn die Prüfung des Zustands nicht aussagekräftig war:
        /// CallKit hat den Anruf von aussen beendet, bevor seine Antwort
        /// verarbeitet war (im Simulator sein Abbau, s. Kopf). Der Zustand
        /// bleibt dann ungeprüft — gezählt und geprüft wird alles andere.
        @MainActor @discardableResult
        private static func zustellen(_ pushes: [Push]) async -> Bool {
            let v = V.geteilt
            let fremdVorher = v.spur.fremdEnden
            var beobachtet = [Beobachtung](repeating: Beobachtung(), count: pushes.count)
            var fremd = false
            await withCheckedContinuation { (weiter: CheckedContinuation<Void, Never>) in
                let wecker = Wecker(weiter)
                for (i, p) in pushes.enumerated() {
                    let vorher = v.spur.meldungen
                    v.pushVerarbeiten(p.inhalt) {
                        beobachtet[i].fertig = true
                        beobachtet[i].folge = v.spur.folge
                        beobachtet[i].stand = p.stand?.1() ?? true
                        if v.spur.fremdEnden != fremdVorher { fremd = true }
                        if beobachtet.allSatisfy(\.fertig) { wecker.wecken() }
                    }
                    beobachtet[i].gemeldet = v.spur.meldungen - vorher
                    beobachtet[i].ausgang = v.spur.ausgang
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 5) { wecker.wecken() }
            }
            for (p, b) in zip(pushes, beobachtet) {
                if let erwartet = p.ausgang { soll("\(p.was): Ausgang \(erwartet)", b.ausgang == erwartet) }
                soll("\(p.was): genau eine Meldung im selben Lauf (\(b.gemeldet))", b.gemeldet == 1)
                soll("\(p.was): PushKits completion gerufen", b.fertig)
                if let erwartet = p.folge { soll("\(p.was): CallKit antwortet \(erwartet)", b.folge == erwartet) }
                guard let (text, _) = p.stand else { continue }
                if fremd {
                    NSLog("[PulseAnruf] PushProbe ---- %@: %@ — nicht aussagekräftig, CallKit "
                        + "hat den Anruf vorher von aussen beendet", p.was, text)
                } else {
                    soll("\(p.was): \(text)", b.stand)
                }
            }
            return !fremd
        }

        private static func klingelPush(_ kennung: String) -> [String: String] {
            ["art": "klingelt", "call_id": kennung, "einleiter_name": "Probe",
             "anruf_art": "dm", "channel_id": "1"]
        }

        private static func abbruchPush(_ kennung: String) -> [String: String] {
            ["art": "abbruch", "call_id": kennung]
        }

        @MainActor private static func ablauf() async {
            let v = V.geteilt
            let stamm = "pushprobe-\(Int(Date().timeIntervalSince1970))"

            // T14: die Oberfläche war schneller, der Push kommt hinterher —
            // hier, bevor CallKit ihre Meldung beantwortet hat.
            let k1 = stamm + "-1"
            v.klingeln(kennung: k1, name: "Probe", video: false)
            guard let u1 = v.uuid(fuer: k1) else {
                soll("Oberfläche meldet einen Anruf", false)
                return
            }
            await zustellen([Push(
                was: "Klingeln, während die Meldung der Oberfläche läuft", inhalt: klingelPush(k1),
                ausgang: .erneutMelden(u1), folge: .schonBekannt,
                stand: ("derselbe Anruf klingelt weiter", { v.uuid(fuer: k1) == u1 && v.phasen[u1] == .klingelt }))])
            await zustellen([Push(
                was: "Abbruch eines klingelnden Anrufs", inhalt: abbruchPush(k1),
                ausgang: .erneutMeldenUndBeenden(u1), folge: .schonBekannt,
                stand: ("beendet, als kürzlich beendet gemerkt",
                        { v.uuid(fuer: k1) == nil && v.kuerzlichBeendet[k1] != nil }))])
            await zustellen([Push(
                was: "Klingeln eines eben beendeten Anrufs", inhalt: klingelPush(k1),
                ausgang: .meldenUndSofortBeenden, stand: ("klingelt nicht wieder", { v.uuid(fuer: k1) == nil }))])

            // T14 wie eben, aber CallKit hat die Meldung der Oberfläche schon
            // beantwortet: die Klingelfrist steht und darf nicht neu kommen.
            let k2 = stamm + "-2"
            v.klingeln(kennung: k2, name: "Probe", video: false)
            guard let u2 = v.uuid(fuer: k2) else {
                soll("Oberfläche meldet einen Anruf", false)
                return
            }
            var uhr: DispatchWorkItem?
            for _ in 0 ..< 500 where uhr == nil && v.phasen[u2] != nil {
                await warten(0.01)
                uhr = v.klingelUhren[u2]
            }
            guard let uhr2 = uhr else {
                soll("CallKit zeigt im Simulator einen Anruf — sonst nicht prüfbar", false)
                return
            }
            await zustellen([
                Push(was: "Klingeln für einen klingelnden Anruf", inhalt: klingelPush(k2),
                     ausgang: .erneutMelden(u2), folge: .schonBekannt,
                     stand: ("klingelt weiter, Frist unverändert",
                             { v.phasen[u2] == .klingelt && v.klingelUhren[u2] === uhr2 })),
                Push(was: "Abbruch gleich hinterher", inhalt: abbruchPush(k2),
                     ausgang: .erneutMeldenUndBeenden(u2), folge: .schonBekannt,
                     stand: ("beendet", { v.uuid(fuer: k2) == nil })),
            ])

            await neuerAnruf(stamm + "-3")

            let k4 = stamm + "-4"
            await zustellen([Push(
                was: "Abbruch eines unbekannten Anrufs", inhalt: abbruchPush(k4),
                ausgang: .meldenUndSofortBeenden, stand: ("bleibt unbekannt", { v.uuid(fuer: k4) == nil }))])

            await laufendesGespraech(stamm + "-5")
        }

        /// Ein Anruf, den erst der Push bringt — und die Oberfläche, die ihn
        /// danach noch einmal meldet.
        @MainActor private static func neuerAnruf(_ k: String) async {
            let v = V.geteilt
            await zustellen([Push(
                was: "Klingeln eines neuen Anrufs", inhalt: klingelPush(k), ausgang: .neuMelden,
                folge: .angezeigt, stand: ("klingelt mit Frist und Kontext", {
                    guard let anruf = v.uuid(fuer: k) else { return false }
                    return v.phasen[anruf] == .klingelt && v.klingelUhren[anruf] != nil
                        && v.kontexte[k]?["anruf_art"] == "dm"
                }))])
            guard let u = v.uuid(fuer: k) else { return }
            let vorher = v.spur.meldungen
            v.klingeln(kennung: k, name: "Probe", video: false)
            soll("Oberfläche meldet ihn hinterher: kein zweiter Anruf", v.spur.meldungen == vorher)
            await zustellen([Push(
                was: "Abbruch eines klingelnden Anrufs", inhalt: abbruchPush(k),
                ausgang: .erneutMeldenUndBeenden(u), folge: .schonBekannt,
                stand: ("beendet", { v.uuid(fuer: k) == nil }))])
        }

        /// Ein Gespräch, das die Oberfläche angenommen hat, ohne dass CallKit es
        /// klingeln sah (der Träger aus `gespraechBeginnen`, Phase
        /// `.angenommen`), dann Klingeln und Abbruch per Push hinterher:
        /// beides meldet, keins beendet das Gespräch.
        ///
        /// **Nicht über einen angenommenen EINGEHENDEN Anruf**, obwohl das der
        /// häufigere Weg ist: den trennt der Simulator (s. Kopf), bevor die
        /// Annahme samt Übergabe der Audio-Session durch ist (die allein
        /// blockiert den Hauptthread rund 200 ms, gemessen 2026-10-11). Der
        /// Ausgang hängt an der Phase, nicht am Weg dorthin — und die Phase
        /// prüft die Tabelle.
        ///
        /// Bis zu drei Versuche: ob der Simulator das Gespräch trennt, bevor
        /// CallKits Antworten verarbeitet sind, hängt daran, wann die Übergabe
        /// den Hauptthread blockiert. Ein Fehler UNSERES Codes fiele in jedem
        /// Versuch auf; ein Ende von aussen wird gezählt und nicht gewertet.
        @MainActor private static func laufendesGespraech(_ stamm: String) async {
            for versuch in 1 ... 3 {
                if await laufendesGespraechVersuch("\(stamm)-\(versuch)") { return }
            }
            soll("Laufendes Gespräch: in drei Versuchen nicht aussagekräftig", false)
        }

        @MainActor private static func laufendesGespraechVersuch(_ k: String) async -> Bool {
            let v = V.geteilt
            // CallKit führt höchstens EINE Anrufgruppe, und die Anrufe davor
            // enden dort erst nach `reportCall(endedAt:)` — ohne Pause weist
            // es den Träger ab (`maximumCallGroupsReached`).
            await warten(1)
            await withCheckedContinuation { (weiter: CheckedContinuation<Void, Never>) in
                v.annehmenVomWeb(kennung: k, name: "Probe") { weiter.resume() }
            }
            guard let u = v.uuid(fuer: k), v.phasen[u] == .angenommen else {
                soll("Gespräch aus der Oberfläche steht bei CallKit — sonst nicht prüfbar", false)
                v.beenden(kennung: k, grund: .lokal)
                return true
            }
            let laeuft: () -> Bool = { v.uuid(fuer: k) == u && v.phasen[u] == .angenommen }
            let aussagekraeftig = await zustellen([
                Push(was: "Klingeln für ein laufendes Gespräch", inhalt: klingelPush(k),
                     ausgang: .erneutMelden(u), folge: .schonBekannt, stand: ("Gespräch läuft weiter", laeuft)),
                Push(was: "Abbruch für ein laufendes Gespräch", inhalt: abbruchPush(k),
                     ausgang: .erneutMelden(u), folge: .schonBekannt, stand: ("Gespräch läuft weiter", laeuft)),
            ])
            v.beenden(kennung: k, grund: .lokal)
            return aussagekraeftig
        }
    }
#endif
