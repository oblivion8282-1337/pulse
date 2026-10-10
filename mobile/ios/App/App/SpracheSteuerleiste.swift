import LiveKit
import SwiftUI

/// Die Knopfreihe der nativen Kanalansicht.
///
/// **Warum es sie überhaupt gibt, obwohl die Sprachleiste im Web lebt**
/// (Entwurf §2): die native Ansicht liegt ÜBER der WebView — solange sie steht,
/// ist die Web-Leiste nicht erreichbar. Eine Ansicht ohne eigene Knöpfe wäre
/// also eine, in der man nicht stummschalten kann.
///
/// **Was hier bewusst NICHT steht, und warum:**
/// - **Auflegen.** Das Verlassen gehört dem Web: dort hängen das Beenden einer
///   gehosteten Watch-Party, der Resume-Eintrag für den nächsten Start und die
///   Töne daran (`livekit.svelte.ts::disconnect`). Ein nativer Knopf müsste das
///   Web darum bitten und auf dessen Antwort warten — ein zweiter Weg zum
///   selben Ziel, der auseinanderlaufen kann. Weg zum Auflegen: Ansicht
///   schliessen (Wischen oder Pfeil), die Leiste liegt darunter. **Zwei
///   Handgriffe statt einem — offener Punkt.**
/// - **Mithören aus (taub).** Die Brücke hat den Befehl noch nicht, und der
///   Web-Weg dafür dreht an HTML-`<audio>`-Elementen, die es auf dem nativen
///   Weg gar nicht gibt. Ein Knopf, der nichts tut, ist schlimmer als keiner.
struct SpracheSteuerleiste: View {
    @ObservedObject var raum: Room
    let fehlerMelden: (String) -> Void

    /// Spiegel der Vorgabe des SDK (`isSpeakerOutputPreferred`). Sie ist keine
    /// beobachtbare Eigenschaft, deshalb ein eigener Stand, beim Erscheinen
    /// abgelesen.
    ///
    /// **Es ist der WUNSCH, nicht die Route.** Welche Route wirklich anliegt,
    /// sagt `eigenerZustand` an die Oberfläche (sie wechselt asynchron, 8–17 ms
    /// nach dem Umschalten — am Gerät gemessen, Begründung in
    /// `SpracheRaum.ausgabe`). Bluetooth und AirPlay bleiben Sache des Systems.
    @State private var lautsprecher = true

    private var mikroAn: Bool { raum.localParticipant.isMicrophoneEnabled() }
    private var kameraAn: Bool { raum.localParticipant.isCameraEnabled() }

    var body: some View {
        HStack(spacing: 14) {
            knopf(
                symbol: mikroAn ? "mic.fill" : "mic.slash.fill",
                an: mikroAn,
                warnend: !mikroAn,
                beschriftung: mikroAn
                    ? NSLocalizedString("Mikrofon stummschalten", comment: "Sprachkanal")
                    : NSLocalizedString("Mikrofon einschalten", comment: "Sprachkanal")
            ) {
                try await SpracheRaum.geteilt.mikrofon(!mikroAn)
            }
            knopf(
                symbol: kameraAn ? "video.fill" : "video.slash.fill",
                an: kameraAn,
                warnend: false,
                beschriftung: kameraAn
                    ? NSLocalizedString("Kamera ausschalten", comment: "Sprachkanal")
                    : NSLocalizedString("Kamera einschalten", comment: "Sprachkanal")
            ) {
                try await SpracheRaum.geteilt.kamera(!kameraAn)
            }
            // Der Front/Rück-Wechsel erscheint nur, wenn es ein Bild gibt, das
            // er umstellen könnte — dasselbe Verhalten wie im Web.
            if kameraAn {
                knopf(
                    symbol: "arrow.triangle.2.circlepath.camera",
                    an: false,
                    warnend: false,
                    beschriftung: NSLocalizedString("Kamera wechseln", comment: "Sprachkanal")
                ) {
                    try await SpracheRaum.geteilt.kameraSeite(
                        front: !SpracheRaum.geteilt.kameraVorn)
                }
            }
            knopf(
                symbol: lautsprecher ? "speaker.wave.2.fill" : "ear",
                an: !lautsprecher,
                warnend: false,
                beschriftung: lautsprecher
                    ? NSLocalizedString("Auf Hörmuschel umschalten", comment: "Sprachkanal")
                    : NSLocalizedString("Auf Lautsprecher umschalten", comment: "Sprachkanal")
            ) {
                let neu = !lautsprecher
                SpracheRaum.geteilt.ausgabe(neu ? "lautsprecher" : "hoermuschel")
                await MainActor.run { lautsprecher = neu }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 6)
        .onAppear { lautsprecher = AudioManager.shared.isSpeakerOutputPreferred }
    }

    /// Ein runder Knopf. **Rund, weil Anruf-Steuerungen rund sind** — dieselbe
    /// Begründung wie in `VoiceControlBar.svelte`, und 56 pt ist dort das Mass
    /// fürs Telefon. 48 pt wäre die Untergrenze aus der Trefferflächen-Regel;
    /// die Leiste hat den Platz für mehr.
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
