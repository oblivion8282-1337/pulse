import CallKit
import Foundation

/// **Was ein VoIP-Push auslöst — als reine Entscheidung, ohne Zustand und
/// ohne Aufruf an CallKit.** Ausgeführt wird sie in `AnrufPush.swift`,
/// geprüft im Debug-Bau über `AnrufPushProbe.swift`.
///
/// **Apples Regel** (Doc-Kommentar von `PKPushRegistryDelegate`): auf JEDEN
/// VoIP-Push muss die App im selben Lauf `reportNewIncomingCall` rufen, sonst
/// beendet iOS sie, und nach Wiederholung stellt es ihr die VoIP-Pushes ab.
/// Deshalb kennt `PushAusgang` keinen Fall „nichts tun": jeder der vier
/// Ausgänge meldet bei CallKit, und welcher es wird, hängt nur daran, was
/// hier über den Anruf bekannt ist.
///
/// **Ein Push für einen Anruf, den CallKit schon führt, meldet ihn mit der
/// BESTEHENDEN UUID erneut** — Apples Vorgabe aus den Developer Forums. CallKit
/// antwortet dann `callUUIDAlreadyExists`, und das gilt als erfüllt. Bis zum
/// 2026-10-11 meldete die App in diesem Fall gar nichts. Seit `eddb1a42`
/// (Bughunt T14) klingelt der Server jedes iOS-Gerät per Push an, auch eines
/// mit wacher WebSocket, und damit ist der Fall alltäglich: die Oberfläche
/// meldet den Anruf über `ankommen`, kurz darauf kommt der Push. Dass iOS die
/// App danach nicht mehr beendet, ist nur am Gerät zu belegen — der Simulator
/// bekommt keinen echten VoIP-Push.
extension Anrufverwaltung {
    /// `art` im Push (`anruf_push.py`): `klingelt` oder `abbruch`. Alles, was
    /// nicht `abbruch` ist, gilt als Klingeln — wie vor der Aufteilung.
    enum PushArt: String {
        case klingeln, abbruch
    }

    enum PushAusgang: Equatable {
        /// Unbekannter Anruf: neu melden, er klingelt.
        case neuMelden
        /// Bekannter Anruf: mit seiner UUID erneut melden, sonst nichts.
        case erneutMelden(UUID)
        /// Bekannter, noch klingelnder Anruf, den der Server abbricht: erneut
        /// melden, DANN beenden. Andersherum wäre die UUID bei CallKit schon
        /// frei, und die Meldung liesse den Anruf neu klingeln.
        case erneutMeldenUndBeenden(UUID)
        /// Kein CallKit-Anruf dazu (Abbruch eines unbekannten, Klingeln eines
        /// eben beendeten oder eines Gesprächs, das ohne CallKit läuft): mit
        /// einer Wegwerf-UUID melden und sofort beenden.
        case meldenUndSofortBeenden
    }

    /// Was CallKit auf eine Meldung geantwortet hat.
    enum MeldungsFolge: Equatable {
        /// Kein Fehler: CallKit zeigt einen klingelnden Anruf.
        case angezeigt
        /// `callUUIDAlreadyExists`: CallKit führt die UUID schon. Auf eine
        /// erneute Meldung die erwartete Antwort. **Keine Ablehnung** — der
        /// laufende Anruf darunter wird weder vergessen noch bekommt er eine
        /// neue Klingelfrist.
        case schonBekannt
        /// Abgewiesen („Nicht stören", Sperrliste, schon ein Anruf …).
        case abgewiesen
    }

    /// Was nach einer ERNEUTEN Meldung zu tun ist.
    enum NachErneuterMeldung: Equatable {
        case nichts
        /// Der Abbruch eines klingelnden Anrufs: beenden.
        case beenden
        /// CallKit kannte die UUID nicht mehr und zeigt nun einen NEUEN Anruf
        /// darunter, den hier keiner führt: sofort wieder beenden.
        case geisterBeenden
    }

    /// **Ein Abbruch beendet nur einen KLINGELNDEN Anruf.** Ein angenommenes
    /// Gespräch beendet der Server nicht per Push (`anruf_push.py`); käme doch
    /// einer, wird er gemeldet und das Gespräch läuft weiter.
    ///
    /// **`ohneCallKit`: das Gespräch läuft, aber CallKit kennt es nicht** (es
    /// hatte abgewiesen). Ein Push dafür darf es nicht neu klingeln lassen —
    /// das klingelte für ein laufendes Gespräch —, melden muss er trotzdem;
    /// es gilt derselbe Ausgang wie ohne Anruf. Ein Abbruch berührt es nicht.
    static func pushAusgang(art: PushArt, bekannt: UUID?, klingelt: Bool,
                            kuerzlichBeendet: Bool, ohneCallKit: Bool) -> PushAusgang {
        if let bekannt {
            return art == .abbruch && klingelt ? .erneutMeldenUndBeenden(bekannt) : .erneutMelden(bekannt)
        }
        let neu = art == .klingeln && !kuerzlichBeendet && !ohneCallKit
        return neu ? .neuMelden : .meldenUndSofortBeenden
    }

    /// Ein Duplikat erkennt man an Domäne UND Code — eine `2` aus einer
    /// anderen Domäne ist eine Ablehnung.
    static func meldungsFolge(_ fehler: Error?) -> MeldungsFolge {
        guard let fehler else { return .angezeigt }
        if let callKit = fehler as? CXErrorCodeIncomingCallError, callKit.code == .callUUIDAlreadyExists {
            return .schonBekannt
        }
        return .abgewiesen
    }

    /// `phase`: wo der Anruf steht, wenn CallKit geantwortet hat — nicht, als
    /// der Push kam. Dazwischen kann der Nutzer angenommen oder abgelehnt
    /// haben.
    ///
    /// **Ein laufendes Gespräch wird hier nie beendet**, auch nicht, wenn
    /// CallKit wider Erwarten `angezeigt` meldet: diese Antwort ist eine
    /// Deutung, und ein Irrtum darin legte den echten Anruf auf. Ein
    /// „Geist" wird nur beendet, wenn hier kein Anruf mehr unter der UUID
    /// steht (der Nutzer hat abgelehnt, während der Push unterwegs war).
    static func nachErneuterMeldung(_ folge: MeldungsFolge, beenden: Bool,
                                    phase: Phase?) -> NachErneuterMeldung {
        switch phase {
        case .klingelt?: return beenden ? .beenden : .nichts
        case nil: return folge == .angezeigt ? .geisterBeenden : .nichts
        case .angenommen?, .ausgehend?: return .nichts
        }
    }
}
