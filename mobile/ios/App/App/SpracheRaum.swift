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
/// **Die Erwartung dabei war, dass es dann nur noch EINE Partei an der
/// Session gibt — und die traf nicht zu.** Die Oberfläche spielt weiter ihre
/// eigenen Töne, und WebKit richtet dafür seine eigene, nicht mischbare
/// Session ein: der Beitritts-Ton zog uns die Session weg, und ohne aktive
/// Session bewegt kein `setCategory` eine Route. Dass es trotzdem genau eine
/// Partei ist, muss der Klient erklären — `webSessionTyp` in
/// `web/src/lib/platform/iosSprache.ts`, dort steht die Messung.
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
    private var sessionBeobachter: NSObjectProtocol?

    // MARK: - Steuerung

    func beitreten(wsUrl: String, token: String, kanalId: String, stumm: Bool) async throws {
        await verlassen()
        sessionBeobachtenFallsNoetig()
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
    /// Hülle die Route selbst (`AudioSessionAusgabe.swift`). Welcher Weg gilt,
    /// entscheidet eine einzige Frage, und `Anrufverwaltung` beantwortet sie
    /// schon heute.
    ///
    /// **Für den CallKit-Weg gilt dieselbe Bedingung wie hier**, und sie stand
    /// bis zum 2026-10-10 falsch da: dort hiess es, die eigene Übersteuerung
    /// habe allein an WebKits zweiter Session gescheitert. Gemessen ist etwas
    /// anderes — eine Übersteuerung an einer NICHT AKTIVEN Session wird
    /// angenommen und tut nichts, ganz ohne zweite Partei. Wer die Route
    /// selbst stellt, muss die Session also auch selbst aktiv halten; bei
    /// CallKit tut das der `CXProvider` in `didActivate`.
    func ausgabe(_ weg: String) {
        let hoermuschel = (weg == "hoermuschel")
        AudioManager.shared.isSpeakerOutputPreferred = !hoermuschel
        // **Hier stand bis zum 2026-10-10 ein `overrideOutputAudioPort`, und
        // es war ein Ruf, der gelang und nichts tat.** Gemessen: die
        // Uebersteuerung wurde angenommen (kein Fehler), die Route blieb
        // `Speaker`, und erst ein `setActive(true)` holte sie. Ein zweiter
        // Schreiber an der Session ist er trotzdem — `.speaker` setzt eine
        // klebende Uebersteuerung, die das naechste `setCategory` des SDK
        // ueberschreiben muesste. Die Vorgabe oben genuegt, sobald die Session
        // aktiv ist — und dass sie das bleibt, entscheidet nicht diese Datei,
        // sondern `webSessionTyp` in `web/src/lib/platform/iosSprache.ts`:
        // dort steht, warum WebKit sie sonst an sich zieht.
        //
        // Die Route wird hier NICHT mehr gemeldet: sie wechselt asynchron
        // (8-17 ms nach dem `setCategory`, am Geraet gemessen), ein Lesen an
        // dieser Stelle liefert also systematisch den alten Wert — genau
        // diese Zahl galt stundenlang als Beleg dafuer, dass der Schalter
        // nicht traegt. Wer die Wahrheit will, hoert auf `eigenerZustand`:
        // den schickt der Routen-Beobachter, wenn der Wechsel wirklich da ist.
        NSLog("[PulseSprache] Ausgabe '%@' gewuenscht", weg)
        schickeEigenen()
    }

    /// Horcht auf Routenwechsel UND Unterbrechungen der Session — einmal fuers
    /// ganze Leben des Singletons, nicht je Beitritt (beide haengen am
    /// einen Merker, sie werden zusammen angelegt).
    ///
    /// **Der Routenwechsel ist ASYNCHRON, und das war eine Messfalle.** Am
    /// 2026-10-10 am Gerät gemessen lagen zwischen `setCategory` und dem
    /// `routeChangeNotification` mit der neuen Route 8–17 ms. Wer die Route
    /// direkt nach dem Umschalten liest, liest deshalb noch die alte — genau
    /// diese Zahl stand stundenlang als Beleg dafür, dass der Schalter nicht
    /// trägt. Die Oberfläche braucht die Wahrheit ausserdem auch dann, wenn
    /// sie den Wechsel nicht selbst ausgelöst hat (Kopfhörer rein, AirPods).
    private func sessionBeobachtenFallsNoetig() {
        guard sessionBeobachter == nil else { return }
        sessionBeobachter = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil
        ) { [weak self] n in
            guard let self else { return }
            let grund = n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 99
            NSLog("[PulseSprache] Routenwechsel grund=%lu neu=%@ kat=%@ modus=%@ opt=%lu",
                  grund, routeJetzt(),
                  AVAudioSession.sharedInstance().category.rawValue,
                  AVAudioSession.sharedInstance().mode.rawValue,
                  AVAudioSession.sharedInstance().categoryOptions.rawValue)
            if raum != nil { schickeEigenen() }
        }
        // **Eine Unterbrechung heisst: jemand anderes hat die Session.** Das
        // ist die Zeile, an der der Hoermuschel-Fehler hing — die Oberfläche
        // spielte ihren Beitritts-Ton, WebKit richtete dafür seine eigene,
        // nicht mischbare Session ein, und iOS nahm uns die unsere. Danach
        // bewegt kein `setCategory` mehr eine Route. Ohne diese Meldung sieht
        // genau das aus wie „der SDK-Schalter trägt nicht".
        //
        // `eingaenge` steht mit im Log, weil `AVAudioSession` nicht sagt, ob
        // sie aktiv ist: eine nicht aktivierte `.playAndRecord`-Session führt
        // keinen Eingang.
        NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: nil
        ) { [weak self] n in
            guard let self, raum != nil else { return }
            let roh = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt ?? 99
            NSLog("[PulseSprache] Unterbrechung art=%@ route=%@ engine=%@ eing=%@",
                  roh == 1 ? "begonnen" : (roh == 0 ? "beendet" : "\(roh)"),
                  routeJetzt(),
                  AudioManager.shared.isEngineRunning ? "laeuft" : "aus",
                  AVAudioSession.sharedInstance().currentRoute.inputs
                      .map { $0.portType.rawValue }.joined(separator: ","))
        }
    }

    // MARK: - Zustand

    func zustand() -> [String: Any] {
        [
            "verbunden": raum?.connectionState == .connected,
            "kanalId": kanalId ?? "",
            "teilnehmer": teilnehmerListe(),
            "mikro": raum?.localParticipant.isMicrophoneEnabled() ?? false,
            "lautsprecher": AudioManager.shared.isSpeakerOutputPreferred,
            "route": routeJetzt(),
            // **Kategorie und Optionen gehören in den Zustand, nicht in einen
            // Einzelfall-Log.** Am 2026-10-10 schaltete die Hörmuschel im
            // Prüfpfad, in der echten App aber nicht — und die Frage, WER
            // die Session gerade anders eingestellt hat, war von aussen
            // nicht zu beantworten. `.defaultToSpeaker` in den Optionen macht
            // die Hörmuschel unerreichbar, ganz gleich wer es gesetzt hat.
            "kategorie": AVAudioSession.sharedInstance().category.rawValue,
            "modus": AVAudioSession.sharedInstance().mode.rawValue,
            "optionen": optionenNamen(),
            // „Spielt eine FREMDE App?" — und das Feld sagt genau das und
            // nichts mehr. Am 2026-10-10 nachgemessen: es blieb `false`,
            // waehrend WebKit die Session unseres EIGENEN Prozesses an sich
            // zog. Es taugt also zum Ausschluss einer fremden App, nicht zum
            // Erkennen der eigenen WebView; dafuer ist `eingaenge` da.
            "fremdTon": AVAudioSession.sharedInstance().isOtherAudioPlaying,
            // Laeuft die Audio-Maschine noch? Nach einer Unterbrechung steht
            // sie, und eine stehende Session bewegt keine Route.
            "engineLaeuft": AudioManager.shared.isEngineRunning,
            // Eingaenge als Anzeiger dafuer, ob die Session wirklich AKTIV
            // ist: eine nicht aktivierte `.playAndRecord`-Session fuehrt
            // keinen Eingang, und „aktiv?" fragt `AVAudioSession` nicht ab.
            "eingaenge": AVAudioSession.sharedInstance().currentRoute.inputs
                .map { $0.portType.rawValue }
        ]
    }

    private func optionenNamen() -> [String] {
        let o = AVAudioSession.sharedInstance().categoryOptions
        var namen: [String] = []
        if o.contains(.defaultToSpeaker) { namen.append("defaultToSpeaker") }
        if o.contains(.allowBluetoothHFP) { namen.append("allowBluetoothHFP") }
        if o.contains(.allowBluetoothA2DP) { namen.append("allowBluetoothA2DP") }
        if o.contains(.mixWithOthers) { namen.append("mixWithOthers") }
        return namen
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
