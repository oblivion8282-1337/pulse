import Capacitor
import MediaPlayer

/// Sperrbildschirm- und Kontrollzentrum-Anzeige des Audio-Session-Plugins
/// (Roadmap-Punkt 25) — ausgezogen aus `AudioSessionPlugin.swift`.
///
/// **Warum eine eigene Datei.** Die Hauptdatei stand am 2026-10-10 bei genau
/// 500 Zeilen, der harten Grenze der Groessen-Policy (`PLAN.md` §12.1), und
/// brauchte Platz fuer die Messung am Tonweg. Geschnitten wurde an der
/// Stelle, die inhaltlich ohnehin fuer sich steht: was hier liegt, spricht
/// `MPNowPlayingInfoCenter`/`MPRemoteCommandCenter` und fasst die
/// `AVAudioSession` nicht an.
///
/// Die Methoden bleiben `@objc` und in der Methodenliste der Hauptklasse —
/// Capacitor loest sie ueber den Selektor auf, und der findet auch eine
/// Erweiterung.
extension AudioSessionPlugin {
    // MARK: - Sperrbildschirm und Kontrollzentrum (Punkt 25)

    /// Was gerade läuft, auf dem Sperrbildschirm und im Kontrollzentrum
    /// anzeigen — plus die beiden Knöpfe, die dort etwas bewirken können.
    ///
    /// **Was „Pause" bei einem Live-Strom heisst, ist eine Entscheidung.**
    /// Anhalten kann man ihn nicht (er läuft weiter, man verpasst nur), und
    /// Beenden wäre von einem Sperrbildschirm aus zu grob — ein Fehlgriff
    /// risse die Übertragung weg. Hier bedeutet Pause deshalb STUMM, und
    /// Wiedergabe wieder laut. Das ist nicht-zerstörend, sofort umkehrbar und
    /// genau das, was man will, wenn jemand den Raum betritt.
    ///
    /// Mindestens ein aktiver Befehl ist nötig, damit iOS die Anzeige
    /// überhaupt zeigt — eine reine Info-Karte ohne Knöpfe blendet es aus.
    @objc func jetztLaeuft(_ call: CAPPluginCall) {
        let titel = call.getString("titel") ?? "Pulse"
        let zeile2 = call.getString("zeile2") ?? ""
        DispatchQueue.main.async {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = [
                MPMediaItemPropertyTitle: titel,
                MPMediaItemPropertyArtist: zeile2,
                // Live: iOS zeigt dann keinen Fortschrittsbalken, der bei
                // einem laufenden Strom ohnehin nichts bedeutete.
                MPNowPlayingInfoPropertyIsLiveStream: true
            ]
            MPNowPlayingInfoCenter.default().playbackState = .playing
            self.befehleVerdrahten()
            call.resolve()
        }
    }

    @objc func jetztLaeuftAus(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            MPNowPlayingInfoCenter.default().playbackState = .stopped
            call.resolve()
        }
    }

    /// Einmal verdrahten, nicht bei jedem Strom: `addTarget` hängt JEDES Mal
    /// einen weiteren Empfänger an, und dann feuert ein Tastendruck mehrfach.
    private func befehleVerdrahten() {
        guard !befehleStehen else { return }
        befehleStehen = true
        let z = MPRemoteCommandCenter.shared()
        z.playCommand.isEnabled = true
        z.pauseCommand.isEnabled = true
        z.playCommand.addTarget { [weak self] _ in
            self?.notifyListeners("fernbefehl", data: ["befehl": "laut"])
            MPNowPlayingInfoCenter.default().playbackState = .playing
            return .success
        }
        z.pauseCommand.addTarget { [weak self] _ in
            self?.notifyListeners("fernbefehl", data: ["befehl": "stumm"])
            MPNowPlayingInfoCenter.default().playbackState = .paused
            return .success
        }
        // Titelsprünge gibt es hier nicht — ohne das Abschalten zeigt iOS
        // Knöpfe, die nichts tun.
        z.nextTrackCommand.isEnabled = false
        z.previousTrackCommand.isEnabled = false
        z.changePlaybackPositionCommand.isEnabled = false
    }
}
