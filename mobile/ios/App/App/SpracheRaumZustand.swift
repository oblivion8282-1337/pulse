import AVFoundation
import LiveKit

/// Der Zustands- und Melde-Teil von `SpracheRaum` — was nach oben geht und in
/// welcher Form.
///
/// Eigene Datei wegen der Grössen-Policy (`PLAN.md` §12.1): hier steht
/// nichts, was etwas tut, nur was etwas berichtet. `private` ist in Swift
/// DATEI-weit, deshalb sind die Glieder intern statt privat.
extension SpracheRaum {
    func zustand() -> [String: Any] {
        let session = AVAudioSession.sharedInstance()
        return [
            "verbunden": raum?.connectionState == .connected,
            "kanalId": kanalId ?? "",
            // Für den Abgleich nach einem Reload: die frische Oberfläche kennt
            // den Kanalnamen nicht, und ohne die Sitzung könnte sie beim
            // Verlassen nicht sagen, WELCHEN Raum sie meint.
            "kanalName": kanalName,
            "sitzung": sitzung,
            "teilnehmer": teilnehmerListe(),
            "mikro": raum?.localParticipant.isMicrophoneEnabled() ?? false,
            // Kamera- und Taub-Stand gehören in dasselbe Vollbild: nach einem
            // Reload der Web-App ist `zustand()` die EINZIGE Quelle, aus der
            // sich Kamera-Knopf und Kopfhörer-Knopf in der Leiste wieder
            // richtig stellen können.
            "kamera": raum?.localParticipant.isCameraEnabled() ?? false,
            "kameraVorn": kameraVorn,
            // Der WIRKSAME Stand: während eines Anrufs hört man den Kanal
            // nicht, auch wenn man nicht taub gestellt hat
            // (`SpracheRaumStumm.swift`). `pausiert` sagt, warum.
            "taub": wirksamTaub,
            "pausiert": anrufPausiert,
            "ansichtOffen": SpracheAnsichtHalter.geteilt.istOffenSynchron,
            // Leer, solange alles in Ordnung ist. Ein Beitritt OHNE Mikrofon ist
            // kein gescheiterter Beitritt (man kann zuhören) — aber er muss
            // sichtbar sein, sonst hält sich der Nutzer für zu hören.
            "mikrofonFehler": mikrofonFehler ?? NSNull(),
            "lautsprecher": AudioManager.shared.isSpeakerOutputPreferred,
            "route": routeJetzt(),
            // **Kategorie und Optionen gehören in den Zustand.** Am 2026-10-10
            // war von aussen nicht zu sagen, WER die Session umgestellt hatte;
            // `.defaultToSpeaker` macht die Hörmuschel unerreichbar.
            "kategorie": session.category.rawValue,
            "modus": session.mode.rawValue,
            "optionen": optionenNamen(),
            // „Spielt eine FREMDE App?" — nur das: es blieb `false`, während
            // WebKit unsere Session an sich zog (2026-10-10). Für die eigene
            // WebView ist `eingaenge` da.
            "fremdTon": session.isOtherAudioPlaying,
            // Laeuft die Audio-Maschine noch? Nach einer Unterbrechung steht
            // sie, und eine stehende Session bewegt keine Route.
            "engineLaeuft": AudioManager.shared.isEngineRunning,
            // Eingaenge als Anzeiger dafuer, ob die Session wirklich AKTIV
            // ist: eine nicht aktivierte `.playAndRecord`-Session fuehrt
            // keinen Eingang, und „aktiv?" fragt `AVAudioSession` nicht ab.
            "eingaenge": session.currentRoute.inputs.map { $0.portType.rawValue }
        ]
    }

    func optionenNamen() -> [String] {
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
    func routeJetzt() -> String {
        AVAudioSession.sharedInstance().currentRoute.outputs.first?.portType.rawValue ?? "(keiner)"
    }

    /// **Die Reihenfolge ist Teil der Form.** Der Web-Weg sortiert in
    /// `#refreshParticipants` eigener Nutzer zuerst, dann nach Namen mit einem
    /// `Intl.Collator`; die Oberfläche sortiert nicht nach. Käme die Liste von
    /// hier unsortiert, sprängen die Zeilen bei jedem `teilnehmer`-Ereignis
    /// umher — `remoteParticipants` ist ein Dictionary, seine Aufzählung ist
    /// nicht stabil. `localizedStandardCompare` ist das nächstliegende
    /// Gegenstück zum Collator (Gross/Klein und Umlaute wie im Telefonbuch).
    func teilnehmerListe() -> [[String: Any]] {
        guard let r = raum else { return [] }
        var liste = [abbilden(r.localParticipant, lokal: true)]
        let fremde = r.remoteParticipants.values
            .map { abbilden($0, lokal: false) }
            .sorted {
                let a = $0["name"] as? String ?? ""
                let b = $1["name"] as? String ?? ""
                return a.localizedStandardCompare(b) == .orderedAscending
            }
        liste.append(contentsOf: fremde)
        return liste
    }

    /// Abbildung auf die Form, die der Web-Store schon kennt
    /// (`VoiceParticipant` in `voice/livekit.svelte.ts`) — damit die 31
    /// Dateien, die ihn benutzen, unverändert bleiben.
    ///
    /// **`micMuted` ist nachgeprüft:** `isMicrophoneEnabled()` ist im SDK
    /// `!(Mikrofon-Publikation?.isMuted ?? true)` — ohne veröffentlichte Spur
    /// gilt man als stumm, wie im Web-Weg. Deshalb schickt `beitreten` die
    /// Liste erst NACH dem Veröffentlichen.
    ///
    /// **`isSpeaking` kommt hier vom SERVER, im Web nicht.** Der Web-Weg
    /// rechnet es aus einem `AnalyserNode` über der abonnierten Spur, mit der
    /// Begründung, LiveKits serverseitige Erkennung sei bei abgeschalteter AGC
    /// unzuverlässig. Auf dem nativen Weg gibt es keinen Web-Audio-Graphen; die
    /// Server-Erkennung ist, was da ist. **Ob sie merklich schlechter trifft,
    /// ist nicht gemessen.**
    func abbilden(_ p: Participant, lokal: Bool) -> [String: Any] {
        let kennung = p.identity?.stringValue ?? ""
        // Dieselbe Regel wie `voice/identity.ts::nameFor` — ein LEERER Name
        // zählt als keiner: geprüft wird der GETRIMMTE Name, weitergegeben der
        // rohe (genau so macht es der Web-Weg). Ein blosses `p.name ?? kennung`
        // liesse "" durch, und die Zeile stünde namenlos da.
        let name = p.name ?? ""
        let hatNamen = !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return [
            "identity": kennung,
            "name": hatNamen ? name : kennung,
            "userId": Self.nutzerId(aus: kennung) ?? NSNull(),
            "isLocal": lokal,
            "isSpeaking": p.isSpeaking,
            "audioLevel": Double(p.audioLevel),
            "micMuted": !p.isMicrophoneEnabled(),
            "cameraOn": p.isCameraEnabled(),
            "connectionQuality": guete(p.connectionQuality)
        ]
    }

    /// `user-<snowflake>` oder `user-<snowflake>~<zufall>` → die nackte Id.
    ///
    /// **Dieselbe Regel wie `voice/identity.ts::userIdFromIdentity`**
    /// (`^user-(\d+)(?:~[0-9a-f]+)?$`). Bis zum 2026-10-11 schnitt die Hülle
    /// nur `user-` ab und liess den Sitzungs-Zusatz stehen, den jeder Beitritt
    /// seit der Mehrgerät-Freischaltung trägt — `userId` war damit
    /// `"123~ab12"`, und alles, was im Web an der Id hängt (Profil, Lautstärke
    /// je Teilnehmer, Admin-Stummschaltung), fand niemanden.
    static func nutzerId(aus kennung: String) -> String? {
        guard kennung.hasPrefix("user-") else { return nil }
        let teile = kennung.dropFirst(5).split(
            separator: "~", maxSplits: 1, omittingEmptySubsequences: false)
        let zahl = teile[0]
        guard !zahl.isEmpty, zahl.allSatisfy({ ("0" ... "9").contains($0) }) else { return nil }
        if teile.count == 2 {
            let zusatz = teile[1]
            guard !zusatz.isEmpty, zusatz.allSatisfy({ "0123456789abcdef".contains($0) })
            else { return nil }
        }
        return String(zahl)
    }

    /// Der Verbindungszustand als schlichtes Wort — **an genau dieser Stelle**.
    /// Bis zum 2026-10-11 ging `"\(state)"` hinüber, und LiveKits
    /// `description` trägt einen Punkt (`.connected`): das Web prüfte auf
    /// `connected`, ein Wiederaufbau wurde nie angezeigt (Bughunt G1). Das Web
    /// liest tolerant (`voice/nativAbgleich.ts`) — ältere Hüllen schicken ihn.
    static func verbindungsName(_ s: ConnectionState) -> String {
        switch s {
        case .disconnected: return "disconnected"
        case .connecting: return "connecting"
        case .reconnecting: return "reconnecting"
        case .connected: return "connected"
        case .disconnecting: return "disconnecting"
        }
    }

    func guete(_ q: ConnectionQuality) -> String {
        switch q {
        case .excellent: return "excellent"
        case .good: return "good"
        case .poor: return "poor"
        case .lost: return "lost"
        default: return "unknown"
        }
    }

    func schickeTeilnehmer() {
        melde?("teilnehmer", ["liste": teilnehmerListe()])
    }

    func schickeEigenen() {
        melde?("eigenerZustand", [
            "mikro": raum?.localParticipant.isMicrophoneEnabled() ?? false,
            "kamera": raum?.localParticipant.isCameraEnabled() ?? false,
            "kameraVorn": kameraVorn,
            "taub": wirksamTaub,
            "pausiert": anrufPausiert,
            "lautsprecher": AudioManager.shared.isSpeakerOutputPreferred,
            "route": routeJetzt()
        ])
    }
}

// MARK: - RoomDelegate

/// **Die Rufe kommen NICHT vom Hauptthread** (so sagt es LiveKits eigene
/// Dokumentation). Hier wird deshalb nur Zustand eingesammelt und über die
/// Brücke geschickt; wer Ansichten anfasst, muss selbst auf den Hauptthread
/// wechseln — die native Kanalansicht tut das nicht von hier aus, sondern
/// beobachtet `Room` selbst als `ObservableObject` (SwiftUI liefert die
/// Änderungen dann auf dem Hauptthread, s. `SpracheAnsicht.swift`).
///
/// **Jeder Haken prüft zuerst, ob `room` noch der laufende Raum ist.** Der
/// Delegat ist für ALLE Räume dieselbe Instanz, und die Ereignisse eines
/// gerade verlassenen Raums kommen verspätet (über LiveKits eigene
/// Warteschlange). Ohne den Wächter meldete der alte Raum nach einem
/// Kanalwechsel sein „getrennt" — an eine Oberfläche, die schon im neuen
/// Kanal sitzt. Der Web-Weg hat denselben Wächter (`_active()` in
/// `#wireEvents`).
extension SpracheRaum: RoomDelegate {
    func room(_ room: Room, didUpdateConnectionState state: ConnectionState,
              from alt: ConnectionState) {
        NSLog("[PulseSprache] Verbindung %@ → %@", "\(alt)", "\(state)")
        guard room === raum else { return }
        melde?("verbindung", ["zustand": Self.verbindungsName(state)])
        if state == .connected { schickeTeilnehmer() }
    }

    func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        NSLog("[PulseSprache] getrennt: %@", error?.localizedDescription ?? "ohne Fehler")
        guard room === raum else { return }
        // Von aussen getrennt (Netz, Server, Rauswurf): die Hülle räumt den
        // Raum selbst ab, auch die Ansicht (`raumAbgerissen`) — die Oberfläche
        // kann gerade eingefroren sein und erst später davon erfahren.
        raumAbgerissen(room)
        melde?("verbindung", ["zustand": "disconnected",
                              "fehler": error?.localizedDescription ?? NSNull()])
    }

    func room(_ room: Room, didFailToConnectWithError error: LiveKitError?) {
        NSLog("[PulseSprache] Verbinden fehlgeschlagen: %@",
              error?.localizedDescription ?? "unbekannt")
        guard room === raum else { return }
        melde?("verbindung", ["zustand": "disconnected",
                              "fehler": error?.localizedDescription ?? "unbekannt"])
    }

    func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        guard room === raum else { return }
        schickeTeilnehmer()
    }

    func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        guard room === raum else { return }
        schickeTeilnehmer()
    }

    // MARK: - Was sonst noch eine neue Liste verlangt
    //
    // **Alles, was ein Feld in `abbilden` ändern kann, MUSS hier durchlaufen**
    // — die Web-Kachel zeichnet allein aus dem `teilnehmer`-Ereignis. Am
    // 2026-10-10 fehlten diese Haken („ich klicke auf stumm und sehe das
    // Zeichen nicht"). Die native Ansicht braucht sie nicht: sie beobachtet
    // `Room` und `Participant` direkt.

    /// **Der wichtigste Haken für das Stumm-Zeichen, in BEIDE Richtungen:**
    /// `participant: Participant` meldet die eigene Spur (`mute()`/`unmute()`)
    /// ebenso wie die Stummschaltung eines Fremden (Signal des Servers).
    func room(_ room: Room, participant: Participant, trackPublication: TrackPublication,
              didUpdateIsMuted isMuted: Bool) {
        guard room === raum else { return }
        schickeTeilnehmer()
        if participant is LocalParticipant { schickeEigenen() }
    }

    /// Verbindungsgüte — die Oberfläche zeigt sie je Teilnehmer an
    /// (`connectionQuality`), und ohne diesen Haken blieb sie auf dem Wert des
    /// Beitritts stehen, in der Regel `unknown`.
    func room(_ room: Room, participant: Participant,
              didUpdateConnectionQuality quality: ConnectionQuality) {
        guard room === raum else { return }
        schickeTeilnehmer()
    }

    /// Namensänderung. Ändert zusätzlich die REIHENFOLGE der Liste, weil nach
    /// Namen sortiert wird — ein Grund mehr, die ganze Liste zu schicken statt
    /// Einzeländerungen.
    func room(_ room: Room, participant: Participant, didUpdateName name: String) {
        guard room === raum else { return }
        schickeTeilnehmer()
    }

    /// Spuren kommen und gehen, ohne dass ein Teilnehmer kommt oder geht — eine
    /// eingeschaltete Kamera und eine beginnende Bildschirmfreigabe laufen
    /// genau hier durch.
    ///
    /// **Veröffentlichen und Abonnieren sind zwei Ereignisse, und beide
    /// zählen.** `cameraOn` liest die PUBLIKATION, die schon beim
    /// Veröffentlichen da ist; die Spur selbst (und damit ein Bild) kommt erst
    /// mit dem Abonnement. Wer nur das eine verdrahtet, hat entweder ein
    /// Zeichen ohne Bild oder ein Bild ohne Zeichen.
    func room(_ room: Room, participant: RemoteParticipant,
              didPublishTrack publication: RemoteTrackPublication) {
        guard room === raum else { return }
        schickeTeilnehmer()
    }

    func room(_ room: Room, participant: RemoteParticipant,
              didUnpublishTrack publication: RemoteTrackPublication) {
        guard room === raum else { return }
        schickeTeilnehmer()
    }

    func room(_ room: Room, participant: RemoteParticipant,
              didSubscribeTrack publication: RemoteTrackPublication) {
        guard room === raum else { return }
        schickeTeilnehmer()
        // Jede neue Tonspur sofort auf ihren richtigen Wert (Taub, Regler je
        // Teilnehmer, Gesamt) — s. `SpracheRaumTaub.swift`.
        if let ton = publication.track as? RemoteAudioTrack {
            spurStellen(ton, kennung: participant.identity?.stringValue ?? "")
        }
    }

    func room(_ room: Room, participant: RemoteParticipant,
              didUnsubscribeTrack publication: RemoteTrackPublication) {
        guard room === raum else { return }
        schickeTeilnehmer()
    }

    /// Die EIGENE Kamera: veröffentlichen und zurücknehmen laufen hier durch.
    /// `kamera(_:)` schickt die Liste schon selbst — dieser Haken fängt die
    /// Fälle, in denen das SDK die Spur ohne unser Zutun abräumt (Kamera vom
    /// System entzogen, Spur gescheitert).
    func room(_ room: Room, participant: LocalParticipant,
              didPublishTrack publication: LocalTrackPublication) {
        guard room === raum else { return }
        schickeTeilnehmer()
        schickeEigenen()
    }

    func room(_ room: Room, participant: LocalParticipant,
              didUnpublishTrack publication: LocalTrackPublication) {
        guard room === raum else { return }
        schickeTeilnehmer()
        schickeEigenen()
    }

    /// **Nur die Kippkante, nicht der Pegel.** Der Pegel ändert sich mehrmals
    /// pro Sekunde je Teilnehmer; über eine serielle Brücke geschickt wäre das
    /// genau die Last, die am 2026-10-10 die App angehalten hat. Wer ihn
    /// braucht, zeichnet ihn nativ — das tut `SpracheKachel`.
    func room(_ room: Room, didUpdateSpeakingParticipants participants: [Participant]) {
        guard room === raum else { return }
        melde?("sprechen", [
            "sprechen": participants.compactMap { $0.identity?.stringValue }
        ])
    }
}
