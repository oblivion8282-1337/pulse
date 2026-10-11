import CallKit
import Foundation
import PushKit

/// Eingehende Anrufe: VoIP-Push → CallKit → Web (iOS-Liste Punkt 40), und
/// seit Etappe 4 der native Raum des Gesprächs (`AnrufRaum.swift`).
///
/// **Warum die Verwaltung NICHT im Plugin wohnt.** Ein Capacitor-Plugin
/// entsteht erst, wenn die WebView lädt. Ein VoIP-Push trifft die App aber in
/// jedem Zustand — auch kalt gestartet, bevor irgendeine WebView existiert.
/// Die Registrierung muss deshalb am `AppDelegate` hängen; `Anrufverwaltung`
/// ist der gemeinsame Zustand, das Plugin nur die Brücke zum Web.
///
/// **Die harte Regel von PushKit:** auf JEDEN VoIP-Push muss im selben Lauf
/// ein Anruf an CallKit gemeldet werden. Tut die App das nicht, beendet iOS
/// sie — und nach Wiederholung entzieht es die VoIP-Pushes ganz. Hier steht
/// deshalb kein `async` und kein Netzaufruf zwischen Push und Meldung, und
/// JEDER Push meldet: ein unbekannter Anruf neu, ein bekannter mit seiner
/// bestehenden UUID, ein Push ohne Anruf mit einer Wegwerf-UUID, die sofort
/// endet. Die Entscheidung steht in `AnrufPushAusgang.swift`, die Ausgänge in
/// `AnrufPush.swift`. Dass Pushes ohne Anruf selten bleiben, sorgt der Server
/// (`anruf_push.py`).
///
/// Aufgeteilt nach der Grössen-Policy: PushKit- und CallKit-Delegat in
/// `AnrufCallKit.swift`, die Meldungen an CallKit in `AnrufPush.swift` und
/// `AnrufPushAusgang.swift`, die Übergabe der Audio-Session in
/// `AnrufSitzung.swift`, die Brücke in `AnrufPlugin.swift` und
/// `AnrufPluginRaum.swift`. Alles hier lebt auf dem Hauptthread — dort
/// rufen PushKit und CallKit (`queue: .main`) und das Plugin.
///
/// Android-Pendant: `AnrufPlugin.java`, gleicher JS-Name (`Anruf`), gleiche
/// Methoden bis auf die Raum-Befehle, gleiches `aktion`-Ereignis.
public final class Anrufverwaltung: NSObject {
    public static let geteilt = Anrufverwaltung()

    private var registry: PKPushRegistry?
    var anbieter: CXProvider?
    let steuerung = CXCallController()
    /// CallKit rechnet in UUIDs, unsere Anruf-Kennungen sind Snowflakes.
    var kennungen: [UUID: String] = [:]
    /// Der Kontext aus dem Push, je Anruf-Kennung.
    ///
    /// **Warum er aufbewahrt wird:** nimmt der Nutzer einen kalt gestarteten
    /// Anruf auf dem Sperrbildschirm an, hat das Web noch nie ein
    /// `call_klingelt` gesehen — sein Zustand ist leer, und eine Annahme mit
    /// nur der Kennung liefe ins Nichts. Der Kanal und die Art stehen im
    /// Push; sie reisen deshalb mit der Aktion ins Web.
    var kontexte: [String: [String: String]] = [:]

    /// Wo ein Anruf steht. **Entscheidet, was „Beenden" im CallKit-Bildschirm
    /// heisst**: bis zum 2026-10-11 meldete es immer `ablehnen`, auch für
    /// ein laufendes Gespräch — der Server antwortete 409, und die Gegenseite
    /// blieb in einem Anruf mit niemandem (Bughunt M5).
    enum Phase { case klingelt, angenommen, ausgehend }
    var phasen: [UUID: Phase] = [:]
    /// Ende, die das Web selbst angestossen hat — kein `aktion` zurück, sonst
    /// legte das Web ein zweites Mal auf.
    var stilleEnden: Set<UUID> = []
    /// Annahmen, die das Web erbeten hat (`annehmen`) — ebenso kein Echo.
    var annahmenVomWeb: Set<UUID> = []
    /// Kennungen, die hier kürzlich zu Ende gingen. Ein Push, der danach
    /// noch kommt (Apple garantiert keine Reihenfolge), darf nicht noch
    /// einmal klingeln lassen.
    var kuerzlichBeendet: [String: Date] = [:]
    var klingelUhren: [UUID: DispatchWorkItem] = [:]

    /// **Wie lange es hier höchstens klingelt.** Bis zum 2026-10-11 gab es
    /// keine Grenze: ein Gruppenanruf, den jemand anderes annahm, klingelte
    /// auf einem iPhone mit eingefrorener Oberfläche, bis man ranging (T4).
    /// 60 s liegen hinter den 45 s des Webs (`KLINGEL_TIMEOUT_MS`) und der
    /// Push-Laufzeit — im Normalfall beendet der Server vorher.
    static let klingelFrist: TimeInterval = 60

    /// Der PushKit-Token dieses Geräts, sobald ihn das System geliefert hat.
    public internal(set) var token: String?

    /// **`true`, solange CallKit die Audio-Session führt** — von der Annahme
    /// (oder dem Beginn eines ausgehenden Anrufs) bis zur Rückgabe an das
    /// SDK (`AnrufSitzung.swift`). Ein KLINGELNDER Anruf zählt nicht: er
    /// nimmt niemandem die Session. Bis zum 2026-10-11 stand hier `true` ab
    /// der Meldung — ein im Web angenommener Anruf übersprang darum das
    /// Aktivieren, und keiner holte es nach (Bughunt E4).
    ///
    /// **Entscheidet, welcher Weg die Hörmuschel stellt** (Entwurf §6): führt
    /// CallKit, stellt sie die Hülle (`ausgabeAnwenden`), sonst der
    /// SDK-Schalter des Kanals. Gelesen auch vom `AudioSessionPlugin`, das die
    /// Session dann nicht anfasst.
    public internal(set) var callkitAktiv = false
    /// Hat CallKit die Session aktiviert (`didActivate`) und noch nicht
    /// wieder abgegeben?
    var sessionAktiv = false
    /// CallKit hat den Anruf abgewiesen (Simulator, laufendes Mobilfunk-
    /// Gespräch, „Nicht stören"): das Gespräch läuft trotzdem nativ, mit der
    /// automatischen Konfiguration des SDK (`AnrufSitzung.swift`).
    var ohneCallKit = false
    /// Was der Kanal vor einem Anruf ohne CallKit wollte (Lautsprecher?).
    var kanalLautsprecher: Bool?
    var rueckgabeUhr: DispatchWorkItem?

    /// Aktionen, die eintreffen, bevor das Web zuhört (kalt gestarteter
    /// Anruf). Capacitor hält sie mit `retainUntilConsumed` selbst; dieser
    /// Verweis ist nur der Weg zum Plugin, sobald es existiert.
    weak var bruecke: AnrufPlugin?

    #if DEBUG
        /// Was die Push-Ausgänge getan haben — der Prüfpfad zählt damit nach,
        /// dass jeder Push meldet (`AnrufPushProbe.swift`).
        var spur = PushSpur()
    #endif

    private override init() { super.init() }

    /// **Erst der Anbieter, dann die Push-Registrierung:** ein Push, der
    /// sofort eintrifft, findet so immer einen `CXProvider` vor, bei dem er
    /// sich melden kann (`AnrufPush.swift::beiCallKitMelden`).
    public func starten() {
        if registry != nil { return }
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

        let r = PKPushRegistry(queue: .main)
        r.delegate = self
        r.desiredPushTypes = [.voIP]
        registry = r
    }

    func uuid(fuer kennung: String) -> UUID? {
        kennungen.first(where: { $0.value == kennung })?.key
    }

    /// Wie das Web ein Ende angestossen hat — bestimmt, was CallKit dem
    /// Anrufverlauf erzählt (und ob überhaupt eine Rückmeldung ans Web geht).
    enum Endgrund: String {
        case lokal, gegenseite, verpasst, fehler
        case anderswoAngenommen = "anderswo-angenommen"
        case anderswoAbgelehnt = "anderswo-abgelehnt"

        var callKit: CXCallEndedReason {
            switch self {
            case .lokal, .gegenseite: return .remoteEnded
            case .verpasst: return .unanswered
            case .fehler: return .failed
            case .anderswoAngenommen: return .answeredElsewhere
            case .anderswoAbgelehnt: return .declinedElsewhere
            }
        }
    }

    /// Einen laufenden/klingelnden Anruf beenden — samt seinem Raum.
    ///
    /// **Ein lokales Ende geht als Transaktion an CallKit** (Apples Weg für
    /// „der Nutzer hat aufgelegt"), ohne Rückmeldung ans Web. Alles andere
    /// wird gemeldet (`reportCall`) — die Gegenseite, ein anderes Gerät oder
    /// ein Fehler hat es beendet.
    func beenden(kennung: String? = nil, grund: Endgrund = .gegenseite) {
        for (uuid, kn) in kennungen where kennung == nil || kn == kennung {
            if grund == .lokal {
                stilleEnden.insert(uuid)
                steuerung.request(CXTransaction(action: CXEndCallAction(call: uuid))) { fehler in
                    guard let fehler else { return }
                    NSLog("[Anruf] Auflegen bei CallKit abgewiesen: %@",
                          (fehler as NSError).localizedDescription)
                    DispatchQueue.main.async {
                        self.stilleEnden.remove(uuid)
                        self.anbieter?.reportCall(with: uuid, endedAt: nil, reason: .remoteEnded)
                        self.anrufZu(uuid)
                    }
                }
            } else {
                anbieter?.reportCall(with: uuid, endedAt: nil, reason: grund.callKit)
                anrufZu(uuid)
            }
        }
        // Ein Raum ohne CallKit-Anruf (CallKit hatte abgewiesen) geht mit.
        if kennungen.isEmpty, ohneCallKit {
            Task { await AnrufRaum.geteilt.verlassen(nur: kennung) }
            ohneCallKitZurueck(kanalFreigeben: true)
        }
    }

    /// Ein Anruf ist hier zu Ende: Raum trennen, Buchführung, Session zurück.
    func anrufZu(_ uuid: UUID) {
        if let kennung = kennungen[uuid] {
            kuerzlichBeendet[kennung] = Date()
            Task { await AnrufRaum.geteilt.verlassen(nur: kennung) }
        }
        vergessen(uuid)
    }

    /// Einen erledigten Anruf aus der Buchführung nehmen; der letzte gibt die
    /// Session zurück (`letzterAnrufVorbei`).
    func vergessen(_ uuid: UUID) {
        stillVergessen(uuid)
        if kennungen.isEmpty { letzterAnrufVorbei() }
    }

    /// Aus der Buchführung nehmen, OHNE die Session-Folgen von `vergessen` —
    /// für einen Eintrag, der nie eine Session hatte oder dessen Gespräch
    /// ohne CallKit weiterläuft.
    ///
    /// Auch der Kontext fällt weg — bleibt er stehen, wächst die Map über die
    /// Lebensdauer der App. **Wer ihn für eine letzte Meldung ans Web
    /// braucht, liest ihn VORHER** (`melde` vor `anrufZu`, s.
    /// `vonDerHuelleBeendet`): danach ist er leer, und das Web bekäme eine
    /// Aktion ohne Kanal und Art.
    func stillVergessen(_ uuid: UUID) {
        if let kennung = kennungen[uuid] { kontexte[kennung] = nil }
        kennungen[uuid] = nil
        phasen[uuid] = nil
        annahmenVomWeb.remove(uuid)
        klingelUhren.removeValue(forKey: uuid)?.cancel()
    }

    func melde(_ aktion: String, _ uuid: UUID) {
        guard let kennung = kennungen[uuid] else { return }
        bruecke?.aktionMelden(
            aktion: aktion, kennung: kennung, kontext: kontexte[kennung] ?? [:])
    }

    /// Der Raum hat selbst beendet (Gegenseite weg, Verbindung endgültig
    /// verloren). CallKit schliessen und das Web es wissen lassen —
    /// AUFBEWAHRT, die Oberfläche kann eingefroren sein.
    ///
    /// **Den Kontext VOR `anrufZu` lesen** — dessen `stillVergessen` löscht
    /// ihn; bis zum 2026-10-11 bekam das Web hier deshalb ein `auflegen`/
    /// `getrennt` ohne Kanal und Art. Ein Anruf OHNE CallKit hat keinen mehr
    /// (`stillVergessen` nahm ihn, als CallKit abwies) — unschädlich: den hat
    /// die Oberfläche selbst angenommen oder begonnen, und für ein Ende
    /// braucht sie nur die Kennung (`nativeAktionVerarbeiten`).
    func vonDerHuelleBeendet(kennung: String, aktion: String) {
        let kontext = kontexte[kennung] ?? [:]
        if let uuid = uuid(fuer: kennung) {
            anbieter?.reportCall(with: uuid, endedAt: nil,
                                 reason: aktion == "getrennt" ? .failed : .remoteEnded)
            anrufZu(uuid)
        } else if ohneCallKit {
            ohneCallKitZurueck(kanalFreigeben: true)
        }
        bruecke?.aktionMelden(aktion: aktion, kennung: kennung, kontext: kontext)
    }

    /// Der Raum ist verbunden. Für einen AUSGEHENDEN Anruf ist das der
    /// Moment, ab dem CallKit die Dauer zählt.
    func verbunden(kennung: String?) {
        guard let kennung, let uuid = uuid(fuer: kennung), phasen[uuid] == .ausgehend else { return }
        anbieter?.reportOutgoingCall(with: uuid, connectedAt: nil)
    }

    /// Kamera an/aus: CallKit zeigt dann den Videoanruf-Bildschirm
    /// (Bughunt G3 — es gibt keinen „Videoanruf" als eigene Art, nur die
    /// zugeschaltete Kamera).
    func videoMelden(kennung: String?, an: Bool) {
        guard let kennung, let uuid = uuid(fuer: kennung) else { return }
        let stand = CXCallUpdate()
        stand.hasVideo = an
        anbieter?.reportCall(with: uuid, updated: stand)
    }
}
