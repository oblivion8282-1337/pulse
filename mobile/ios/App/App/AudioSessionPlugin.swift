import AVFoundation
import Capacitor

/// Audio-Session-Steuerung für die Hülle (Etappe 3, Item 21/23/26).
///
/// Die Web-App läuft im WKWebView und spricht WebRTC — dieselbe
/// Prozess-Audio-Session. Native Steuerung ist nötig, weil iOS die Session
/// beim Sperren des Displays sonst killt (Hintergrund-Ton braucht den
/// `audio`-Background-Mode in der Info.plist) und weil der Voice-Modus
/// (`voiceChat`) das iOS-eigene Echo-Auslösen + Bluetooth-Mikrofon
/// freischaltet, das der Browser-Stack nicht anfasst.
///
/// Android-Pendant: `AudioRoutePlugin` (setVoiceActive vor room.connect()).
@objc(AudioSessionPlugin)
public class AudioSessionPlugin: CAPPlugin {

    /// Voice-Modus an/aus: `aktiv` = playAndRecord + voiceChat (Mikro, Echo-
    /// Auslösen, Bluetooth), sonst Session deaktivieren mit
    /// notifyOthersOnDeactivation (pausiert höflich fremde Musik-Apps).
    @objc func setVoiceActive(_ call: CAPPluginCall) {
        let aktiv = (call.jsObjectRepresentation["aktiv"] as? Bool) ?? false
        let session = AVAudioSession.sharedInstance()
        do {
            if aktiv {
                try session.setCategory(
                    .playAndRecord,
                    mode: .voiceChat,
                    options: [.allowBluetooth, .defaultToSpeaker]
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
}
