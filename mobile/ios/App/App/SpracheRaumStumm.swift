import Foundation
import LiveKit

/// Mikrofon, Taubstellen — und die Pause, in die ein Direktanruf den Kanal
/// schickt.
///
/// **Ein Anruf gewinnt gegen den Sprachkanal** (Eigentümer-Entscheid,
/// 2026-10-11; im Entwurf §8 Punkt 2 als offene Frage). Wird ein Anruf
/// angenommen oder begonnen, bleibt der Kanal verbunden, aber er schweigt in
/// beide Richtungen: das Mikrofon im Kanal geht zu, die Spuren der anderen
/// auf 0. Nach dem Auflegen geht es zurück, wie es vorher war.
///
/// **Warum die Pause in der Hülle liegt und nicht im Web.** Ein Anruf wird
/// oft auf dem Sperrbildschirm angenommen, über CallKit, während die
/// Oberfläche eingefroren ist — sie erfährt davon vielleicht erst Minuten
/// später. Der Kanal muss aber in dem Moment schweigen, in dem man abnimmt,
/// sonst hören die Leute im Kanal das Telefonat mit.
///
/// **Was gemeldet wird, ist der WIRKSAME Stand**, nicht der Wunsch:
/// `eigenerZustand` trägt während der Pause `mikro: false`, `taub: true`,
/// dazu `pausiert: true`. Das Web spiegelt es und meldet es dem Gateway —
/// die anderen im Kanal sehen also, dass man weder spricht noch zuhört.
/// Ein Mikrofon- oder Taub-Befehl während der Pause ändert nur den Wunsch,
/// der danach gilt (`mikroWunsch`, `taub`).
///
/// Alles hier läuft über `nacheinander` — die Pause ist ein Befehl wie jeder
/// andere und darf ein laufendes Stummschalten nicht überholen.
extension SpracheRaum {
    /// **Beide Meldungen, und das ist kein Versehen.** `eigenerZustand` stellt
    /// den Knopf, `teilnehmer` die eigene KACHEL — die zeichnet aus
    /// `voice.participants`, und die Liste kommt nur aus dem
    /// `teilnehmer`-Ereignis. Zwei Meldungen mit demselben Inhalt kosten
    /// nichts: jede liest den Live-Zustand.
    func mikrofon(_ an: Bool) async throws {
        mikroWunsch = an
        if let r = raum, !anrufPausiert { try await Self.stummSchalten(!an, in: r) }
        schickeEigenen()
        schickeTeilnehmer()
    }

    // MARK: - Taubstellen

    /// Nicht mehr mithören. Es gibt im SDK kein globales Stummschalten der
    /// Wiedergabe; die Wirkung liegt an den Lautstärken der fremden Spuren
    /// (`SpracheRaumTaub.swift`). **Bis zum 2026-10-10 war dieser Knopf auf
    /// iOS wirkungslos:** der Web-Weg schaltet `<audio>`-Elemente stumm, die
    /// es hier nicht gibt — das Zeichen kippte, gehört wurde weiter alles.
    func taubStellen(_ an: Bool) async {
        taub = an
        await lautstaerkenAnwenden()
        schickeEigenen()
    }

    /// Hört der Nutzer gerade wirklich nichts? Taub ODER angehalten — daran
    /// hängen die Lautstärken (`SpracheRaumTaub.swift`) und die Meldung.
    var wirksamTaub: Bool { taub || anrufPausiert }

    // MARK: - Anruf-Pause

    /// Den Kanal für einen Anruf anhalten oder ihn wieder freigeben. Gerufen
    /// von `Anrufverwaltung` (`AnrufSitzung.swift`), in der Kette.
    ///
    /// Beim Anhalten wird der Mikrofon-Stand GELESEN, nicht angenommen: wer
    /// vor dem Anruf stumm war, bleibt es danach.
    func anrufPause(_ an: Bool) async {
        guard anrufPausiert != an else { return }
        if an, let r = raum { mikroWunsch = r.localParticipant.isMicrophoneEnabled() }
        anrufPausiert = an
        NSLog("[PulseSprache] Anruf-Pause %@ (Mikrofon danach: %@)",
              an ? "an" : "aus", mikroWunsch ? "offen" : "stumm")
        if let r = raum {
            do {
                try await Self.stummSchalten(an || !mikroWunsch, in: r)
            } catch {
                // Laut, aber nicht werfend: die Pause gilt trotzdem (die
                // Lautstärken unten greifen), und ein gescheitertes Stumm
                // beim Wiederaufnehmen ist ein Kanal, der stumm bleibt — der
                // Knopf zeigt das, weil `schickeEigenen` den echten Stand liest.
                NSLog("[PulseSprache] Anruf-Pause: Mikrofon schalten fehlgeschlagen: %@",
                      error.localizedDescription)
            }
        }
        await lautstaerkenAnwenden()
        schickeEigenen()
        schickeTeilnehmer()
    }

    /// Stummschalten, ohne die Spur aufzuheben — s. Begründung in `beitreten`.
    /// Gibt es noch keine Spur, wird sie angelegt.
    ///
    /// **Die Spur, nicht das Gerät.** `mute()` schaltet die Spur DIESES Raums
    /// ab (`Track._mute` → `disable`); ein angenommener Anruf hat seine eigene
    /// Spur im eigenen Raum. Dass das Mikrofon im Anruf trotzdem trägt, hängt
    /// an WebRTCs gemeinsamer Audio-Maschine und ist nur am Gerät zu belegen.
    /// Statisch, weil der Anruf-Raum dieselbe Mechanik braucht (`AnrufRaum`).
    static func stummSchalten(_ stumm: Bool, in r: Room) async throws {
        // Über `audioTracks` statt `getTrackPublication(source:)` — Letzteres
        // ist im SDK `internal`.
        guard let spur = r.localParticipant.audioTracks
            .first(where: { $0.source == .microphone })?.track as? LocalAudioTrack
        else {
            try await r.localParticipant.setMicrophone(enabled: !stumm)
            return
        }
        if stumm { try await spur.mute() } else { try await spur.unmute() }
    }
}
