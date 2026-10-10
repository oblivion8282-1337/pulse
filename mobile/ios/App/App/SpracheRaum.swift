import AVFoundation
import LiveKit

/// Der native LiveKit-Raum für Sprachkanäle und Anrufe auf iOS.
///
/// **Warum es ihn gibt.** Auf iOS gehört die Audio-Session, die den Sprachton
/// wirklich abspielt, WebKits eigenem Prozess — sie fordert `DefaultToSpeaker`
/// und ist nicht mischbar. Die Hörmuschel ist damit aus dem Web heraus
/// unerreichbar, und jedes Drehen an unserer eigenen Session unterbricht nur
/// WebKit (beides am 2026-10-10 am Gerät gemessen, voller Befund im Entwurf
/// `docs/superpowers/specs/2026-10-10-ios-nativer-sprachweg-design.md`).
/// Sobald der Raum hier liegt, gibt es nur noch EINE Partei an der Session.
///
/// **Die Anmeldung bleibt im Web.** Diese Klasse bekommt `wsUrl` und `token`
/// gereicht und kennt weder Konten noch Sitzungen — der Teil, der sonst in
/// zwei Sprachen doppelt gepflegt werden müsste.
///
/// Zustand geht als Ereignis nach oben, nie als Abfrage im Takt: Capacitors
/// Brücke ist EINE serielle Warteschlange, und ihre Verstopfung hat am selben
/// Tag die App einfrieren lassen. Pegel bleiben deshalb hier.
final class SpracheRaum: NSObject {
    static let geteilt = SpracheRaum()

    /// Meldet ein Ereignis an die Brücke. Wird vom Plugin gesetzt.
    var melde: ((String, [String: Any]) -> Void)?

    private var raum: Room?
    private(set) var kanalId: String?

    // MARK: - Steuerung

    func beitreten(wsUrl: String, token: String, kanalId: String, stumm: Bool) async throws {
        await verlassen()
        let r = Room(delegate: self)
        raum = r
        self.kanalId = kanalId
        try await r.connect(url: wsUrl, token: token)
        // **Erst verbinden, dann veröffentlichen.** LiveKit verlangt eine
        // eingerichtete und aktive Session, bevor ein Mikrofon publiziert
        // wird; das SDK richtet sie beim Verbinden ein. Dieselbe
        // Reihenfolge-Regel wie im Web — dort hat ihre Verletzung zwei
        // Mikrofon-Fehler gekostet.
        //
        // **Die Spur wird IMMER veröffentlicht, auch wenn stumm gestartet
        // wird** — und das ist kein Detail, sondern die Bedingung dafür, dass
        // die Hörmuschel überhaupt wählbar ist. Das SDK wählt die Kategorie
        // nach dem Zustand der Audio-Maschine: ohne Aufnahme `.playback`, und
        // dort gibt es keine Hörmuschel. Wer stumm schaltet, indem er die
        // Spur aufhebt, schickt die Ausgabe zurück auf den Lautsprecher.
        // Am 2026-10-10 genau so erlebt. Der Web-Weg macht es seit jeher
        // richtig (`stopMicTrackOnMute` ist aus).
        try await r.localParticipant.setMicrophone(enabled: true)
        if stumm { try await stummSchalten(true) }
        schickeTeilnehmer()
        schickeEigenen()
    }

    func verlassen() async {
        guard let r = raum else { return }
        raum = nil
        kanalId = nil
        await r.disconnect()
    }

    func mikrofon(_ an: Bool) async throws {
        try await stummSchalten(!an)
        schickeEigenen()
    }

    /// Stummschalten, ohne die Spur aufzuheben — s. Begründung in `beitreten`.
    /// Gibt es noch keine Spur (Beitritt noch nicht durch), wird sie angelegt.
    private func stummSchalten(_ stumm: Bool) async throws {
        guard let r = raum else { return }
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

    /// Lautsprecher oder Hörmuschel.
    ///
    /// **Der Schalter, um den es beim ganzen Umbau geht.** Doc-Kommentar des
    /// SDK wörtlich: „Determines whether the device's built-in speaker or
    /// receiver is preferred for audio output. Defaults to `true` … Set to
    /// `false` if the receiver is preferred instead of the speaker."
    ///
    /// **Er gilt NICHT, wenn CallKit führt.** Derselbe Doc-Kommentar sagt, die
    /// Eigenschaft werde ignoriert, sobald die Session-Konfiguration des SDK
    /// abgeschaltet ist — und genau das verlangt CallKit. Dort stellt die
    /// Hülle die Route selbst (`AudioSessionAusgabe.swift`), was dann auch
    /// wirklich wirkt: es scheiterte bisher allein daran, dass WebKit eine
    /// zweite Session hielt. Welcher Weg gilt, entscheidet eine einzige
    /// Frage, und `Anrufverwaltung` beantwortet sie schon heute.
    func ausgabe(_ weg: String) {
        AudioManager.shared.isSpeakerOutputPreferred = (weg != "hoermuschel")
        NSLog("[PulseSprache] Ausgabe '%@' gewuenscht, Route: %@", weg, routeJetzt())
        schickeEigenen()
    }

    // MARK: - Zustand

    func zustand() -> [String: Any] {
        [
            "verbunden": raum?.connectionState == .connected,
            "kanalId": kanalId ?? "",
            "teilnehmer": teilnehmerListe(),
            "mikro": raum?.localParticipant.isMicrophoneEnabled() ?? false,
            "lautsprecher": AudioManager.shared.isSpeakerOutputPreferred,
            "route": routeJetzt()
        ]
    }

    /// Was die Session gerade WIRKLICH ausgibt — nicht, was gewünscht ist.
    /// Der Unterschied war am 2026-10-10 der ganze Befund.
    private func routeJetzt() -> String {
        AVAudioSession.sharedInstance().currentRoute.outputs.first?.portType.rawValue ?? "(keiner)"
    }

    private func teilnehmerListe() -> [[String: Any]] {
        guard let r = raum else { return [] }
        var liste = [abbilden(r.localParticipant, lokal: true)]
        liste.append(contentsOf: r.remoteParticipants.values.map { abbilden($0, lokal: false) })
        return liste
    }

    /// Abbildung auf die Form, die der Web-Store schon kennt
    /// (`VoiceParticipant` in `voice/livekit.svelte.ts`) — damit die 31
    /// Dateien, die ihn benutzen, unverändert bleiben.
    private func abbilden(_ p: Participant, lokal: Bool) -> [String: Any] {
        let kennung = p.identity?.stringValue ?? ""
        return [
            "identity": kennung,
            "name": p.name ?? kennung,
            // `user-<snowflake>` → die nackte Id, wie im Web.
            "userId": kennung.hasPrefix("user-") ? String(kennung.dropFirst(5)) : NSNull(),
            "isLocal": lokal,
            "isSpeaking": p.isSpeaking,
            "audioLevel": Double(p.audioLevel),
            "micMuted": !p.isMicrophoneEnabled(),
            "cameraOn": p.isCameraEnabled(),
            "connectionQuality": guete(p.connectionQuality)
        ]
    }

    private func guete(_ q: ConnectionQuality) -> String {
        switch q {
        case .excellent: return "excellent"
        case .good: return "good"
        case .poor: return "poor"
        case .lost: return "lost"
        default: return "unknown"
        }
    }

    private func schickeTeilnehmer() {
        melde?("teilnehmer", ["liste": teilnehmerListe()])
    }

    private func schickeEigenen() {
        melde?("eigenerZustand", [
            "mikro": raum?.localParticipant.isMicrophoneEnabled() ?? false,
            "lautsprecher": AudioManager.shared.isSpeakerOutputPreferred,
            "route": routeJetzt()
        ])
    }
}

// MARK: - RoomDelegate

/// **Die Rufe kommen NICHT vom Hauptthread** (so sagt es LiveKits eigene
/// Dokumentation). Hier wird deshalb nur Zustand eingesammelt und über die
/// Brücke geschickt; wer später Ansichten anfasst, muss selbst auf den
/// Hauptthread wechseln.
extension SpracheRaum: RoomDelegate {
    func room(_ room: Room, didUpdateConnectionState state: ConnectionState,
              from alt: ConnectionState) {
        NSLog("[PulseSprache] Verbindung %@ → %@", "\(alt)", "\(state)")
        melde?("verbindung", ["zustand": "\(state)"])
        if state == .connected { schickeTeilnehmer() }
    }

    func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        NSLog("[PulseSprache] getrennt: %@", error?.localizedDescription ?? "ohne Fehler")
        melde?("verbindung", ["zustand": "disconnected",
                              "fehler": error?.localizedDescription ?? NSNull()])
    }

    func room(_ room: Room, didFailToConnectWithError error: LiveKitError?) {
        NSLog("[PulseSprache] Verbinden fehlgeschlagen: %@",
              error?.localizedDescription ?? "unbekannt")
        melde?("verbindung", ["zustand": "disconnected",
                              "fehler": error?.localizedDescription ?? "unbekannt"])
    }

    func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        schickeTeilnehmer()
    }

    func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        schickeTeilnehmer()
    }

    /// **Nur die Kippkante, nicht der Pegel.** Der Pegel ändert sich 10–20 mal
    /// pro Sekunde je Teilnehmer; über eine serielle Brücke geschickt wäre das
    /// genau die Last, die am 2026-10-10 die App angehalten hat. Wer ihn
    /// braucht, zeichnet ihn nativ.
    func room(_ room: Room, didUpdateSpeakingParticipants participants: [Participant]) {
        melde?("sprechen", [
            "sprechen": participants.compactMap { $0.identity?.stringValue }
        ])
    }
}
