import Capacitor
import UIKit

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
        CAPPluginMethod(name: "lautstaerken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "erzwungen", returnType: CAPPluginReturnPromise),
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
        // Knöpfe der Ansicht, deren Regeln das Web kennt (`SpracheRaum.wunsch`).
        // **`hasListeners` ist die Frage „hört die Oberfläche gerade zu?"** —
        // Capacitor räumt alle Hörer bei jeder Navigation der WebView ab
        // (`CapacitorBridge.reset`), ein Reload hinterlässt also keine toten.
        SpracheRaum.geteilt.wunschAnWeb = { [weak self] wunsch, an in
            guard let self, self.hasListeners("wunsch") else { return false }
            self.notifyListeners("wunsch", data: ["aktion": wunsch.rawValue, "an": an])
            return true
        }
    }

    /// Einen Befehl in die Kette des Raums stellen (Begründung an
    /// `SpracheRaum.nacheinander`) und mit dem Zustand danach beantworten.
    /// **Laut scheitern:** ein verschluckter Fehlschlag ist hier der teuerste
    /// Zustand — die Oberfläche hielte etwas für geschaltet, das es nicht ist.
    private func befehl(_ call: CAPPluginCall, _ name: String,
                        _ arbeit: @escaping () async throws -> Void) {
        Task {
            do {
                try await SpracheRaum.geteilt.nacheinander(arbeit)
                call.resolve(SpracheRaum.geteilt.zustand())
            } catch {
                NSLog("[PulseSprache] %@ FEHLER: %@", name, error.localizedDescription)
                call.reject("sprache_\(name)_fehlgeschlagen", nil, error)
            }
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
        let (je, gesamt) = Self.hoerwunsch(call)
        // In der Kette: ein Mikrofon-Befehl, der während des Aufbaus kommt,
        // wartet auf den Raum, statt auf dem alten oder keinem zu landen. Die
        // Brücken-Warteschlange hält das NICHT — der Aufbau läuft im `Task`.
        befehl(call, "beitritt") {
            try await SpracheRaum.geteilt.beitreten(
                wsUrl: wsUrl, token: token, kanalId: kanalId, kanalName: kanalName,
                stumm: stumm, taubStart: taub, lautstaerken: je, gesamt: gesamt)
        }
    }

    /// **Nicht in der Kette** — Auflegen darf nicht hinter einem hängenden
    /// Verbindungsaufbau warten, und es bricht ihn ab. `sitzung` (optional):
    /// nur verlassen, wenn genau dieser Beitritt noch läuft.
    @objc func verlassen(_ call: CAPPluginCall) {
        let sitzung = call.getInt("sitzung")
        Task {
            await SpracheRaum.geteilt.verlassen(sitzung: sitzung)
            call.resolve()
        }
    }

    @objc func mikrofon(_ call: CAPPluginCall) {
        let an = call.getBool("an") ?? true
        befehl(call, "mikrofon") { try await SpracheRaum.geteilt.mikrofon(an) }
    }

    /// Mithören aus. Kann nicht scheitern — im schlechtesten Fall gibt es
    /// keine Spur, die gestellt werden könnte.
    @objc func taub(_ call: CAPPluginCall) {
        let an = call.getBool("an") ?? false
        befehl(call, "taub") { await SpracheRaum.geteilt.taubStellen(an) }
    }

    /// Lautstärke je Teilnehmer und gesamt — **immer die ganze Tabelle**, aus
    /// demselben Grund wie die Teilnehmerliste: Teil-Updates bräuchten eine
    /// Reihenfolge, die eine Brücke nicht zusagt. Der Entwurf (§4) nannte
    /// `lautstaerke({identitaet, wert})`; der Schlüssel ist hier die Nutzer-Id,
    /// weil die Einstellungen im Web so gespeichert sind.
    @objc func lautstaerken(_ call: CAPPluginCall) {
        let (je, gesamt) = Self.hoerwunsch(call)
        befehl(call, "lautstaerken") {
            await SpracheRaum.geteilt.hoerwunschSetzen(je: je, gesamt: gesamt)
        }
    }

    /// Admin-Stumm- und -Taubschaltung im Kanal (Nutzer-Ids, je die ganze
    /// Liste). Nur Anzeige — Schild und gesperrter Knopf in der Ansicht;
    /// durchgesetzt wird die Stummschaltung vom Server, die Taubschaltung vom
    /// Web (`taub`). Nicht in der Kette: kein SDK-Ruf, kein Rennen.
    @objc func erzwungen(_ call: CAPPluginCall) {
        let stumm = Set(call.getArray("stumm", String.self) ?? [])
        let taub = Set(call.getArray("taub", String.self) ?? [])
        DispatchQueue.main.async {
            SpracheStand.geteilt.erzwungenSetzen(stumm: stumm, taub: taub)
            call.resolve(SpracheRaum.geteilt.zustand())
        }
    }

    private static func hoerwunsch(_ call: CAPPluginCall) -> ([String: Double]?, Double?) {
        let je = call.getObject("lautstaerken")?.compactMapValues { wert -> Double? in
            (wert as? NSNumber)?.doubleValue
        }
        return (je, call.getDouble("gesamt"))
    }

    /// Nicht in der Kette: ein Schalter am SDK, kein `await`, kein Rennen.
    @objc func ausgabe(_ call: CAPPluginCall) {
        SpracheRaum.geteilt.ausgabe(call.getString("weg") ?? "lautsprecher")
        call.resolve(SpracheRaum.geteilt.zustand())
    }

    @objc func kamera(_ call: CAPPluginCall) {
        let an = call.getBool("an") ?? false
        befehl(call, "kamera") { try await SpracheRaum.geteilt.kamera(an) }
    }

    @objc func kameraSeite(_ call: CAPPluginCall) {
        let front = call.getBool("front") ?? true
        befehl(call, "kameraseite") { try await SpracheRaum.geteilt.kameraSeite(front: front) }
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
        let stil = Self.stil(call.getString("thema"))
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
                ueber: wurzel, raum: raum, kanalName: SpracheRaum.geteilt.kanalName, stil: stil)
            call.resolve(SpracheRaum.geteilt.zustand())
        }
    }

    /// Das Thema der Web-App (`thema`: `light`/`dark`/`system`). Ohne Angabe —
    /// eine Web-App, die das Feld noch nicht mitschickt — folgt die Ansicht dem
    /// Telefon, wie die Web-App mit ihrer Vorgabe `system`.
    static func stil(_ thema: String?) -> UIUserInterfaceStyle {
        switch thema {
        case "light": return .light
        case "dark": return .dark
        default: return .unspecified
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
