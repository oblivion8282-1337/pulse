import LiveKit

/// Die Mechanik hinter dem Taubstellen: die Lautstärken der fremden Tonspuren.
///
/// **Warum eine eigene Datei.** Der BEFEHL steht in `SpracheRaum.swift`
/// (`taubStellen`), hier liegt nur, wie er wirkt — und das ist ein eigener
/// Mechanismus mit einer eigenen Invariante: alles, was `lautstaerken` oder
/// eine `volume`-Eigenschaft anfasst, läuft über `tonFaden`. Zusammen mit der
/// Steuerung lag die Datei über der Grössen-Policy (`PLAN.md` §12.1).
///
/// `lautstaerken` und `tonFaden` sind deshalb am Typ und nicht `private`
/// (Swift rechnet `private` DATEI-weit): **sie gehören dieser Datei, auch wenn
/// sie dort nicht deklariert werden können** — Erweiterungen dürfen keine
/// gespeicherten Eigenschaften tragen.
extension SpracheRaum {
    /// Eine neu abonnierte Spur sofort auf 0, solange taubgestellt ist.
    /// **Der Befehl allein genügt nicht:** wer beitritt, WÄHREND man taub ist,
    /// wäre sonst genau der eine, den man hört.
    func taubAufNeueSpur(_ spur: RemoteAudioTrack) {
        guard taub else { return }
        Task { await aufTonFaden { [weak self] in self?.anpassen([spur], taub: true) } }
    }

    func spurVergessen(_ sid: String) {
        Task { await aufTonFaden { [weak self] in self?.lautstaerken.removeValue(forKey: sid) } }
    }

    func lautstaerkenVergessen() {
        Task { await aufTonFaden { [weak self] in self?.lautstaerken.removeAll() } }
    }

    func lautstaerkenAnwenden(_ taub: Bool) {
        guard let r = raum else { return }
        let spuren = r.remoteParticipants.values.flatMap { p in
            p.audioTracks.compactMap { $0.track as? RemoteAudioTrack }
        }
        anpassen(spuren, taub: taub)
    }

    /// **Diagnose, und eine, ohne die der Taub-Zustand nicht prüfbar wäre.**
    /// Ob das Taubstellen gewirkt hat, steht nicht in einem Merker, sondern an
    /// den Spuren — und ein Merker, der behauptet, was er nicht nachsieht, ist
    /// genau die Sorte Beleg, die nichts belegt. Liefert die anliegende
    /// Lautstärke je fremder Tonspur.
    ///
    /// Liest `volume` und blockiert deshalb — läuft über `tonFaden`, nie auf
    /// dem Hauptthread.
    func lautstaerkenLesen() async -> [String: Double] {
        var ergebnis: [String: Double] = [:]
        await aufTonFaden { [weak self] in
            guard let r = self?.raum else { return }
            for p in r.remoteParticipants.values {
                for pub in p.audioTracks {
                    guard let ton = pub.track as? RemoteAudioTrack else { continue }
                    let name = (p.identity?.stringValue ?? "?") + "/" + pub.sid.stringValue
                    ergebnis[name] = ton.volume
                }
            }
        }
        return ergebnis
    }

    /// Läuft ausschliesslich auf `tonFaden` — dort liegt auch `lautstaerken`.
    func anpassen(_ spuren: [RemoteAudioTrack], taub: Bool) {
        for spur in spuren {
            let schluessel = spur.sid?.stringValue ?? ""
            if taub {
                if lautstaerken[schluessel] == nil { lautstaerken[schluessel] = spur.volume }
                spur.volume = 0
            } else if let alt = lautstaerken.removeValue(forKey: schluessel) {
                spur.volume = alt
            }
        }
    }

    /// **Lesen und Schreiben von `volume` BLOCKIERT den rufenden Faden**, bis
    /// WebRTCs Signalisierungs-Faden es angewandt hat (Doc-Kommentar des SDK,
    /// `RemoteAudioTrack.volume`). Deshalb ein eigener Faden — und ein
    /// `withCheckedContinuation` statt eines `sync`: der Rufer WARTET, aber er
    /// blockiert dabei nichts. Das ist hier der Unterschied, auf den es
    /// ankommt, denn der Rufer ist Capacitors Brücke, und die ist EINE
    /// serielle Warteschlange für alle Plugins.
    ///
    /// Der Faden ist zugleich der Schutz für `lautstaerken`: alles, was die
    /// Karte anfasst, läuft hier durch, und sie ist serialisiert.
    func aufTonFaden(_ arbeit: @escaping () -> Void) async {
        await withCheckedContinuation { fortsetzen in
            tonFaden.async {
                arbeit()
                fortsetzen.resume()
            }
        }
    }
}
