import AVFoundation
import CallKit
import Capacitor
import PushKit
import UIKit

/// Eingehende Anrufe: VoIP-Push → CallKit → Web (iOS-Liste Punkt 40).
///
/// **Warum die Verwaltung NICHT im Plugin wohnt.** Ein Capacitor-Plugin
/// entsteht erst, wenn die WebView lädt. Ein VoIP-Push trifft die App aber in
/// jedem Zustand — auch kalt gestartet, bevor irgendeine WebView existiert.
/// Die Registrierung muss deshalb am `AppDelegate` hängen; `Anrufverwaltung`
/// ist der gemeinsame Zustand, das Plugin nur die Brücke zum Web.
///
/// **Die harte Regel von PushKit:** `reportNewIncomingCall` muss im SELBEN
/// Lauf von `didReceiveIncomingPushWith` passieren. Tut es das nicht, beendet
/// iOS die App — und nach Wiederholung entzieht es die VoIP-Pushes ganz. Hier
/// steht deshalb kein `async` und kein Netzaufruf zwischen Push und Meldung.
///
/// Android-Pendant: `AnrufPlugin.java`, gleicher JS-Name (`Anruf`), gleiche
/// Methoden, gleiches `aktion`-Ereignis. Dort ist es eine Benachrichtigung,
/// hier der System-Anrufbildschirm.
public final class Anrufverwaltung: NSObject {
    public static let geteilt = Anrufverwaltung()

    private var registry: PKPushRegistry?
    private var anbieter: CXProvider?
    /// CallKit rechnet in UUIDs, unsere Anruf-Kennungen sind Snowflakes.
    private var kennungen: [UUID: String] = [:]
    /// Der Kontext aus dem Push, je Anruf-Kennung.
    ///
    /// **Warum er aufbewahrt wird:** nimmt der Nutzer einen kalt gestarteten
    /// Anruf auf dem Sperrbildschirm an, hat das Web noch nie ein
    /// `call_klingelt` gesehen — sein Zustand ist leer, und eine Annahme mit
    /// nur der Kennung liefe ins Nichts. Der Kanal und die Art stehen im
    /// Push; sie reisen deshalb mit der Aktion ins Web.
    private var kontexte: [String: [String: String]] = [:]

    /// Der PushKit-Token dieses Geräts, sobald ihn das System geliefert hat.
    public private(set) var token: String?

    /// `true`, solange CallKit einen Anruf führt.
    ///
    /// **Wird vom `AudioSessionPlugin` gelesen, und das ist kein Beiwerk:**
    /// bei einem CallKit-Anruf gehört die Audio-Session dem `CXProvider`. Wer
    /// sie daneben selbst aktiviert, nimmt sie ihm weg, und der angenommene
    /// Anruf bleibt stumm.
    public private(set) var callkitAktiv = false

    /// Aktionen, die eintreffen, bevor das Web zuhört (kalt gestarteter
    /// Anruf). Capacitor hält sie mit `retainUntilConsumed` selbst; dieser
    /// Verweis ist nur der Weg zum Plugin, sobald es existiert.
    weak var bruecke: AnrufPlugin?

    private override init() { super.init() }

    public func starten() {
        if registry != nil { return }
        let r = PKPushRegistry(queue: .main)
        r.delegate = self
        r.desiredPushTypes = [.voIP]
        registry = r

        let aufbau = CXProviderConfiguration()
        aufbau.supportsVideo = true
        aufbau.maximumCallsPerCallGroup = 1
        aufbau.maximumCallGroups = 1
        // `.generic`: wir übergeben einen NAMEN, keine Telefonnummer. Mit
        // `.phoneNumber` würde iOS den Text als Nummer deuten und im
        // Anrufverlauf eine Rückruf-Taste anbieten, die nirgends hinführt.
        aufbau.supportedHandleTypes = [.generic]
        let p = CXProvider(configuration: aufbau)
        p.setDelegate(self, queue: .main)
        anbieter = p
    }

    /// Einen eingehenden Anruf melden. Auch vom Web gerufen (`ankommen`), wenn
    /// die WebSocket schneller war als der Push.
    func klingeln(kennung: String, name: String, video: Bool, fertig: (() -> Void)? = nil) {
        guard let anbieter else {
            fertig?()
            return
        }
        // Dieselbe Kennung nicht zweimal melden: Push und WebSocket können
        // beide ankommen, und ein zweiter Bildschirm für denselben Anruf wäre
        // für den Nutzer ein zweiter Anruf.
        if kennungen.values.contains(kennung) {
            fertig?()
            return
        }
        let uuid = UUID()
        kennungen[uuid] = kennung
        let stand = CXCallUpdate()
        stand.remoteHandle = CXHandle(type: .generic, value: name)
        stand.localizedCallerName = name
        stand.hasVideo = video
        stand.supportsDTMF = false
        stand.supportsHolding = false
        stand.supportsGrouping = false
        stand.supportsUngrouping = false
        anbieter.reportNewIncomingCall(with: uuid, update: stand) { fehler in
            if let fehler {
                // **Diese Meldung ist nachträglich dazugekommen, und sie hat
                // einen Anlass** (2026-10-08): bei eingeschaltetem „Nicht
                // stören" klingelte nichts, und nichts sagte warum — der Push
                // kam an, CallKit wies ihn ab, der Fehler wurde hier still
                // verworfen. Dieselbe Fehlerklasse wie ein `catch`, das `null`
                // zurückgibt: der Befund, den man braucht, ist genau der, der
                // verschwindet. Häufige Gründe: `filteredByDoNotDisturb`,
                // `filteredByBlockList`, `maximumCallGroupsReached`.
                // Der Anruf ist damit ERLEDIGT, nicht verschoben.
                NSLog("[Anruf] CallKit hat den Anruf abgewiesen: %@",
                      (fehler as NSError).localizedDescription)
                self.vergessen(uuid)
            } else {
                self.callkitAktiv = true
            }
            fertig?()
        }
    }

    /// Einen laufenden/klingelnden Anruf beenden (Gegenstelle hat aufgelegt,
    /// Abbruch-Push, oder das Web hat aufgelegt).
    func beenden(kennung: String? = nil) {
        guard let anbieter else { return }
        // `kennungen` wird in der Schleife geändert — in Swift iteriert `for`
        // über eine Kopie des Dictionarys, das ist also kein Rennen.
        for (uuid, kn) in kennungen where kennung == nil || kn == kennung {
            anbieter.reportCall(with: uuid, endedAt: nil, reason: .remoteEnded)
            vergessen(uuid)
        }
    }

    /// Einen erledigten Anruf aus der Buchführung nehmen.
    ///
    /// Auch der Kontext fällt weg: lesen kann ihn nur `melde`, und das setzt
    /// einen Eintrag in `kennungen` voraus — bleibt er stehen, wächst die Map
    /// über die Lebensdauer der App, ohne je wieder gebraucht zu werden.
    private func vergessen(_ uuid: UUID) {
        if let kennung = kennungen[uuid] { kontexte[kennung] = nil }
        kennungen[uuid] = nil
        if kennungen.isEmpty { callkitAktiv = false }
    }

    private func melde(_ aktion: String, _ uuid: UUID) {
        guard let kennung = kennungen[uuid] else { return }
        bruecke?.aktionMelden(
            aktion: aktion, kennung: kennung, kontext: kontexte[kennung] ?? [:])
    }

    /// Kontext aus einem Push merken. Nur Strings — was hier hineinkommt,
    /// geht unverändert ins Web und soll dort nicht erst gedeutet werden.
    func kontextMerken(kennung: String, inhalt: [AnyHashable: Any]) {
        guard !kennung.isEmpty else { return }
        var k: [String: String] = [:]
        for feld in ["channel_id", "anruf_art", "einleiter_id", "einleiter_name"] {
            if let wert = inhalt[feld] as? String { k[feld] = wert }
        }
        kontexte[kennung] = k
    }
}

// MARK: - PushKit

extension Anrufverwaltung: PKPushRegistryDelegate {
    public func pushRegistry(
        _ registry: PKPushRegistry,
        didUpdate pushCredentials: PKPushCredentials,
        for type: PKPushType
    ) {
        token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        bruecke?.tokenMelden(token)
    }

    public func pushRegistry(
        _ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType
    ) {
        token = nil
    }

    public func pushRegistry(
        _ registry: PKPushRegistry,
        didReceiveIncomingPushWith payload: PKPushPayload,
        for type: PKPushType,
        completion: @escaping () -> Void
    ) {
        let inhalt = payload.dictionaryPayload
        let kennung = inhalt["call_id"] as? String ?? ""
        if inhalt["art"] as? String == "abbruch" {
            beenden(kennung: kennung.isEmpty ? nil : kennung)
            completion()
            return
        }
        kontextMerken(kennung: kennung, inhalt: inhalt)
        // SOFORT melden, im selben Lauf — s. Klassenkommentar.
        klingeln(
            kennung: kennung,
            name: inhalt["einleiter_name"] as? String ?? "Pulse",
            video: (inhalt["anruf_art"] as? String) == "video",
            fertig: completion
        )
    }
}

// MARK: - CallKit

extension Anrufverwaltung: CXProviderDelegate {
    public func providerDidReset(_ provider: CXProvider) {
        kennungen.removeAll()
        // Die Kontexte mit: ohne Zuordnung UUID → Kennung kommt niemand mehr
        // an sie heran (s. `vergessen`).
        kontexte.removeAll()
        callkitAktiv = false
    }

    public func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        melde("annehmen", action.callUUID)
        action.fulfill()
    }

    public func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        // Reihenfolge: erst melden, dann vergessen — `melde` braucht die
        // Zuordnung UUID → Kennung, die `vergessen` gerade abräumt.
        melde("ablehnen", action.callUUID)
        vergessen(action.callUUID)
        action.fulfill()
    }

    public func provider(
        _ provider: CXProvider, didActivate audioSession: AVAudioSession
    ) {
        // Hier wird NICHTS konfiguriert: die Session gehört jetzt CallKit.
        // `AudioSessionPlugin` fragt `callkitAktiv` ab und aktiviert sie nicht
        // selbst (Begründung dort und am Merker).
        callkitAktiv = true
    }

    public func provider(
        _ provider: CXProvider, didDeactivate audioSession: AVAudioSession
    ) {
        callkitAktiv = false
    }
}

// MARK: - Brücke zum Web

@objc(AnrufPlugin)
public class AnrufPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AnrufPlugin"
    public let jsName = "Anruf"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "ankommen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "beenden", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "voipToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "addListener", returnType: CAPPluginReturnCallback),
        CAPPluginMethod(name: "removeAllListeners", returnType: CAPPluginReturnPromise)
    ]

    public override func load() {
        Anrufverwaltung.geteilt.bruecke = self
        Anrufverwaltung.geteilt.starten()
    }

    @objc func ankommen(_ call: CAPPluginCall) {
        let kennung = call.getString("callId") ?? ""
        let name = call.getString("gegenstelle") ?? "Pulse"
        DispatchQueue.main.async {
            Anrufverwaltung.geteilt.klingeln(kennung: kennung, name: name, video: false)
            call.resolve()
        }
    }

    @objc func beenden(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            Anrufverwaltung.geteilt.beenden()
            call.resolve()
        }
    }

    @objc func voipToken(_ call: CAPPluginCall) {
        call.resolve(["token": Anrufverwaltung.geteilt.token as Any])
    }

    func tokenMelden(_ token: String?) {
        guard let token else { return }
        // `retainUntilConsumed`: der Token kann vor dem ersten Hörer kommen —
        // der Push-Registry antwortet beim Start, die WebView lädt erst.
        notifyListeners("voipToken", data: ["token": token], retainUntilConsumed: true)
    }

    func aktionMelden(aktion: String, kennung: String, kontext: [String: String]) {
        // Ebenfalls aufbewahrt: ein kalt gestarteter Anruf wird angenommen,
        // BEVOR die entfernte Web-App geladen ist. Ohne das Aufbewahren wäre
        // die Annahme verloren und der Nutzer stünde in einem stummen Anruf.
        var daten: [String: Any] = ["aktion": aktion, "callId": kennung]
        for (schluessel, wert) in kontext { daten[schluessel] = wert }
        notifyListeners("aktion", data: daten, retainUntilConsumed: true)
    }
}
