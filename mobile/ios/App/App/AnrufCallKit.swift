import AVFoundation
import CallKit
import PushKit

/// CallKit- und PushKit-Seite der Anrufverwaltung: was der
/// System-Anrufbildschirm meldet, was die Oberfläche bei CallKit anstösst,
/// und was ein VoIP-Push auslöst.
///
/// **CallKit trägt jedes Gespräch, auch das in der App angenommene oder
/// begonnene.** Nur so führt es die Audio-Session (Hintergrund, Sperr-
/// bildschirm, ein dazwischenkommendes Mobilfunk-Gespräch), und nur so gibt
/// es EINE Stelle, die über die Session entscheidet (`AnrufSitzung.swift`).
/// Bis zum 2026-10-11 beendete das Web den CallKit-Anruf nach der Annahme
/// sofort — CallKit deaktivierte darauf die Session, mitten im Gespräch
/// (Bughunt E4).
extension Anrufverwaltung: CXProviderDelegate {
    public func providerDidReset(_ provider: CXProvider) {
        for uhr in klingelUhren.values { uhr.cancel() }
        klingelUhren.removeAll()
        // Wie jedes andere Ende: ein Push danach klingelt nicht neu.
        for kennung in kennungen.values { kuerzlichBeendet[kennung] = Date() }
        kennungen.removeAll()
        // Die Kontexte mit: lesen könnten sie nur `melde` (braucht die eben
        // geleerte Zuordnung UUID → Kennung) und `vonDerHuelleBeendet` — und
        // der Raum, der das auslöst, geht gleich mit (`verlassen` löst ihn,
        // bevor er trennt). Stehen gelassen wüchse die Map (s. `stillVergessen`).
        kontexte.removeAll()
        phasen.removeAll()
        stilleEnden.removeAll()
        annahmenVomWeb.removeAll()
        Task { await AnrufRaum.geteilt.verlassen() }
        sessionAktiv = false
        // Erst das Gespräch ohne CallKit aus der Buchführung — sonst hielte
        // die Rückgabe es für laufend und den Kanal angehalten.
        if let ohne = ohneCallKitKennung { ohneCallKitBeendet(ohne) }
        sessionZurueckgeben()
    }

    public func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        let uuid = action.callUUID
        klingelUhren.removeValue(forKey: uuid)?.cancel()
        phasen[uuid] = .angenommen
        // VOR dem `fulfill`: danach aktiviert CallKit die Session, und bis
        // dahin müssen Kanal und SDK sie losgelassen haben.
        sessionUebernehmen()
        // Kam die Annahme aus der Oberfläche, weiss sie es schon.
        if annahmenVomWeb.remove(uuid) == nil { melde("annehmen", uuid) }
        action.fulfill()
    }

    public func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        let uuid = action.callUUID
        sessionUebernehmen()
        action.fulfill()
        provider.reportOutgoingCall(with: uuid, startedConnectingAt: nil)
        // Ein Gesprächs-Träger für einen schon angenommenen Anruf (s.
        // `gespraechBeginnen`) klingelt nicht — er ist verbunden.
        if phasen[uuid] == .angenommen { provider.reportOutgoingCall(with: uuid, connectedAt: nil) }
    }

    /// „Beenden" im System-Bildschirm. **Was das heisst, hängt an der
    /// Phase** (M5): ein klingelnder Anruf wird abgelehnt, ein laufender oder
    /// ausgehender aufgelegt. Der Raum geht SOFORT zu — die Oberfläche kann
    /// eingefroren sein, und die Gegenseite darf nicht weiter mithören.
    public func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        let uuid = action.callUUID
        if stilleEnden.remove(uuid) == nil {
            melde(phasen[uuid] == .klingelt ? "ablehnen" : "auflegen", uuid)
            #if DEBUG
                if kennungen[uuid] != nil { spur.fremdEnden += 1 }
            #endif
        }
        anrufZu(uuid)
        action.fulfill()
    }

    /// Der Stummschalter im System-Bildschirm.
    public func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        AnrufRaum.geteilt.mikrofonVonCallKit(stumm: action.isMuted)
        action.fulfill()
    }

    public func provider(
        _ provider: CXProvider, didActivate audioSession: AVAudioSession
    ) {
        sessionAktiviert()
    }

    public func provider(
        _ provider: CXProvider, didDeactivate audioSession: AVAudioSession
    ) {
        sessionDeaktiviert()
    }

    // MARK: - Was die Oberfläche anstösst

    /// In der App angenommen. Klingelt der Anruf bei CallKit, wird er DORT
    /// angenommen (Transaktion) — sonst bliebe der System-Bildschirm stehen,
    /// und die Session gehörte niemandem. Kennt CallKit ihn nicht (abgewiesen,
    /// „Nicht stören"), trägt ein eigenes Gespräch die Session.
    func annehmenVomWeb(kennung: String, name: String, fertig: @escaping () -> Void) {
        guard let uuid = uuid(fuer: kennung) else {
            gespraechBeginnen(kennung: kennung, name: name, phase: .angenommen, fertig: fertig)
            return
        }
        guard phasen[uuid] == .klingelt else {
            fertig()
            return
        }
        annahmenVomWeb.insert(uuid)
        steuerung.request(CXTransaction(action: CXAnswerCallAction(call: uuid))) { fehler in
            DispatchQueue.main.async {
                if let fehler {
                    NSLog("[PulseAnruf] Annahme bei CallKit abgewiesen: %@",
                          (fehler as NSError).localizedDescription)
                    // Das Gespräch läuft ohne CallKit weiter — der klingelnde
                    // Eintrag muss dort weg, sonst klingelte er weiter und
                    // lehnte nach der Klingelfrist ein laufendes Gespräch ab.
                    // ERST buchen, dann `vergessen` (s. `gespraechBeginnen`).
                    self.ohneCallKitUebernehmen(kennung: kennung)
                    self.anbieter?.reportCall(with: uuid, endedAt: nil, reason: .answeredElsewhere)
                    self.vergessen(uuid)
                }
                fertig()
            }
        }
    }

    /// Ein ausgehender Anruf — CallKit zeigt ihn, führt die Session und zählt
    /// die Dauer ab `verbunden`.
    func ausgehendBeginnen(kennung: String, name: String, fertig: @escaping () -> Void) {
        gespraechBeginnen(kennung: kennung, name: name, phase: .ausgehend, fertig: fertig)
    }

    private func gespraechBeginnen(kennung: String, name: String, phase: Phase,
                                   fertig: @escaping () -> Void) {
        // Auch ein Gespräch ohne CallKit zählt — sonst bekäme es beim zweiten
        // Tipp auf „Annehmen" einen zweiten Anruf bei CallKit.
        if fuehrt(kennung) {
            fertig()
            return
        }
        let uuid = UUID()
        kennungen[uuid] = kennung
        phasen[uuid] = phase
        let start = CXStartCallAction(call: uuid, handle: CXHandle(type: .generic, value: name))
        start.isVideo = false
        steuerung.request(CXTransaction(action: start)) { fehler in
            DispatchQueue.main.async {
                if let fehler {
                    NSLog("[PulseAnruf] CallKit hat das Gespräch abgewiesen: %@",
                          (fehler as NSError).localizedDescription)
                    // **Erst buchen, dann `vergessen`.** Bis zum 2026-10-11
                    // stand hier `stillVergessen`, weil `vergessen` ein Gespräch
                    // ohne CallKit mit beendete — das tut `letzterAnrufVorbei`
                    // nicht mehr. Und nur `vergessen` schliesst eine Rückgabe ab,
                    // die noch von einem vorigen Anruf aussteht: ihre Uhr und
                    // `didDeactivate` geben nur bei leerer Buchführung zurück, und
                    // lag dieser Eintrag gerade darin, gab sonst niemand mehr
                    // zurück (`callkitAktiv` blieb stehen, die Maschine aus).
                    self.ohneCallKitUebernehmen(kennung: kennung)
                    self.vergessen(uuid)
                } else {
                    let stand = CXCallUpdate()
                    stand.localizedCallerName = name
                    stand.remoteHandle = CXHandle(type: .generic, value: name)
                    self.anbieter?.reportCall(with: uuid, updated: stand)
                }
                fertig()
            }
        }
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
        // SOFORT melden, im selben Lauf — jeder Ausgang meldet bei CallKit,
        // auch für einen Anruf, den es hier schon gibt (`AnrufPush.swift`).
        pushVerarbeiten(payload.dictionaryPayload, fertig: completion)
    }
}
