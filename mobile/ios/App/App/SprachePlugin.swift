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
        CAPPluginMethod(name: "taub", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ausgabe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "kamera", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "kameraSeite", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ansichtOeffnen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ansichtSchliessen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "zustand", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "addListener", returnType: CAPPluginReturnCallback),
        CAPPluginMethod(name: "removeAllListeners", returnType: CAPPluginReturnPromise)
    ]

    public override func load() {
        SpracheRaum.geteilt.melde = { [weak self] name, nutzlast in
            self?.notifyListeners(name, data: nutzlast)
        }
        // Die Ansicht meldet ihr Schliessen auf demselben Weg. Sie kennt die
        // Brücke nicht — sie ruft einen Abschluss, und der sitzt hier.
        SpracheAnsichtHalter.geteilt.geschlossen = { [weak self] in
            self?.notifyListeners("ansichtGeschlossen", data: [:])
        }
    }

    @objc func beitreten(_ call: CAPPluginCall) {
        guard let wsUrl = call.getString("wsUrl"), let token = call.getString("token") else {
            call.reject("wsUrl und token sind Pflicht")
            return
        }
        let kanalId = call.getString("kanalId") ?? ""
        let kanalName = call.getString("kanalName") ?? ""
        let stumm = call.getBool("startStumm") ?? false
        let taub = call.getBool("startTaub") ?? false
        // `Task`, weil die SDK-Rufe `async` sind. Die Brücken-Warteschlange
        // wird dadurch NICHT gehalten — das ist hier wichtiger als sonst, denn
        // ein Verbindungsaufbau dauert.
        Task {
            do {
                try await SpracheRaum.geteilt.beitreten(
                    wsUrl: wsUrl, token: token, kanalId: kanalId, kanalName: kanalName,
                    stumm: stumm, taubStart: taub)
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

    /// Mithören aus. **Kein `throws`-Weg** — das Stellen einer Lautstärke kann
    /// nicht scheitern, es gibt im schlechtesten Fall nur keine Spur, die
    /// gestellt werden könnte.
    @objc func taub(_ call: CAPPluginCall) {
        let an = call.getBool("an") ?? false
        Task {
            await SpracheRaum.geteilt.taubStellen(an)
            call.resolve(SpracheRaum.geteilt.zustand())
        }
    }

    @objc func ausgabe(_ call: CAPPluginCall) {
        SpracheRaum.geteilt.ausgabe(call.getString("weg") ?? "lautsprecher")
        call.resolve(SpracheRaum.geteilt.zustand())
    }

    @objc func kamera(_ call: CAPPluginCall) {
        let an = call.getBool("an") ?? false
        Task {
            do {
                try await SpracheRaum.geteilt.kamera(an)
                call.resolve(SpracheRaum.geteilt.zustand())
            } catch {
                // Laut scheitern: eine verweigerte Kamera-Erlaubnis oder ein
                // belegtes Gerät muss die Oberfläche erreichen, sonst sieht der
                // Knopf geschaltet aus und es kommt kein Bild.
                NSLog("[PulseSprache] kamera FEHLER: %@", error.localizedDescription)
                call.reject("sprache_kamera_fehlgeschlagen", nil, error)
            }
        }
    }

    @objc func kameraSeite(_ call: CAPPluginCall) {
        let front = call.getBool("front") ?? true
        Task {
            do {
                try await SpracheRaum.geteilt.kameraSeite(front: front)
                call.resolve(SpracheRaum.geteilt.zustand())
            } catch {
                NSLog("[PulseSprache] kameraSeite FEHLER: %@", error.localizedDescription)
                call.reject("sprache_kameraseite_fehlgeschlagen", nil, error)
            }
        }
    }

    /// Die native Kanalansicht zeigen.
    ///
    /// **Das Web entscheidet, wann — nicht `beitreten`.** Der Entwurf (§4)
    /// führt das Zeigen als Teil von `beitreten` auf; hier ist es ein eigener
    /// Befehl, aus einem Grund, der erst beim Bauen sichtbar wurde: die Hülle
    /// weiss nicht, ob der Nutzer gerade auf den Kanal schaut. Ein Beitritt
    /// kommt auch aus dem Wiederaufnehmen nach einem Reload und aus dem
    /// automatischen Beitritt beim Navigieren — ein Vollbild über irgendeinem
    /// anderen Bildschirm wäre dort falsch. So liegt das Zeigen an GENAU EINER
    /// Stelle (hier), und wer sie ruft, entscheidet das Web.
    ///
    /// Ohne stehenden Raum tut der Befehl nichts: eine Kanalansicht ohne Kanal
    /// hätte keinen Inhalt und keinen Ausweg.
    @objc func ansichtOeffnen(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let raum = SpracheRaum.geteilt.raum else {
                call.reject("sprache_kein_raum")
                return
            }
            guard let wurzel = self.bridge?.viewController else {
                call.reject("keine Ansicht")
                return
            }
            SpracheAnsichtHalter.geteilt.zeigen(
                ueber: wurzel, raum: raum, kanalName: SpracheRaum.geteilt.kanalName)
            call.resolve(SpracheRaum.geteilt.zustand())
        }
    }

    /// Nur die ANSICHT schliessen — der Raum bleibt. Gemeldet wird es nicht:
    /// das Web hat selbst geschlossen und weiss es.
    @objc func ansichtSchliessen(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            SpracheAnsichtHalter.geteilt.schliessen(melden: false)
            call.resolve(SpracheRaum.geteilt.zustand())
        }
    }

    /// Vollbild des Zustands — für den Abgleich, nachdem die Web-App neu
    /// geladen hat. Der Raum überlebt das nativ; ohne diesen Ruf wüsste die
    /// frische Oberfläche nichts davon.
    @objc func zustand(_ call: CAPPluginCall) {
        call.resolve(SpracheRaum.geteilt.zustand())
    }
}
