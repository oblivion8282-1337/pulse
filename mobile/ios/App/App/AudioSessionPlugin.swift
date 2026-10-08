import AVFoundation
import Capacitor

/// Audio-Session-Steuerung für die Hülle (Etappe 3, Punkte 21/23/24/26).
///
/// Die Web-App läuft im WKWebView und spricht WebRTC — dieselbe
/// Prozess-Audio-Session. Native Steuerung ist nötig, weil iOS die Session
/// beim Sperren des Displays sonst killt (Hintergrund-Ton braucht den
/// `audio`-Background-Mode in der Info.plist) und weil der Voice-Modus
/// (`voiceChat`) das iOS-eigene Echo-Auslösen + Bluetooth-Mikrofon
/// freischaltet, das der Browser-Stack nicht anfasst.
///
/// **Wer hier etwas aufruft, geht über `platform/iosTon.ts`** — nicht direkt.
/// Es gibt EINE Session je Prozess und zwei Verbraucher (Sprachkanal und
/// Stream-Ton); wer sie unabhängig schaltet, reisst dem anderen den Ton weg.
///
/// Android-Pendant: `AudioRoutePlugin` (setVoiceActive vor room.connect()).
@objc(AudioSessionPlugin)
public class AudioSessionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AudioSessionPlugin"
    public let jsName = "AudioSessionPlugin"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setVoiceActive", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPlaybackMode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "routen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "routeSetzen", returnType: CAPPluginReturnPromise)
    ]

    /// Beobachter werden EINMAL gesetzt, beim ersten Laden des Plugins.
    /// `load()` ist Capacitors Haken dafür; ein Aufruf aus `setVoiceActive`
    /// würde sie bei jedem Betreten erneut anhängen.
    public override func load() {
        let z = NotificationCenter.default
        z.addObserver(
            self, selector: #selector(unterbrechung(_:)),
            name: AVAudioSession.interruptionNotification, object: nil)
        z.addObserver(
            self, selector: #selector(routeGewechselt(_:)),
            name: AVAudioSession.routeChangeNotification, object: nil)
    }

    // MARK: - Betriebsarten

    /// Voice-Modus an/aus: `aktiv` = playAndRecord + voiceChat (Mikro, Echo-
    /// Auslösen, Bluetooth), sonst Session deaktivieren mit
    /// notifyOthersOnDeactivation (pausiert höflich fremde Musik-Apps).
    @objc func setVoiceActive(_ call: CAPPluginCall) {
        let aktiv = call.getBool("aktiv") ?? false
        let session = AVAudioSession.sharedInstance()
        do {
            if aktiv {
                try session.setCategory(
                    .playAndRecord,
                    mode: .voiceChat,
                    options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker]
                )
                try session.setActive(true)
            } else {
                try session.setActive(false, options: [.notifyOthersOnDeactivation])
            }
            call.resolve()
        } catch {
            call.reject("audio_session_error", nil, error)
        }
    }

    /// Playback-Modus für Watch-/Stream-Ton (ohne Mikro, category playback
    /// übersteht das Sperren dank Background-Mode).
    @objc func setPlaybackMode(_ call: CAPPluginCall) {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default)
            try session.setActive(true)
            call.resolve()
        } catch {
            call.reject("audio_session_error", nil, error)
        }
    }

    // MARK: - Wege (Punkt 24)

    /// Welche Ausgabewege es gibt und welcher gerade gilt.
    ///
    /// **iOS wählt anders als Android.** Dort pinnt man ein Ausgabegerät; hier
    /// wählt man den EINGANG, und der Ausgang folgt ihm (bei einem
    /// Bluetooth-Headset ist beides dasselbe Gerät). Lautsprecher und
    /// Hörmuschel sind kein Eingang, sondern eine Übersteuerung
    /// (`overrideOutputAudioPort`) — deshalb stehen sie hier als zwei feste
    /// Einträge neben den echten Geräten.
    @objc func routen(_ call: CAPPluginCall) {
        let session = AVAudioSession.sharedInstance()
        var geraete: [[String: Any]] = [
            ["id": "speaker", "art": "speaker", "name": "Lautsprecher"],
            ["id": "earpiece", "art": "earpiece", "name": "Hörmuschel"]
        ]
        for eingang in session.availableInputs ?? [] {
            // Das eingebaute Mikrofon ist kein eigener WEG — es gehört zu
            // Lautsprecher und Hörmuschel, die schon oben stehen.
            if eingang.portType == .builtInMic { continue }
            geraete.append([
                "id": eingang.uid,
                "art": eingang.portType.rawValue,
                "name": eingang.portName
            ])
        }
        call.resolve([
            "aktuell": session.currentRoute.outputs.first?.portType.rawValue ?? "",
            "aktuellName": session.currentRoute.outputs.first?.portName ?? "",
            "geraete": geraete
        ])
    }

    /// Einen Weg erzwingen. `id` ist entweder `speaker`/`earpiece` oder die
    /// UID eines Eintrags aus `routen()`.
    @objc func routeSetzen(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("id_fehlt")
            return
        }
        let session = AVAudioSession.sharedInstance()
        do {
            switch id {
            case "speaker":
                try session.setPreferredInput(nil)
                try session.overrideOutputAudioPort(.speaker)
            case "earpiece":
                try session.setPreferredInput(nil)
                try session.overrideOutputAudioPort(.none)
            default:
                guard let eingang = (session.availableInputs ?? []).first(where: { $0.uid == id })
                else {
                    // Gerät inzwischen weg (Headset abgezogen): kein Fehler,
                    // sondern ein Zustand. Die Oberfläche holt die Liste neu.
                    call.reject("geraet_weg")
                    return
                }
                // Übersteuerung ZUERST zurücknehmen: ein stehengebliebenes
                // `.speaker` schlägt jede Eingangswahl und das Headset bliebe
                // stumm, obwohl es gewählt ist.
                try session.overrideOutputAudioPort(.none)
                try session.setPreferredInput(eingang)
            }
            call.resolve()
        } catch {
            call.reject("audio_session_error", nil, error)
        }
    }

    // MARK: - Ereignisse

    /// Telefonanruf, Siri, Wecker (Punkt 26).
    ///
    /// iOS deaktiviert die Session beim Beginn der Unterbrechung selbst; ohne
    /// Gegenmassnahme bleibt sie danach TOT, und der Sprachkanal ist stumm,
    /// obwohl die Verbindung steht. Wir melden beides nach oben — das Wieder-
    /// Aktivieren macht der Koordinator im Web (`platform/iosTon.ts`), weil
    /// nur er weiss, ob gerade Voice oder Wiedergabe gilt.
    ///
    /// `shouldResume` wird mitgereicht und NICHT hier ausgewertet: iOS setzt
    /// es nicht immer (bei einem Anruf schon, bei manchen Apps nicht), und die
    /// Entscheidung, es trotzdem zu versuchen, gehört zur Anwendung.
    @objc private func unterbrechung(_ nachricht: Notification) {
        guard
            let info = nachricht.userInfo,
            let roh = info[AVAudioSessionInterruptionTypeKey] as? UInt,
            let art = AVAudioSession.InterruptionType(rawValue: roh)
        else { return }
        var nutzlast: [String: Any] = ["art": art == .began ? "begonnen" : "beendet"]
        if art == .ended, let optRoh = info[AVAudioSessionInterruptionOptionKey] as? UInt {
            nutzlast["weiterMoeglich"] =
                AVAudioSession.InterruptionOptions(rawValue: optRoh).contains(.shouldResume)
        }
        notifyListeners("unterbrechung", data: nutzlast)
    }

    /// Headset rein/raus, AirPods verbunden — die Oberfläche soll ihre
    /// Wege-Liste neu holen statt eine veraltete zu zeigen.
    @objc private func routeGewechselt(_ nachricht: Notification) {
        let session = AVAudioSession.sharedInstance()
        notifyListeners("routeGewechselt", data: [
            "aktuell": session.currentRoute.outputs.first?.portType.rawValue ?? "",
            "aktuellName": session.currentRoute.outputs.first?.portName ?? ""
        ])
    }
}
