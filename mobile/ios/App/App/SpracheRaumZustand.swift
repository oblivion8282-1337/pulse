import AVFoundation
import LiveKit

/// Der Zustands- und Melde-Teil von `SpracheRaum` — was nach oben geht und in
/// welcher Form.
///
/// **Warum eine eigene Datei.** `SpracheRaum.swift` trägt die Steuerung
/// (verbinden, Mikrofon, Ausgabe, Kamera) samt ihren teuer erkauften
/// Begründungen; mit der Abbildung und der Diagnose zusammen lag die Datei über
/// der Grössen-Policy (`PLAN.md` §12.1). Der Schnitt ist die natürliche Naht:
/// hier steht nichts, was etwas tut, nur was etwas berichtet. Eine reine
/// Verschiebung — Verhalten unverändert.
///
/// `private` ist in Swift DATEI-weit, nicht typweit: die verschobenen Glieder
/// mussten dafür von `private` auf intern wechseln. Sie sind weiterhin nur
/// innerhalb dieses Moduls sichtbar.
extension SpracheRaum {
    func zustand() -> [String: Any] {
        [
            "verbunden": raum?.connectionState == .connected,
            "kanalId": kanalId ?? "",
            "teilnehmer": teilnehmerListe(),
            "mikro": raum?.localParticipant.isMicrophoneEnabled() ?? false,
            // Kamera- und Taub-Stand gehören in dasselbe Vollbild: nach einem
            // Reload der Web-App ist `zustand()` die EINZIGE Quelle, aus der
            // sich Kamera-Knopf und Kopfhörer-Knopf in der Leiste wieder
            // richtig stellen können.
            "kamera": raum?.localParticipant.isCameraEnabled() ?? false,
            "kameraVorn": kameraVorn,
            "taub": taub,
            "ansichtOffen": SpracheAnsichtHalter.geteilt.istOffenSynchron,
            // Leer, solange alles in Ordnung ist. Ein Beitritt OHNE Mikrofon ist
            // kein gescheiterter Beitritt (man kann zuhören) — aber er muss
            // sichtbar sein, sonst hält sich der Nutzer für zu hören.
            "mikrofonFehler": mikrofonFehler ?? NSNull(),
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
    /// **`micMuted` ist nachgeprüft, nicht angenommen.** Es kommt aus
    /// `isMicrophoneEnabled()`, und das ist im SDK
    /// `!(Mikrofon-Publikation?.isMuted ?? true)` — ein Teilnehmer OHNE
    /// veröffentlichte Mikrofonspur gilt damit als stumm. Das ist richtig und
    /// deckt sich mit dem Web-Weg, der dieselbe Eigenschaft liest: wer nicht
    /// veröffentlicht, ist nicht zu hören, und genau das soll das Zeichen
    /// sagen. Es gilt auch beim Beitritt für den Bruchteil einer Sekunde, bevor
    /// die eigene Spur steht — deshalb schickt `beitreten` die Liste erst
    /// NACH dem Veröffentlichen.
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
            "taub": taub,
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
        // **Der Raum ist weg, also muss die Ansicht weg.** Eine stehengebliebene
        // Vollbild-Ansicht über einer getrennten Verbindung ist der eine
        // Zustand, aus dem der Nutzer nicht mehr herausfindet: die Web-Leiste
        // liegt darunter, und die Ansicht selbst hat keinen Auflegen-Knopf,
        // weil es nichts mehr aufzulegen gibt. Gemeldet wird das Schliessen
        // trotzdem — die Oberfläche soll ihren Griff „zurück in den Kanal"
        // nicht anbieten, wenn kein Kanal mehr da ist.
        Task { @MainActor in SpracheAnsichtHalter.geteilt.schliessen(melden: true) }
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

    // MARK: - Was sonst noch eine neue Liste verlangt
    //
    // **Die Haken hier sind der eigentliche Inhalt dieses Abschnitts, und sie
    // haben am 2026-10-10 gefehlt.** Der Befund vom Gerät war „ich klicke auf
    // stumm und sehe das Zeichen nicht" — die Oberfläche zeichnet die Kachel
    // aus `voice.participants`, und die Liste kommt ausschliesslich aus dem
    // `teilnehmer`-Ereignis. Alles, was ein Feld in `abbilden` ändern kann,
    // MUSS deshalb hier durchlaufen. Vorher taten es nur Beitritt, Austritt
    // und die Verbindungsaufnahme; Stummschalten — in beide Richtungen — kam
    // nirgends an.
    //
    // Die native Ansicht braucht keinen dieser Haken: sie beobachtet `Room`
    // und `Participant` direkt als `ObservableObject`. Nur das Web hängt an
    // der Liste, und ein Wert, der im Web fehlt, fehlt still.

    /// **Der wichtigste Haken für das Stumm-Zeichen, und er deckt BEIDE
    /// Richtungen ab.** Er trägt `participant: Participant`, nicht
    /// `RemoteParticipant`: das SDK meldet hier auch die eigene Spur (der Weg
    /// läuft über `TrackPublication.track(_:didUpdateIsMuted:)`, also über
    /// jedes `mute()`/`unmute()` der lokalen Spur) und genauso die
    /// Stummschaltung eines Fremden (über `RemoteTrackPublication`, ausgelöst
    /// vom Signal des Servers).
    func room(_ room: Room, participant: Participant, trackPublication: TrackPublication,
              didUpdateIsMuted isMuted: Bool) {
        schickeTeilnehmer()
        if participant is LocalParticipant { schickeEigenen() }
    }

    /// Verbindungsgüte — die Oberfläche zeigt sie je Teilnehmer an
    /// (`connectionQuality`), und ohne diesen Haken blieb sie auf dem Wert des
    /// Beitritts stehen, in der Regel `unknown`.
    func room(_ room: Room, participant: Participant,
              didUpdateConnectionQuality quality: ConnectionQuality) {
        schickeTeilnehmer()
    }

    /// Namensänderung. Ändert zusätzlich die REIHENFOLGE der Liste, weil nach
    /// Namen sortiert wird — ein Grund mehr, die ganze Liste zu schicken statt
    /// Einzeländerungen.
    func room(_ room: Room, participant: Participant, didUpdateName name: String) {
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
        schickeTeilnehmer()
    }

    func room(_ room: Room, participant: RemoteParticipant,
              didUnpublishTrack publication: RemoteTrackPublication) {
        schickeTeilnehmer()
    }

    func room(_ room: Room, participant: RemoteParticipant,
              didSubscribeTrack publication: RemoteTrackPublication) {
        schickeTeilnehmer()
        // **Taubstellen muss überleben, wer dazukommt.** Wer beitritt, WÄHREND
        // man taubgestellt ist, wäre sonst genau der eine, den man hört: der
        // Befehl hat seine Spur nie gesehen, weil sie es noch nicht gab.
        if let ton = publication.track as? RemoteAudioTrack {
            taubAufNeueSpur(ton)
        }
    }

    func room(_ room: Room, participant: RemoteParticipant,
              didUnsubscribeTrack publication: RemoteTrackPublication) {
        schickeTeilnehmer()
        // Die gemerkte Lautstärke gehört zu einer Spur, die es nicht mehr gibt.
        // Bliebe sie stehen, bekäme eine spätere Spur mit derselben Kennung
        // einen fremden Wert — und die Karte wüchse über die Sitzung.
        spurVergessen(publication.sid.stringValue)
    }

    /// Die EIGENE Kamera: veröffentlichen und zurücknehmen laufen hier durch.
    /// `kamera(_:)` schickt die Liste schon selbst — dieser Haken fängt die
    /// Fälle, in denen das SDK die Spur ohne unser Zutun abräumt (Kamera vom
    /// System entzogen, Spur gescheitert).
    func room(_ room: Room, participant: LocalParticipant,
              didPublishTrack publication: LocalTrackPublication) {
        schickeTeilnehmer()
        schickeEigenen()
    }

    func room(_ room: Room, participant: LocalParticipant,
              didUnpublishTrack publication: LocalTrackPublication) {
        schickeTeilnehmer()
        schickeEigenen()
    }

    /// **Nur die Kippkante, nicht der Pegel.** Der Pegel ändert sich mehrmals
    /// pro Sekunde je Teilnehmer; über eine serielle Brücke geschickt wäre das
    /// genau die Last, die am 2026-10-10 die App angehalten hat. Wer ihn
    /// braucht, zeichnet ihn nativ — das tut `SpracheKachel`.
    func room(_ room: Room, didUpdateSpeakingParticipants participants: [Participant]) {
        melde?("sprechen", [
            "sprechen": participants.compactMap { $0.identity?.stringValue }
        ])
    }
}
