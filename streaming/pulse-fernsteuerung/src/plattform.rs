//! Der Schnitt zwischen Kern und Betriebssystem — drei Traits, sonst nichts.
//!
//! Wer eine neue Plattform anschliesst, schreibt genau diese drei und sonst
//! nichts. Umgekehrt gilt: was hier nicht steht, kennt der Kern nicht — und
//! darf ihn deshalb auch nicht beeinflussen.
//!
//! **`Sync`, weil die Sitzung von mehreren Faeden gerufen wird:** vom
//! Dispatch-Faden (eingehende Nachrichten) und vom Wecker der Wache
//! (Vorrang-Uebergaenge).

use crate::druck::Druck;
use crate::zuordnung::Rechteck;

/// Was die Plattform mit dem Betriebssystem macht.
///
/// **Alles hier ist Ausfuehrung ohne Entscheidung.** Ob ueberhaupt injiziert
/// wird, entscheidet die Sitzung; wohin, [`crate::zuordnung`]. Ein Injektor,
/// der selbst entscheidet, waere eine zweite Meinung an einer Stelle, an der
/// es nur eine geben darf.
pub trait Injektor: Sync {
    /// Den Zeiger **absolut** auf `punkt` setzen.
    ///
    /// `gedrueckt` sagt, welche Maustasten gerade unten sind. Windows braucht
    /// das nicht; **macOS schon**: eine Bewegung bei gedruecktem Knopf ist
    /// dort ein eigener Ereignistyp (`LeftMouseDragged` statt `MouseMoved`),
    /// und ohne diese Unterscheidung zieht in vielen Programmen nichts.
    fn maus_setzen(&self, punkt: (i32, i32), gedrueckt: &Druck);

    /// Eine Maustaste. `btn` ist bereits gegen
    /// [`crate::format::knopf_bekannt`] geprueft — hier wird nicht mehr
    /// entschieden, hier wird abgefeuert.
    fn maus_knopf(&self, btn: u8, down: bool);

    /// Das Mausrad in Windows-Rastschritten (120 = eine Raste), `dv`
    /// senkrecht, `dh` waagerecht, Windows-Vorzeichen (`dv > 0` = vom Nutzer
    /// weg). Nie beide null — das siebt der Aufrufer aus.
    fn maus_rad(&self, dv: i16, dh: i16);

    /// Eine Taste per Scancode Satz 1. `scan` ist bereits gegen
    /// [`crate::format::scancode_gueltig`] geprueft.
    fn taste(&self, scan: u16, down: bool);
}

/// Sitzt der **Host** gerade selbst an Maus und Tastatur?
pub trait Wache: Sync {
    /// Die Wache aufstellen. Idempotent.
    ///
    /// **`Err` heisst: die Zusage ist auf diesem System nicht zu halten.** Der
    /// Host hat zugestimmt, weil ihm zugesagt ist, dass er jederzeit mit einer
    /// Handbewegung uebernimmt. Laesst sich das nicht durchsetzen, verweigert
    /// der Handschlag die Sitzung, statt still etwas Schwaecheres unter
    /// demselben Etikett zu liefern (dieselbe Linie wie bei HDR).
    fn starten(&self) -> Result<(), String>;

    /// Die Wache abbauen. Idempotent, und **ohne auf einen Faden zu warten**:
    /// dieser Weg laeuft auch beim Prozessende und unter der Sitzungssperre.
    fn stoppen(&self);

    fn host_regt_sich(&self) -> bool;

    /// Wie lange der Vorrang noch gilt (0 = keiner). Geht als Zahl an den
    /// Steuernden, damit er „noch 4 s" sehen kann statt nur „gesperrt".
    fn rest_ms(&self) -> u64;
}

/// Alles Uebrige, was der Kern von aussen braucht.
pub trait Umgebung: Sync {
    /// Welches Rechteck meint dieser Platz gerade?
    ///
    /// **Jedes Mal frisch** — Fenster bewegen sich. Der Aufrufer haelt das
    /// Ergebnis fuer die Dauer EINER Nachricht, nicht fuer die Sitzung.
    fn ziel(&self, slot: u64) -> Zielsuche;

    /// Host-Zeiger in die Aufnahme zurueck (`true`) oder heraus (`false`) —
    /// das Cursor-Echo. Ohne laufende Aufnahme folgenlos.
    ///
    /// Laeuft bei JEDER Nachricht, deren letzter Frame die Fuehrung wechselt,
    /// und bei jedem Vorrang-Uebergang. Was nur ans Sitzungsende gehoert, hat
    /// hier nichts zu suchen — dafuer gibt es [`Self::sitzung_beendet`].
    fn host_zeiger_zeigen(&self, zeigen: bool);

    /// Die Sitzung ist vorbei — was die Plattform an sitzungsgebundenen
    /// Merkern fuehrt, wird geraeumt.
    ///
    /// **Eigener Weg, obwohl das Sitzungsende auch `host_zeiger_zeigen(true)`
    /// ausloest.** Auf Windows raeumt das den Merker der gemeldeten
    /// Zeigerform; haenge man es an `host_zeiger_zeigen`, liefe es zusaetzlich
    /// bei jedem Wechsel von absoluter auf relative Mausfuehrung und bei jedem
    /// Vorrang-Uebergang — der Sidecar hielte die Form dann fuer unbekannt und
    /// schickte sie erneut. Das waere eine Verhaltensaenderung, und zwar eine
    /// mit Kosten auf der Leitung.
    fn sitzung_beendet(&self);

    /// Laeuft gerade eine Fernsteuerung? Der Aufnahme-Takt haengt daran.
    fn fern_aktiv_setzen(&self, aktiv: bool);

    /// Vorrang beginnt oder endet — geht als `remote_state` nach vorn.
    fn vorrang_melden(&self, gilt: bool, hold_ms: u64);

    /// fail-closed — geht als `remote_state` mit `input_error` nach vorn.
    fn fehler_melden(&self, grund: &str);
}

/// Was die Aufloesung eines Platzes ergeben hat.
pub enum Zielsuche {
    /// Ein Stream traegt diesen Platz.
    ///
    /// `rechteck` ist `None`, wenn die Quelle gerade nicht aufloesbar ist
    /// (Fenster zu, Bildschirm abgesteckt) — dann wird die Bewegung verworfen
    /// und die gemerkte Zeigerlage entwertet. `sichtbar = false` heisst
    /// Sichtschutz: der Steuernde sieht Schwarzbild und darf nicht blind
    /// klicken.
    Gefunden { rechteck: Option<Rechteck>, sichtbar: bool },
    /// Kein Stream auf diesem Platz → still verwerfen, Sitzung bleibt stehen.
    ///
    /// **Die eine Ausnahme von fail-closed.** Streams enden asynchron, ein
    /// Platz kann zwischen Absenden und Ankunft verschwinden. Das ist ein
    /// Rennen, kein Angriff.
    KeinStrom,
    /// Stream da, Quelle aber nicht aufloesbar → auch verwerfen, aber mit
    /// Begruendung in der Diagnose.
    NichtAufloesbar(String),
}
