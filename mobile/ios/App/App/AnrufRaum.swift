import AVFoundation
import LiveKit

/// Der native LiveKit-Raum eines Direktanrufs (Etappe 4 des Entwurfs
/// `docs/superpowers/specs/2026-10-10-ios-nativer-sprachweg-design.md`).
///
/// **Warum es ihn gibt.** Bis zum 2026-10-11 lief ein Anruf auf iOS über
/// WebKit — mit denselben zwei Fehlern, derentwegen der Sprachkanal nativ
/// wurde: keine Hörmuschel, und mehr als eine Partei an der Audio-Session
/// (hier sogar drei, CallKit kam dazu). Eigentümer-Entscheid: beides nativ.
///
/// **Ein zweiter `Room` neben dem des Kanals — aber EINE Audio-Maschine.**
/// Das SDK führt einen einzigen `AudioManager` je Prozess, und beide Räume
/// spielen über ihn ab und nehmen über ihn auf. Wer die Session führt, ist
/// deshalb keine Frage des Raums; das entscheidet `AnrufSitzung.swift`.
///
/// **Die Anmeldung bleibt im Web**, wie beim Kanal: Token und E2EE-Schlüssel
/// holt die Oberfläche und reicht sie herüber (`raumBeitreten`).
///
/// **Verschlüsselung: HKDF, nicht PBKDF2.** Das Web setzt den Anruf-Schlüssel
/// als ROHE 32 Bytes (`ExternalE2EEKeyProvider.setKey(ArrayBuffer)`), und
/// livekit-client leitet daraus per HKDF ab (`createKeyMaterialFromBuffer`,
/// 2.18.9). Das Swift-SDK leitet von sich aus per PBKDF2 ab und hätte damit
/// einen anderen Schlüssel — beide Seiten hörten nur Rauschen. Deshalb hier
/// `keyDerivationAlgorithm: .hkdf` und `setKey(keyData:)` mit denselben Bytes
/// (Doc-Kommentar des SDK 2.17.0: „HKDF — required for interop with peers that
/// derive keys via HKDF"). Salz, Fenster und Ringgrösse sind auf beiden Seiten
/// die Vorgaben (`LKFrameEncryptionKey`, 0, 16). **Am Quelltext beider SDKs
/// geprüft, nicht gemessen** — ob ein iPhone und ein Rechner einander hören,
/// zeigt erst ein echter Anruf (`e2ee` im Zustand meldet einen Fehlschlag).
///
/// Delegat-Rufe kommen von LiveKits Fäden; alles, was die Anrufverwaltung
/// anfasst, geht auf den Hauptthread (dort lebt CallKit). Die übrigen Felder
/// sind kleine Werte wie in `SpracheRaum` — daher `@unchecked Sendable`.
final class AnrufRaum: NSObject, @unchecked Sendable {
    static let geteilt = AnrufRaum()

    /// Meldet ein Ereignis an die Brücke. Wird vom Plugin gesetzt.
    var melde: ((String, [String: Any]) -> Void)?

    private(set) var raum: Room?
    /// Die Anruf-Kennung (Snowflake), zu der der Raum gehört.
    private(set) var kennung: String?
    /// Was das Web über den Anruf weiss (Art, Kanal, Rolle, Gegenstelle).
    /// Reist im Zustand zurück: eine neu geladene Oberfläche kennt den Anruf
    /// sonst nicht — er läuft nativ weiter, das Overlay wäre weg.
    private(set) var kontext: [String: String] = [:]
    private(set) var verbundenSeit: Date?
    private(set) var verschluesselt = false
    private(set) var e2eeZustand = ""
    private(set) var mikrofonFehler: String?
    /// **Am Ohr ist im Anruf der Normalfall** (Eigentümer-Entscheid) — anders
    /// als im Kanal, wo das SDK den Lautsprecher vorgibt.
    private(set) var lautsprecher = false
    /// War die Gegenseite schon einmal im Raum? Erst danach heisst ein leerer
    /// Raum „sie hat aufgelegt" (s. `alleinGelassen`).
    private var gegenseiteGesehen = false
    /// Nur auf dem Hauptthread anfassen (`alleinGelassen`).
    private var alleinUhr: DispatchWorkItem?
    private var routenBeobachter: NSObjectProtocol?
    private let kette = Befehlskette()

    enum Fehler: LocalizedError {
        case ueberholt
        var errorDescription: String? { "anruf_beitritt_ueberholt" }
    }

    /// Wie `SpracheRaum.nacheinander`, Begründung dort.
    func nacheinander<T>(_ arbeit: @escaping () async throws -> T) async throws -> T {
        try await kette.nacheinander(arbeit)
    }

    // MARK: - Beitreten und Verlassen

    func beitreten(kennung neu: String, wsUrl: String, token: String, schluessel: Data?,
                   stumm: Bool, kontext neuerKontext: [String: String]) async throws {
        // Derselbe Anruf zweimal (Web neu verbunden, Doppel-Tipp): der Raum
        // steht schon — nichts tun ist richtig, ein zweiter Raum wäre ein
        // zweites offenes Mikrofon.
        if raum != nil, kennung == neu { return }
        await verlassen()
        beobachtenFallsNoetig()
        var optionen = RoomOptions()
        if let schluessel {
            let anbieter = BaseKeyProvider(
                options: KeyProviderOptions(sharedKey: true, keyDerivationAlgorithm: .hkdf))
            anbieter.setKey(keyData: schluessel)
            optionen = RoomOptions(encryptionOptions: EncryptionOptions(keyProvider: anbieter))
        }
        let r = Room(delegate: self, roomOptions: optionen)
        raum = r
        kennung = neu
        kontext = neuerKontext
        verbundenSeit = nil
        verschluesselt = schluessel != nil
        e2eeZustand = ""
        mikrofonFehler = nil
        gegenseiteGesehen = false
        do {
            try await r.connect(url: wsUrl, token: token)
        } catch {
            loesen(r)
            throw error
        }
        guard raum === r else {
            await r.disconnect()
            throw Fehler.ueberholt
        }
        // Erlaubnis VOR dem Veröffentlichen: führt CallKit, ist die
        // Audio-Maschine noch gesperrt, und das SDK fragt dann selbst nicht
        // (`LocalAudioTrack.startCapture`). Die Sperre hebt erst
        // `didActivate` — ohne Erlaubnis dort nur für die Ausgabe.
        await Anrufverwaltung.mikrofonErlaubnisHolen()
        do {
            try await r.localParticipant.setMicrophone(enabled: true)
            if stumm { try await stummSchalten(true) }
        } catch {
            // Wie im Kanal: ohne Mikrofon kann man zuhören, also bleibt der
            // Raum stehen — aber es muss sichtbar sein.
            mikrofonFehler = error.localizedDescription
            NSLog("[PulseAnruf] Mikrofon gescheitert: %@", error.localizedDescription)
        }
        gegenseiteGesehen = !r.remoteParticipants.isEmpty
        schicke()
    }

    /// Den Raum trennen. Ohne `nur`: was gerade läuft.
    func verlassen(nur gemeint: String? = nil) async {
        guard let r = raum else { return }
        if let gemeint, gemeint != kennung { return }
        loesen(r)
        await r.disconnect()
    }

    private func loesen(_ r: Room) {
        guard raum === r else { return }
        raum = nil
        kennung = nil
        kontext = [:]
        verbundenSeit = nil
        // Die Uhr selbst prüft `raum === r` — sie liefe ins Leere. Abgeräumt
        // wird sie trotzdem, auf ihrem Faden, damit der nächste Anruf eine
        // eigene bekommt.
        DispatchQueue.main.async { self.nichtMehrAllein() }
    }

    // MARK: - Befehle

    func mikrofon(_ an: Bool) async throws {
        try await stummSchalten(!an)
        schicke()
    }

    /// Vom Stummschalter im CallKit-Bildschirm. Ein Fehlschlag wird gemeldet,
    /// nicht geworfen — CallKit wartet auf keine Antwort.
    func mikrofonVonCallKit(stumm: Bool) {
        Task {
            try? await nacheinander { try await self.stummSchalten(stumm) }
            self.schicke()
        }
    }

    func kamera(_ an: Bool) async throws {
        guard let r = raum else { return }
        if an {
            try await r.localParticipant.setCamera(enabled: true)
        } else if let pub = r.localParticipant.firstCameraPublication as? LocalTrackPublication {
            // Zurücknehmen statt stummschalten — Begründung an `SpracheRaum.kamera`.
            try await r.localParticipant.unpublish(publication: pub)
        }
        let gemeint = kennung
        DispatchQueue.main.async { Anrufverwaltung.geteilt.videoMelden(kennung: gemeint, an: an) }
        schicke()
    }

    /// Stummschalten, ohne die Spur aufzuheben — dieselbe Mechanik wie im
    /// Kanal (`SpracheRaum.stummSchalten`; Begründung an
    /// `SpracheRaum.beitreten`: ohne Aufnahme keine Hörmuschel).
    private func stummSchalten(_ stumm: Bool) async throws {
        guard let r = raum else { return }
        try await SpracheRaum.stummSchalten(stumm, in: r)
    }

    /// Hörmuschel oder Lautsprecher. **Der zweite Weg** (Entwurf §6): führt
    /// CallKit, ist `isSpeakerOutputPreferred` wirkungslos — der Doc-Kommentar
    /// des SDK sagt es, der Wert wird nur bei automatischer Konfiguration
    /// gelesen. Dann stellt die Hülle die Route selbst (`AnrufSitzung.swift`).
    /// Der Wunsch des KANALS bleibt dabei unberührt und gilt nach dem Anruf.
    /// Nur auf dem Hauptthread.
    func ausgabe(lautsprecher an: Bool) {
        lautsprecher = an
        Anrufverwaltung.geteilt.ausgabeAnwenden(lautsprecher: an)
        schicke()
    }

    // MARK: - Zustand

    func zustand() -> [String: Any] {
        return [
            "kennung": kennung ?? "",
            "zustand": raum.map { SpracheRaum.verbindungsName($0.connectionState) } ?? "disconnected",
            // Millisekunden seit 1970, wie `Date.now()` im Web — der Ticker
            // der Gesprächsdauer läuft nach einem Reload von hier weiter.
            "seit": verbundenSeit.map { $0.timeIntervalSince1970 * 1000 } ?? NSNull(),
            "mikro": raum?.localParticipant.isMicrophoneEnabled() ?? false,
            "kamera": raum?.localParticipant.isCameraEnabled() ?? false,
            "lautsprecher": lautsprecher,
            "route": Anrufverwaltung.routeJetzt(),
            "verschluesselt": verschluesselt,
            "e2ee": e2eeZustand,
            "mikrofonFehler": mikrofonFehler ?? NSNull(),
            "callkit": Anrufverwaltung.geteilt.callkitAktiv,
            "kontext": kontext
        ]
    }

    func schicke() {
        melde?("anrufRaum", zustand())
    }

    /// Lautsprecher-Taste im CallKit-Bildschirm, AirPods, Kabel: die Route
    /// ändert sich ohne uns. Der Merker folgt der WIRKLICHEN Route, sonst
    /// zeigte der Knopf im Web das Gegenteil von dem, was man hört.
    private func beobachtenFallsNoetig() {
        guard routenBeobachter == nil else { return }
        routenBeobachter = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self, raum != nil, Anrufverwaltung.geteilt.sessionAktiv else { return }
            let ausgang = AVAudioSession.sharedInstance().currentRoute.outputs.first?.portType
            lautsprecher = ausgang == .builtInSpeaker
            schicke()
        }
    }

    // MARK: - Allein im Raum

    /// **Die Gegenseite hat aufgelegt, und die Oberfläche hat es vielleicht
    /// nicht gehört.** Das Ende kommt über die WebSocket (`call_ende`) — ist
    /// das JS eingefroren, bleibt der CallKit-Anruf stehen, mit niemandem
    /// darin. Einen Abbruch-Push bekommt das annehmende Gerät bewusst nicht
    /// (`anruf_push.py`, Begründung dort). Deshalb schliesst die Hülle ein
    /// Zweiergespräch selbst, wenn die Gegenseite gegangen ist und nicht
    /// zurückkommt — 20 s, damit ein kurzer Netzabriss drüben kein Auflegen
    /// ist. Gruppenanrufe nicht: dort ist ein leerer Raum kein Ende.
    private func alleinGelassen(_ r: Room) {
        guard r === raum, kontext["art"] == "dm", gegenseiteGesehen,
              r.remoteParticipants.isEmpty, alleinUhr == nil else { return }
        let gemeint = kennung
        let uhr = DispatchWorkItem { [weak self] in
            guard let self else { return }
            alleinUhr = nil
            guard raum === r, kennung == gemeint, r.remoteParticipants.isEmpty,
                  let gemeint else { return }
            NSLog("[PulseAnruf] Gegenseite seit 20 s weg — die Hülle legt auf")
            Anrufverwaltung.geteilt.vonDerHuelleBeendet(kennung: gemeint, aktion: "auflegen")
        }
        alleinUhr = uhr
        DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: uhr)
    }

    private func nichtMehrAllein() {
        alleinUhr?.cancel()
        alleinUhr = nil
    }
}

// MARK: - RoomDelegate

extension AnrufRaum: RoomDelegate {
    func room(_ room: Room, didUpdateConnectionState state: ConnectionState,
              from alt: ConnectionState) {
        guard room === raum else { return }
        NSLog("[PulseAnruf] Verbindung %@ → %@",
              SpracheRaum.verbindungsName(alt), SpracheRaum.verbindungsName(state))
        if state == .connected, verbundenSeit == nil {
            verbundenSeit = Date()
            let gemeint = kennung
            DispatchQueue.main.async { Anrufverwaltung.geteilt.verbunden(kennung: gemeint) }
        }
        schicke()
    }

    /// Von aussen getrennt (Netz endgültig weg, Server, Rauswurf): der Anruf
    /// ist vorbei. Die Hülle räumt ab und sagt es dem Web AUFBEWAHRT
    /// (`getrennt`) — eine eingefrorene Oberfläche stünde sonst nach dem
    /// Aufwachen in einem Gespräch, das es nicht mehr gibt.
    func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        guard room === raum, let gemeint = kennung else { return }
        NSLog("[PulseAnruf] getrennt: %@", error?.localizedDescription ?? "ohne Fehler")
        loesen(room)
        DispatchQueue.main.async {
            Anrufverwaltung.geteilt.vonDerHuelleBeendet(kennung: gemeint, aktion: "getrennt")
        }
        schicke()
    }

    func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        guard room === raum else { return }
        gegenseiteGesehen = true
        DispatchQueue.main.async { self.nichtMehrAllein() }
        schicke()
    }

    func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        guard room === raum else { return }
        DispatchQueue.main.async { self.alleinGelassen(room) }
        schicke()
    }

    func room(_ room: Room, participant: Participant, trackPublication: TrackPublication,
              didUpdateIsMuted isMuted: Bool) {
        guard room === raum, participant is LocalParticipant else { return }
        schicke()
    }

    /// **Die Zeile, an der man die Verschlüsselung am Gerät prüft.** Ein
    /// `decryption_failed` heisst: die beiden Seiten leiten verschiedene
    /// Schlüssel ab (s. Klassenkommentar) — hörbar wäre es nur als Stille.
    func room(_ room: Room, trackPublication: TrackPublication, didUpdateE2EEState state: E2EEState) {
        guard room === raum else { return }
        e2eeZustand = "\(state)"
        NSLog("[PulseAnruf] E2EE %@: %@", trackPublication.sid.stringValue, e2eeZustand)
        schicke()
    }
}
