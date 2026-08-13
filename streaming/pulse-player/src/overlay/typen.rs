//! Die Datentypen des Overlays: was ein Fensterereignis bedeutet hat, was der
//! Nutzer ausgeloest hat, und was das Statistik-Feld anzeigt.
//!
//! Abgetrennt von [`super`], weil dort die Zeichen-Schleife wohnt und die
//! Groessen-Policy (PLAN.md §12.1) sonst reisst. Reine Definitionen ohne
//! Verhalten — wer die Schleife lesen will, findet sie nebenan, und wer nur
//! wissen will, was `StatsView` traegt, muss sie nicht mehr durchblaettern.

use std::time::Instant;

/// Was ein Fensterereignis fuer das Overlay bedeutet hat.
///
/// **`verbraucht` ist nicht nur Beiwerk.** Die Bedienleiste liegt ueber dem
/// Bild; ein Klick auf ihr ist also im Bildrechteck und trotzdem keiner fuer
/// den fernen Rechner. Ohne diese Auskunft schickte die Eingabe-Erfassung
/// (`crate::fernsteuerung`) jeden Griff an den Lautstaerkeregler zusaetzlich als
/// Klick ueber die Leitung.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ereignisantwort {
    /// Ein Zeichen-Durchgang ist angefordert.
    pub durchgang: bool,
    /// egui hat den Zeiger fuer sich beansprucht.
    pub verbraucht: bool,
}

impl Ereignisantwort {
    pub const NICHTS: Self = Self { durchgang: false, verbraucht: false };
}

/// Was der Nutzer im Fenster ausgeloest hat. Angewandt wird es von
/// [`crate::app`] — dort liegen Sitzung und Fenster.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum OverlayAction {
    /// Neue Lautstaerke als Faktor (1.0 = 100 %).
    Volume(f32),
    Fullscreen(bool),
    /// Zurueck in die Kachel: Fenster zu, Bild wieder in der App. Entfaellt,
    /// wenn die App das Fenster erzwingt (10 bit kann das `<video>` nicht).
    Reattach,
    /// Diesen Stream nicht mehr ansehen — die App schliesst die Kachel. Das ist
    /// der Weg, den es bei erzwungenem Fenster vorher gar nicht gab: dort war
    /// Zumachen wirkungslos, weil sofort ein neues Fenster aufging.
    Close,
    /// Chat zu diesem Stream — die App holt ihr Fenster nach vorne und oeffnet
    /// ihn. Bewusst NICHT hier im Fenster: der Chat waere ein vollstaendiger
    /// Nachbau samt eigener Serververbindung.
    Chat,
    /// Statistikfeld ein- oder ausblenden.
    ToggleStats,
    /// Die Fernsteuerung beenden — NICHT den Stream. Das Fenster bleibt offen
    /// und zeigt weiter das Bild; die App loest die Sitzung auf. Bewusst hier
    /// und nicht nur in der App: wer gerade steuert, sieht das Fenster, nicht
    /// die Kachel dahinter.
    RemoteDisconnect,
}

/// Alles, was das Statistik-Feld anzeigt. Als Kopie herein, damit das Overlay
/// keine Sitzungsstruktur kennen muss.
pub struct StatsView<'a> {
    pub width: u32,
    pub height: u32,
    pub decoder: &'a str,
    pub hardware: bool,
    pub surface_format: &'a str,
    /// Gemessen von der Sitzung (eine Quelle fuer alle Anzeigen) — `None`, bis
    /// das erste Messfenster voll ist. Das ist die DEKODIERTE Rate.
    pub fps: Option<u64>,
    pub kbps: Option<u64>,
    /// Wie viele Bilder wirklich ausgegeben wurden (Zaehler, live nach jedem
    /// `present` erhoeht). Die Rate daraus rechnet dieses Modul selbst — hier
    /// ist das richtig, anders als bei `fps`: der Zaehler ist im Moment der
    /// Abfrage aktuell und nicht bis zu 250 ms alt.
    pub frames_presented: u64,
    /// Bilder, die dekodiert wurden, aber nie auf den Schirm kamen, weil das
    /// naechste schon da war. Ohne diesen Zaehler war genau dieser Verlust
    /// unsichtbar: er taucht weder unter „verworfen" noch unter
    /// „uebersprungen" auf.
    pub never_drawn: u64,
    /// Mittlere Dauer der beiden Abschnitte auf dem Fenster-Thread in
    /// Mikrosekunden. Bei 144 fps stehen zusammen nur 6900 zur Verfuegung.
    pub upload_us: u64,
    pub render_us: u64,
    /// Durchgaenge, in denen die Oberflaeche kein Bild hergab — das Bild ist
    /// dann verloren, ohne bei „nie gezeichnet" zu erscheinen. 0 = gesund.
    pub acquire_misses: u64,
    pub frames_dropped: u64,
    pub frames_skipped: u64,
    pub packets_lost: u64,
    pub buffered_packets: u64,
    pub jitter_target_ms: u64,
    pub ten_bit_source: bool,
    pub audio_active: bool,
    pub audio_underruns: u64,
    /// Das Ausgabegeraet hat einen Fehler gemeldet — dann kommt gar nichts
    /// mehr heraus, und "laeuft" waere eine Falschaussage.
    pub audio_geraetefehler: bool,
    pub recording: bool,
    /// Laeuft die Eingabe-Erfassung (= dieser Zuschauer steuert gerade)? Erst
    /// dann zeigt das Feld die Eingabe-Zeilen.
    pub fern_aktiv: bool,
    /// Worueber die Eingabe faehrt („Direktverbindung" / „Serverweg — …");
    /// leer = noch nichts gemeldet, dann steht dort schlicht „Serverweg" (der
    /// Weg, mit dem jede Sitzung beginnt).
    pub fern_transport: &'a str,
    /// Kumulierte Eingabe-Frames — die Rate rechnet das Overlay selbst, wie
    /// bei `frames_presented`.
    pub input_frames: u64,
    pub input_verworfen: u64,
    pub input_ohne_abbildung: u64,
}

/// Bezugspunkt fuer die Rate der ausgegebenen Bilder.
pub(super) struct PresentRate {
    pub(super) at: Instant,
    pub(super) frames: u64,
    pub(super) per_second: Option<u64>,
}
