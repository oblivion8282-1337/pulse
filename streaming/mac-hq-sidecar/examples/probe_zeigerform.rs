//! Pruefling fuer die Zeigerabfrage (`remote_input::zeigerform`).
//!
//! **Warum es ihn braucht.** Die Unit-Tests pruefen die ganze Rechnung
//! (`remote_input::zeigerpunkte`) und die eine Regel der Weiche („in jeder
//! Runde neu fragen"). Was sie nicht koennen: `NSCursor.currentSystemCursor`
//! ueberhaupt aufrufen. Genau dort sitzen die Fragen, die man nur messen kann —
//! traegt die Abfrage ueber Prozessgrenzen, traegt sie ausserhalb des
//! Hauptfadens, was kostet sie im 100-ms-Takt der Wache, und kommt hinten ein
//! Bild heraus, das man auch anschauen wuerde.
//!
//! Laeufe (`cargo run --example probe_zeigerform -- <lauf>`):
//!
//! * `einmal` (Vorgabe) — eine Abfrage, alles Wissenswerte ueber das Ergebnis:
//!   Masse, Haltepunkt, Kennung, gepackte Groesse gegen den 5900-Byte-Trichter,
//!   und die Verteilung der Deckung (ein Zeiger, der nur aus deckenden oder nur
//!   aus durchsichtigen Punkten besteht, ist verdaechtig).
//! * `faden` — dieselbe Abfrage im Hauptfaden und auf einem eigenen Faden. Der
//!   Wecker der Wache laeuft auf einem eigenen; AppKit ausserhalb des
//!   Hauptfadens ist nicht selbstverstaendlich.
//! * `takt` — 200 Abfragen hintereinander, Dauer je Abfrage. Der Wecker kommt
//!   alle 100 ms.
//! * `wandern` — **die Frische-Messung.** Faehrt den Zeiger ueber den Schirm
//!   und zaehlt, wie viele VERSCHIEDENE Zeiger dabei herauskommen. Ein
//!   zwischengespeichertes Ergebnis saehe hier wie genau einer aus. Bewegt die
//!   Maus des Benutzers (und stellt sie danach zurueck).

use std::collections::BTreeMap;

use objc2_core_foundation::CGPoint;
use objc2_core_graphics::{CGDisplayBounds, CGEvent, CGMainDisplayID};
use pulse_mac_hq_sidecar::remote_input::zeigerform;
use pulse_zeigerbild::{MAX_LAEUFE_BYTE, Zeigerbild};

// `CGWarpMouseCursorPosition` liegt hinter dem Merkmal `CGError`, das der
// Sidecar sonst nicht braucht — fuer den Pruefling selbst erklaert, statt die
// Kiste des Auslieferungsbaus um ein Merkmal zu erweitern.
unsafe extern "C-unwind" {
    fn CGWarpMouseCursorPosition(punkt: CGPoint) -> i32;
}

fn urteil(was: &str, gut: bool) -> bool {
    println!("{} {was}", if gut { "OK  " } else { "FEHL" });
    gut
}

/// Wie sich die Deckung ueber das Bild verteilt: ganz durchsichtig, ganz
/// deckend, dazwischen.
fn deckung(bild: &Zeigerbild) -> (usize, usize, usize) {
    let mut leer = 0;
    let mut voll = 0;
    let mut halb = 0;
    for p in bild.punkte.chunks_exact(4) {
        match p[3] {
            0 => leer += 1,
            255 => voll += 1,
            _ => halb += 1,
        }
    }
    (leer, halb, voll)
}

fn beschreiben(bild: &Zeigerbild) {
    let (leer, halb, voll) = deckung(bild);
    let gepackt = bild.packen().map(|l| l.len());
    println!(
        "  {}x{}  Halt {},{}  Kennung {}",
        bild.breite,
        bild.hoehe,
        bild.halt_x,
        bild.halt_y,
        bild.kennung()
    );
    println!(
        "  Deckung: {leer} durchsichtig, {halb} teilweise, {voll} voll  ({} Punkte)",
        bild.punkte.len() / 4
    );
    match gepackt {
        Some(n) => println!(
            "  gepackt {n} Byte von hoechstens {MAX_LAEUFE_BYTE} ({} %)",
            n * 100 / MAX_LAEUFE_BYTE
        ),
        None => println!("  gepackt: passt NICHT durch den Trichter — ginge als Name hinaus"),
    }
}

/// Der Zeiger als Zeichenbild — Deckung in fuenf Stufen. Die einzige Probe,
/// die ein Mensch in einer Sekunde macht und kein Test in hundert Zeilen: ist
/// da ueberhaupt ein Pfeil? Ein vertauschter Zeilenabstand, eine falsche
/// Zeilenrichtung oder eine verlorene Maske faellt hier sofort auf.
fn zeichnen(bild: &Zeigerbild) {
    const STUFEN: [char; 5] = [' ', '.', '+', '*', '#'];
    for y in 0..bild.hoehe as usize {
        let mut zeile = String::new();
        for x in 0..bild.breite as usize {
            let a = bild.punkte[(y * bild.breite as usize + x) * 4 + 3];
            zeile.push(STUFEN[(a as usize * (STUFEN.len() - 1)) / 255]);
        }
        println!("  |{zeile}|");
    }
}

fn lauf_einmal() -> bool {
    let Some(bild) = zeigerform::abfragen() else {
        return urteil("eine Abfrage liefert ein Bild", false);
    };
    beschreiben(&bild);
    zeichnen(&bild);
    let mut gut = urteil("das Bild ist in sich stimmig", bild.stimmig());
    gut &= urteil("es passt durch den Trichter", bild.packen().is_some());
    let (leer, halb, voll) = deckung(&bild);
    // Ein Zeiger ohne durchsichtige Punkte waere ein Rechteck, einer ohne
    // deckende gar nichts — beides hiesse, dass die Deckung verlorenging.
    gut &= urteil("er hat durchsichtige UND deckende Punkte", leer > 0 && voll > 0);
    println!("  (teilweise deckende Punkte: {halb} — 0 waere bei einem weichen Zeiger auffaellig)");
    gut
}

fn lauf_faden() -> bool {
    let hier = zeigerform::abfragen().map(|b| b.kennung());
    let dort = std::thread::spawn(|| zeigerform::abfragen().map(|b| b.kennung()))
        .join()
        .expect("Faden");
    println!("  Hauptfaden: {hier:?}\n  eigener Faden: {dort:?}");
    let mut gut = urteil("auch ausserhalb des Hauptfadens kommt ein Bild", dort.is_some());
    gut &= urteil("beide Faeden sehen denselben Zeiger", hier == dort);
    gut
}

fn lauf_takt() -> bool {
    // Der erste Aufruf laedt AppKit und ist um Groessenordnungen teurer — er
    // gehoert nicht in den Mittelwert, sondern eigens gemeldet.
    let t0 = std::time::Instant::now();
    let _ = zeigerform::abfragen();
    let erster = t0.elapsed();

    let runden = 200;
    let t1 = std::time::Instant::now();
    let mut gefunden = 0;
    for _ in 0..runden {
        if zeigerform::abfragen().is_some() {
            gefunden += 1;
        }
    }
    let je = t1.elapsed() / runden;
    println!("  erste Abfrage {erster:?}, danach {je:?} je Abfrage ({gefunden}/{runden} mit Bild)");
    urteil("eine Abfrage bleibt weit unter dem 100-ms-Wecker", je.as_millis() < 10)
}

fn lauf_wandern() -> bool {
    let schirm = CGDisplayBounds(CGMainDisplayID());
    let zurueck = CGEvent::new(None).map(|e| CGEvent::location(Some(&e)));
    println!("  Schirm {}x{}, Ausgangslage {zurueck:?}", schirm.size.width, schirm.size.height);

    let mut gesehen: BTreeMap<String, (usize, u16, u16)> = BTreeMap::new();
    let spalten = 40;
    for i in 0..spalten {
        let x = schirm.origin.x + schirm.size.width * (i as f64 + 0.5) / spalten as f64;
        for anteil in [0.02f64, 0.05, 0.5, 0.98] {
            let y = schirm.origin.y + schirm.size.height * anteil;
            unsafe { CGWarpMouseCursorPosition(CGPoint::new(x, y)) };
            // Der Fenster-Server setzt den Zeiger erst nach der Bewegung.
            std::thread::sleep(std::time::Duration::from_millis(25));
            let (kennung, breite, hoehe) = match zeigerform::abfragen() {
                Some(b) => {
                    // Jede neue Form einmal zeigen: der I-Balken kommt auf
                    // dieser Maschine nur in doppelter Aufloesung heraus und
                    // wird beim Zeichnen halbiert — ob dabei ein I-Balken
                    // bleibt, sieht man und rechnet es nicht nach.
                    if !gesehen.contains_key(&b.kennung()) {
                        beschreiben(&b);
                        zeichnen(&b);
                    }
                    (b.kennung(), b.breite, b.hoehe)
                }
                None => ("(kein Bild)".to_string(), 0, 0),
            };
            gesehen.entry(kennung).or_insert((0, breite, hoehe)).0 += 1;
        }
    }
    if let Some(p) = zurueck {
        unsafe { CGWarpMouseCursorPosition(p) };
    }
    for (kennung, (anzahl, b, h)) in &gesehen {
        println!("  {anzahl:4}x  {b}x{h}  {kennung}");
    }
    // **Kein fester Erwartungswert.** Wie viele Formen ein Schirm hergibt,
    // haengt davon ab, welche Fenster offen sind — ein Test daraus waere genau
    // die Sorte, die nur auf einer Maschine gruen ist. Gemessen wird die eine
    // Aussage, die ueberall gilt: mehr als eine Form heisst, dass wirklich
    // jedes Mal neu gefragt wurde.
    urteil("mehr als ein Zeiger unterwegs — die Abfrage liest frisch", gesehen.len() > 1)
}

fn main() {
    let lauf = std::env::args().nth(1).unwrap_or_else(|| "einmal".into());
    let gut = match lauf.as_str() {
        "einmal" => lauf_einmal(),
        "faden" => lauf_faden(),
        "takt" => lauf_takt(),
        "wandern" => lauf_wandern(),
        anders => {
            eprintln!("unbekannter Lauf: {anders} (einmal | faden | takt | wandern)");
            false
        }
    };
    if !gut {
        std::process::exit(1);
    }
}
