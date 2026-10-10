import Capacitor

/// Brücke zwischen Web-Oberfläche und nativem Sprach-Raum (`SpracheRaum`).
///
/// Die Aufteilung folgt dem Entwurf
/// `docs/superpowers/specs/2026-10-10-ios-nativer-sprachweg-design.md`:
/// **nativ ist die Wahrheit, der Web-Store spiegelt.** Die Fläche hier ist
/// absichtlich klein — Befehle hinein, grober Zustand hinaus. Alles, was
/// schnell ist (Pegel, Sprechringe), bleibt drüben und kommt gar nicht erst
/// über die Brücke: sie ist EINE serielle Warteschlange.
///
/// **Die Anmeldung bleibt im Web.** Dieses Plugin bekommt `wsUrl` und `token`
/// gereicht; es kennt weder Konten noch Sitzungen.
@objc(SprachePlugin)
public class SprachePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SprachePlugin"
    public let jsName = "SprachePlugin"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "beitreten", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "verlassen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mikrofon", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ausgabe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "zustand", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "addListener", returnType: CAPPluginReturnCallback),
        CAPPluginMethod(name: "removeAllListeners", returnType: CAPPluginReturnPromise)
    ]

    public override func load() {
        SpracheRaum.geteilt.melde = { [weak self] name, nutzlast in
            self?.notifyListeners(name, data: nutzlast)
        }
    }

    @objc func beitreten(_ call: CAPPluginCall) {
        guard let wsUrl = call.getString("wsUrl"), let token = call.getString("token") else {
            call.reject("wsUrl und token sind Pflicht")
            return
        }
        let kanalId = call.getString("kanalId") ?? ""
        let stumm = call.getBool("startStumm") ?? false
        // `Task`, weil die SDK-Rufe `async` sind. Die Brücken-Warteschlange
        // wird dadurch NICHT gehalten — das ist hier wichtiger als sonst, denn
        // ein Verbindungsaufbau dauert.
        Task {
            do {
                try await SpracheRaum.geteilt.beitreten(
                    wsUrl: wsUrl, token: token, kanalId: kanalId, stumm: stumm)
                call.resolve(SpracheRaum.geteilt.zustand())
            } catch {
                // **Laut scheitern.** Ein verschluckter Fehlschlag hier ist
                // der teuerste Zustand: die Oberfläche hielte sich für
                // verbunden, und niemand hörte etwas.
                NSLog("[PulseSprache] beitreten FEHLER: %@", error.localizedDescription)
                call.reject("sprache_beitritt_fehlgeschlagen", nil, error)
            }
        }
    }

    @objc func verlassen(_ call: CAPPluginCall) {
        Task {
            await SpracheRaum.geteilt.verlassen()
            call.resolve()
        }
    }

    @objc func mikrofon(_ call: CAPPluginCall) {
        let an = call.getBool("an") ?? true
        Task {
            do {
                try await SpracheRaum.geteilt.mikrofon(an)
                call.resolve(SpracheRaum.geteilt.zustand())
            } catch {
                NSLog("[PulseSprache] mikrofon FEHLER: %@", error.localizedDescription)
                call.reject("sprache_mikrofon_fehlgeschlagen", nil, error)
            }
        }
    }

    @objc func ausgabe(_ call: CAPPluginCall) {
        SpracheRaum.geteilt.ausgabe(call.getString("weg") ?? "lautsprecher")
        call.resolve(SpracheRaum.geteilt.zustand())
    }

    /// Vollbild des Zustands — für den Abgleich, nachdem die Web-App neu
    /// geladen hat. Der Raum überlebt das nativ; ohne diesen Ruf wüsste die
    /// frische Oberfläche nichts davon.
    @objc func zustand(_ call: CAPPluginCall) {
        call.resolve(SpracheRaum.geteilt.zustand())
    }
}

#if DEBUG
    /// **Prüfpfad für Etappe 1 — nur in Debug-Bauten.**
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
            let teile = roh.split(separator: "|", maxSplits: 1).map(String.init)
            guard teile.count == 2 else {
                NSLog("[PulseSprache] Probe: erwartet \"<wsUrl>|<token>\"")
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
                        wsUrl: teile[0], token: teile[1], kanalId: "probe", stumm: true)
                    NSLog("[PulseSprache] Probe VERBUNDEN, Route: %@",
                          "\(SpracheRaum.geteilt.zustand()["route"] ?? "?")")
                } catch {
                    NSLog("[PulseSprache] Probe VERBINDEN fehlgeschlagen: %@",
                          error.localizedDescription)
                    return
                }

                // **Erst das Mikrofon, dann die Route — in dieser
                // Reihenfolge, und das ist der Befund vom 2026-10-10.** Der
                // SDK-Schalter wirkt nicht fuer sich: er greift, wenn das SDK
                // die Session neu einrichtet, und das tut es beim
                // Veroeffentlichen einer Aufnahme (Kategorie wechselt von
                // `.playback` auf `.playAndRecord`). Vorher gemessen: drei
                // Umschaltversuche ohne jede Wirkung, dann `Mikrofon an` —
                // und die Route sprang auf `Receiver`.
                //
                // Die eigentliche Frage ist damit eine andere: traegt das
                // Umschalten auch MITTEN im Gespraech, wenn die Aufnahme schon
                // laeuft? Genau das misst die Reihenfolge hier.
                do {
                    try await SpracheRaum.geteilt.mikrofon(true)
                    NSLog("[PulseSprache] Probe MIKROFON an, Route: %@",
                          "\(SpracheRaum.geteilt.zustand()["route"] ?? "?")")
                } catch {
                    NSLog("[PulseSprache] Probe MIKROFON fehlgeschlagen: %@",
                          error.localizedDescription)
                }

                for weg in ["hoermuschel", "lautsprecher", "hoermuschel"] {
                    try? await Task.sleep(nanoseconds: 3_000_000_000)
                    SpracheRaum.geteilt.ausgabe(weg)
                }
            }
        }
    }
#endif
