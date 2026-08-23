//! Wie aus dem, was CoreGraphics herausgibt, ein [`Zeigerbild`] wird — die
//! reine Rechnung hinter [`super::zeigerform`].
//!
//! **Getrennt, damit sie pruefbar ist.** Alles hier ist Umrechnung: die Masse
//! waehlen, die Deckung zurueckrechnen, Zeilenabstand ueberspringen, den
//! Haltepunkt klemmen. Nichts davon braucht macOS, und in
//! [`super::zeigerform`] koennte es niemand ohne laufenden Fenster-Server
//! nachrechnen — dabei sind genau diese Schritte die, bei denen ein Fehler
//! nicht abstuerzt, sondern still ein falsches Bild erzeugt: einen doppelt so
//! grossen Zeiger, einen zu dunklen Saum, einen Zielpunkt neben der Spitze.
//!
//! ## Warum die Rechnung hier duenner ist als auf Windows
//!
//! Der Windows-Zwilling (`win-hq-sidecar/src/remote_input/zeigerpunkte.rs`)
//! traegt drei GDI-Eigenheiten mit: BGRA statt RGBA, Farbbilder ohne eigene
//! Deckung, reine Maskenzeiger mit doppelt hoher Bitmap. Nichts davon gibt es
//! hier — nicht, weil macOS es besser koennte, sondern weil
//! [`super::zeigerform`] den Zeiger in einen **selbst angelegten** Zeichenraum
//! malt und dessen Format bestimmt: RGBA, 8 bit je Kanal, Deckung
//! vorvervielfacht. Was bleibt, ist genau eine gemeinsame Rechnung, und die
//! steht deshalb in der gemeinsamen Kiste
//! ([`pulse_fernsteuerung::deckung::entvielfachen`]).
//!
//! ## Die eine Falle, die dieses Modul bewacht
//!
//! **Einfache Aufloesung, nicht doppelte.** winit skaliert eigene Zeiger nicht
//! mit; ein 2x-Bild erschiene beim Steuernden doppelt gross, und der
//! 5900-Byte-Trichter (`pulse_zeigerbild::MAX_LAEUFE_BYTE`) wuerde eng. Das ist
//! keine theoretische Sorge: auf dieser Maschine (macOS 15.7.3, Schirm
//! 1920x1080, **nicht** Retina) gemessen am 2026-08-23 —
//!
//! | Zeiger | `NSImage.size` (Punkte) | `CGImageForProposedRect` (Bildpunkte) |
//! |---|---|---|
//! | Pfeil | 17x23 | 17x23 |
//! | I-Balken | 9x18 | **18x36** |
//!
//! AppKit gibt also mal die einfache und mal die doppelte Aufloesung heraus,
//! je nachdem, welche Darstellungen der Zeiger mitbringt. Wer die Masse dem
//! CGImage entnimmt — dem naheliegenden Ort, dort liegen ja die Daten —,
//! verschickt jeden zweiten Zeiger doppelt so gross. [`zielmasse`] bekommt
//! beide Zahlen und entscheidet sichtbar fuer die Punkte.
//!
//! **Der Haltepunkt haengt daran mit.** `NSCursor.hotSpot` ist in **Punkten**
//! angegeben (gemessen: Pfeil 4,4 bei 17x23 Punkten; I-Balken 4,9 bei 9x18).
//! Weil das Ziel die Punktmasse sind, ist die Umrechnung die Identitaet — es
//! gibt keine. Wer auf die doppelte Aufloesung umstellt, muss den Haltepunkt
//! mit verdoppeln, und das wird niemand tun, der es nicht weiss.

use pulse_fernsteuerung::deckung::entvielfachen;
use pulse_zeigerbild::{MAX_KANTE, Zeigerbild};

/// Wie gross das Bild hinausgeht: **in Punkten**, nicht in Bildpunkten.
///
/// `bild_punkte` wird nicht benutzt, um die Masse zu bestimmen — es ist die
/// Zahl, die hier ausdruecklich **nicht** gewaehlt wird (s. Modulkopf). Es
/// dient als Vorhandensein-Probe: ein CGImage ohne Flaeche traegt nichts, was
/// sich zeichnen liesse, und ist damit der Rueckfall-Fall
/// (`NSCursor.arrow.image` liefert Groesse (0,0) und gar kein Bild — genau die
/// Beobachtung, die die Namensuebertragung auf macOS erledigt hat).
///
/// `None` heisst nie „Fehler", sondern immer „kein uebertragbares Bild" — der
/// Aufrufer meldet dann die Vorgabe.
pub(super) fn zielmasse(punkt: (f64, f64), bild_punkte: (usize, usize)) -> Option<(u16, u16)> {
    if bild_punkte.0 == 0 || bild_punkte.1 == 0 {
        return None;
    }
    Some((kante(punkt.0)?, kante(punkt.1)?))
}

/// Eine Kantenlaenge in Punkten auf eine brauchbare Bildkante runden.
///
/// [`MAX_KANTE`] deckelt hier schon, nicht erst beim Packen: an der Zahl haengt
/// die Arbeit, die ein einziger Wecker ausloest (Zeichnen, Rueckrechnen,
/// FNV-Lauf), und ein Zeiger jenseits davon ist ohnehin keiner.
fn kante(punkte: f64) -> Option<u16> {
    if !punkte.is_finite() {
        return None;
    }
    let gerundet = punkte.round();
    (gerundet >= 1.0 && gerundet <= MAX_KANTE as f64).then_some(gerundet as u16)
}

/// Der Haltepunkt, geklemmt auf das Bild.
///
/// Wie auf Windows geklemmt statt verworfen: ein Zeiger mit leicht verschobenem
/// Zielpunkt ist immer noch besser als keiner, und `Zeigerbild::stimmig` weist
/// ein Bild ab, dessen Halt daneben liegt.
fn halt(haltepunkt: (f64, f64), breite: u16, hoehe: u16) -> (u16, u16) {
    (klemmen(haltepunkt.0, breite), klemmen(haltepunkt.1, hoehe))
}

fn klemmen(wert: f64, kante: u16) -> u16 {
    // NaN und Unendlich landen bei 0, nicht am Rand: ohne Haltepunkt zeigt der
    // Zeiger mit seiner linken oberen Ecke — mit einem erfundenen zeigt er
    // irgendwohin, und niemand sucht den Fehler beim Haltepunkt.
    if !wert.is_finite() || wert < 0.0 {
        return 0;
    }
    wert.round().min((kante - 1) as f64) as u16
}

/// Ein vorvervielfachtes RGBA-Feld in das Format der Leitung umrechnen.
///
/// `bytes_je_zeile` ist der Zeilenabstand des Zeichenraums, **nicht**
/// `breite * 4`: CoreGraphics darf Zeilen auffuellen, und tut es je nach
/// Breite. Ungeprueft uebernommen erzeugte die Auffuellung einen schraeg
/// verzogenen Zeiger — ein Fehler, der wie ein kaputter Packer aussieht.
///
/// `None`, wenn der Puffer nicht zu den Massen passt. Aus fremdem Speicher
/// liest hier nichts: jede Zeile wird vor dem Zugriff geprueft.
fn entvielfachtes_feld(
    roh: &[u8],
    breite: u16,
    hoehe: u16,
    bytes_je_zeile: usize,
) -> Option<Vec<u8>> {
    let (b, h) = (breite as usize, hoehe as usize);
    let zeile_byte = b.checked_mul(4)?;
    if b == 0 || h == 0 || bytes_je_zeile < zeile_byte {
        return None;
    }
    // Die letzte Zeile muss ganz da sein; hinter ihr darf die Auffuellung
    // fehlen (der Zeichenraum legt sie an, aber niemand verspricht es).
    if roh.len() < (h - 1) * bytes_je_zeile + zeile_byte {
        return None;
    }
    let mut punkte = Vec::with_capacity(b * h * 4);
    for y in 0..h {
        let anfang = y * bytes_je_zeile;
        for p in roh[anfang..anfang + zeile_byte].chunks_exact(4) {
            let deckung = p[3];
            punkte.extend_from_slice(&[
                entvielfachen(p[0], deckung),
                entvielfachen(p[1], deckung),
                entvielfachen(p[2], deckung),
                deckung,
            ]);
        }
    }
    Some(punkte)
}

/// Alles zusammen: aus dem gezeichneten Feld ein sendefertiges [`Zeigerbild`].
///
/// Die letzte Wache vor der Leitung ist `stimmig()` — was hier nicht stimmig
/// ist, ginge sonst als Bild hinaus, das die Gegenseite nur abweisen kann.
///
/// **Der 5900-Byte-Trichter wird hier bewusst nicht geprueft.** Er sitzt im
/// Format (`pulse_zeigerbild::MAX_LAEUFE_BYTE`) und wird von
/// `Zeigerbuch::nachricht` angewandt: passt ein Bild nicht, geht die Meldung
/// ohne `bild`-Feld hinaus und der Steuernde behaelt den Namen als Rueckfall.
/// Ihn hier ein zweites Mal zu ziehen hiesse, die Grenze an zwei Stellen zu
/// pflegen.
pub(super) fn bild(
    breite: u16,
    hoehe: u16,
    haltepunkt: (f64, f64),
    roh: &[u8],
    bytes_je_zeile: usize,
) -> Option<Zeigerbild> {
    let punkte = entvielfachtes_feld(roh, breite, hoehe, bytes_je_zeile)?;
    let (halt_x, halt_y) = halt(haltepunkt, breite, hoehe);
    let bild = Zeigerbild { breite, hoehe, halt_x, halt_y, punkte };
    bild.stimmig().then_some(bild)
}

#[cfg(test)]
#[path = "zeigerpunkte_tests.rs"]
mod zeigerpunkte_tests;
