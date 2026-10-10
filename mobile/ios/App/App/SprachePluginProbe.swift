import LiveKit
import UIKit

#if DEBUG
    /// **Prüfpfad für den nativen Sprachweg — nur in Debug-Bauten.**
    ///
    /// Der Entwurf verlangt, den Tonweg zu belegen, BEVOR eine Oberfläche
    /// darauf steht: „trägt sie nicht, ist der ganze Weg falsch, und wir haben
    /// es für den Preis einer Etappe erfahren".
    ///
    /// Angestossen über ein Startargument, weil der sonst einzige Weg zum
    /// Plugin durch die WebView führt — und die verlangt eine Anmeldung, die
    /// in einem automatischen Lauf nichts zu suchen hat. So lässt sich der
    /// native Raum gegen einen Testraum fahren, ohne Konto und ohne
    /// Oberfläche:
    ///
    ///     xcrun simctl launch <sim> com.howispulse.app \
    ///         -PulseSpracheProbe "<wsUrl>|<token>"
    ///
    /// `#if DEBUG` ist Absicht und keine Formsache: ein Startargument, das
    /// einen Sprachraum öffnet, gehört in keine ausgelieferte App.
    extension SprachePlugin {
        static func probeAusStartargumenten() {
            guard let roh = UserDefaults.standard.string(forKey: "PulseSpracheProbe") else { return }
            let teile = roh.split(separator: "|", maxSplits: 2).map(String.init)
            guard teile.count >= 2 else {
                NSLog("[PulseSprache] Probe: erwartet \"<wsUrl>|<token>[|<wartesekunden>]\"")
                return
            }
            NSLog("[PulseSprache] Probe startet gegen %@", teile[0])
            // **Jeder Schritt meldet sich einzeln, und ein Fehlschlag haelt die
            // folgenden nicht auf.** Der erste Anlauf brach am Mikrofon ab und
            // liess damit offen, ob der Rest — die Route, um die es geht —
            // ueberhaupt traegt. Ein Pruefpfad, der beim ersten Stolpern
            // aufhoert, misst die eine Sache nicht, fuer die er gebaut wurde.
            Task {
                do {
                    try await SpracheRaum.geteilt.beitreten(
                        wsUrl: teile[0], token: teile[1], kanalId: "probe",
                        kanalName: "Probe-Kanal", stumm: true, taubStart: false)
                    NSLog("[PulseSprache] Probe VERBUNDEN, Route: %@",
                          "\(SpracheRaum.geteilt.zustand()["route"] ?? "?")")
                } catch {
                    NSLog("[PulseSprache] Probe VERBINDEN fehlgeschlagen: %@",
                          error.localizedDescription)
                    return
                }

                // **Erst das Mikrofon, dann die Route.** Ohne Aufnahme
                // waehlt das SDK `.playback`, und dort gibt es gar keine
                // Hoermuschel-Wahl — vorher gemessen: drei Umschaltversuche
                // ohne jede Wirkung, dann `Mikrofon an`, und die Route sprang
                // auf `Receiver`.
                //
                // Die Bedingung dahinter ist allgemeiner, und sie kostete den
                // ganzen 2026-10-10: **die Session muss AKTIV sein.** Das SDK
                // waehlt Lautsprecher oder Hoermuschel nur ueber
                // `setCategory`, und an einer nicht aktiven Session bewegt
                // eine Kategorie keine Route (sie meldet nicht einmal einen
                // Routenwechsel).
                do {
                    try await SpracheRaum.geteilt.mikrofon(true)
                    NSLog("[PulseSprache] Probe MIKROFON an, Route: %@",
                          "\(SpracheRaum.geteilt.zustand()["route"] ?? "?")")
                } catch {
                    NSLog("[PulseSprache] Probe MIKROFON fehlgeschlagen: %@",
                          error.localizedDescription)
                }

                // **Die Wartezeit ist regelbar, weil die erste Vermutung
                // am Abstand zum Beitritt hing — und daran lag es nicht.**
                // In der App lagen zwischen Beitritt und Umschalten ~40 s, im
                // Pruefpfad 3 s; die Gegenprobe mit 45 s hier war gruen
                // (`Routenwechsel grund=3 neu=Receiver`). Damit war die Zeit
                // ausgeschlossen und der Blick frei fuer den wirklichen
                // Unterschied: in der App lief die Audio-Maschine nicht, weil
                // WebKits Beitritts-Ton die Session an sich gezogen hatte
                // (volle Messung an `webSessionTyp` in
                // `web/src/lib/platform/iosSprache.ts`). Der Parameter
                // bleibt — er ist der Weg, eine solche Vermutung in einem Lauf
                // zu erledigen statt sie zu glauben.
                let warten = teile.count > 2 ? (Double(teile[2]) ?? 3) : 3
                try? await Task.sleep(nanoseconds: UInt64(warten * 1_000_000_000))

                // **Die Ansicht zuerst, dann der Rest.** Sie ist das, was ein
                // Simulator-Lauf wirklich zeigen kann (Mikrofon und Kamera hat
                // er nicht), und sie stört die Ton-Messungen nicht — sie
                // zeichnet nur.
                await ansichtZeigen()
                ereignisseMitschneiden()
                // **Mehrfach, nicht einmal.** Ein einziger Bericht beweist
                // nur, dass die Liste irgendwann einmal stimmte; die Frage ist
                // aber, ob sie sich bei einer Änderung mitbewegt (fremdes
                // Stummschalten, Kamera an und aus, Pegel). Deshalb über
                // mehrere Sekunden, damit ein Lauf eine Veränderung zeigen
                // kann statt eines Standbildes.
                for runde in 1 ... 6 {
                    await teilnehmerBerichten("Runde \(runde)")
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                }

                for weg in ["hoermuschel", "lautsprecher", "hoermuschel"] {
                    SpracheRaum.geteilt.ausgabe(weg)
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    NSLog("[PulseSprache] Probe nach '%@': Route %@", weg,
                          "\(SpracheRaum.geteilt.zustand()["route"] ?? "?")")
                }

                await taubDurchfahren()

                // **Zum Schluss der Rückweg.** 20 s Pause — Zeit, die Ansicht
                // von Hand zu schliessen (Wischen oder Pfeil) —, dann erneut
                // öffnen. Das ist genau, was der Griff „zurück in den Kanal"
                // in der Web-Leiste tut, und der einzige Weg, ihn ohne
                // angemeldete Oberfläche zu prüfen.
                try? await Task.sleep(nanoseconds: 20_000_000_000)
                NSLog("[PulseSprache] Probe RUECKWEG: Ansicht offen=%@, erneut oeffnen",
                      SpracheAnsichtHalter.geteilt.istOffenSynchron ? "ja" : "nein")
                await ansichtZeigen()
            }
        }

        /// Native Ansicht über die WebView legen — ohne Plugin-Instanz, also
        /// ohne Capacitors `bridge`. Die Wurzel kommt deshalb vom
        /// Schlüsselfenster; bis die steht, kann es einen Moment dauern
        /// (die Probe läuft aus `didFinishLaunchingWithOptions`).
        private static func ansichtZeigen() async {
            for _ in 0 ..< 20 {
                let wurzel: UIViewController? = await MainActor.run {
                    UIApplication.shared.connectedScenes
                        .compactMap { ($0 as? UIWindowScene)?.windows.first { $0.isKeyWindow } }
                        .first?.rootViewController
                }
                if let wurzel, let raum = SpracheRaum.geteilt.raum {
                    await MainActor.run {
                        SpracheAnsichtHalter.geteilt.zeigen(
                            ueber: wurzel, raum: raum,
                            kanalName: SpracheRaum.geteilt.kanalName)
                    }
                    let offen = SpracheAnsichtHalter.geteilt.istOffenSynchron
                    NSLog("[PulseSprache] Probe ANSICHT offen=%@", offen ? "ja" : "nein")
                    return
                }
                try? await Task.sleep(nanoseconds: 250_000_000)
            }
            NSLog("[PulseSprache] Probe ANSICHT: keine Fensterwurzel gefunden")
        }

        /// **Mitschnitt dessen, was WIRKLICH über die Brücke geht.**
        ///
        /// Ein Prüfpfad, der `teilnehmerListe()` selbst aufruft, prüft die
        /// Nutzlast — aber nicht, ob jemals ein Ereignis ausgelöst wird. Genau
        /// diese Lücke war der Befund vom Gerät („ich klicke auf stumm und
        /// sehe das Zeichen nicht"): die Daten stimmten, es fragte sie nur
        /// niemand ab, weil kein Ereignis kam. Deshalb hängt sich die Probe
        /// in den Melde-Weg und schreibt mit, was die Oberfläche bekäme.
        ///
        /// **Nach dem Plugin, nicht davor.** `SprachePlugin.load()` setzt
        /// `melde` selbst — wer sich vorher einhängt, wird überschrieben. Die
        /// Probe läuft aus `didFinishLaunchingWithOptions`, also Sekunden vor
        /// der WebView; an dieser Stelle ist die Verdrahtung durch, und der
        /// vorhandene Empfänger wird weitergereicht statt ersetzt.
        private static func ereignisseMitschneiden() {
            let vorher = SpracheRaum.geteilt.melde
            SpracheRaum.geteilt.melde = { name, nutzlast in
                if name == "teilnehmer", let liste = nutzlast["liste"] as? [[String: Any]] {
                    NSLog("[PulseSprache] Probe EREIGNIS teilnehmer: %@",
                          liste.map {
                              let n = $0["name"] as? String ?? "?"
                              return "\(n):\(($0["micMuted"] as? Bool ?? true) ? "stumm" : "offen")"
                          }.joined(separator: " "))
                } else if name != "sprechen" {
                    // `sprechen` kommt im Sekundentakt und würde den Rest
                    // zuschütten — es ist ausserdem das eine Ereignis, das
                    // ohnehin unstrittig feuert.
                    NSLog("[PulseSprache] Probe EREIGNIS %@: %@", name, "\(nutzlast)")
                }
                vorher?(name, nutzlast)
            }
            // `ansichtGeschlossen` nimmt einen ANDEREN Weg nach oben (der
            // Halter ruft seinen eigenen Abschluss, nicht `melde`) — wer nur
            // `melde` mitschneidet, sieht es nicht und hielte es für
            // ausgefallen. Beim ersten Durchgang genau so passiert.
            let vorherGeschlossen = SpracheAnsichtHalter.geteilt.geschlossen
            SpracheAnsichtHalter.geteilt.geschlossen = {
                NSLog("[PulseSprache] Probe EREIGNIS ansichtGeschlossen (Raum verbunden: %@)",
                      SpracheRaum.geteilt.zustand()["verbunden"] as? Bool == true ? "ja" : "nein")
                vorherGeschlossen?()
            }
            NSLog("[PulseSprache] Probe MITSCHNITT an (melde gesetzt: %@, geschlossen: %@)",
                  vorher == nil ? "nein" : "ja", vorherGeschlossen == nil ? "nein" : "ja")
        }

        /// **Taubstellen an der WIRKUNG geprüft, nicht am Merker.** Gelesen
        /// wird die anliegende Lautstärke jeder fremden Tonspur — vorher,
        /// taub, und wieder zurück. Ohne einen zweiten Teilnehmer im Raum ist
        /// die Liste leer, und der Lauf sagt das auch; das ist dann keine
        /// Bestätigung, sondern eine fehlende Messung.
        private static func taubDurchfahren() async {
            await lautstaerkenMelden("vor taub")
            await SpracheRaum.geteilt.taubStellen(true)
            try? await Task.sleep(nanoseconds: 500_000_000)
            await lautstaerkenMelden("taub AN")
            await SpracheRaum.geteilt.taubStellen(false)
            try? await Task.sleep(nanoseconds: 500_000_000)
            await lautstaerkenMelden("taub AUS")
        }

        private static func lautstaerkenMelden(_ wann: String) async {
            let werte = await SpracheRaum.geteilt.lautstaerkenLesen()
            if werte.isEmpty {
                NSLog("[PulseSprache] Probe LAUTSTAERKE %@: KEINE fremde Tonspur"
                    + " — nichts gemessen", wann)
                return
            }
            let text = werte.sorted { $0.key < $1.key }
                .map { "\($0.key)=\($0.value)" }.joined(separator: " ")
            NSLog("[PulseSprache] Probe LAUTSTAERKE %@ (taub=%@): %@", wann,
                  SpracheRaum.geteilt.taub ? "ja" : "nein", text)
        }

        /// Was in der Teilnehmerliste steht, die ans Web ginge. Der Bericht
        /// liest dieselbe Funktion, die das `teilnehmer`-Ereignis füllt —
        /// damit prüft er die Nutzlast und nicht nur, dass gerufen wurde.
        private static func teilnehmerBerichten(_ wann: String) async {
            let liste = SpracheRaum.geteilt.teilnehmerListe()
            NSLog("[PulseSprache] Probe TEILNEHMER %@ (%d): %@", wann, liste.count,
                  liste.map {
                      let name = $0["name"] as? String ?? "?"
                      let stumm = ($0["micMuted"] as? Bool ?? true) ? "stumm" : "offen"
                      let kam = ($0["cameraOn"] as? Bool ?? false) ? "cam" : "-"
                      // **Pegel und Sprech-Kippkante gehören in den Bericht.**
                      // Sie treiben den Ring an der Kachel, und ein Ring, den
                      // man nur ansieht, ist nicht gemessen — die Dicke folgt
                      // dem Pegel, und ein Pegel, der still auf 0 steht, sähe
                      // genauso aus wie einer, der nie ankommt.
                      let pegel = String(format: "%.3f", $0["audioLevel"] as? Double ?? -1)
                      let spricht = ($0["isSpeaking"] as? Bool ?? false) ? "SPRICHT" : "still"
                      return "\(name):\(stumm):\(kam):\(spricht):\(pegel)"
                  }.joined(separator: " "))
        }
    }
#endif
