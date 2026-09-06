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
    /// Die Fernsteuerung ANFRAGEN — das Fenster fragt nicht selbst, es meldet
    /// nur den Wunsch. Wer gefragt wird, wie die Zusage aussieht und was bei
    /// einer Ablehnung geschieht, weiss allein die App (`$lib/remote/`).
    ///
    /// **Warum der Knopf hier ueberhaupt sitzt:** wer schon im Fenster zusieht,
    /// müsste sonst zurueck in die App wechseln, die Kachel suchen und dort
    /// klicken — fuer etwas, das genau dieses Fenster betrifft.
    RemoteRequest,
    /// Die Fernsteuerung beenden — NICHT den Stream. Das Fenster bleibt offen
    /// und zeigt weiter das Bild; die App loest die Sitzung auf. Bewusst hier
    /// und nicht nur in der App: wer gerade steuert, sieht das Fenster, nicht
    /// die Kachel dahinter.
    RemoteDisconnect,
    /// Einen weiteren Bildschirm des ferngesteuerten Rechners anfordern. Die
    /// Nummer ist die des Bildschirms auf dem fernen Rechner.
    ///
    /// **Das Fenster tut hier nichts selbst.** Es kennt weder das Geraet noch
    /// die Sitzung beim Server; anfordern kann nur die App. Dasselbe Muster wie
    /// bei [`OverlayAction::Chat`] und [`OverlayAction::RemoteDisconnect`].
    RemoteScreen(u32),
    /// Ein Kaestchen der Bildschirm-Karte antippen, das schon offen ist — aber
    /// in einem ANDEREN Fenster als diesem. Anders als
    /// [`OverlayAction::RemoteScreen`] wird hier nichts neu angefordert: das
    /// Fenster existiert im selben Prozess bereits, es soll nur nach vorne.
    /// Die Nummer ist die des Bildschirms auf dem fernen Rechner.
    RemoteScreenFocus(u32),
    /// Knopf „Fenster wie drueben anordnen": alle offenen Fenster DIESER
    /// Fernsteuerungs-Sitzung auf dem eigenen Bildschirm so legen, wie die
    /// Host-Monitore zueinander liegen. Zielflaeche ist der Bildschirm, auf
    /// dem GENAU DIESES Fenster liegt. Einmalig auf Knopfdruck, kein
    /// Dauerzustand — wer danach von Hand nachzieht, behaelt seine Anordnung.
    ///
    /// **Das Fenster tut hier nichts selbst.** Es kennt weder die Fenster-
    /// Objekte der anderen Sitzungen noch, ob die Oberflaeche das Setzen von
    /// Fensterlagen ueberhaupt zulaesst (unter Wayland nicht) — beides liegt
    /// in der App (`crate::app::anordnen`). Der Knopf erscheint deshalb nur,
    /// wenn beides zutrifft.
    FensterAnordnen,
    /// Schalter „Zwischenablage teilen", je Sitzung, Vorgabe an.
    ///
    /// **Das Fenster tut hier nichts selbst** — wie ueberall in dieser Liste.
    /// Was daran haengt, steht in `app::ablage`: ausschalten gibt einen
    /// laufenden Anspruch frei und schreibt den Vorbestand zurueck, statt
    /// bloss den naechsten Anspruch zu unterlassen. Sonst bliebe die Ablage
    /// des Nutzers leer, obwohl er das Teilen gerade abgeschaltet hat.
    AblageTeilen(bool),
}

/// Ein Bildschirm des ferngesteuerten Rechners, wie ihn die App ins Fenster
/// meldet. Reine Anzeige — die Entscheidung, was ein Klick ausloest, faellt in
/// der App.
///
/// **Alle fuenf neuen Felder (`x`/`y`/`width`/`height`/`dieses_fenster`)
/// tragen `#[serde(default)]` — aus zwei VERSCHIEDENEN Gruenden, nicht aus
/// einem gemeinsamen:**
///
/// * An `dieses_fenster` (`bool`, kein `Option`) ist die Annotation
///   **tragend**: serde verlangt ein `bool`-Feld ohne Angabe standardmaessig
///   als vorhanden und bricht sonst mit „missing field" ab. Gemessen, nicht
///   angenommen (Wegwerf-Probe gegen serde direkt) — der Test
///   `dieses_fenster_fehlt_und_defaultet_auf_false` unten haelt genau diesen
///   Fall fest.
/// * An `x`/`y`/`width`/`height` (alle `Option<T>`) ist sie dagegen nur
///   **Deutlichkeit**: serde behandelt ein `Option<T>`-Feld schon eingebaut
///   als optional und liest ein fehlendes als `None` — mit oder ohne die
///   Annotation, kein Test kann daran also je etwas festmachen. Sie steht
///   trotzdem an allen vieren, weil eine Datei, in der vier Felder die
///   Angabe tragen und eines nicht, ohne erkennbaren Grund verwirrt; mit
///   diesem Kommentar ist der Grund sichtbar.
///
/// Damit bricht eine aeltere Gegenstelle — App ODER Geraet, die keines der
/// fuenf Felder kennt — an keiner Stelle.
#[derive(Clone, Debug, serde::Deserialize)]
pub struct Schirm {
    /// Nummer auf dem fernen Rechner (1-basiert).
    pub index: u32,
    /// Lesbarer Name, wie ihn der ferne Rechner gemeldet hat.
    pub name: String,
    /// Laeuft dieser Bildschirm schon in einem Fenster? Dann holt der Klick es
    /// nach vorne, statt eine zweite Uebertragung zu starten.
    #[serde(default)]
    pub open: bool,
    /// Lage und Groesse in Bildpunkten auf dem fernen Rechner — Grundlage der
    /// massstaeblichen Bildschirm-Karte. `x`/`y` duerfen negativ sein (ein
    /// Monitor links vom oder ueber dem Hauptbildschirm hat eine negative
    /// Lage); `width`/`height` sind immer positiv. Fehlt eine der vier, ist
    /// die Lage insgesamt unbekannt — die Karte zeichnet dann nichts fuer
    /// diesen Bildschirm, statt zu raten. `#[serde(default)]` ist hier reine
    /// Deutlichkeit, s. Erklaerung am Typ oben — kein Test haengt daran.
    #[serde(default)]
    pub x: Option<i32>,
    #[serde(default)]
    pub y: Option<i32>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    /// Zeigt DIESES Fenster genau diesen Bildschirm? Die App markiert je
    /// Fenster hoechstens EINEN Eintrag — und **keinen**, wenn sie die
    /// Zuordnung Strom-zu-Bildschirm nicht sicher treffen kann
    /// (fail-visible, `web/src/lib/stream/schirmFuerFenster.ts`): lieber gar
    /// keine Markierung als eine falsche, die auf den falschen Bildschirm
    /// schickt. `#[serde(default)]` ist hier TRAGEND, s. Erklaerung am Typ
    /// oben.
    #[serde(default)]
    pub dieses_fenster: bool,
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

/// Bezugspunkt einer laufend fortgeschriebenen Rate — die ausgegebenen Bilder
/// und die Eingabe-Frames der Fernsteuerung teilen sich die Mechanik
/// (`Overlay::rate_nachziehen`).
pub(super) struct PresentRate {
    pub(super) at: Instant,
    pub(super) frames: u64,
    pub(super) per_second: Option<u64>,
}

impl PresentRate {
    /// Frischer Bezugspunkt: ab jetzt zaehlen, noch keine Rate.
    pub(super) fn neu() -> Self {
        Self { at: Instant::now(), frames: 0, per_second: None }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Eine aeltere Gegenstelle (App ODER Geraet) kennt die vier Lage-Felder
    /// und `dieses_fenster` noch nicht und laesst alle fuenf im JSON weg —
    /// die Nachricht bleibt trotzdem lesbar.
    ///
    /// **Sagt NICHT aus, welches `#[serde(default)]` dafuer sorgt.** Bei
    /// `x`/`y`/`width`/`height` (`Option<T>`) waere dieser Test genauso
    /// gruen, wenn man die Annotation dort entfernt — serde liest ein
    /// fehlendes `Option`-Feld eingebaut als `None`. Nur bei `dieses_fenster`
    /// (`bool`) ist sie tragend; das isoliert
    /// `dieses_fenster_fehlt_und_defaultet_auf_false` unten eigens, weil
    /// dieser Test hier es nicht leistet.
    #[test]
    fn schirm_ohne_neue_felder_bleibt_deserialisierbar() {
        let s: Schirm = serde_json::from_str(r#"{"index":1,"name":"Bildschirm 1"}"#).unwrap();
        assert_eq!(s.index, 1);
        assert_eq!(s.name, "Bildschirm 1");
        assert!(!s.open);
        assert_eq!(s.x, None);
        assert_eq!(s.y, None);
        assert_eq!(s.width, None);
        assert_eq!(s.height, None);
        assert!(!s.dieses_fenster);
    }

    /// Isoliert das EINE Feld, an dem `#[serde(default)]` wirklich traegt:
    /// alle vier Lage-Felder UND `open` sind im JSON gesetzt, nur
    /// `dieses_fenster` fehlt. Ohne die Annotation an `dieses_fenster` waere
    /// das ein Deserialisierungsfehler („missing field"); mit ihr defaultet
    /// es auf `false` — der Fall, den eine App meldet, die die Markierung
    /// noch nicht kennt, aber die Lage schon.
    #[test]
    fn dieses_fenster_fehlt_und_defaultet_auf_false() {
        let s: Schirm = serde_json::from_str(
            r#"{"index":1,"name":"Bildschirm 1","open":true,"x":0,"y":0,
                "width":1920,"height":1080}"#,
        )
        .unwrap();
        assert!(!s.dieses_fenster);
    }

    /// Die volle Meldung mit Lage, Groesse und Markierung.
    #[test]
    fn schirm_mit_lage_und_markierung() {
        let s: Schirm = serde_json::from_str(
            r#"{"index":2,"name":"Rechts","open":true,"x":-1920,"y":0,
                "width":1920,"height":1080,"dieses_fenster":true}"#,
        )
        .unwrap();
        assert!(s.open);
        assert_eq!(s.x, Some(-1920));
        assert_eq!(s.y, Some(0));
        assert_eq!(s.width, Some(1920));
        assert_eq!(s.height, Some(1080));
        assert!(s.dieses_fenster);
    }
}
