import LiveKit

/// Was die Oberfläche hören will. Die Lautstärke JEDER fremden Tonspur ergibt
/// sich daraus und aus `taub` — sie wird ausgerechnet, nicht gemerkt.
struct Hoerwunsch {
    /// Faktor je Nutzer-Id (die nackte Snowflake, wie `settings.voice.userVolumes`
    /// im Web). Fehlt ein Eintrag, gilt 1.
    var je: [String: Double] = [:]
    /// Gesamtlautstärke (`settings.voice.outputVolume`).
    var gesamt: Double = 1
}

/// Die Mechanik hinter Taubstellen und Lautstärken: die `volume` der fremden
/// Tonspuren.
///
/// **Ausgerechnet statt gemerkt — und das ist die Behebung, nicht ein
/// Umbau.** Bis zum 2026-10-11 merkte sich das Taubstellen den alten Wert
/// jeder Spur und stellte ihn beim Zurücknehmen wieder her. Wurde dazwischen
/// der Merker umgedreht, ohne die Spuren mitzuziehen (der Beitritt tat genau
/// das), blieben Spuren auf 0 stehen — man hörte niemanden, und nichts zeigte
/// es an (Bughunt 2026-10-11, E1). Jetzt hat jede Spur EINEN richtigen Wert,
/// und jeder Anlass (Taub, Regler, neue Spur) setzt ihn neu. Einen falschen
/// Zwischenstand, der hängen bleiben könnte, gibt es nicht mehr.
///
/// **Die Lautstärke je Teilnehmer gab es nativ bis dahin gar nicht** (M4):
/// die Regler gingen an `<audio>`-Elemente, die es auf diesem Weg nicht gibt.
///
/// Alles, was `hoerwunsch` oder eine `volume`-Eigenschaft anfasst, läuft über
/// `tonFaden` — beides ist hier serialisiert.
extension SpracheRaum {
    /// **Gedeckelt bei 1, wie der Mobil-Web-Weg** (`audioElements.ts`,
    /// `#elementVolume`): das SDK erlaubte bis 10, aber ohne den Begrenzer, den
    /// der Rechner-Weg dahinter schaltet, wäre jede Verstärkung ungeschützt
    /// gegen Übersteuern — und der Regler am Telefon geht ohnehin nur bis
    /// 100 % (`VoiceUserVolumeControl.svelte`).
    static func wirksameLautstaerke(taub: Bool, nutzer: Double?, gesamt: Double) -> Double {
        if taub { return 0 }
        return min(max((nutzer ?? 1) * gesamt, 0), 1)
    }

    /// Neuen Wunsch übernehmen und auf alle Spuren anwenden. `nil` lässt den
    /// bisherigen Teil stehen — eine ältere Oberfläche schickt nichts mit.
    func hoerwunschSetzen(je: [String: Double]?, gesamt: Double?) async {
        await aufTonFaden { [weak self] in
            guard let self else { return }
            if let je { hoerwunsch.je = je }
            if let gesamt { hoerwunsch.gesamt = gesamt }
            alleSpurenStellen()
        }
    }

    /// Nach einer Änderung von `taub`.
    func lautstaerkenAnwenden() async {
        await aufTonFaden { [weak self] in self?.alleSpurenStellen() }
    }

    /// Eine neu abonnierte Spur sofort richtig stellen. **Der Befehl allein
    /// genügt nicht:** wer beitritt, WÄHREND man taub ist, wäre sonst genau
    /// der eine, den man hört — der Befehl hat seine Spur nie gesehen.
    func spurStellen(_ spur: RemoteAudioTrack, kennung: String) {
        Task { await aufTonFaden { [weak self] in self?.stellen(spur, kennung: kennung) } }
    }

    /// **Diagnose, und eine, ohne die der Taub-Zustand nicht prüfbar wäre.**
    /// Ob es gewirkt hat, steht nicht in einem Merker, sondern an den Spuren.
    /// Liest `volume` und blockiert deshalb — läuft über `tonFaden`.
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

    /// Nur auf `tonFaden`.
    private func alleSpurenStellen() {
        guard let r = raum else { return }
        for p in r.remoteParticipants.values {
            let kennung = p.identity?.stringValue ?? ""
            for pub in p.audioTracks {
                if let spur = pub.track as? RemoteAudioTrack { stellen(spur, kennung: kennung) }
            }
        }
    }

    /// Nur auf `tonFaden`. `taub` wird hier gelesen, nicht mitgegeben: der
    /// Befehl setzt es, BEVOR er diese Arbeit einreiht, also liegt hier immer
    /// der neueste Stand an.
    private func stellen(_ spur: RemoteAudioTrack, kennung: String) {
        let nutzer = Self.nutzerId(aus: kennung).flatMap { hoerwunsch.je[$0] }
        spur.volume = Self.wirksameLautstaerke(taub: taub, nutzer: nutzer,
                                               gesamt: hoerwunsch.gesamt)
    }

    /// **Lesen und Schreiben von `volume` BLOCKIERT den rufenden Faden**, bis
    /// WebRTCs Signalisierungs-Faden es angewandt hat (Doc-Kommentar des SDK,
    /// `RemoteAudioTrack.volume`). Deshalb ein eigener Faden — und ein
    /// `withCheckedContinuation` statt eines `sync`: der Rufer WARTET, aber er
    /// blockiert dabei nichts. Der Rufer kann Capacitors Brücke sein, und die
    /// ist EINE serielle Warteschlange für alle Plugins.
    func aufTonFaden(_ arbeit: @escaping () -> Void) async {
        await withCheckedContinuation { fortsetzen in
            tonFaden.async {
                arbeit()
                fortsetzen.resume()
            }
        }
    }
}
