import AVFoundation
import AVKit
import UIKit
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
        CAPPluginMethod(name: "routeSetzen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "jetztLaeuft", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "jetztLaeuftAus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "airplayWaehler", returnType: CAPPluginReturnPromise)
    ]

    /// Welchen Ausgang der Nutzer gewaehlt hat — und warum das gemerkt werden
    /// MUSS, statt ihn nur einmal zu setzen.
    ///
    /// **`overrideOutputAudioPort(.none)` heisst nicht „Hoermuschel".** Es
    /// heisst „keine Uebersteuerung, nimm die Vorgabe der Kategorie" — und die
    /// Vorgabe war hier `.defaultToSpeaker`. Lautsprecher → `.none` →
    /// Lautsprecher: die Hoermuschel war ueber diesen Weg prinzipiell
    /// unerreichbar. Am 2026-10-10 am Geraet belegt, und zwar an einem
    /// Negativbefund: bei jedem Tippen stand im Geraetelog KEIN Routenwechsel.
    /// Der Ruf scheiterte nicht, er gelang und aenderte nichts.
    ///
    /// **Und ein einmaliges Setzen genuegt nicht.** `setCategory` nimmt jede
    /// Uebersteuerung zurueck, und die Session wird bei jedem Routenwechsel neu
    /// eingerichtet (`iosTon.ts`). Ein eben gesetzter Wunsch waere also
    /// Sekundenbruchteile spaeter wieder weg — wer nur die Vorgabe korrigiert,
    /// dreht den Fehler bloss auf die andere Seite.
    ///
    /// Deshalb ueberlebt der Wunsch hier und wird nach JEDEM Einrichten erneut
    /// angewandt (`ausgabeDurchsetzen`).
    ///
    /// **Nicht `private`, und das hat einen Grund:** `private` gilt in Swift
    /// je DATEI, und die Ausgabe-Wahl, die diesen Wunsch setzt, liegt seit dem
    /// 2026-10-10 in `AudioSessionAusgabe.swift` (die Hauptdatei stiess an die
    /// harte Groessen-Grenze). Gespeicherte Eigenschaften koennen nicht in
    /// eine Erweiterung wandern — also bleiben sie hier und werden sichtbar.
    enum Ausgabewunsch { case offen, lautsprecher, hoermuschel }
    var ausgabewunsch: Ausgabewunsch = .offen
    /// Letzter `hqFunk`-Wert, damit `routeSetzen` die Kategorie mit denselben
    /// Vorgaben neu setzen kann wie `setVoiceActive`.
    var letzterHqFunk = false

    /// Merker fuer `befehleVerdrahten()` (in `AudioSessionJetztLaeuft.swift`).
    ///
    /// **Steht hier, obwohl die Sperrbildschirm-Anzeige ausgezogen ist:**
    /// Swift erlaubt in einer Erweiterung keine gespeicherten Eigenschaften.
    /// Deshalb auch nicht `private` — das gilt je Datei, und der einzige
    /// Leser steht in einer anderen.
    var befehleStehen = false

    /// Den gemerkten Ausgabewunsch anwenden. Nach jedem `setCategory` noetig.
    /// Bewusst ohne `throws`: ein gescheitertes Durchsetzen darf das Einrichten
    /// der Session nicht abbrechen — ohne Wunsch (`.offen`) gibt es ohnehin
    /// nichts zu tun.
    private func ausgabeDurchsetzen(_ session: AVAudioSession) {
        switch ausgabewunsch {
        case .lautsprecher: try? session.overrideOutputAudioPort(.speaker)
        case .hoermuschel: try? session.overrideOutputAudioPort(.none)
        case .offen: break
        }
    }

    /// Zeitmass um einen Ruf, der unbegrenzt lange dauern kann.
    ///
    /// **Warum das dauerhaft hier steht.** `setCategory` und `setActive` sind
    /// die einzigen Stellen im Tonweg, die auf den Audio-Server des Systems
    /// warten — sie koennen Millisekunden brauchen oder Sekunden, und das
    /// haengt nicht an unserem Code. Capacitor arbeitet Plugin-Rufe auf EINER
    /// gemeinsamen, SERIELLEN Warteschlange ab (`DispatchQueue(label:
    /// "bridge")`, `CapacitorBridge.swift`), also haelt eine lange Wartezeit
    /// hier jeden anderen Plugin-Ruf mit auf.
    ///
    /// Ohne Messung ist genau das nicht von „die App haengt" zu
    /// unterscheiden. Am 2026-10-10 wurde deshalb dem Hauptthread
    /// angelastet, was nie auf ihm lief, und daraufhin eine richtige
    /// Reihenfolge zurueckgenommen (s. `tonVoice` in `livekit.svelte.ts`).
    /// Die Zeile sagt beides: welcher Thread, und wie lange.
    private func gemessen<T>(_ was: String, _ block: () throws -> T) rethrows -> T {
        let start = CFAbsoluteTimeGetCurrent()
        defer {
            NSLog("[PulseTon] %@ dauer=%.0fms haupt=%@", was,
                  (CFAbsoluteTimeGetCurrent() - start) * 1000,
                  Thread.isMainThread ? "JA" : "nein")
        }
        return try block()
    }

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
    enum Tonweg {
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

        /// Name fuer die Bruecke. **Das Web vergleicht Tonwege, nicht Ports.**
        /// Genau diese drei Faelle entscheiden die Konfiguration — ein Wechsel
        /// von Lautsprecher auf Hoermuschel ist derselbe Tonweg und braucht
        /// kein Neueinrichten. Die Einteilung bleibt dadurch an EINER Stelle
        /// (hier), und das Web muss keine Porttypen kennen.
        var kennung: String {
            switch self {
            case .eingebaut: return "eingebaut"
            case .kabel: return "kabel"
            case .funk: return "funk"
            }
        }
    }

    func wegJetzt() -> Tonweg {
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
        letzterHqFunk = hqFunk
        let session = AVAudioSession.sharedInstance()
        let callkit = Anrufverwaltung.geteilt.callkitAktiv
        NSLog("[PulseTon] setVoiceActive aktiv=%@ hqFunk=%@ callkit=%@",
              aktiv ? "JA" : "nein", hqFunk ? "JA" : "nein", callkit ? "JA" : "nein")
        do {
            if aktiv {
                let modus = try gemessen("setCategory(voice)") {
                    try voiceEinrichten(session, hqFunk: hqFunk)
                }
                if !callkit {
                    try gemessen("setActive(true)") { try session.setActive(true) }
                }
                // Erst JETZT durchsetzen: `overrideOutputAudioPort` verlangt
                // eine aktive Session, und `setCategory` oben hat jede
                // vorherige Uebersteuerung geloescht.
                ausgabeDurchsetzen(session)
                // Der Modus geht ZURÜCK ans Web, weil daran die eigene
                // Rauschunterdrückung hängt: bei `voiceChat` filtert Apple
                // schon, bei `default` nicht. Zweimal filtern verdirbt die
                // Stimme (abgeschnittene Wortanfänge) — es soll in jeder
                // Konfiguration genau EINER filtern.
                //
                // Der Weg geht MIT zurueck: daran erkennt das Web, ob ein
                // spaeter gemeldeter Routenwechsel ueberhaupt einer ist, der
                // eine neue Einrichtung braucht (`iosTon.ts`). Bewusst NACH
                // dem Einrichten gelesen — das ist der Zustand, gegen den
                // kuenftige Ereignisse verglichen werden.
                call.resolve(["modus": modus, "weg": wegJetzt().kennung])
                return
            }
            if !callkit {
                try gemessen("setActive(false)") {
                    try session.setActive(false, options: [.notifyOthersOnDeactivation])
                }
            }
            // Der Wunsch gilt fuer die Sitzung, nicht fuer immer. Ohne das
            // bliebe `.defaultToSpeaker` nach einmal „Hoermuschel" dauerhaft
            // aus der Kategorie — auch beim naechsten Beitritt.
            ausgabewunsch = .offen
            call.resolve(["modus": "aus", "weg": wegJetzt().kennung])
        } catch {
            // **Laut scheitern.** Ein verschluckter Fehlschlag hier ist der
            // teuerste Zustand ueberhaupt: die Session ist nicht aktiv, der
            // Klient haelt sich fuer verbunden, und niemand hoert etwas. Die
            // Gegenseite meldet es seit dem 2026-10-10 auch im Web
            // (`iosVoiceAktiv`), vorher ging beides still unter.
            NSLog("[PulseTon] setVoiceActive FEHLER aktiv=%@: %@",
                  aktiv ? "JA" : "nein", error.localizedDescription)
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
    /// `mitWuenschen: false` laesst `setPreferredSampleRate`/
    /// `setPreferredIOBufferDuration` aus. Die gehoeren laut Apple VOR das
    /// Aktivieren — mitten im Betrieb sind sie eine komplette
    /// Hardware-Neukonfiguration, und die Session teilen wir uns mit WebKit.
    func voiceEinrichten(
        _ session: AVAudioSession, hqFunk: Bool, mitWuenschen: Bool = true
    ) throws -> String {
        // `.allowBluetoothHFP` (früher `.allowBluetooth`) — der neue Name sagt,
        // was die Option wirklich tut: sie ERLAUBT das Hands-Free-Profil, und
        // genau das zieht einen Kopfhörer bei offenem Mikrofon aus A2DP heraus
        // ins Schmalband. Sie bleibt trotzdem drin: ohne sie gibt es mit einem
        // Bluetooth-Kopfhörer gar kein Mikrofon.
        var optionen: AVAudioSession.CategoryOptions = [
            .allowBluetoothHFP, .allowBluetoothA2DP
        ]
        // `.defaultToSpeaker` NUR, wenn die Hoermuschel nicht gewuenscht ist:
        // es ist die Vorgabe, auf die `overrideOutputAudioPort(.none)`
        // zurueckfaellt — mit ihr drin ist die Hoermuschel unerreichbar
        // (s. `ausgabewunsch`).
        if ausgabewunsch != .hoermuschel { optionen.insert(.defaultToSpeaker) }
        if mitWuenschen { wuenscheSetzen(session) }

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
    /// Unterbrechungen melden — **zum MITLESEN, nicht als Handlungsanweisung.**
    ///
    /// Im Web hoert darauf seit dem 2026-10-10 niemand mehr, und das ist
    /// Absicht: wer auf eine beendete Unterbrechung hin unsere Session wieder
    /// aktiviert, unterbricht damit WebKit — und raeumt dessen laufende
    /// Aufnahme ab. Die volle Messung steht in `platform/iosTon.ts` an der
    /// Stelle, wo der Hoerer frueher sass.
    ///
    /// Die Meldung bleibt, weil sie im Geraetelog die halbe Diagnose ist: an
    /// ihr liest man ab, wann die beiden Sessions einander in die Quere
    /// kommen.
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
        // **Ins Geraetelog, nicht nur ueber die Bruecke.** Ob eine
        // Unterbrechung gemeldet wurde und was das Web daraus gemacht hat,
        // war am 2026-10-10 nicht entscheidbar — die Web-Konsole ist am
        // Telefon nur ueber Kabel und Safari erreichbar, der Systemlog
        // dagegen laesst sich mitlesen. Ohne diese Zeile sieht „der Handler
        // lief nicht" genauso aus wie „es kam nie etwas an".
        NSLog("[PulseTon] Unterbrechung %@ weiterMoeglich=%@",
              art == .began ? "begonnen" : "beendet",
              String(describing: nutzlast["weiterMoeglich"] ?? "-"))
        notifyListeners("unterbrechung", data: nutzlast)
    }

    /// Headset rein/raus, AirPods verbunden — die Oberfläche soll ihre
    /// Wege-Liste neu holen statt eine veraltete zu zeigen.
    @objc private func routeGewechselt(_ nachricht: Notification) {
        let session = AVAudioSession.sharedInstance()
        notifyListeners("routeGewechselt", data: [
            "aktuell": session.currentRoute.outputs.first?.portType.rawValue ?? "",
            "aktuellName": session.currentRoute.outputs.first?.portName ?? "",
            // **Der Tonweg ist der Teil, auf den es ankommt.** Ohne ihn kann
            // das Web nicht unterscheiden, ob dieses Ereignis die Folge der
            // eigenen Einrichtung ist (gleicher Weg) oder ein echter Wechsel
            // — und musste die Antwort bis zum 2026-10-10 ueber eine
            // Zeitfrist raten, was die Rueckkopplung nur verlangsamte statt
            // sie zu beenden.
            "weg": wegJetzt().kennung
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
