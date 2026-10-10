import AVFoundation
import LiveKit

/// Was die Audio-Session der Hülle tut, während der Raum steht — beobachtet,
/// nicht gesteuert.
///
/// **Warum eine eigene Datei.** Hier steht nichts, was etwas bewirkt: nur zwei
/// Beobachter und ihre Begründungen. Zusammen mit der Steuerung lag
/// `SpracheRaum.swift` über der Grössen-Policy (`PLAN.md` §12.1). Reine
/// Verschiebung, Verhalten unverändert; `sessionBeobachter` liegt weiter am
/// Typ, weil eine Erweiterung keine gespeicherte Eigenschaft tragen kann.
extension SpracheRaum {
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
    func sessionBeobachtenFallsNoetig() {
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
}
