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
//!   und die Urteile aus [`pruefen`] ueber das gebaute Bild.
//! * `faden` — dieselbe Abfrage im Hauptfaden und auf einem eigenen Faden. Der
//!   Wecker der Wache laeuft auf einem eigenen; AppKit ausserhalb des
//!   Hauptfadens ist nicht selbstverstaendlich.
//! * `takt` — 200 Abfragen hintereinander, Dauer je Abfrage. Der Wecker kommt
//!   alle 100 ms.
//! * `wandern` — **die Frische-Messung, und die einzige mit einem doppelt
//!   aufgeloesten Zeiger.** Faehrt den Zeiger ueber den Schirm, zaehlt, wie
//!   viele VERSCHIEDENE dabei herauskommen (ein zwischengespeichertes Ergebnis
//!   saehe wie genau einer aus), und laesst **jede neue Form** durch
//!   [`pruefen`] laufen. Der Pfeil kommt einfach aufgeloest herein, der
//!   I-Balken doppelt — nur an ihm ist zu bemerken, ob beim Zeichnen wirklich
//!   halbiert wird. Bewegt die Maus des Benutzers (und stellt sie danach
//!   zurueck).

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

/// Ein einzelner Punkt des fertigen Bildes — RGBA, so wie er auf die Leitung
/// geht.
fn punkt(bild: &Zeigerbild, x: u16, y: u16) -> [u8; 4] {
    let i = (y as usize * bild.breite as usize + x as usize) * 4;
    [bild.punkte[i], bild.punkte[i + 1], bild.punkte[i + 2], bild.punkte[i + 3]]
}

/// Nachbarpaare, bei denen **voll deckend** unmittelbar an **ganz
/// durchsichtig** grenzt.
///
/// Ein Systemzeiger wird geglaettet gezeichnet: zwischen seiner Flaeche und
/// dem Nichts liegt immer ein weicher Saum. Springt die Deckung irgendwo
/// unvermittelt von 255 auf 0, kommt sie nicht aus dem Deckungs-Byte — genau
/// das passiert bei gedrehter Byte-Ordnung, wo die Deckung aus dem Rot-Byte
/// gelesen wird und ein schwarzer Strich auf hellem Grund zur harten Kante
/// wird. Die Zahl ist **verhaeltnismaessig** zu lesen (Anteil an den Punkten),
/// nie als feste Schranke dieser Maschine.
fn harte_kanten(bild: &Zeigerbild) -> usize {
    let (b, h) = (bild.breite, bild.hoehe);
    let mut kanten = 0;
    let hart = |a: [u8; 4], c: [u8; 4]| (a[3] == 255 && c[3] == 0) || (a[3] == 0 && c[3] == 255);
    for y in 0..h {
        for x in 0..b {
            let hier = punkt(bild, x, y);
            if x + 1 < b && hart(hier, punkt(bild, x + 1, y)) {
                kanten += 1;
            }
            if y + 1 < h && hart(hier, punkt(bild, x, y + 1)) {
                kanten += 1;
            }
        }
    }
    kanten
}

/// Dunkelster und hellster **voll deckender** Punkt.
///
/// Nur die voll deckenden zaehlen: an einem halbdurchsichtigen Saum sagt die
/// Farbe nach der Rueckrechnung wenig, und genau dort saessen die Rundungen.
/// Ohne einen einzigen deckenden Punkt kommt (255, 0) heraus — eine Spanne von
/// null, also dasselbe Urteil wie bei einfarbig.
fn spanne(bild: &Zeigerbild) -> (u16, u16) {
    let mut dunkel = 255u16;
    let mut hell = 0u16;
    for p in bild.punkte.chunks_exact(4) {
        if p[3] == 255 {
            let helligkeit = (p[0] as u16 + p[1] as u16 + p[2] as u16) / 3;
            dunkel = dunkel.min(helligkeit);
            hell = hell.max(helligkeit);
        }
    }
    (dunkel, hell)
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

/// Die Urteile ueber **ein** gebautes Bild — dieselben fuer jeden Zeiger, den
/// ein Lauf zu sehen bekommt.
///
/// **Warum das ueberhaupt hier steht und nicht als Unit-Test.** Alles vor
/// [`zeigerform::zeichnen`] ist gerechnet und wird ohne Fenster-Server
/// geprueft; alles danach ebenfalls. Was hier hinzukommt, ist der **echte**
/// Zeiger dieser Maschine statt eines gebauten Quellbildes — und der bringt
/// Formen mit, die niemand erfindet. Die Urteile sind deshalb bewusst
/// verhaeltnismaessig formuliert: kein Mass, keine Punktzahl, kein Zeigername
/// dieser Maschine steht darin.
fn pruefen(bild: &Zeigerbild) -> bool {
    let mut gut = urteil("das Bild ist in sich stimmig", bild.stimmig());
    gut &= urteil("es passt durch den Trichter", bild.packen().is_some());
    let (leer, halb, voll) = deckung(bild);
    // Ein Zeiger ohne durchsichtige Punkte waere ein Rechteck, einer ohne
    // deckende gar nichts — beides hiesse, dass die Deckung verlorenging.
    gut &= urteil("er hat durchsichtige UND deckende Punkte", leer > 0 && voll > 0);

    // Der Haltepunkt ist die Stelle, mit der der Zeiger auf etwas zeigt; bei
    // jedem Systemzeiger liegt er auf dessen Flaeche. **Dieses Urteil faengt
    // das falsche Zeichenrechteck** — wird das Quellbild in Bildpunkten statt
    // in Punkten aufgezogen, bleibt ein vergroessertes Viertel uebrig, und der
    // Halt zeigt daneben. Gemessen am I-Balken im Lauf `wandern`: richtig
    // Deckung 255, mit Bildpunkt-Rechteck 0. Am Pfeil ist davon nichts zu
    // sehen — der kommt einfach aufgeloest herein, das Rechteck ist dort
    // dasselbe. Gegen die gedrehte Byte-Ordnung traegt das Urteil **nicht**
    // (am Pfeil gemessen: Deckung 55 statt 255, also weiter „etwas zu sehen");
    // die faengt die Helligkeitsspanne weiter unten.
    let am_halt = punkt(bild, bild.halt_x, bild.halt_y);
    gut &= urteil(
        &format!("am Haltepunkt ist etwas zu sehen (Deckung {})", am_halt[3]),
        am_halt[3] > 0,
    );

    // **Das Urteil, das die Byte-Ordnung faengt.** Ein Systemzeiger ist immer
    // zweifarbig — dunkle Flaeche mit hellem Saum oder umgekehrt, damit er auf
    // jedem Untergrund sichtbar bleibt. Wird die Deckung aus dem Rot-Byte
    // gelesen, verschwindet die dunkle Haelfte (Rot 0 heisst dann
    // durchsichtig) und die helle bleibt mit Deckung 255 stehen: uebrig ist
    // eine **einfarbig weisse** Flaeche. Gemessen am Pfeil dieser Maschine —
    // richtig 0..255, mit gedrehter Ordnung 255..255. Verglichen wird die
    // Spanne, nicht ihre Lage: welche Farbe der Zeiger hat, bleibt offen.
    let (dunkel, hell) = spanne(bild);
    gut &= urteil(
        &format!("die deckende Flaeche ist nicht einfarbig (Helligkeit {dunkel}..{hell})"),
        hell.saturating_sub(dunkel) >= 128,
    );

    // Der weiche Saum. Nicht „wie viele Stufen", sondern „gibt es Spruenge von
    // ganz deckend auf ganz durchsichtig" — unabhaengig von Groesse, Form und
    // Schirm. Am Pfeil dieser Maschine gemessen: richtig **null** solche
    // Spruenge. Der Spielraum von einem Fuenfzigstel ist nicht die Messung,
    // sondern die Vorsorge fuer einen Zeiger, den jemand ohne Glaettung
    // gezeichnet hat; die gedrehte Byte-Ordnung liegt mit einem Zwanzigstel
    // darueber.
    let kanten = harte_kanten(bild);
    let punkte = bild.punkte.len() / 4;
    gut &= urteil(
        &format!("der Rand ist weich, nicht gestanzt ({kanten} harte Kanten auf {punkte} Punkte)"),
        kanten * 50 <= punkte,
    );
    println!("  (teilweise deckende Punkte: {halb} — 0 waere bei einem weichen Zeiger auffaellig)");
    gut
}

fn lauf_einmal() -> bool {
    let Some(bild) = zeigerform::abfragen() else {
        return urteil("eine Abfrage liefert ein Bild", false);
    };
    beschreiben(&bild);
    zeichnen(&bild);
    pruefen(&bild)
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

    let mut alles_gut = true;
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
                        // **Hier und nicht in `einmal` sitzt die Probe auf den
                        // doppelt aufgeloesten Zeiger.** Der Pfeil kommt auf
                        // dieser Maschine einfach aufgeloest heraus; an ihm
                        // waere ein Zeichenrechteck in Bildpunkten statt in
                        // Punkten gar nicht zu bemerken. Der I-Balken kommt
                        // 18x36 herein und muss 9x18 hinausgehen — bei
                        // falschem Rechteck bleibt davon ein vergroessertes
                        // Viertel, und dessen Haltepunkt zeigt ins Leere.
                        alles_gut &= pruefen(&b);
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
    let frisch = urteil(
        "mehr als ein Zeiger unterwegs — die Abfrage liest frisch",
        gesehen.len() > 1,
    );
    alles_gut & frisch
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
