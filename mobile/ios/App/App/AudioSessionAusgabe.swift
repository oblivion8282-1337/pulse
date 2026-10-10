import AVFoundation
import Capacitor

/// Ausgabe-Wahl des Audio-Session-Plugins (Roadmap-Punkte 24 und 30) —
/// ausgezogen aus `AudioSessionPlugin.swift`.
///
/// **Warum eine eigene Datei.** Die Hauptdatei stand am 2026-10-10 an der
/// harten Grenze der Groessen-Policy (`PLAN.md` §12.1, 500 Zeilen) und
/// brauchte Platz fuer die Messung am Tonweg. Dieser Teil steht inhaltlich
/// fuer sich: er WAEHLT einen Ausgang, waehrend die Hauptdatei die
/// Betriebsart der Session bestimmt.
///
/// Was dort bleiben MUSSTE: der gemerkte Wunsch (`ausgabewunsch`) und
/// `letzterHqFunk`. Swift erlaubt in einer Erweiterung keine gespeicherten
/// Eigenschaften — deshalb sind sie dort auch nicht mehr `private`.
extension AudioSessionPlugin {
    // MARK: - Wege (Punkt 24)

    /// Welche Ausgabewege es gibt und welcher gerade gilt.
    ///
    /// **iOS wählt anders als Android.** Dort pinnt man ein Ausgabegerät; hier
    /// wählt man den EINGANG, und der Ausgang folgt ihm (bei einem
    /// Bluetooth-Headset ist beides dasselbe Gerät). Lautsprecher und
    /// Hörmuschel sind kein Eingang, sondern eine Übersteuerung
    /// (`overrideOutputAudioPort`) — deshalb stehen sie hier als zwei feste
    /// Einträge neben den echten Geräten.
    @objc func routen(_ call: CAPPluginCall) {
        let session = AVAudioSession.sharedInstance()
        var geraete: [[String: Any]] = [
            ["id": "speaker", "art": "speaker", "name": "Lautsprecher"],
            ["id": "earpiece", "art": "earpiece", "name": "Hörmuschel"]
        ]
        for eingang in session.availableInputs ?? [] {
            // Das eingebaute Mikrofon ist kein eigener WEG — es gehört zu
            // Lautsprecher und Hörmuschel, die schon oben stehen.
            if eingang.portType == .builtInMic { continue }
            geraete.append([
                "id": eingang.uid,
                "art": eingang.portType.rawValue,
                "name": eingang.portName
            ])
        }
        call.resolve([
            "aktuell": session.currentRoute.outputs.first?.portType.rawValue ?? "",
            "aktuellName": session.currentRoute.outputs.first?.portName ?? "",
            "geraete": geraete
        ])
    }

    /// Einen Weg erzwingen. `id` ist entweder `speaker`/`earpiece` oder die
    /// UID eines Eintrags aus `routen()`.
    @objc func routeSetzen(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("id_fehlt")
            return
        }
        let session = AVAudioSession.sharedInstance()
        do {
            switch id {
            case "speaker", "earpiece":
                ausgabewunsch = (id == "speaker") ? .lautsprecher : .hoermuschel
                // `try?`, nicht `try`: der EINGANG ist fuer die Ausgabe-Wahl
                // belanglos, und ein Fehlschlag hier darf sie nicht aufhalten
                // — vorher endete der ganze Ruf im `catch`, ohne dass je
                // uebersteuert wurde.
                try? session.setPreferredInput(nil)
                // Die Kategorie muss zum Wunsch passen, BEVOR uebersteuert
                // wird: `.defaultToSpeaker` ist genau das, worauf `.none`
                // zurueckfaellt. Nur im Sprach-Betrieb — in `.playback` ist
                // eine Uebersteuerung ungueltig.
                //
                // **Die Ausgabe-Wahl versorgt sich selbst.** Vorher hing sie
                // daran, dass anderswo schon eine Session eingerichtet war —
                // war sie es nicht, lief der Zweig ins Leere, und `try?`
                // verschluckte das. Am 2026-10-10 gemessen: nach dem Tippen
                // stand im Geraetelog NULL mal `overrideOutputAudioPort`.
                //
                // `overrideOutputAudioPort` verlangt beides: die passende
                // Kategorie UND eine aktive Session. Ohne Hardware-Wuensche,
                // die gehoeren vor das Aktivieren und nicht in den Betrieb.
                _ = try? voiceEinrichten(session, hqFunk: letzterHqFunk, mitWuenschen: false)
                try? session.setActive(true)
                // Kein `try?`: scheitert gerade DIE Uebersteuerung, um die es
                // hier geht, soll der Rufer es erfahren.
                try session.overrideOutputAudioPort(
                    ausgabewunsch == .lautsprecher ? .speaker : .none
                )
                // **Ins Geraetelog, nicht nur ins Promise.** Die Web-Konsole
                // ist am Telefon nur ueber Kabel und Safari erreichbar; der
                // System-Log dagegen laesst sich mitlesen. Ohne diese Zeile
                // war am 2026-10-10 nicht entscheidbar, ob die Uebersteuerung
                // ankommt — `overrideOutputAudioPort` selbst protokolliert iOS
                // nirgends.
                NSLog("[PulseTon] Ausgabe '%@' gesetzt, erreicht: %@", id,
                      session.currentRoute.outputs.first?.portType.rawValue ?? "(keiner)")
            default:
                guard let eingang = (session.availableInputs ?? []).first(where: { $0.uid == id })
                else {
                    // Gerät inzwischen weg (Headset abgezogen): kein Fehler,
                    // sondern ein Zustand. Die Oberfläche holt die Liste neu.
                    call.reject("geraet_weg")
                    return
                }
                // Übersteuerung ZUERST zurücknehmen: ein stehengebliebenes
                // `.speaker` schlägt jede Eingangswahl und das Headset bliebe
                // stumm, obwohl es gewählt ist.
                try session.overrideOutputAudioPort(.none)
                ausgabewunsch = .offen
                try session.setPreferredInput(eingang)
            }
            // **Den erreichten Ausgang zurueckgeben, nicht nur „ok".** Vorher
            // sahen Erfolg und Wirkungslosigkeit auf der Web-Seite identisch
            // aus — genau daran scheiterte die Fehlersuche am 2026-10-10.
            call.resolve([
                "aktuell": session.currentRoute.outputs.first?.portType.rawValue ?? "",
                "aktuellName": session.currentRoute.outputs.first?.portName ?? ""
            ])
        } catch {
            call.reject("audio_session_error", nil, error)
        }
    }
}
