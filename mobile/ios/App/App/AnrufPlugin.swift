import Capacitor

/// Die Brücke der Anrufe zum Web (JS-Name `Anruf`). Der Zustand lebt in
/// `Anrufverwaltung` (`Anrufverwaltung.swift`) — ein VoIP-Push trifft die App
/// auch, bevor es dieses Plugin gibt. Die Raum-Befehle stehen in
/// `AnrufPluginRaum.swift`.
///
/// Android-Pendant: `AnrufPlugin.java`, gleicher JS-Name, gleiche Methoden bis
/// auf die Raum-Befehle, gleiches `aktion`-Ereignis.
@objc(AnrufPlugin)
public class AnrufPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AnrufPlugin"
    public let jsName = "Anruf"
    /// **Jede neue Methode gehört auch in `ANRUF_RAUM_METHODEN`** im Web
    /// (`platform/anrufNativ.ts`) — sonst fährt eine Oberfläche gegen einen
    /// älteren Bau einen halben Weg.
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "ankommen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "beenden", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "voipToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "annehmen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ausgehend", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "raumBeitreten", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "raumMikrofon", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "raumKamera", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "raumAusgabe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "raumZustand", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "addListener", returnType: CAPPluginReturnCallback),
        CAPPluginMethod(name: "removeAllListeners", returnType: CAPPluginReturnPromise)
    ]

    public override func load() {
        Anrufverwaltung.geteilt.bruecke = self
        Anrufverwaltung.geteilt.starten()
        AnrufRaum.geteilt.melde = { [weak self] name, nutzlast in
            self?.notifyListeners(name, data: nutzlast)
        }
    }

    @objc func ankommen(_ call: CAPPluginCall) {
        let kennung = call.getString("callId") ?? ""
        let name = call.getString("gegenstelle") ?? "Pulse"
        let video = call.getBool("video") ?? false
        DispatchQueue.main.async {
            Anrufverwaltung.geteilt.klingeln(kennung: kennung, name: name, video: video)
            call.resolve()
        }
    }

    /// `grund` (optional, s. `Endgrund`): eine ältere Oberfläche schickt ihn
    /// nicht — dann gilt „die Gegenseite", wie bisher.
    @objc func beenden(_ call: CAPPluginCall) {
        let grund = call.getString("grund").flatMap(Anrufverwaltung.Endgrund.init) ?? .gegenseite
        DispatchQueue.main.async {
            Anrufverwaltung.geteilt.beenden(grund: grund)
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
