//! Der Schnitt zwischen Kern und Betriebssystem — drei Traits, dazu eine
//! kurze Liste weiterer Pflichten, die keine Trait-Signatur allein einfaengt.
//!
//! Wer eine neue Plattform anschliesst, implementiert die drei Traits unten —
//! und haelt sich zusaetzlich an die vier Punkte hier. Kein viertes Trait,
//! aber eben doch nicht "sonst nichts". Was darueber hinaus hier nicht steht,
//! kennt der Kern nicht — und darf ihn deshalb auch nicht beeinflussen.
//!
//! 1. **Der 100-ms-Takt** fuer [`Wache::rest_ms`] samt `vorrang_tick` (s.
//!    [`Wache`] unten) — derselbe Wecker treibt zugleich
//!    `crate::zeigerbuch::Zeigerbuch::nachricht`, s. Punkt 2.
//! 2. **Drei Pflichten aus dem Kopf von `crate::zeigerbuch`:** der Takt aus
//!    Punkt 1 angewandt auf das Zeigerbuch, die Vorrang-Weiche (bei
//!    Host-Vorrang geht `Stand::Name(VORGABE)` hinaus, OHNE vorher den echten
//!    Zeiger zu ermitteln) und das Einreihen der fertigen Meldung
//!    ausserhalb der eigenen Sperre.
//! 3. **Das Protokoll aus dem Kopf von `crate::zeigerschalter`:** `setzen` →
//!    Plattform-Aufruf → `gelungen`/`gescheitert`, wobei `gescheitert(true)`
//!    heisst: raeumen.
//! 4. **`handle()`** — laut Kopf von `crate::huelle` bleibt es bei der
//!    Plattform: es holt die eine Sitzung des Prozesses, ruft `huelle_lesen`
//!    und [`crate::sitzung::Sitzung::frames`] auf und huellt einen
//!    Protokollfehler in die eigene Fehlerbehandlung.
//!
//! **`Sync`, weil die Sitzung von mehreren Faeden gerufen wird:** vom
//! Dispatch-Faden (eingehende Nachrichten) und vom Wecker der Wache
//! (Vorrang-Uebergaenge).

use crate::druck::Druck;
use crate::zuordnung::Rechteck;

/// Was die Plattform mit dem Betriebssystem macht.
///
/// **Alles hier ist Ausfuehrung ohne Entscheidung.** Ob ueberhaupt injiziert
/// wird, entscheidet `crate::ausfuehrung` (kistenintern, deshalb ohne Link);
/// wohin, [`crate::zuordnung`]. Ein Injektor, der selbst entscheidet, waere
/// eine zweite Meinung an einer Stelle, an der es nur eine geben darf.
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
///
/// **Vertragspflicht, die keine einzelne Methode hier erzwingt:** die
/// Plattform muss [`crate::sitzung::Sitzung::vorrang_tick`] in einem Takt von
/// 100 ms treiben, solange eine Sitzung laeuft — vom Aufstellen
/// ([`Self::starten`]) bis zum Abbau ([`Self::stoppen`]). Grund: der Vorrang
/// ENDET von selbst, wenn der Host Ruhe gibt, und es kommt kein Ereignis, das
/// ihn beendet. Hinge das Ende an der naechsten Eingabe-Nachricht, erfuehre
/// ein Steuernder, der gerade nur eine Taste haelt und nichts sendet, nie
/// davon — seine Taste bliebe tot, bis er zufaellig die Maus bewegt. Eine
/// Plattform, die die drei Methoden unten korrekt implementiert, aber diesen
/// Wecker vergisst, sieht in jedem Test gruen und haelt die Zusage trotzdem
/// nicht.
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
    ///
    /// **Kein Waechter heisst `sichtbar: true`.** Der Sichtschutz ist ein
    /// Zusatz, den nicht jeder Strom traegt; das Original prueft deshalb
    /// `wacht.is_some_and(|w| !w.is_source_visible())` und wertet einen Strom
    /// ohne Waechter als sichtbar. Ein Adapter, der stattdessen `false`
    /// liefert, legt die Fernsteuerung fuer **jeden** Strom ohne Sichtschutz
    /// still — und **kein Test dieser Kiste kann das sehen**, weil hier nur
    /// ankommt, was der Adapter behauptet.
    Gefunden { rechteck: Option<Rechteck>, sichtbar: bool },
    /// Kein Stream auf diesem Platz → still verwerfen, Sitzung bleibt stehen.
    ///
    /// **Die eine Ausnahme von fail-closed.** Streams enden asynchron, ein
    /// Platz kann zwischen Absenden und Ankunft verschwinden. Das ist ein
    /// Rennen, kein Angriff.
    KeinStrom,
    /// Stream da, Quelle aber nicht aufloesbar → auch verwerfen, aber mit
    /// Begruendung in der Diagnose.
    ///
    /// **Warum die Begruendung eine rohe Zeichenkette bleibt, keine eigene
    /// Sorte.** Beim Umzug aus `win-hq-sidecar/src/remote_input/ziel.rs`
    /// (2026-08-23) sind nur die Schranken gewandert (`crate::slot::{SLOT_MAX,
    /// im_bereich, traegt_slot}`) — der ganze Ablauf von `bindung_fuer_slot`
    /// haengt an Windows-eigenen Typen (`AktiverStrom`, `Bindung`,
    /// `InjectTarget`) und blieb deshalb dort. Die Zeichenkette fuer genau
    /// diesen Fall ("die Aufnahme hat ihr Ziel noch nicht gemeldet …") tippt
    /// eine zweite Plattform also selbst und moeglicherweise mit anderem
    /// Wortlaut — bewusst nicht vereinheitlicht, weil dafuer der ganze Ablauf
    /// haette wandern muessen, nicht nur seine Schranken.
    NichtAufloesbar(String),
}
