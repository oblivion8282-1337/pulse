import LiveKit
import SwiftUI
import UIKit

/// Die Farben der nativen Kanalansicht, abgelesen von den beiden Sätzen der
/// Web-App (`web/src/app.css`: `:root` hell, `.dark` dunkel) — damit das Blatt
/// nicht wie eine fremde App aussieht, wenn es über die Oberfläche fährt.
///
/// **Sie folgt dem Thema der Web-App** (seit 2026-10-11). Bis dahin war sie
/// immer dunkel, mit der Begründung, die Hülle müsste die Wahl erst aus dem
/// `localStorage` der WebView lesen. Das muss sie nicht: das Web reicht sie
/// beim Öffnen mit (`ansichtOeffnen({thema})`), und der Halter setzt sie als
/// `overrideUserInterfaceStyle`. Die Farben hier sind deshalb dynamisch — bis
/// auf die drei für die dunkle Kapsel (`aufBild`, `warnungAufBild`, `schild`),
/// die in beiden Themen gleich bleiben; `system` folgt dem Telefon auch,
/// während die Ansicht offen ist.
enum SpracheFarben {
    static let grund = farbe(hell: (0.914, 0.925, 0.949, 1), dunkel: (0.043, 0.043, 0.047, 1))
    static let kachel = farbe(hell: (1, 1, 1, 1), dunkel: (1, 1, 1, 0.045))
    /// Runde Knöpfe in Ruhe. Hell ist die weisse Kachelfläche auf dem hellen
    /// Grund zu schwach; die Web-App nimmt dort `--secondary`.
    static let knopf = farbe(hell: (0.067, 0.094, 0.153, 0.06), dunkel: (1, 1, 1, 0.045))
    static let rand = farbe(hell: (0.067, 0.094, 0.153, 0.14), dunkel: (1, 1, 1, 0.08))
    static let text = farbe(hell: (0.067, 0.094, 0.153, 1), dunkel: (0.941, 0.945, 0.953, 1))
    static let textMatt = farbe(hell: (0.294, 0.333, 0.388, 1), dunkel: (0.612, 0.639, 0.686, 1))
    static let marke = farbe(hell: (0.145, 0.388, 0.922, 1), dunkel: (0.231, 0.510, 0.965, 1))
    static let gut = farbe(hell: (0.016, 0.471, 0.341, 1), dunkel: (0.063, 0.725, 0.506, 1))
    static let schlecht = farbe(hell: (0.863, 0.149, 0.149, 1), dunkel: (0.937, 0.267, 0.267, 1))
    /// Schrift und Zeichen AUF einem Bild oder einer abgedunkelten Kapsel —
    /// in beiden Themen hell, sonst stünde Dunkel auf Dunkel.
    static let aufBild = Color(red: 0.941, green: 0.945, blue: 0.953)
    /// Das Stumm-Zeichen auf derselben Kapsel: das Rot des DUNKLEN Satzes —
    /// das dunklere `#dc2626` des hellen ist für weisse Flächen gedacht.
    static let warnungAufBild = Color(red: 0.937, green: 0.267, blue: 0.267)
    /// Das Schild der Admin-Stummschaltung (`amber-400`, wie `VoiceMuteIcon`).
    static let schild = Color(red: 0.984, green: 0.749, blue: 0.141)

    private typealias RGBA = (CGFloat, CGFloat, CGFloat, CGFloat)

    private static func farbe(hell: RGBA, dunkel: RGBA) -> Color {
        Color(UIColor { merkmale in
            let f = merkmale.userInterfaceStyle == .dark ? dunkel : hell
            return UIColor(red: f.0, green: f.1, blue: f.2, alpha: f.3)
        })
    }
}

/// Die native Kanalansicht: Kacheln, Video, Pegel, Steuerung.
///
/// **Warum sie nativ ist.** Auf iOS hält die Hülle den LiveKit-Raum (Grund:
/// die Hörmuschel, voller Befund im Entwurf
/// `docs/superpowers/specs/2026-10-10-ios-nativer-sprachweg-design.md`). Die
/// Spuren entstehen damit im nativen Prozess, und die WebView kann sie nicht
/// anzeigen — ohne diese Ansicht hat der Sprachkanal auf iOS KEIN Bild.
///
/// **Der Pegel geht nicht über die Brücke, er wird hier gezeichnet.** Capacitors
/// Brücke ist eine einzige serielle Warteschlange, und ihre Verstopfung hat am
/// 2026-10-10 die App einfrieren lassen. Deshalb beobachtet diese Ansicht
/// `Room` und jede Kachel ihren `Participant` direkt — beide sind
/// `ObservableObject` und melden jede Zustandsänderung (Pegel inbegriffen) an
/// SwiftUI, auf dem Hauptthread.
///
/// **Ungemessen:** was dieses Beobachten unter Last kostet. Das SDK schickt
/// `objectWillChange` je Mutation; bei einer Handvoll Kacheln ist das
/// unauffällig, bei zwanzig nicht nachgeprüft. Der Hebel, falls es je klemmt,
/// wäre ein Drosseln zwischen `Room` und dieser Ansicht — nicht ein Umweg über
/// die Brücke, der wäre genau die alte Falle.
struct SpracheAnsicht: View {
    @ObservedObject var raum: Room
    let kanalName: String
    let schliessen: () -> Void

    /// Fehlschläge der Steuerung — sichtbar, nicht verschluckt. Im Simulator
    /// ist das der Normalfall (keine Kamera, kein Mikrofon), am Gerät die
    /// verweigerte Erlaubnis.
    @State private var fehler: String?

    var body: some View {
        VStack(spacing: 0) {
            kopf
            if let fehler {
                fehlerband(fehler)
            }
            kacheln
            SpracheSteuerleiste(raum: raum, fehlerMelden: { self.fehler = $0 })
        }
        .background(SpracheFarben.grund.ignoresSafeArea())
    }

    // MARK: - Kopfzeile

    private var kopf: some View {
        HStack(spacing: 12) {
            Button(action: schliessen) {
                Image(systemName: "chevron.down")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(SpracheFarben.text)
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel(
                NSLocalizedString("Kanalansicht schliessen", comment: "Sprachkanal"))
            VStack(alignment: .leading, spacing: 1) {
                Text(kanalName.isEmpty
                    ? NSLocalizedString("Sprachkanal", comment: "Sprachkanal") : kanalName)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(SpracheFarben.text)
                    .lineLimit(1)
                Text(zustandsZeile)
                    .font(.system(size: 13))
                    .foregroundStyle(SpracheFarben.textMatt)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.trailing, 16)
        .padding(.top, 4)
    }

    /// „Verbunden · 3 Teilnehmer", sonst der Zustand in Worten. Ein
    /// beschönigter Zwischenzustand wäre hier besonders teuer: wer die Ansicht
    /// offen hat, hat keine andere Anzeige. Bis zum 2026-10-11 stand hier der
    /// rohe Wert des SDK (`.reconnecting`, Bughunt G1).
    private var zustandsZeile: String {
        switch raum.connectionState {
        case .connected: break
        case .connecting: return NSLocalizedString("Verbinde …", comment: "Sprachkanal")
        case .reconnecting:
            return NSLocalizedString("Verbindung wird wiederhergestellt …", comment: "Sprachkanal")
        case .disconnecting, .disconnected:
            return NSLocalizedString("Getrennt", comment: "Sprachkanal")
        }
        let anzahl = raum.remoteParticipants.count + 1
        return anzahl == 1
            ? NSLocalizedString("Verbunden · allein im Kanal", comment: "Sprachkanal")
            : String(
                format: NSLocalizedString("Verbunden · %d Teilnehmer", comment: "Sprachkanal"),
                anzahl)
    }

    private func fehlerband(_ text: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
            Text(text).font(.system(size: 13)).lineLimit(3)
            Spacer(minLength: 0)
            Button(NSLocalizedString("OK", comment: "Fehlerband")) { fehler = nil }
                .font(.system(size: 13, weight: .semibold))
        }
        .foregroundStyle(SpracheFarben.schlecht)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    // MARK: - Kacheln

    private var kacheln: some View {
        ScrollView {
            LazyVGrid(columns: spalten, spacing: 10) {
                ForEach(kachelListe) { k in
                    SpracheKachel(teilnehmer: k.teilnehmer, video: k.video,
                                  istBildschirm: k.istBildschirm,
                                  umschalten: k.eigeneKamera ? kameraUmschalten : nil)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
        }
    }

    /// **Bis zwei Kacheln EINE Spalte, darüber so viele wie hineinpassen.**
    /// Im Simulator nachgesehen: zwei kleine Rechtecke am oberen Rand eines
    /// sonst schwarzen Bildschirms sehen nach einem Fehler aus, nicht nach
    /// einem Gespräch — und ein Zweiergespräch ist der häufigste Fall. Ab drei
    /// zählt wieder, dass alle sichtbar bleiben.
    ///
    /// Kein Breakpoint und keine Fensterbreite: die Spaltenzahl folgt dem
    /// Platz, den `adaptive` selbst ausrechnet.
    private var spalten: [GridItem] {
        kachelListe.count <= 2
            ? [GridItem(.flexible(), spacing: 10)]
            : [GridItem(.adaptive(minimum: 150, maximum: 400), spacing: 10)]
    }

    private struct Eintrag: Identifiable {
        let id: String
        let teilnehmer: Participant
        let video: VideoTrack?
        let istBildschirm: Bool
        /// Die eigene, laufende Kamera — nur sie bekommt den Wechsel-Knopf.
        var eigeneKamera = false
    }

    /// Front ↔ Rück. Sitzt auf der eigenen Kachel statt in der Knopfreihe
    /// (Begründung an `SpracheSteuerleiste`).
    private func kameraUmschalten() {
        let sprache = SpracheRaum.geteilt
        Task {
            do {
                try await sprache.nacheinander {
                    try await sprache.kameraSeite(front: !sprache.kameraVorn)
                }
            } catch {
                await MainActor.run { fehler = error.localizedDescription }
            }
        }
    }

    /// **Die Reihenfolge wird festgelegt, nicht übernommen.** `remoteParticipants`
    /// ist ein Dictionary; seine Aufzählung ist nicht stabil, und die Kacheln
    /// sprängen bei jeder Pegel-Änderung um. Sortiert wird nach Kennung —
    /// stabil, auch wenn jemand kommt oder geht. Der eigene Teilnehmer steht
    /// immer vorn.
    ///
    /// Eine Bildschirmfreigabe bekommt eine EIGENE Kachel neben der Kamera
    /// desselben Teilnehmers; beides in eine zu quetschen hiesse, eines von
    /// beiden zu verstecken.
    private var kachelListe: [Eintrag] {
        var leute: [Participant] = [raum.localParticipant]
        leute += raum.remoteParticipants.values
            .sorted { ($0.identity?.stringValue ?? "") < ($1.identity?.stringValue ?? "") }
        var ergebnis: [Eintrag] = []
        for p in leute {
            let kennung = p.identity?.stringValue ?? "?"
            let video = p.firstCameraVideoTrack
            ergebnis.append(Eintrag(id: kennung + "|kamera", teilnehmer: p,
                                    video: video, istBildschirm: false,
                                    eigeneKamera: p is LocalParticipant && video != nil))
            if let schirm = p.firstScreenShareVideoTrack {
                ergebnis.append(Eintrag(id: kennung + "|schirm", teilnehmer: p,
                                        video: schirm, istBildschirm: true))
            }
        }
        return ergebnis
    }
}
