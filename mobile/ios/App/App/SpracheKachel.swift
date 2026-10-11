import LiveKit
import SwiftUI

/// Eine Teilnehmerkachel: Video oder Namenskreis, Name, Stumm-Zeichen,
/// Sprech-Ring und **Pegel**.
///
/// **Der Pegel wird HIER gezeichnet und geht nie über die Brücke.** Er ändert
/// sich mehrmals pro Sekunde und je Teilnehmer; Capacitors Brücke ist eine
/// einzige serielle Warteschlange, und ihre Verstopfung hat am 2026-10-10 die
/// App einfrieren lassen. Über die Brücke geht nur die Kippkante
/// (`sprechen`) — der Rest bleibt in diesem Prozess.
///
/// Dafür beobachtet die Kachel ihren `Participant` selbst: er ist ein
/// `ObservableObject` und meldet jede Mutation (`audioLevel`, `isSpeaking`,
/// Spuren) an SwiftUI. Die Delegat-Rufe des SDK kommen NICHT vom Hauptthread —
/// dieser Weg ist genau deshalb der richtige: das `objectWillChange` des SDK
/// wird in einem `Task { @MainActor }` geschickt, SwiftUI fasst die Ansicht
/// also auf dem Hauptthread an, ohne dass wir dafür etwas tun müssten.
struct SpracheKachel: View {
    @ObservedObject var teilnehmer: Participant
    @ObservedObject private var stand = SpracheStand.geteilt
    let video: VideoTrack?
    let istBildschirm: Bool
    /// Front/Rück-Wechsel — nur auf der eigenen Kamerakachel gesetzt.
    var umschalten: (() -> Void)?

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(SpracheFarben.kachel)
            inhalt
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            ring
            VStack {
                if let umschalten { wechselKnopf(umschalten) }
                Spacer(minLength: 0)
                fussZeile
            }
            .padding(8)
        }
        .aspectRatio(4.0 / 3.0, contentMode: .fit)
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(SpracheFarben.rand, lineWidth: 1)
        )
    }

    // MARK: - Inhalt

    @ViewBuilder private var inhalt: some View {
        if let video {
            // `mirrorMode: .auto` spiegelt die EIGENE Frontkamera und sonst
            // nichts — so, wie man es aus jedem Videoanruf kennt. Eine
            // Bildschirmfreigabe wird nie gespiegelt, deshalb reicht `.auto`
            // auch hier.
            //
            // `layoutMode`: eine Kamera füllt die Kachel (`.fill`), eine
            // Bildschirmfreigabe darf NICHT beschnitten werden — bei einem
            // geteilten Bildschirm ist der Rand oft genau das, worum es geht.
            SwiftUIVideoView(video,
                             layoutMode: istBildschirm ? .fit : .fill,
                             mirrorMode: .auto)
        } else {
            namensKreis
        }
    }

    private var namensKreis: some View {
        Circle()
            .fill(SpracheFarben.marke.opacity(0.25))
            .overlay(
                Text(anfangsBuchstaben)
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(SpracheFarben.text)
            )
            .frame(width: 64, height: 64)
    }

    /// Bis zu zwei Anfangsbuchstaben. Bei einem Gast-Namen ohne Leerzeichen ist
    /// es einer — bewusst keine Kunstgriffe, ein falsch geratenes Kürzel ist
    /// schlimmer als ein kurzes.
    private var anfangsBuchstaben: String {
        let teile = anzeigeName.split(separator: " ").prefix(2)
        let kurz = String(teile.compactMap(\.first))
        return kurz.isEmpty ? "?" : kurz.uppercased()
    }

    private var anzeigeName: String {
        if let n = teilnehmer.name, !n.isEmpty { return n }
        return teilnehmer.identity?.stringValue ?? "?"
    }

    // MARK: - Ring und Pegel

    /// Sprech-Ring: er ist DA, sobald das SDK den Teilnehmer als sprechend
    /// meldet, und seine Dicke folgt dem Pegel. Zwei Anzeigen in einer, und
    /// das mit Absicht: ein Ring, der nur am Pegel hing, flackerte bei jedem
    /// Atemgeräusch; einer, der nur an der Kippkante hing, stand starr da.
    private var ring: some View {
        RoundedRectangle(cornerRadius: 14, style: .continuous)
            .strokeBorder(
                SpracheFarben.gut.opacity(teilnehmer.isSpeaking ? 0.95 : 0),
                lineWidth: teilnehmer.isSpeaking ? 2 + 4 * pegel : 0
            )
            .animation(.easeOut(duration: 0.12), value: pegel)
            .allowsHitTesting(false)
    }

    /// 0..1, gedeckelt. `audioLevel` des SDK kommt vom Server und ist
    /// ausserhalb des Sprechens 0 — ohne Deckel würde ein Ausreisser den Ring
    /// über die Kachel hinaus wachsen lassen.
    private var pegel: Double {
        min(max(Double(teilnehmer.audioLevel), 0), 1)
    }

    // MARK: - Kamera-Wechsel

    /// 48 pt Trefferfläche (Regel aus `mobile-treffflaechen.spec.ts`), das
    /// Zeichen darin kleiner.
    private func wechselKnopf(_ tun: @escaping () -> Void) -> some View {
        HStack {
            Spacer(minLength: 0)
            Button(action: tun) {
                Image(systemName: "arrow.triangle.2.circlepath.camera")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(SpracheFarben.aufBild)
                    .frame(width: 36, height: 36)
                    .background(Color.black.opacity(0.55), in: Circle())
                    .frame(width: 48, height: 48)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel(NSLocalizedString("Kamera wechseln", comment: "Sprachkanal"))
        }
    }

    // MARK: - Fusszeile

    /// Die Kapsel liegt auf Bild oder Kachel, in jedem Thema dunkel — Schrift
    /// und neutrale Zeichen darin deshalb immer hell (`SpracheFarben.aufBild`),
    /// die Stumm-Zeichen im Rot des dunklen Satzes (`warnungAufBild`).
    private var fussZeile: some View {
        // Von der Moderation geschaltet: dasselbe Zeichen mit Schild, wie
        // `VoiceMuteIcon.svelte` im Web. Bis zum 2026-10-11 sah es hier aus wie
        // eine eigene Stummschaltung, und die Taubschaltung fehlte ganz.
        let zwang = stand.erzwungen(fuer: teilnehmer)
        return HStack(spacing: 6) {
            // Kein Zeichen für „Mikrofon an" — eine Reihe immer sichtbarer
            // Symbole sagt weniger als ein einzelnes, das etwas bedeutet.
            if !teilnehmer.isMicrophoneEnabled() || zwang.stumm {
                zeichen("mic.slash.fill", mitSchild: zwang.stumm,
                        beschriftung: zwang.stumm
                            ? NSLocalizedString("Vom Mod stummgeschaltet", comment: "Sprachkanal")
                            : NSLocalizedString("Stummgeschaltet", comment: "Sprachkanal"))
            }
            if zwang.taub {
                zeichen("speaker.slash.fill", mitSchild: true,
                        beschriftung: NSLocalizedString("Vom Mod taubgeschaltet", comment: "Sprachkanal"))
            }
            if istBildschirm {
                Image(systemName: "rectangle.on.rectangle")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(SpracheFarben.aufBild.opacity(0.7))
            }
            Text(anzeigeName)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(SpracheFarben.aufBild)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(Color.black.opacity(0.55), in: Capsule())
    }

    private func zeichen(_ symbol: String, mitSchild: Bool, beschriftung: String) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(SpracheFarben.warnungAufBild)
            .overlay(alignment: .bottomTrailing) {
                if mitSchild {
                    Image(systemName: "shield.fill")
                        .font(.system(size: 7, weight: .bold))
                        .foregroundStyle(SpracheFarben.schild)
                        .offset(x: 3, y: 3)
                }
            }
            .accessibilityLabel(beschriftung)
    }
}
