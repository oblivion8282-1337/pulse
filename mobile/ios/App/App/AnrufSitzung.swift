import AVFoundation
import LiveKit

/// **Zwei Räume, EINE Audio-Session — wer sie führt, und wie sie übergeben
/// wird.**
///
/// Das SDK hat einen einzigen `AudioManager` je Prozess: eine Audio-Maschine,
/// eine `AVAudioSession`. Kanal und Anruf spielen und nehmen über dieselbe
/// auf. Es gibt deshalb nicht „die Session des Kanals" und „die des Anrufs",
/// sondern nur die Frage, wer sie gerade EINRICHTET:
///
/// | Lage | führt die Session | Hörmuschel über |
/// |---|---|---|
/// | kein Anruf (auch: Anruf klingelt nur) | SDK, automatisch | `isSpeakerOutputPreferred` (Kanal) |
/// | Anruf angenommen / begonnen | CallKit | `overrideOutputAudioPort` (hier) |
/// | Anruf, CallKit hat abgewiesen | SDK, automatisch | `isSpeakerOutputPreferred`, Kanalwunsch gemerkt |
///
/// **Die Übergabe an CallKit** folgt LiveKits README (im Entwurf §6 belegt):
/// vor dem Verbinden `isAutomaticConfigurationEnabled = false` und
/// `setEngineAvailability(.none)`; in `didActivate` erst Kategorie und Modus,
/// dann `.default`; in `didDeactivate` wieder `.none`. **Die Reihenfolge beim
/// Übernehmen ist Absicht:** erst die Automatik aus, dann die Maschine an —
/// andersherum sähe das SDK seine Maschine stoppen und deaktivierte die
/// Session selbst (`AudioSessionEngineObserver.configureAudioSession`), mitten
/// in CallKits Übernahme.
///
/// **Die Rückgabe an das SDK** geschieht erst, wenn CallKit die Session
/// wirklich losgelassen hat (`didDeactivate`) — sonst richtete das SDK sie
/// ein, und CallKit deaktivierte sie Augenblicke später unter dem Kanal weg.
/// Dann: Übersteuerung zurück, Automatik an, Maschine frei; das SDK richtet
/// die Session beim Wiederanlaufen nach dem Wunsch des Kanals neu ein
/// (`engineWillEnable`), und der Kanal hört wieder.
///
/// **Die beiden Hörmuschel-Wege überschreiben einander nicht.** Der Kanal
/// schreibt nur `isSpeakerOutputPreferred`, und das liest das SDK nur bei
/// eingeschalteter Automatik — während CallKit führt, bleibt der Wunsch
/// liegen und gilt danach. Der Anruf schreibt nur die Übersteuerung, und die
/// wird bei der Rückgabe zurückgenommen. Welcher Weg gilt, beantwortet
/// `callkitAktiv` (Entwurf §6).
///
/// **Was nur am Gerät zu belegen ist** (der Simulator aktiviert keine
/// CallKit-Session): dass das Mikrofon im Anruf trägt, während die Spur im
/// Kanal stumm ist; die Hörmuschel am Ohr; die Rückkehr in den Kanal.
extension Anrufverwaltung {
    /// CallKit übernimmt — aus `CXAnswerCallAction`/`CXStartCallAction`,
    /// VOR dem `fulfill`.
    func sessionUebernehmen() {
        rueckgabeUhr?.cancel()
        rueckgabeUhr = nil
        // Ein gebuchtes Gespräch ohne CallKit bleibt gebucht: es ist ein
        // ANDERES als das, das CallKit jetzt trägt (dasselbe kann es nicht
        // sein, s. `fuehrt`), und es endet über `beenden` wie jedes andere.
        // Läuft es dann noch, führt nach der Rückgabe das SDK wieder für es
        // (`sessionZurueckgeben`). Bis zum 2026-10-11 fiel es hier aus der
        // Buchführung, und die Rückgabe gab den Kanal frei, während es lief.
        guard !callkitAktiv else { return }
        callkitAktiv = true
        NSLog("[PulseAnruf] CallKit übernimmt die Audio-Session")
        kanalPause(true)
        AudioManager.shared.audioSession.isAutomaticConfigurationEnabled = false
        maschineStellen(.none, "anhalten")
        kategorieSetzen()
    }

    /// `provider(_:didActivate:)`.
    func sessionAktiviert() {
        sessionAktiv = true
        kategorieSetzen()
        ausgabeAnwenden(lautsprecher: AnrufRaum.geteilt.lautsprecher)
        // Ohne Erlaubnis nur die Ausgabe: `setEngineAvailability` wirft
        // sonst (`deviceAccessDenied`, Doc-Kommentar des SDK), und man
        // hörte die Gegenseite nicht einmal.
        let maschine = Self.mikrofonErlaubt()
            ? AudioEngineAvailability.default
            : AudioEngineAvailability(isInputAvailable: false, isOutputAvailable: true)
        maschineStellen(maschine, "freigeben")
        NSLog("[PulseAnruf] Session aktiv, Route: %@", Self.routeJetzt())
    }

    /// `provider(_:didDeactivate:)` — auch mitten im Anruf möglich (ein
    /// Mobilfunk-Gespräch drängt sich dazwischen); dann kommt `didActivate`
    /// wieder.
    func sessionDeaktiviert() {
        sessionAktiv = false
        try? AudioManager.shared.setEngineAvailability(.none)
        if kennungen.isEmpty { sessionZurueckgeben() }
    }

    /// Der letzte CallKit-Eintrag ist aus der Buchführung (aus `vergessen`).
    ///
    /// **Ein Gespräch ohne CallKit endet hier NICHT.** Bis zum 2026-10-11
    /// gab dieser Weg es frei — aber CallKit-Einträge neben einem Gespräch
    /// ohne CallKit gehören immer einem ANDEREN Anruf (einem, der nur
    /// klingelte, oder dem Eintrag, den CallKit selbst beendet hat). Lehnte
    /// man den ab, lief das Gespräch weiter, während der Kanal wieder
    /// zuhörte und sein Mikrofon öffnete. Das Gespräch endet über
    /// `ohneCallKitBeendet`, mit seiner Kennung.
    func letzterAnrufVorbei() {
        guard callkitAktiv else { return }
        guard sessionAktiv else {
            sessionZurueckgeben()
            return
        }
        // CallKit deaktiviert gleich (`didDeactivate`). Bleibt das aus, gibt
        // die Hülle trotzdem zurück — ein Kanal, der für immer schweigt, wäre
        // der schlimmere Fehler. Die 3 s sind gesetzt, nicht gemessen.
        let uhr = DispatchWorkItem { [weak self] in
            guard let self, callkitAktiv, kennungen.isEmpty else { return }
            NSLog("[PulseAnruf] CallKit hat die Session nicht abgegeben — Rückgabe trotzdem")
            sessionAktiv = false
            sessionZurueckgeben()
        }
        rueckgabeUhr = uhr
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: uhr)
    }

    /// An das SDK zurück; der Kanal hört wieder.
    func sessionZurueckgeben() {
        rueckgabeUhr?.cancel()
        rueckgabeUhr = nil
        guard callkitAktiv else { return }
        callkitAktiv = false
        NSLog("[PulseAnruf] Audio-Session zurück an das SDK")
        try? AVAudioSession.sharedInstance().overrideOutputAudioPort(.none)
        AudioManager.shared.audioSession.isAutomaticConfigurationEnabled = true
        maschineStellen(.default, "freigeben")
        // Läuft daneben ein Gespräch ohne CallKit (abgewiesen, während CallKit
        // die Session noch hielt — die Rückgabe wartet bis zu 3 s auf
        // `didDeactivate`), bleibt der Kanal angehalten, und das SDK führt
        // die Session jetzt für DIESES Gespräch.
        if ohneCallKit {
            ohneCallKitSessionUebernehmen()
        } else {
            kanalPause(false)
        }
    }

    // MARK: - Ohne CallKit

    /// CallKit hat den Anruf abgewiesen (Simulator, ein laufendes
    /// Mobilfunk-Gespräch, eine Sperre). Das Gespräch läuft trotzdem — mit
    /// der Automatik des SDK, wie der Kanal. Der Hörmuschel-Schalter ist dann
    /// DERSELBE wie der des Kanals; dessen Wunsch wird gemerkt und nach dem
    /// Anruf zurückgestellt (`kanalWunschMerken`).
    ///
    /// **Die Kennung wird IMMER gebucht**, auch wenn CallKit die Session noch
    /// hält (Rückgabe ausstehend, s. `sessionZurueckgeben`): ein Gespräch,
    /// das die Buchführung nicht kennt, bekommt keinen Raum
    /// (`AnrufRaum.beitreten`) und klingelt auf jeden Push neu.
    func ohneCallKitUebernehmen(kennung: String) {
        if let alt = ohneCallKitKennung, alt != kennung {
            // Es gibt EINEN Anruf-Raum; ein zweites Gespräch ohne CallKit
            // verdrängt das erste (`AnrufRaum.beitreten` verlässt es).
            kuerzlichBeendet[alt] = Date()
        }
        let neu = ohneCallKitKennung == nil
        ohneCallKitKennung = kennung
        NSLog("[PulseAnruf] ohne CallKit: %@", kennung)
        if neu, !callkitAktiv { ohneCallKitSessionUebernehmen() }
    }

    /// Das SDK führt die Session für das Gespräch ohne CallKit: der
    /// Hörmuschel-Wunsch des Anrufs gilt, der des Kanals wird gemerkt, der
    /// Kanal hält an.
    private func ohneCallKitSessionUebernehmen() {
        NSLog("[PulseAnruf] ohne CallKit — das SDK führt die Session")
        if kanalLautsprecher == nil {
            kanalLautsprecher = AudioManager.shared.isSpeakerOutputPreferred
        }
        AudioManager.shared.isSpeakerOutputPreferred = AnrufRaum.geteilt.lautsprecher
        kanalPause(true)
    }

    /// **Das Gespräch ohne CallKit ist zu Ende** — aus `beenden`,
    /// `vonDerHuelleBeendet` und `providerDidReset` (verdrängt ein zweites
    /// es, merkt `ohneCallKitUebernehmen` es nur als beendet). Wie
    /// `anrufZu` für einen CallKit-Anruf: als kürzlich beendet merken (ein
    /// Push danach klingelt nicht neu), Raum trennen, den Hörmuschel-Wunsch
    /// des Kanals zurück, Kanal frei — es sei denn, CallKit hält die Session
    /// gerade für einen anderen Anruf; dann gibt `sessionZurueckgeben` frei.
    func ohneCallKitBeendet(_ kennung: String) {
        guard ohneCallKitKennung == kennung else { return }
        ohneCallKitKennung = nil
        kuerzlichBeendet[kennung] = Date()
        Task { await AnrufRaum.geteilt.verlassen(nur: kennung) }
        if let wunsch = kanalLautsprecher { AudioManager.shared.isSpeakerOutputPreferred = wunsch }
        kanalLautsprecher = nil
        if !callkitAktiv { kanalPause(false) }
    }

    /// Ein Ausgabe-Wunsch des KANALS während eines Anrufs ohne CallKit: gemerkt
    /// statt angewandt — sonst drehte er dem Anruf die Route weg. `true`, wenn
    /// er gemerkt wurde.
    func kanalWunschMerken(lautsprecher: Bool) -> Bool {
        guard ohneCallKit else { return false }
        kanalLautsprecher = lautsprecher
        return true
    }

    // MARK: - Route und Kategorie

    /// Hörmuschel oder Lautsprecher im Anruf — der ZWEITE Weg (Entwurf §6).
    ///
    /// Die Kategorie trägt bewusst kein `.defaultToSpeaker`: `.none` heisst
    /// „Vorgabe der Kategorie", und die ist damit die Hörmuschel
    /// (`AudioSessionPlugin.ausgabewunsch` erklärt, warum `.none` mit
    /// `.defaultToSpeaker` den Lautsprecher bedeutet — die Falle vom
    /// 2026-10-10).
    func ausgabeAnwenden(lautsprecher: Bool) {
        if callkitAktiv {
            // Vor `didActivate` wirkt eine Übersteuerung nicht; sie wird dort
            // nachgeholt.
            guard sessionAktiv else { return }
            do {
                try AVAudioSession.sharedInstance().overrideOutputAudioPort(
                    lautsprecher ? .speaker : .none)
            } catch {
                NSLog("[PulseAnruf] Ausgabe stellen fehlgeschlagen: %@", error.localizedDescription)
            }
        } else if ohneCallKit {
            AudioManager.shared.isSpeakerOutputPreferred = lautsprecher
        }
    }

    /// `.voiceChat`: Apples Sprachverarbeitung und Echo-Auslöschung — und am
    /// Ohr die richtige Wahl. Bluetooth-Kopfhörer bleiben erlaubt.
    private func kategorieSetzen() {
        do {
            try AVAudioSession.sharedInstance().setCategory(
                .playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP, .allowBluetoothA2DP])
        } catch {
            NSLog("[PulseAnruf] Kategorie setzen fehlgeschlagen: %@", error.localizedDescription)
        }
    }

    /// Die Audio-Maschine sperren oder freigeben. Ein Fehlschlag wird
    /// geloggt, nicht geworfen — die Übergabe läuft trotzdem weiter.
    private func maschineStellen(_ stand: AudioEngineAvailability, _ was: String) {
        do {
            try AudioManager.shared.setEngineAvailability(stand)
        } catch {
            NSLog("[PulseAnruf] Maschine %@ fehlgeschlagen: %@", was, error.localizedDescription)
        }
    }

    private func kanalPause(_ an: Bool) {
        Task { try? await SpracheRaum.geteilt.nacheinander { await SpracheRaum.geteilt.anrufPause(an) } }
    }

    static func routeJetzt() -> String {
        AVAudioSession.sharedInstance().currentRoute.outputs.first?.portType.rawValue ?? "(keiner)"
    }

    // MARK: - Mikrofon-Erlaubnis

    static func mikrofonErlaubt() -> Bool {
        if #available(iOS 17.0, *) {
            return AVAudioApplication.shared.recordPermission == .granted
        }
        return AVAudioSession.sharedInstance().recordPermission == .granted
    }

    /// Fragen, falls noch nicht entschieden. **Nötig, weil das SDK es im
    /// CallKit-Fall selbst nicht tut**: bei gesperrter Maschine überspringt
    /// es die Frage (`LocalAudioTrack.startCapture`). Auf dem Sperrbildschirm
    /// erscheint kein Dialog; dann bleibt es beim Zuhören.
    static func mikrofonErlaubnisHolen() async {
        if #available(iOS 17.0, *) {
            guard AVAudioApplication.shared.recordPermission == .undetermined else { return }
            _ = await AVAudioApplication.requestRecordPermission()
            return
        }
        guard AVAudioSession.sharedInstance().recordPermission == .undetermined else { return }
        await withCheckedContinuation { (fertig: CheckedContinuation<Void, Never>) in
            AVAudioSession.sharedInstance().requestRecordPermission { _ in fertig.resume() }
        }
    }
}
