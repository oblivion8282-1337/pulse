import LiveKit
import SwiftUI

/// Was die Ansicht von `SpracheRaum` beobachten muss, das kein
/// `ObservableObject` des SDK trägt. Heute nur `taub`: es lebt in der Hülle
/// (`SpracheRaum.taub`), nicht am `Room`. Geschrieben nur auf dem Hauptthread
/// (`didSet` dort schickt hierher).
final class SpracheStand: ObservableObject {
    static let geteilt = SpracheStand()
    @Published var taub = false
}

/// Die Knopfreihe der nativen Kanalansicht.
///
/// **Warum es sie überhaupt gibt, obwohl die Sprachleiste im Web lebt**
/// (Entwurf §2): die native Ansicht liegt ÜBER der WebView — solange sie steht,
/// ist die Web-Leiste nicht erreichbar. Eine Ansicht ohne eigene Knöpfe wäre
/// also eine, in der man nicht stummschalten kann.
///
/// **Mikrofon, Taub und Auflegen fragen das Web** (`SpracheRaum.wunsch`):
/// ihre Regeln (Admin-Stummschaltung, Sprechtaste, Watch-Party,
/// Wiederaufnahme) liegen dort. Bis zum 2026-10-11 fehlten Taub und Auflegen
/// hier ganz, mit einer Begründung, die nicht mehr stimmte — die Brücke hatte
/// `taub` längst, und „Auflegen gehört dem Web" heisst nicht, dass der Knopf
/// fehlen muss, sondern dass er das Web bittet. Kamera und Ausgabe schalten
/// direkt: an ihnen hängt keine Regel des Webs.
///
/// **Fünf Knöpfe, einzeilig.** Der Kamera-Wechsel sitzt deshalb auf der
/// eigenen Kachel (wie im Web, `CLAUDE.md`: „der Front/Rück-Wechsel auf der
/// eigenen Kamerakachel"): sechs runde 56-pt-Knöpfe passen auf ein schmales
/// Telefon nicht nebeneinander.
struct SpracheSteuerleiste: View {
    @ObservedObject var raum: Room
    @ObservedObject private var stand = SpracheStand.geteilt
    let fehlerMelden: (String) -> Void

    /// Spiegel der Vorgabe des SDK (`isSpeakerOutputPreferred`). Sie ist keine
    /// beobachtbare Eigenschaft, deshalb ein eigener Stand, beim Erscheinen
    /// abgelesen. **Es ist der WUNSCH, nicht die Route** — die wirkliche Route
    /// meldet `eigenerZustand` (sie wechselt asynchron, 8–17 ms, am Gerät
    /// gemessen). Bluetooth und AirPlay bleiben Sache des Systems.
    @State private var lautsprecher = true

    private var mikroAn: Bool { raum.localParticipant.isMicrophoneEnabled() }
    private var kameraAn: Bool { raum.localParticipant.isCameraEnabled() }

    var body: some View {
        HStack(spacing: 14) {
            knopf(
                symbol: mikroAn ? "mic.fill" : "mic.slash.fill",
                an: mikroAn, warnend: !mikroAn,
                beschriftung: mikroAn
                    ? NSLocalizedString("Mikrofon stummschalten", comment: "Sprachkanal")
                    : NSLocalizedString("Mikrofon einschalten", comment: "Sprachkanal")
            ) {
                try await SpracheRaum.geteilt.wunsch(.mikrofon, an: !mikroAn)
            }
            knopf(
                symbol: stand.taub ? "speaker.slash.fill" : "headphones",
                an: false, warnend: stand.taub,
                beschriftung: stand.taub
                    ? NSLocalizedString("Mithören einschalten", comment: "Sprachkanal")
                    : NSLocalizedString("Nicht mehr mithören", comment: "Sprachkanal")
            ) {
                try await SpracheRaum.geteilt.wunsch(.taub, an: !stand.taub)
            }
            knopf(
                symbol: kameraAn ? "video.fill" : "video.slash.fill",
                an: kameraAn, warnend: false,
                beschriftung: kameraAn
                    ? NSLocalizedString("Kamera ausschalten", comment: "Sprachkanal")
                    : NSLocalizedString("Kamera einschalten", comment: "Sprachkanal")
            ) {
                try await SpracheRaum.geteilt.nacheinander {
                    try await SpracheRaum.geteilt.kamera(!kameraAn)
                }
            }
            knopf(
                symbol: lautsprecher ? "speaker.wave.2.fill" : "ear",
                an: !lautsprecher, warnend: false,
                beschriftung: lautsprecher
                    ? NSLocalizedString("Auf Hörmuschel umschalten", comment: "Sprachkanal")
                    : NSLocalizedString("Auf Lautsprecher umschalten", comment: "Sprachkanal")
            ) {
                let neu = !lautsprecher
                SpracheRaum.geteilt.ausgabe(neu ? "lautsprecher" : "hoermuschel")
                await MainActor.run { lautsprecher = neu }
            }
            knopf(
                symbol: "phone.down.fill", an: false, warnend: true,
                beschriftung: NSLocalizedString("Auflegen", comment: "Sprachkanal")
            ) {
                try await SpracheRaum.geteilt.wunsch(.auflegen, an: true)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 6)
        .onAppear { lautsprecher = AudioManager.shared.isSpeakerOutputPreferred }
    }

    /// Ein runder Knopf. **Rund, weil Anruf-Steuerungen rund sind** — dieselbe
    /// Begründung wie in `VoiceControlBar.svelte`, und 56 pt ist dort das Mass
    /// fürs Telefon (48 pt wäre die Untergrenze der Trefferflächen-Regel).
    private func knopf(
        symbol: String,
        an: Bool,
        warnend: Bool,
        beschriftung: String,
        tun: @escaping () async throws -> Void
    ) -> some View {
        Button {
            // **Jeder Fehlschlag wird sichtbar.** Ein verschluckter Fehler ist
            // hier der teuerste Zustand: der Knopf sähe geschaltet aus, und
            // nichts hätte sich geändert. Im Simulator ist genau das der
            // Normalfall (kein Mikrofon, keine Kamera).
            Task {
                do {
                    try await tun()
                } catch {
                    NSLog("[PulseSprache] Knopf '%@' fehlgeschlagen: %@",
                          symbol, error.localizedDescription)
                    await MainActor.run { fehlerMelden(error.localizedDescription) }
                }
            }
        } label: {
            Image(systemName: symbol)
                .font(.system(size: 22, weight: .medium))
                .foregroundStyle(warnend ? Color.white : SpracheFarben.text)
                .frame(width: 56, height: 56)
                .background(hintergrund(an: an, warnend: warnend), in: Circle())
        }
        .accessibilityLabel(beschriftung)
    }

    private func hintergrund(an: Bool, warnend: Bool) -> Color {
        if warnend { return SpracheFarben.schlecht }
        return an ? SpracheFarben.marke : SpracheFarben.kachel
    }
}

// MARK: - Knöpfe, deren Regeln dem Web gehören

extension SpracheRaum {
    /// Ein Knopfdruck in der nativen Ansicht, dessen REGELN im Web liegen.
    ///
    /// **Warum nicht direkt.** Mikrofon, Taubstellen und Auflegen hängen an
    /// Regeln, die nur das Web kennt: ein Admin-Stummschalten darf die
    /// Ansicht nicht aufheben, Taub nimmt das Mikrofon mit und gibt es danach
    /// zurück (nicht bei der Sprechtaste), Auflegen beendet eine gehostete
    /// Watch-Party und löscht den Eintrag fürs Wiederaufnehmen. Bis zum
    /// 2026-10-11 schaltete der Mikrofon-Knopf hier direkt — und hob damit
    /// ein Admin-Stummschalten auf. Ein zweiter Weg zum selben Ziel läuft
    /// auseinander; deshalb geht der Wunsch ans Web, und das Web befiehlt.
    ///
    /// **Hört dort niemand zu** (Prüfpfad, Oberfläche lädt gerade neu), tut die
    /// Hülle es selbst — ein Knopf, der nichts tut, ist schlimmer als keiner.
    func wunsch(_ w: Wunsch, an: Bool) async throws {
        if wunschAnWeb?(w, an) == true {
            if w == .auflegen { auflegenAbsichern() }
            return
        }
        switch w {
        case .mikrofon: try await nacheinander { try await self.mikrofon(an) }
        case .taub: try await nacheinander { await self.taubStellen(an) }
        case .auflegen: await selbstAuflegen()
        }
    }

    /// **Auflegen muss immer gehen.** Antwortet das Web nicht binnen vier
    /// Sekunden (eingefroren, abgestürzt), legt die Hülle selbst auf.
    private func auflegenAbsichern() {
        let gemeint = sitzung
        Task {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard raum != nil, sitzung == gemeint else { return }
            NSLog("[PulseSprache] Auflegen: keine Antwort der Oberflaeche — die Huelle legt auf")
            await selbstAuflegen()
        }
    }

    /// Verlassen und es melden — die Delegat-Ereignisse des alten Raums gehen
    /// nach dem Verlassen nirgends mehr hin (`room === raum`-Wächter), also
    /// sagt es die Hülle selbst. Die Oberfläche räumt daraufhin ab wie nach
    /// einem Abbruch von aussen.
    private func selbstAuflegen() async {
        guard raum != nil else { return }
        await verlassen()
        melde?("verbindung", ["zustand": "disconnected"])
    }
}
