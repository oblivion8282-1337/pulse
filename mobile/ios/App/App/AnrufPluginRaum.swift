import Capacitor

/// Die Befehle des nativen Anruf-Raums an der Brücke (Etappe 4).
///
/// **Nur iOS.** Android hat dieselben übrigen Methoden des `Anruf`-Plugins,
/// diese nicht — die Oberfläche fragt die Hülle vor dem ersten Ruf, ob sie
/// ALLE kennt (`platform/anrufNativ.ts`, `ANRUF_RAUM_METHODEN`), und bleibt
/// sonst ganz beim Web-Weg. Ein halber nativer Anruf wäre schlimmer als
/// keiner.
///
/// Die Methoden stehen in der Liste der Hauptklasse (`pluginMethods`);
/// Capacitor löst sie über den Selektor auf, und der findet auch eine
/// Erweiterung.
extension AnrufPlugin {
    /// In der App angenommen — CallKit nimmt mit an (`annehmenVomWeb`).
    @objc func annehmen(_ call: CAPPluginCall) {
        let kennung = call.getString("callId") ?? ""
        let name = call.getString("gegenstelle") ?? "Pulse"
        DispatchQueue.main.async {
            Anrufverwaltung.geteilt.annehmenVomWeb(kennung: kennung, name: name) {
                call.resolve(AnrufRaum.geteilt.zustand())
            }
        }
    }

    /// Ein ausgehender Anruf, sobald der Server die Kennung vergeben hat.
    @objc func ausgehend(_ call: CAPPluginCall) {
        let kennung = call.getString("callId") ?? ""
        let name = call.getString("gegenstelle") ?? "Pulse"
        DispatchQueue.main.async {
            Anrufverwaltung.geteilt.ausgehendBeginnen(kennung: kennung, name: name) {
                call.resolve(AnrufRaum.geteilt.zustand())
            }
        }
    }

    /// Den Raum des Gesprächs betreten.
    ///
    /// **`schluessel` ist fail-closed**: kommt einer mit und lässt er sich
    /// nicht lesen, gibt es KEINEN Raum — ein Anruf, der verschlüsselt sein
    /// sollte, läuft nie im Klartext (dieselbe Regel wie im Web,
    /// `anruf.svelte.ts`).
    @objc func raumBeitreten(_ call: CAPPluginCall) {
        guard let kennung = call.getString("callId"), let wsUrl = call.getString("wsUrl"),
              let token = call.getString("token") else {
            call.reject("callId, wsUrl und token sind Pflicht")
            return
        }
        var schluessel: Data?
        if let roh = call.getString("schluessel") {
            guard let bytes = Data(base64Encoded: roh), bytes.count == 32 else {
                call.reject("anruf_schluessel_unlesbar")
                return
            }
            schluessel = bytes
        }
        let stumm = call.getBool("stumm") ?? false
        var kontext: [String: String] = [:]
        for feld in ["art", "kanalId", "rolle", "gegenstelle"] {
            if let wert = call.getString(feld) { kontext[feld] = wert }
        }
        Task {
            do {
                try await AnrufRaum.geteilt.nacheinander {
                    try await AnrufRaum.geteilt.beitreten(
                        kennung: kennung, wsUrl: wsUrl, token: token, schluessel: schluessel,
                        stumm: stumm, kontext: kontext)
                }
                call.resolve(AnrufRaum.geteilt.zustand())
            } catch {
                NSLog("[PulseAnruf] Beitritt fehlgeschlagen: %@", error.localizedDescription)
                call.reject("anruf_beitritt_fehlgeschlagen", nil, error)
            }
        }
    }

    @objc func raumMikrofon(_ call: CAPPluginCall) {
        let an = call.getBool("an") ?? true
        befehl(call, "mikrofon") { try await AnrufRaum.geteilt.mikrofon(an) }
    }

    @objc func raumKamera(_ call: CAPPluginCall) {
        let an = call.getBool("an") ?? false
        befehl(call, "kamera") { try await AnrufRaum.geteilt.kamera(an) }
    }

    @objc func raumAusgabe(_ call: CAPPluginCall) {
        let lautsprecher = call.getBool("lautsprecher") ?? false
        DispatchQueue.main.async {
            AnrufRaum.geteilt.ausgabe(lautsprecher: lautsprecher)
            call.resolve(AnrufRaum.geteilt.zustand())
        }
    }

    /// Vollbild des Zustands — für eine neu geladene Oberfläche, die ein
    /// laufendes Gespräch übernimmt.
    @objc func raumZustand(_ call: CAPPluginCall) {
        call.resolve(AnrufRaum.geteilt.zustand())
    }

    /// **Laut scheitern** — wie `SprachePlugin.befehl`.
    private func befehl(_ call: CAPPluginCall, _ name: String,
                        _ arbeit: @escaping () async throws -> Void) {
        Task {
            do {
                try await AnrufRaum.geteilt.nacheinander(arbeit)
                call.resolve(AnrufRaum.geteilt.zustand())
            } catch {
                NSLog("[PulseAnruf] %@ FEHLER: %@", name, error.localizedDescription)
                call.reject("anruf_\(name)_fehlgeschlagen", nil, error)
            }
        }
    }
}
