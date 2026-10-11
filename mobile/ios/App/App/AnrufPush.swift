import CallKit
import Foundation

/// Eingehende Anrufe bei CallKit melden — aus einem VoIP-Push oder aus der
/// Oberfläche (`ankommen`).
///
/// **Je Push-Ausgang eine Funktion, und jede ruft `beiCallKitMelden`**, den
/// einzigen Weg zu `reportNewIncomingCall`. Welcher Ausgang gilt, entscheidet
/// `pushAusgang` (`AnrufPushAusgang.swift`, dort auch Apples Regel); der
/// `switch` in `pushVerarbeiten` ist erschöpfend, ein Push kann also keinen
/// Weg ohne Meldung nehmen. Die einzige Lücke wäre ein fehlender
/// `CXProvider`, und die schliesst die Reihenfolge in `starten()`. PushKits
/// `completion` läuft erst, wenn CallKit geantwortet hat. Nachgezählt im
/// Debug-Bau (`AnrufPushProbe.swift`).
extension Anrufverwaltung {
    /// Ein VoIP-Push — aus `pushRegistry(_:didReceiveIncomingPushWith:…)`,
    /// im Debug-Bau auch aus dem Prüfpfad mit selbst gebauter Nutzlast.
    func pushVerarbeiten(_ inhalt: [AnyHashable: Any], fertig: @escaping () -> Void) {
        let kennung = inhalt["call_id"] as? String ?? ""
        let name = inhalt["einleiter_name"] as? String ?? "Pulse"
        let art: PushArt = inhalt["art"] as? String == "abbruch" ? .abbruch : .klingeln
        let bekannt = uuid(fuer: kennung)
        let ausgang = Self.pushAusgang(
            art: art, bekannt: bekannt, klingelt: bekannt.map { phasen[$0] == .klingelt } ?? false,
            kuerzlichBeendet: istKuerzlichBeendet(kennung))
        NSLog("[Anruf] VoIP-Push %@ %@ → %@", art.rawValue, kennung, "\(ausgang)")
        #if DEBUG
            spur.ausgang = ausgang
        #endif
        // Auch für einen bekannten Anruf: hat ihn die Oberfläche gemeldet
        // (`ankommen`), bringt erst der Push Kanal und Art mit.
        if art == .klingeln, ausgang != .meldenUndSofortBeenden {
            kontextMerken(kennung: kennung, inhalt: inhalt)
        }
        switch ausgang {
        case .neuMelden:
            // `anruf_art` ist `dm` oder `gruppe`, NICHT Video (G3): ein Anruf
            // beginnt immer ohne Kamera.
            neuMelden(kennung: kennung, name: name, video: false, fertig: fertig)
        case .erneutMelden(let uuid):
            erneutMelden(uuid, name: name, beenden: false, fertig: fertig)
        case .erneutMeldenUndBeenden(let uuid):
            erneutMelden(uuid, name: name, beenden: true, fertig: fertig)
        case .meldenUndSofortBeenden:
            meldenUndSofortBeenden(name: name, fertig: fertig)
        }
    }

    /// Die Oberfläche meldet einen Anruf (`ankommen`): die WebSocket war
    /// schneller als der Push. Hier gilt Apples Pflicht nicht — ein schon
    /// gemeldeter oder eben beendeter Anruf verfällt still; ein zweiter
    /// Bildschirm wäre ein zweiter Anruf.
    func klingeln(kennung: String, name: String, video: Bool) {
        guard uuid(fuer: kennung) == nil, !istKuerzlichBeendet(kennung) else { return }
        neuMelden(kennung: kennung, name: name, video: video) {}
    }

    // MARK: - Die Ausgänge

    private func neuMelden(kennung: String, name: String, video: Bool,
                           fertig: @escaping () -> Void) {
        let uuid = UUID()
        kennungen[uuid] = kennung
        phasen[uuid] = .klingelt
        beiCallKitMelden(uuid, name: name, video: video) { folge in
            switch folge {
            case .angezeigt:
                self.klingelFristStellen(uuid)
            case .schonBekannt:
                // Bei einer frischen UUID nicht zu erwarten — und käme es doch,
                // führte CallKit darunter schon einen Anruf: nicht vergessen,
                // keine zweite Frist.
                break
            case .abgewiesen:
                // Der Anruf ist damit ERLEDIGT, nicht verschoben.
                self.vergessen(uuid)
            }
            fertig()
        }
    }

    /// Ein Push für einen Anruf, den CallKit schon führt: mit der BESTEHENDEN
    /// UUID melden. Die erwartete Antwort ist `callUUIDAlreadyExists`, und der
    /// laufende Anruf bleibt, wie er ist; nur ein klingelnder wird auf einen
    /// Abbruch hin beendet — nach der Meldung, s. `PushAusgang`.
    private func erneutMelden(_ uuid: UUID, name: String, beenden: Bool,
                              fertig: @escaping () -> Void) {
        beiCallKitMelden(uuid, name: name, video: false) { folge in
            // Am Gerät der Beleg, dass CallKit das Duplikat erkannt hat.
            NSLog("[Anruf] erneut gemeldet, CallKit: %@", "\(folge)")
            switch Self.nachErneuterMeldung(folge, beenden: beenden, phase: self.phasen[uuid]) {
            case .nichts:
                break
            case .beenden:
                self.anbieter?.reportCall(with: uuid, endedAt: nil, reason: .remoteEnded)
                self.anrufZu(uuid)
            case .geisterBeenden:
                NSLog("[Anruf] CallKit kannte den Anruf nicht mehr und zeigte ihn neu — beendet")
                self.anbieter?.reportCall(with: uuid, endedAt: nil, reason: .remoteEnded)
            }
            fertig()
        }
    }

    /// **Für Pushes, zu denen es hier keinen Anruf gibt** — Abbruch eines
    /// unbekannten Anrufs, Klingeln eines eben beendeten. Apples Vorgabe für
    /// diesen Fall: melden und sofort beenden (PushKit-Dokumentation,
    /// „Responding to VoIP Notifications from PushKit"; gefolgert, nicht am
    /// Gerät gemessen). Ob der Bildschirm dabei kurz aufblitzt, ist am Gerät
    /// offen — der Server vermeidet den Fall, so gut er kann (Bughunt K3).
    private func meldenUndSofortBeenden(name: String, fertig: @escaping () -> Void) {
        let uuid = UUID()
        beiCallKitMelden(uuid, name: name, video: false) { _ in
            self.anbieter?.reportCall(with: uuid, endedAt: nil, reason: .remoteEnded)
            fertig()
        }
    }

    // MARK: - Die Meldung selbst

    /// **Der einzige Weg zu `reportNewIncomingCall`.** `danach` läuft auf dem
    /// Hauptthread (CallKit ruft auf der Delegat-Queue, `CXProvider.h`).
    private func beiCallKitMelden(_ uuid: UUID, name: String, video: Bool,
                                  danach: @escaping (MeldungsFolge) -> Void) {
        // Nicht zu erreichen: `starten()` legt den Anbieter vor der
        // Push-Registrierung an, und das Plugin ruft `starten()` vor jedem
        // `ankommen`.
        guard let anbieter else {
            NSLog("[Anruf] kein CXProvider — Meldung unmöglich")
            danach(.abgewiesen)
            return
        }
        let stand = CXCallUpdate()
        stand.remoteHandle = CXHandle(type: .generic, value: name)
        stand.localizedCallerName = name
        stand.hasVideo = video
        stand.supportsDTMF = false
        stand.supportsHolding = false
        stand.supportsGrouping = false
        stand.supportsUngrouping = false
        #if DEBUG
            spur.meldungen += 1
        #endif
        anbieter.reportNewIncomingCall(with: uuid, update: stand) { fehler in
            let folge = Self.meldungsFolge(fehler)
            #if DEBUG
                self.spur.folge = folge
            #endif
            if let fehler, folge == .abgewiesen {
                // **Nachträglich dazugekommen, mit Anlass** (2026-10-08): bei
                // „Nicht stören" klingelte nichts, und nichts sagte warum.
                // Häufige Gründe: `filteredByDoNotDisturb`,
                // `filteredByBlockList`, `maximumCallGroupsReached`.
                NSLog("[Anruf] CallKit hat den Anruf abgewiesen: %@",
                      (fehler as NSError).localizedDescription)
            }
            danach(folge)
        }
    }

    private func klingelFristStellen(_ uuid: UUID) {
        let uhr = DispatchWorkItem { [weak self] in
            guard let self, phasen[uuid] == .klingelt else { return }
            NSLog("[Anruf] nach %.0f s nicht angenommen — das Klingeln endet", Self.klingelFrist)
            anbieter?.reportCall(with: uuid, endedAt: nil, reason: .unanswered)
            // Wie der 45-s-Wecker des Webs: der Server soll es wissen (im
            // Gruppenanruf geht das seit T4 auch, wenn schon jemand spricht).
            melde("ablehnen", uuid)
            anrufZu(uuid)
        }
        klingelUhren[uuid] = uhr
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.klingelFrist, execute: uhr)
    }

    private func istKuerzlichBeendet(_ kennung: String) -> Bool {
        let grenze = Date().addingTimeInterval(-10 * 60)
        kuerzlichBeendet = kuerzlichBeendet.filter { $0.value > grenze }
        return kuerzlichBeendet[kennung] != nil
    }

    /// Kontext aus einem Push merken. Nur Strings — was hier hineinkommt,
    /// geht unverändert ins Web und soll dort nicht erst gedeutet werden.
    private func kontextMerken(kennung: String, inhalt: [AnyHashable: Any]) {
        guard !kennung.isEmpty else { return }
        var k: [String: String] = [:]
        for feld in ["channel_id", "anruf_art", "einleiter_id", "einleiter_name"] {
            if let wert = inhalt[feld] as? String { k[feld] = wert }
        }
        kontexte[kennung] = k
    }
}
