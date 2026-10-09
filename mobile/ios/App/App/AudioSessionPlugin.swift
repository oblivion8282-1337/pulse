import AVFoundation
import AVKit
import UIKit
import Capacitor
import MediaPlayer

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
        CAPPluginMethod(name: "routeSetzen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "jetztLaeuft", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "jetztLaeuftAus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "airplayWaehler", returnType: CAPPluginReturnPromise)
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

    /// Welcher Ausgabeweg gerade gilt — die Session wird danach eingerichtet.
    ///
    /// **Warum routenabhängig und nicht ein Satz für alles.** Bis zum
    /// 2026-10-08 stand hier eine feste Konfiguration, und die musste einen
    /// Kompromiss sein. Sie ist keiner mehr, sobald man hinsieht: Echo
    /// entsteht, wenn ein Lautsprecher in einem Raum ins Mikrofon
    /// zurückstrahlt — mit Kopfhörern im Ohr gibt es diesen Weg praktisch
    /// nicht. Und umgekehrt kostet Bluetooth Qualität, der Telefonlautsprecher
    /// nicht. **Die beiden Nöte treten also nie gleichzeitig auf**, und ein
    /// gemeinsamer Satz Einstellungen verschenkt in jedem Einzelfall etwas.
    private enum Tonweg {
        /// Eingebauter Lautsprecher oder Hörmuschel: Echo-Unterdrückung ist
        /// hier unverzichtbar, Bluetooth-Qualität steht nicht zur Debatte.
        case eingebaut
        /// Kabel (Klinke, USB, Auto): voller Klang OHNE Bluetooth-Einschränkung,
        /// Echo-Weg praktisch null. Hier kostet `voiceChat` nichts.
        case kabel
        /// Bluetooth: der EINZIGE Fall, in dem es eng ist — mit offenem
        /// Mikrofon verlässt der Kopfhörer A2DP und beide Richtungen werden
        /// schmalbandig und mono.
        case funk
    }

    private func wegJetzt() -> Tonweg {
        let ausgaenge = AVAudioSession.sharedInstance().currentRoute.outputs
        let funk: Set<AVAudioSession.Port> = [.bluetoothA2DP, .bluetoothHFP, .bluetoothLE]
        if ausgaenge.contains(where: { funk.contains($0.portType) }) { return .funk }
        let kabel: Set<AVAudioSession.Port> = [
            .headphones, .usbAudio, .carAudio, .lineOut, .HDMI, .airPlay
        ]
        if ausgaenge.contains(where: { kabel.contains($0.portType) }) { return .kabel }
        return .eingebaut
    }

    /// Apples eigene Empfehlungen für Sprach-Sitzungen, die hier fehlten.
    ///
    /// **Vor dem Aktivieren setzen** (Apple, QA1631): an einer AKTIVEN Session
    /// sind das nur Wünsche, die oft verpuffen. Beides sind ohnehin Wünsche —
    /// was die Hardware wirklich liefert, entscheidet sie.
    private func wuenscheSetzen(_ session: AVAudioSession) {
        try? session.setPreferredSampleRate(48_000)
        try? session.setPreferredIOBufferDuration(0.02)
    }

    /// Voice-Modus an/aus: `aktiv` = playAndRecord mit der Konfiguration, die
    /// zum aktuellen Weg passt, sonst Session deaktivieren mit
    /// notifyOthersOnDeactivation (pausiert höflich fremde Musik-Apps).
    ///
    /// **Während CallKit einen Anruf führt, wird die Session NICHT selbst
    /// aktiviert oder deaktiviert** (Punkt 40). Apples Regel: bei CallKit
    /// konfiguriert die App die Kategorie, AKTIVIERT aber der `CXProvider`
    /// (`didActivate`). Wer sie daneben selbst anfasst, nimmt sie ihm weg —
    /// der angenommene Anruf bleibt stumm, und das `setActive(false)` beim
    /// Verlassen würde einen laufenden CallKit-Anruf mitreissen. Die
    /// Kategorie wird weiter gesetzt: sie ist unsere Sache und sagt dem
    /// System, WAS für eine Sitzung das ist.
    @objc func setVoiceActive(_ call: CAPPluginCall) {
        let aktiv = call.getBool("aktiv") ?? false
        // Opt-in für die Hochqualitäts-Route über Bluetooth. **Vorgabe aus**,
        // bis sie an einem Gerät gemessen ist: es gibt einen Bericht, dass
        // WebRTC-Engines auf dieser Route VERSTUMMEN, und Stille ist für eine
        // Sprach-App der schlimmste Fehlschlag. Siehe `modus` in der Antwort.
        let hqFunk = call.getBool("hqFunk") ?? false
        let session = AVAudioSession.sharedInstance()
        let callkit = Anrufverwaltung.geteilt.callkitAktiv
        do {
            if aktiv {
                let modus = try voiceEinrichten(session, hqFunk: hqFunk)
                if !callkit { try session.setActive(true) }
                // Der Modus geht ZURÜCK ans Web, weil daran die eigene
                // Rauschunterdrückung hängt: bei `voiceChat` filtert Apple
                // schon, bei `default` nicht. Zweimal filtern verdirbt die
                // Stimme (abgeschnittene Wortanfänge) — es soll in jeder
                // Konfiguration genau EINER filtern.
                call.resolve(["modus": modus])
                return
            }
            if !callkit {
                try session.setActive(false, options: [.notifyOthersOnDeactivation])
            }
            call.resolve(["modus": "aus"])
        } catch {
            call.reject("audio_session_error", nil, error)
        }
    }

    /// Richtet die Sprach-Session für den aktuellen Weg ein und liefert den
    /// gewählten Modus (`voiceChat` oder `default`).
    /// **Diese Session nimmt das Mikrofon NICHT auf.** Am 2026-10-10 am Gerät
    /// mitgeschnitten: aufgenommen wird auf der Session der WebView
    /// (`com.apple.WebKit`, `has started recording`), der systemweite Modus
    /// war `VideoChat`. Was hier gesetzt wird, beschreibt also eine zweite,
    /// tonlose Session — und der zurückgelieferte Modus, an dem die eigene
    /// Rauschunterdrückung hängt, beschreibt sie mit.
    ///
    /// Heute geht das gut, weil `voiceChat` und `VideoChat` beide Apples
    /// Verarbeitung einschalten. Es bricht, sobald `hqFunk` auf `default`
    /// stellt — die volle Herleitung steht an der Einstellung `bluetoothHq`
    /// (`web/src/lib/settings-registry/sections/audio.ts`).
    private func voiceEinrichten(_ session: AVAudioSession, hqFunk: Bool) throws -> String {
        // `.allowBluetoothHFP` (früher `.allowBluetooth`) — der neue Name sagt,
        // was die Option wirklich tut: sie ERLAUBT das Hands-Free-Profil, und
        // genau das zieht einen Kopfhörer bei offenem Mikrofon aus A2DP heraus
        // ins Schmalband. Sie bleibt trotzdem drin: ohne sie gibt es mit einem
        // Bluetooth-Kopfhörer gar kein Mikrofon.
        var optionen: AVAudioSession.CategoryOptions = [
            .allowBluetoothHFP, .allowBluetoothA2DP, .defaultToSpeaker
        ]
        wuenscheSetzen(session)

        // Hochqualitäts-Bluetooth gibt es erst ab iOS 26, nur für Kopfhörer,
        // die es tragen (sonst fällt iOS auf HFP zurück) — und **nur mit
        // `mode: .default`**: die Option verlangt es, und damit entfällt
        // Apples Sprachverarbeitung. Für Kopfhörer im Ohr ist das der richtige
        // Tausch, weil es dort kaum einen akustischen Echo-Weg gibt.
        if hqFunk, wegJetzt() == .funk {
            if #available(iOS 26.0, *) {
                optionen.insert(.bluetoothHighQualityRecording)
                try session.setCategory(.playAndRecord, mode: .default, options: optionen)
                return "default"
            }
        }
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: optionen)
        return "voiceChat"
    }

    /// Playback-Modus für Watch-/Stream-Ton (ohne Mikro, category playback
    /// übersteht das Sperren dank Background-Mode).
    @objc func setPlaybackMode(_ call: CAPPluginCall) {
        let session = AVAudioSession.sharedInstance()
        do {
            wuenscheSetzen(session)
            // `.playback` + `.default` ist für Wiedergabe schon das Beste, was
            // die Plattform hat: keine Sprachverarbeitung, kein HFP-Zwang
            // (ohne offenes Mikrofon bleibt Bluetooth in A2DP, also stereo).
            // `.allowBluetoothA2DP` wird hier NICHT gesetzt — die Kategorie
            // nimmt A2DP von sich aus; die Option gehört zu `playAndRecord`.
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

    // MARK: - Sperrbildschirm und Kontrollzentrum (Punkt 25)

    /// Was gerade läuft, auf dem Sperrbildschirm und im Kontrollzentrum
    /// anzeigen — plus die beiden Knöpfe, die dort etwas bewirken können.
    ///
    /// **Was „Pause" bei einem Live-Strom heisst, ist eine Entscheidung.**
    /// Anhalten kann man ihn nicht (er läuft weiter, man verpasst nur), und
    /// Beenden wäre von einem Sperrbildschirm aus zu grob — ein Fehlgriff
    /// risse die Übertragung weg. Hier bedeutet Pause deshalb STUMM, und
    /// Wiedergabe wieder laut. Das ist nicht-zerstörend, sofort umkehrbar und
    /// genau das, was man will, wenn jemand den Raum betritt.
    ///
    /// Mindestens ein aktiver Befehl ist nötig, damit iOS die Anzeige
    /// überhaupt zeigt — eine reine Info-Karte ohne Knöpfe blendet es aus.
    @objc func jetztLaeuft(_ call: CAPPluginCall) {
        let titel = call.getString("titel") ?? "Pulse"
        let zeile2 = call.getString("zeile2") ?? ""
        DispatchQueue.main.async {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = [
                MPMediaItemPropertyTitle: titel,
                MPMediaItemPropertyArtist: zeile2,
                // Live: iOS zeigt dann keinen Fortschrittsbalken, der bei
                // einem laufenden Strom ohnehin nichts bedeutete.
                MPNowPlayingInfoPropertyIsLiveStream: true
            ]
            MPNowPlayingInfoCenter.default().playbackState = .playing
            self.befehleVerdrahten()
            call.resolve()
        }
    }

    @objc func jetztLaeuftAus(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            MPNowPlayingInfoCenter.default().playbackState = .stopped
            call.resolve()
        }
    }

    private var befehleStehen = false

    /// Einmal verdrahten, nicht bei jedem Strom: `addTarget` hängt JEDES Mal
    /// einen weiteren Empfänger an, und dann feuert ein Tastendruck mehrfach.
    private func befehleVerdrahten() {
        guard !befehleStehen else { return }
        befehleStehen = true
        let z = MPRemoteCommandCenter.shared()
        z.playCommand.isEnabled = true
        z.pauseCommand.isEnabled = true
        z.playCommand.addTarget { [weak self] _ in
            self?.notifyListeners("fernbefehl", data: ["befehl": "laut"])
            MPNowPlayingInfoCenter.default().playbackState = .playing
            return .success
        }
        z.pauseCommand.addTarget { [weak self] _ in
            self?.notifyListeners("fernbefehl", data: ["befehl": "stumm"])
            MPNowPlayingInfoCenter.default().playbackState = .paused
            return .success
        }
        // Titelsprünge gibt es hier nicht — ohne das Abschalten zeigt iOS
        // Knöpfe, die nichts tun.
        z.nextTrackCommand.isEnabled = false
        z.previousTrackCommand.isEnabled = false
        z.changePlaybackPositionCommand.isEnabled = false
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

    /// Öffnet Apples AirPlay-Auswahl (Punkt 30).
    ///
    /// **Warum ein unsichtbarer `AVRoutePickerView` und ein ausgelöster Tipp.**
    /// Es gibt keine öffentliche Schnittstelle, die den Auswahl-Dialog direkt
    /// aufruft — `AVRoutePickerView` ist der einzige Weg, und er ist als
    /// sichtbarer Knopf gedacht. Unsere Oberfläche ist Web; einen nativen Knopf
    /// pixelgenau über eine WebView zu legen hiesse, seine Position bei jedem
    /// Umbau der Leiste nachzupflegen. Deshalb hängt der Wähler nur für die
    /// Dauer des Aufrufs in der Hierarchie und sein eigener Knopf wird
    /// programmatisch getippt. Das ist KEINE private Schnittstelle — wir
    /// schicken einer öffentlichen Ansicht eine Aktion auf ihren eigenen
    /// Unterknopf.
    ///
    /// Die Annahme dabei ist, dass dieser Unterknopf ein `UIButton` IST. Sie
    /// trifft heute zu, ist aber von Apple nirgends zugesagt — deshalb wird
    /// der Fehlschlag gemeldet statt verschluckt: das Web kann dann sagen
    /// „bitte über das Kontrollzentrum", anstatt dass ein Knopf still nichts
    /// tut.
    @objc func airplayWaehler(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let wurzel = self.bridge?.viewController?.view else {
                call.reject("keine Ansicht")
                return
            }
            let waehler = AVRoutePickerView(frame: .zero)
            waehler.isHidden = true
            wurzel.addSubview(waehler)
            let knopf = waehler.subviews.compactMap { $0 as? UIButton }.first
            knopf?.sendActions(for: .touchUpInside)
            // Erst im nächsten Durchlauf entfernen: der Dialog wird aus der
            // Aktion heraus aufgebaut, ein sofortiges Entfernen nähme ihm
            // seinen Ursprung.
            DispatchQueue.main.async { waehler.removeFromSuperview() }
            if knopf == nil {
                call.reject("AirPlay-Auswahl nicht erreichbar")
            } else {
                call.resolve()
            }
        }
    }
}
