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
/// und die Delegat-Haken liegen in `SpracheRaumZustand.swift` — hier steht nur,
/// was etwas TUT.
/// **`@unchecked Sendable` ist eine Aussage, also hier was sie bedeutet.**
/// `RoomDelegate` verlangt `Sendable`, und diese Klasse wird wirklich von
/// mehreren Fäden berührt: Befehle kommen von Capacitors Brücken-Faden, die
/// Delegat-Rufe des SDK von dessen eigenen, die Ansicht liest vom Hauptthread.
/// Geprüft ist davon GENAU EINES — `lautstaerken` liegt hinter `tonFaden`
/// (s. `SpracheRaumTaub.swift`). Die übrigen Felder (`raum`, `kanalId`,
/// `kanalName`, `kameraVorn`, `taub`, `melde`) sind kleine Werte, die ein
/// Befehl setzt und andere lesen; sie sind NICHT synchronisiert, und das ist
/// der Grund für `unchecked`.
///
/// Bis zum 2026-10-10 stand hier gar nichts: die Zusicherung kam stillschweigend
/// über `RoomDelegate` mit, und der Übersetzer mahnte sie in der Swift-5-Art
/// nur als Warnung an. Wer auf Swift 6 geht, muss diese Felder wirklich
/// absichern — die Warnung wird dort ein Fehler, und das zu Recht.
final class SpracheRaum: NSObject, @unchecked Sendable {
    static let geteilt = SpracheRaum()

    /// Meldet ein Ereignis an die Brücke. Wird vom Plugin gesetzt.
    var melde: ((String, [String: Any]) -> Void)?

    /// Der LiveKit-Raum. **Setzen nur in dieser Datei** (`private(set)` ist in
    /// Swift datei-weit) — gelesen wird er auch vom Zustandsteil und von der
    /// nativen Ansicht, die ihn als `ObservableObject` beobachtet.
    private(set) var raum: Room?
    private(set) var kanalId: String?
    /// Gewünschter Kanalname für die Kopfzeile der nativen Ansicht. Kommt vom
    /// Web mit — die Hülle kennt keine Kanäle.
    private(set) var kanalName: String = ""
    /// Welche Kamera läuft. **Gemerkt statt abgefragt**, weil die Abfrage am
    /// Aufnehmer hängt (`CameraCapturer.position`) und der zwischen
    /// „aus" und „an" gar nicht existiert — ein Wunsch, der das Ausschalten
    /// überlebt, ist das, was die Oberfläche braucht.
    private(set) var kameraVorn = true
    /// Mithören aus. Eine Entscheidung des Nutzers, nicht ein Zustand des
    /// Raums — sie überlebt deshalb einen Kanalwechsel.
    private(set) var taub = false
    /// Warum das Mikrofon beim Beitritt nicht hochkam, falls es das nicht tat.
    /// Reist im Zustand mit, statt den Beitritt zu werfen — Begründung in
    /// `beitreten`.
    private(set) var mikrofonFehler: String?
    /// Griff auf den Routen-Beobachter. **Nur in `SpracheRaumSession.swift`
    /// anfassen** — `private` ginge nicht, Swift rechnet es datei-weit.
    var sessionBeobachter: NSObjectProtocol?

    /// Lautstärke je fremder Tonspur, gemerkt beim Taubstellen. Schlüssel ist
    /// die Spur-Kennung (`Track.sid`), nicht die Teilnehmer-Kennung: ein
    /// Teilnehmer kann zwei Tonspuren führen (Mikrofon und der Ton einer
    /// Bildschirmfreigabe).
    ///
    /// **Nur auf `tonFaden` anfassen, und nur aus `SpracheRaumTaub.swift`.**
    /// Nicht `private`, weil Swift das DATEI-weit rechnet und die Mechanik
    /// dort liegt — eine Erweiterung kann keine gespeicherte Eigenschaft
    /// tragen.
    var lautstaerken: [String: Double] = [:]
    let tonFaden = DispatchQueue(label: "com.howispulse.sprache.lautstaerke")

    // MARK: - Steuerung

    func beitreten(wsUrl: String, token: String, kanalId: String, kanalName: String,
                   stumm: Bool, taubStart: Bool) async throws {
        await verlassen()
        sessionBeobachtenFallsNoetig()
        let r = Room(delegate: self)
        raum = r
        self.kanalId = kanalId
        self.kanalName = kanalName
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
        //
        // **Ein gescheitertes Mikrofon lässt den Beitritt STEHEN** — es meldet
        // sich, es wirft nicht. Bis zum 2026-10-10 warf es, und das hinterliess
        // den teuersten Zustand dieser Baustelle: `r.connect` war durch, der
        // Raum also verbunden, aber niemand räumte ihn ab. Für alle anderen sass
        // man im Kanal, die eigene Oberfläche sagte „nicht verbunden", und es
        // gab keinen Knopf zum Verlassen. Im Simulator ist das der Normalfall
        // (`Audio engine returned error code: -4010`, kein Mikrofon am Mac), am
        // Gerät die verweigerte Erlaubnis.
        //
        // Der Web-Weg macht es seit jeher so (`livekit.svelte.ts`: `micEnabled
        // = false` plus `this.error`), und er hat recht: ohne Mikrofon kann man
        // immer noch ZUHÖREN. **Der Preis steht im Absatz darüber** — ohne
        // veröffentlichte Aufnahme wählt das SDK `.playback`, und dort gibt es
        // keine Hörmuschel. Das ist keine Folge dieser Entscheidung, sondern
        // der fehlenden Aufnahme selbst.
        mikrofonFehler = nil
        do {
            try await r.localParticipant.setMicrophone(enabled: true)
            if stumm { try await stummSchalten(true) }
        } catch {
            mikrofonFehler = error.localizedDescription
            NSLog("[PulseSprache] Mikrofon beim Beitritt gescheitert: %@",
                  error.localizedDescription)
        }
        // **Der Taub-Stand reist mit, der Raum ist neu.** Bei einem
        // Kanalwechsel baut diese Methode einen frischen `Room`, und dessen
        // fremde Spuren spielen auf voller Lautstärke — wer taubgestellt im
        // Nachbarkanal landet, hörte dort sonst wieder alles. Die Spuren sind
        // hier noch nicht abonniert; der Haken dafür sitzt im Delegaten
        // (`didSubscribeTrack`), diese Zeile setzt nur den Stand.
        taub = taubStart
        schickeTeilnehmer()
        schickeEigenen()
    }

    func verlassen() async {
        guard let r = raum else { return }
        raum = nil
        kanalId = nil
        kanalName = ""
        // Die gemerkten Lautstärken gehören zu Spuren, die es nicht mehr gibt.
        // Der Taub-STAND bleibt dagegen stehen — er ist eine Entscheidung des
        // Nutzers, kein Zustand des Raums (dasselbe Verhalten wie im Web, wo
        // ein Kanalwechsel die Wahl mitnimmt).
        lautstaerkenVergessen()
        // **Zuerst die Ansicht, dann die Trennung.** Die Ansicht hält den Raum
        // und zeichnet daraus; sie über einem gerade abgebauten Raum stehen zu
        // lassen, zeigt einen leeren Bildschirm ohne Ausweg. Ein Melden wäre
        // hier falsch: das Web hat das Verlassen selbst angestossen und räumt
        // seinen Zustand ohnehin auf — ein `ansichtGeschlossen` hinterher
        // sähe wie eine Nutzergeste aus.
        await MainActor.run { SpracheAnsichtHalter.geteilt.schliessen(melden: false) }
        await r.disconnect()
    }

    /// **Beide Meldungen, und das ist kein Versehen.** `eigenerZustand` stellt
    /// den Knopf, `teilnehmer` die eigene KACHEL — die zeichnet aus
    /// `voice.participants`, und die Liste kommt nur aus dem
    /// `teilnehmer`-Ereignis. Bis zum 2026-10-10 stand hier nur das erste:
    /// der Knopf kippte, das Stumm-Zeichen an der eigenen Kachel nicht.
    /// Am Gerät gemeldet, und von aussen sah es wie ein Darstellungsfehler aus.
    ///
    /// Der Delegat (`didUpdateIsMuted`) schickt die Liste inzwischen auch —
    /// aber erst asynchron (`Task.detachedDiscarding` im SDK), während der
    /// Rückgabewert dieses Rufes sofort gebraucht wird. Zwei Meldungen mit
    /// demselben Inhalt kosten nichts: jede liest den Live-Zustand, eine
    /// spätere kann also keine ältere Wahrheit tragen.
    func mikrofon(_ an: Bool) async throws {
        try await stummSchalten(!an)
        schickeEigenen()
        schickeTeilnehmer()
    }

    /// Kamera veröffentlichen oder zurücknehmen.
    ///
    /// **Ausschalten heisst ZURÜCKNEHMEN, nicht stummschalten** — und das ist
    /// der genaue Gegensatz zum Mikrofon drüber, aus zwei Gründen, die beide
    /// schon im Web-Weg stehen (`livekit.svelte.ts::setCamera`):
    /// LiveKits `setCamera(enabled: false)` mutet die Veröffentlichung nur, also
    /// (a) feuert der `track_unpublished`-Webhook nie, und voice-signaling
    /// lässt das CAM-Zeichen bei allen Teilnehmern an, und (b) die Kamera des
    /// Geräts bleibt samt Leuchte in Betrieb. Beim Mikrofon ist Muten dagegen
    /// Pflicht — dort hängt die Hörmuschel daran (Begründung in `beitreten`).
    func kamera(_ an: Bool) async throws {
        guard let r = raum else { return }
        if an {
            try await r.localParticipant.setCamera(
                enabled: true, captureOptions: kameraOptionen())
        } else if let pub = r.localParticipant.firstCameraPublication as? LocalTrackPublication {
            // `unpublish` stoppt die Spur mit (`stopLocalTrackOnUnpublish`,
            // Vorgabe des SDK) — damit geht die Kamera-Leuchte aus.
            try await r.localParticipant.unpublish(publication: pub)
        }
        schickeEigenen()
        schickeTeilnehmer()
    }

    /// Front- oder Rückkamera.
    ///
    /// Läuft die Kamera, wird der AUFNEHMER umgestellt statt neu
    /// veröffentlicht: die Spur bleibt dieselbe, die Gegenseite bemerkt keinen
    /// Abriss (dasselbe Vorgehen wie `restartTrack` im Web). Läuft sie nicht,
    /// wird nur der Wunsch gemerkt und beim nächsten Einschalten angewandt.
    func kameraSeite(front: Bool) async throws {
        kameraVorn = front
        if let spur = raum?.localParticipant.firstCameraPublication?.track as? LocalVideoTrack,
           let aufnehmer = spur.capturer as? CameraCapturer {
            _ = try await aufnehmer.set(cameraPosition: front ? .front : .back)
        }
        schickeEigenen()
    }

    private func kameraOptionen() -> CameraCaptureOptions {
        CameraCaptureOptions(position: kameraVorn ? .front : .back)
    }

    // MARK: - Taubstellen

    /// Nicht mehr mithören.
    ///
    /// **Es gibt im SDK kein globales Stummschalten der Wiedergabe** (gesucht:
    /// kein `isPlayoutMuted` und nichts Gleichwertiges am `AudioManager`), also
    /// wird jede fremde Tonspur einzeln auf 0 gestellt — und beim Zurücknehmen
    /// auf den vorher gelesenen Wert, nicht blind auf 1: es gibt eine
    /// Lautstärke je Teilnehmer, und ein Taub-Zyklus darf sie nicht platt
    /// machen.
    ///
    /// **Bis zum 2026-10-10 war dieser Knopf auf iOS wirkungslos, und das war
    /// schlimmer als „fehlt":** der Web-Weg schaltet `<audio>`-Elemente stumm,
    /// die es auf dem nativen Weg nicht gibt. Das Zeichen kippte, der Server
    /// meldete allen anderen „taub" — und gehört wurde weiter alles.
    func taubStellen(_ an: Bool) async {
        taub = an
        await aufTonFaden { [weak self] in self?.lautstaerkenAnwenden(an) }
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
}
