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
///
/// Die Abbildung nach oben (Zustands-Vollbild, Teilnehmerform, Diagnosefelder)
/// und die Delegat-Haken liegen in `SpracheRaumZustand.swift`, die Lautstärken
/// in `SpracheRaumTaub.swift` — hier steht nur, was etwas TUT.
///
/// **`@unchecked Sendable` ist eine Aussage, also hier was sie bedeutet.**
/// `RoomDelegate` verlangt `Sendable`, und diese Klasse wird wirklich von
/// mehreren Fäden berührt: Befehle kommen über `nacheinander`, die
/// Delegat-Rufe des SDK von dessen eigenen Fäden, die Ansicht liest vom
/// Hauptthread. Geprüft sind davon zwei Dinge — `hoerwunsch` liegt hinter
/// `tonFaden` (s. `SpracheRaumTaub.swift`), die Kette hinter der Sperre in
/// `Befehlskette`. Die übrigen Felder (`raum`, `kanalId`, `kanalName`,
/// `kameraVorn`, `taub`, `anrufPausiert`, `mikroWunsch`, `sitzung`, `melde`)
/// sind kleine Werte, die ein Befehl setzt und andere lesen; sie sind NICHT
/// synchronisiert, und das ist der Grund für `unchecked`. Wer auf Swift 6
/// geht, muss sie wirklich absichern.
final class SpracheRaum: NSObject, @unchecked Sendable {
    static let geteilt = SpracheRaum()

    /// Meldet ein Ereignis an die Brücke. Wird vom Plugin gesetzt.
    var melde: ((String, [String: Any]) -> Void)?

    /// Reicht einen Knopfdruck der nativen Ansicht an die Oberfläche weiter.
    /// `false`, wenn dort gerade niemand zuhört — dann handelt die Hülle
    /// selbst (s. `wunsch`). Wird vom Plugin gesetzt.
    var wunschAnWeb: ((Wunsch, Bool) -> Bool)?

    /// Der LiveKit-Raum. **Setzen nur in dieser Datei** (`private(set)` ist in
    /// Swift datei-weit) — gelesen wird er auch vom Zustandsteil und von der
    /// nativen Ansicht, die ihn als `ObservableObject` beobachtet.
    private(set) var raum: Room?
    private(set) var kanalId: String?
    /// Gewünschter Kanalname für die Kopfzeile der nativen Ansicht. Kommt vom
    /// Web mit — die Hülle kennt keine Kanäle.
    private(set) var kanalName: String = ""
    /// Zählt die Beitritte. **Die Antwort auf „welcher Raum ist gemeint?"** —
    /// ein Verlassen mit einer Sitzung, die nicht mehr die laufende ist, tut
    /// nichts. Ohne sie räumte ein überholter Beitritt im Web den NEUEREN Raum
    /// ab (Bughunt 2026-10-11, M6), denn `verlassen` traf das gemeinsame Feld.
    private(set) var sitzung = 0
    /// Welche Kamera läuft. **Gemerkt statt abgefragt**, weil die Abfrage am
    /// Aufnehmer hängt (`CameraCapturer.position`) und der zwischen
    /// „aus" und „an" gar nicht existiert — ein Wunsch, der das Ausschalten
    /// überlebt, ist das, was die Oberfläche braucht.
    private(set) var kameraVorn = true
    /// Mithören aus. Setzt das Web bei JEDEM Beitritt ausdrücklich
    /// (`startTaub`); der Stand eines früheren Raums gilt nicht mit. Gesetzt
    /// nur hier und in `SpracheRaumStumm.swift` (`private(set)` gilt in Swift
    /// je Datei).
    var taub = false {
        didSet {
            let neu = taub
            DispatchQueue.main.async { SpracheStand.geteilt.taub = neu }
        }
    }
    /// Ein Direktanruf hält den Kanal an (`SpracheRaumStumm.swift`).
    /// **Überdauert Beitritte**: wer WÄHREND eines Anrufs einem Kanal
    /// beitritt, tritt angehalten bei — gesetzt und gelöst nur von der
    /// Anrufverwaltung (`AnrufSitzung.swift`).
    var anrufPausiert = false
    /// Was der Nutzer für das Mikrofon WILL. Während der Pause bleibt das
    /// Mikrofon zu, ein Mikrofon-Befehl ändert nur den Wunsch; mit dem Ende des
    /// Anrufs gilt er wieder.
    var mikroWunsch = true
    /// Warum das Mikrofon beim Beitritt nicht hochkam, falls es das nicht tat.
    /// Reist im Zustand mit, statt den Beitritt zu werfen — Begründung in
    /// `beitreten`.
    private(set) var mikrofonFehler: String?
    /// Griff auf den Routen-Beobachter. **Nur in `SpracheRaumSession.swift`
    /// anfassen** — `private` ginge nicht, Swift rechnet es datei-weit.
    var sessionBeobachter: NSObjectProtocol?

    /// Was die Oberfläche hören will: Lautstärke je Nutzer und gesamt. **Nur
    /// auf `tonFaden` anfassen, und nur aus `SpracheRaumTaub.swift`** — nicht
    /// `private`, weil eine Erweiterung keine gespeicherte Eigenschaft tragen
    /// kann.
    var hoerwunsch = Hoerwunsch()
    let tonFaden = DispatchQueue(label: "com.howispulse.sprache.lautstaerke")

    /// Die Befehlskette, s. `nacheinander`.
    private let kette = Befehlskette()

    /// Knöpfe der nativen Ansicht, deren Regeln dem Web gehören.
    enum Wunsch: String {
        case mikrofon, taub, auflegen
    }

    enum Fehler: LocalizedError {
        /// Ein Verlassen hat den Raum genommen, während er noch aufgebaut
        /// wurde. Kein echter Fehlschlag: wer aufgelegt hat, will genau das.
        case ueberholt
        var errorDescription: String? { "sprache_beitritt_ueberholt" }
    }

    // MARK: - Reihenfolge

    /// **Befehle laufen der Reihe nach, nicht jeder in seinem eigenen `Task`.**
    ///
    /// Bis zum 2026-10-11 startete jeder Brücken-Ruf einen eigenen `Task`, und
    /// zwei davon haben keine Reihenfolge. Belegt am SDK-Quelltext
    /// (`Track.swift`, `_mute`/`_unmute`): `isMuted` wird erst NACH dem
    /// `await` gesetzt, und `_mute` kehrt bei noch ungesetztem `isMuted` sofort
    /// zurück. Ein „an" und gleich danach ein „aus" (Sprechtaste loslassen)
    /// liess so das Mikrofon OFFEN — der stillste denkbare Fehler.
    ///
    /// `verlassen` läuft bewusst NICHT hier durch: Auflegen darf nicht hinter
    /// einem hängenden Verbindungsaufbau warten, und es bricht ihn ab (s.
    /// `nochAktuell`).
    func nacheinander<T>(_ arbeit: @escaping () async throws -> T) async throws -> T {
        try await kette.nacheinander(arbeit)
    }

    // MARK: - Steuerung

    func beitreten(wsUrl: String, token: String, kanalId: String, kanalName: String,
                   stumm: Bool, taubStart: Bool,
                   lautstaerken: [String: Double]? = nil, gesamt: Double? = nil) async throws {
        await verlassen()
        sessionBeobachtenFallsNoetig()
        // **Taub und Lautstärken ZUERST, nicht am Ende.** Bis zum 2026-10-11
        // stand `taub = taubStart` als letzte Zeile — dazwischen abonniert
        // LiveKit schon die vorhandenen Spuren und stellte sie nach dem ALTEN
        // Stand (eines früheren Raums) auf 0; die letzte Zeile drehte nur den
        // Merker um. Man hörte niemanden, die Oberfläche sagte „nicht taub"
        // (Bughunt 2026-10-11, E1).
        taub = taubStart
        await hoerwunschSetzen(je: lautstaerken, gesamt: gesamt)
        let r = Room(delegate: self)
        sitzung += 1
        raum = r
        self.kanalId = kanalId
        self.kanalName = kanalName
        do {
            try await r.connect(url: wsUrl, token: token)
        } catch {
            // Gescheitert: den Raum nicht als „den laufenden" stehen lassen
            // (Bughunt 2026-10-11, M2).
            raumLoesen(r)
            throw error
        }
        try await nochAktuell(r)
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
        // Am 2026-10-10 genau so erlebt.
        //
        // **Ein gescheitertes Mikrofon lässt den Beitritt STEHEN** — es meldet
        // sich, es wirft nicht. Bis zum 2026-10-10 warf es, und das hinterliess
        // einen verbundenen Raum, den niemand abräumte: für alle anderen sass
        // man im Kanal, die eigene Oberfläche sagte „nicht verbunden". Im
        // Simulator ist das der Normalfall (`-4010`, kein Mikrofon am Mac), am
        // Gerät die verweigerte Erlaubnis. Ohne Mikrofon kann man zuhören —
        // der Preis ist der Absatz darüber: ohne Aufnahme keine Hörmuschel.
        mikrofonFehler = nil
        mikroWunsch = !stumm
        do {
            try await r.localParticipant.setMicrophone(enabled: true)
            // `r`, nicht `raum`: ein Befehl dieses Beitritts darf nie auf einem
            // anderen Raum landen (M6). Läuft ein Anruf, bleibt das Mikrofon
            // im Kanal zu — der Anruf gewinnt (Entwurf §8, Punkt 2).
            if stumm || anrufPausiert { try await Self.stummSchalten(true, in: r) }
        } catch {
            mikrofonFehler = error.localizedDescription
            NSLog("[PulseSprache] Mikrofon beim Beitritt gescheitert: %@",
                  error.localizedDescription)
        }
        try await nochAktuell(r)
        schickeTeilnehmer()
        schickeEigenen()
    }

    /// Steht `r` noch als laufender Raum? Wenn nicht, hat ein Verlassen ihn
    /// während des Aufbaus genommen: `r` wird getrennt (das Verlassen hat es
    /// schon getan — doppelt schadet nicht), und der Beitritt endet mit
    /// `ueberholt`. **Er darf danach NICHTS mehr anfassen** — jedes weitere
    /// `raum`-Lesen träfe einen fremden Raum.
    private func nochAktuell(_ r: Room) async throws {
        guard raum !== r else { return }
        await r.disconnect()
        throw Fehler.ueberholt
    }

    /// Nimmt `r` als laufenden Raum heraus, falls er es noch ist.
    private func raumLoesen(_ r: Room) {
        guard raum === r else { return }
        raum = nil
        kanalId = nil
        kanalName = ""
    }

    /// `sitzung`: nur verlassen, wenn genau dieser Beitritt noch läuft. `nil`
    /// heisst „was gerade läuft" (Auflegen aus der Oberfläche).
    func verlassen(sitzung gemeint: Int? = nil) async {
        guard let r = raum else { return }
        if let gemeint, gemeint != sitzung {
            NSLog("[PulseSprache] verlassen(Sitzung %ld) übergangen — läuft: %ld",
                  gemeint, sitzung)
            return
        }
        raumLoesen(r)
        // **Zuerst die Ansicht, dann die Trennung.** Die Ansicht hält den Raum
        // und zeichnet daraus; sie über einem gerade abgebauten Raum stehen zu
        // lassen, zeigt einen leeren Bildschirm ohne Ausweg. Ein Melden wäre
        // hier falsch: das Web hat das Verlassen selbst angestossen und räumt
        // seinen Zustand ohnehin auf — ein `ansichtGeschlossen` hinterher
        // sähe wie eine Nutzergeste aus.
        await MainActor.run { SpracheAnsichtHalter.geteilt.schliessen(melden: false) }
        await r.disconnect()
    }

    /// Der Raum ist von aussen weggebrochen (Netz, Server, Rauswurf) — von
    /// `didDisconnectWithError` gerufen. Bis zum 2026-10-11 blieb er danach
    /// als toter Raum stehen (Bughunt M1).
    func raumAbgerissen(_ r: Room) {
        guard raum === r else { return }
        raumLoesen(r)
        // **Der Raum ist weg, also muss die Ansicht weg.** Gemeldet wird das
        // Schliessen, damit die Oberfläche keinen Griff „zurück in den Kanal"
        // anbietet, wenn es keinen Kanal mehr gibt.
        Task { @MainActor in SpracheAnsichtHalter.geteilt.schliessen(melden: true) }
    }

    /// Kamera veröffentlichen oder zurücknehmen.
    ///
    /// **Ausschalten heisst ZURÜCKNEHMEN, nicht stummschalten** — der genaue
    /// Gegensatz zum Mikrofon, aus zwei Gründen, die beide schon im Web-Weg
    /// stehen (`livekit.svelte.ts::setCamera`): ein nur gemutetes Video lässt
    /// den `track_unpublished`-Webhook aus (das CAM-Zeichen bliebe bei allen
    /// an), und die Kamera des Geräts liefe samt Leuchte weiter.
    func kamera(_ an: Bool) async throws {
        guard let r = raum else { return }
        if an {
            try await r.localParticipant.setCamera(
                enabled: true, captureOptions: CameraCaptureOptions(
                    position: kameraVorn ? .front : .back))
        } else if let pub = r.localParticipant.firstCameraPublication as? LocalTrackPublication {
            // `unpublish` stoppt die Spur mit (`stopLocalTrackOnUnpublish`,
            // Vorgabe des SDK) — damit geht die Kamera-Leuchte aus.
            try await r.localParticipant.unpublish(publication: pub)
        }
        schickeEigenen()
        schickeTeilnehmer()
    }

    /// Front- oder Rückkamera. Läuft die Kamera, wird der AUFNEHMER umgestellt
    /// statt neu veröffentlicht (die Gegenseite bemerkt keinen Abriss, wie
    /// `restartTrack` im Web); sonst wird nur der Wunsch gemerkt.
    func kameraSeite(front: Bool) async throws {
        kameraVorn = front
        if let spur = raum?.localParticipant.firstCameraPublication?.track as? LocalVideoTrack,
           let aufnehmer = spur.capturer as? CameraCapturer {
            _ = try await aufnehmer.set(cameraPosition: front ? .front : .back)
        }
        schickeEigenen()
    }

    /// Lautsprecher oder Hörmuschel — der Schalter, um den es beim ganzen
    /// Umbau geht (`isSpeakerOutputPreferred`, Doc-Kommentar des SDK: „Set to
    /// `false` if the receiver is preferred instead of the speaker").
    ///
    /// **Er wirkt NICHT, solange ein Anruf die Session führt** — führt CallKit,
    /// ist die Konfiguration des SDK abgeschaltet und die Hülle stellt die
    /// Route des Anrufs selbst; der Wunsch hier bleibt liegen und gilt nach
    /// dem Anruf. Läuft der Anruf ohne CallKit, teilen sich beide den Schalter
    /// des SDK, und der Wunsch wird nur gemerkt (`AnrufSitzung.swift`). Die
    /// Route wird hier NICHT gemeldet: sie wechselt asynchron (8–17 ms, am
    /// Gerät gemessen), ein Lesen hier läse den alten Wert. Die Wahrheit
    /// schickt der Routen-Beobachter.
    func ausgabe(_ weg: String) {
        let lautsprecher = weg != "hoermuschel"
        if !Anrufverwaltung.geteilt.kanalWunschMerken(lautsprecher: lautsprecher) {
            AudioManager.shared.isSpeakerOutputPreferred = lautsprecher
        }
        NSLog("[PulseSprache] Ausgabe '%@' gewuenscht", weg)
        schickeEigenen()
    }
}

/// Befehle der Reihe nach — für `SpracheRaum` und `AnrufRaum` dieselbe
/// Mechanik (Begründung an `SpracheRaum.nacheinander`). Jeder Befehl wartet
/// auf den vorigen; ein Fehlschlag reisst die Kette nicht ab.
final class Befehlskette: @unchecked Sendable {
    private let sperre = NSLock()
    private var letzte: Task<Void, Never>?

    func nacheinander<T>(_ arbeit: @escaping () async throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { fortsetzen in
            sperre.lock()
            let vorher = letzte
            letzte = Task {
                await vorher?.value
                do {
                    fortsetzen.resume(returning: try await arbeit())
                } catch {
                    fortsetzen.resume(throwing: error)
                }
            }
            sperre.unlock()
        }
    }
}
