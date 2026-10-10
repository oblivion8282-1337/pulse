import LiveKit
import SwiftUI

/// Die Farben der nativen Kanalansicht, abgelesen vom dunklen Satz der Web-App
/// (`web/src/app.css`, `.dark`-Block) — damit das Blatt nicht wie eine fremde
/// App aussieht, wenn es über die Oberfläche fährt.
///
/// **Immer dunkel, auch wenn der Nutzer hell gewählt hat.** Die Wahl lebt im
/// `localStorage` der Web-App (`dcc.settings`), und die Hülle liest den nicht —
/// sie müsste dafür JavaScript in die WebView schicken und auf eine Antwort
/// warten, bevor sie ein Blatt zeigen darf. Ein Gesprächsbildschirm ist in
/// jedem Telefon-Betriebssystem dunkel; das ist die billigere Abweichung als
/// ein verzögertes Öffnen. **Offen und bewusst so.**
enum SpracheFarben {
    static let grund = Color(red: 0.043, green: 0.043, blue: 0.047)
    static let kachel = Color(white: 1.0, opacity: 0.045)
    static let rand = Color(white: 1.0, opacity: 0.08)
    static let text = Color(red: 0.941, green: 0.945, blue: 0.953)
    static let textMatt = Color(red: 0.612, green: 0.639, blue: 0.686)
    static let marke = Color(red: 0.231, green: 0.510, blue: 0.965)
    static let gut = Color(red: 0.063, green: 0.725, blue: 0.506)
    static let schlecht = Color(red: 0.937, green: 0.267, blue: 0.267)
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
        .preferredColorScheme(.dark)
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

    /// „Verbunden · 3 Teilnehmer" — und bei allem anderen der rohe Zustand des
    /// SDK. Ein beschönigter Zwischenzustand wäre hier besonders teuer: wer die
    /// Ansicht offen hat, hat keine andere Anzeige.
    private var zustandsZeile: String {
        guard raum.connectionState == .connected else {
            return "\(raum.connectionState)"
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
                                  istBildschirm: k.istBildschirm)
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
            ergebnis.append(Eintrag(id: kennung + "|kamera", teilnehmer: p,
                                    video: p.firstCameraVideoTrack, istBildschirm: false))
            if let schirm = p.firstScreenShareVideoTrack {
                ergebnis.append(Eintrag(id: kennung + "|schirm", teilnehmer: p,
                                        video: schirm, istBildschirm: true))
            }
        }
        return ergebnis
    }
}
