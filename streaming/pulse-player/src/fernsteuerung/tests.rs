//! Tests der Erfassung. Kein Fenster, keine GPU, kein Netz.
//!
//! `WindowEvent::KeyboardInput` fehlt hier: `KeyEvent` traegt ein
//! `pub(crate)`-Feld und ist ausserhalb von winit nicht zu bauen. Die
//! Tastenseite wird deshalb ueber [`Erfassung::taste_von_code`],
//! [`Erfassung::taste`] und [`super::tasten::scancode`] geprueft — zusammen
//! decken sie denselben Weg ab, den `on_window_event` fuer Tasten nimmt.

use super::*;
use super::schlange::{BEWEGUNGSTAKT, MAX_GESAMT, MAX_WARTEND};
use winit::dpi::PhysicalPosition;
use winit::event::{DeviceId, MouseButton, MouseScrollDelta};

/// Die Kennung der Fernsteuerungs-Sitzung, unter der die meisten Tests
/// einschalten. Sie entscheidet, ob Liegengebliebenes an dasselbe Ziel geht —
/// wer sie weglaesst, prueft den Zielwechsel (s. `fremde_sitzung_...`).
const SITZUNG: &str = "sit-a";

/// Base64 rueckwaerts — pruefen will man Opcodes, nicht Buchstaben. Zugleich
/// die Gegenprobe zum Kodierer in [`super::rahmen`].
fn entziffern(text: &str) -> Vec<u8> {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let werte: Vec<u32> = text
        .bytes()
        .filter(|b| *b != b'=')
        .map(|b| ALPHABET.iter().position(|a| *a == b).expect("gueltiges Zeichen") as u32)
        .collect();
    let mut out = Vec::new();
    for block in werte.chunks(4) {
        let mut n = 0u32;
        for (i, wert) in block.iter().enumerate() {
            n |= wert << (18 - 6 * i);
        }
        for i in 0..block.len() - 1 {
            out.push(((n >> (16 - 8 * i)) & 0xff) as u8);
        }
    }
    out
}

fn rahmen_von(abgabe: Eingabeabgabe) -> Vec<Vec<u8>> {
    match abgabe {
        Eingabeabgabe::Jetzt { frames, .. } => frames.iter().map(|f| entziffern(f)).collect(),
        andere => panic!("Frames erwartet, bekam {andere:?}"),
    }
}

/// Alles herausholen, ohne auf den Bewegungstakt zu warten. Die Buendel werden
/// dabei zusammengelegt — wer die Plaetze auseinanderhalten will, nimmt
/// [`alles_mit_platz`].
fn alles(e: &mut Erfassung) -> Vec<Vec<u8>> {
    e.raeumen().into_iter().flat_map(|(_, f)| f).map(|s| entziffern(&s)).collect()
}

/// Wie [`alles`], aber je Buendel mit dem Platz, unter dem es hinausginge.
fn alles_mit_platz(e: &mut Erfassung) -> Vec<(u32, Vec<Vec<u8>>)> {
    e.raeumen()
        .into_iter()
        .map(|(slot, f)| (slot, f.iter().map(|s| entziffern(s)).collect()))
        .collect()
}

fn lage() -> Bildlage {
    // Fenster und Quelle im selben Verhaeltnis: kein Rand, die Ecken sind
    // dadurch exakt 0,0 und 1,1.
    Bildlage::neu((1920, 1080), (1920, 1080), [0.0, 0.0, 1.0, 1.0]).expect("Lage")
}

fn eingeschaltet() -> Erfassung {
    let mut e = Erfassung::neu();
    e.einschalten(0, false, Some(SITZUNG));
    // Zeiger in die Bildmitte stellen: Knopf und Rad gehen nur hinaus, wenn der
    // Zeiger IM Bild steht, und ohne ein `CursorMoved` weiss die Erfassung
    // nicht, wo er ist (die Ereignisse selbst tragen keine Position).
    e.on_window_event(&zeiger_ereignis(960.0, 540.0), Some(lage()), false);
    // Hello und diese Bewegung wegnehmen, damit die Tests nur ihren eigenen
    // Frame sehen.
    let vorlauf = alles(&mut e);
    assert_eq!(vorlauf.len(), 2, "Hello und Zeigerlage: {vorlauf:?}");
    assert_eq!(vorlauf[0], vec![0x00, 0x02]);
    e
}

fn maus_ereignis(state: ElementState, button: MouseButton) -> WindowEvent {
    WindowEvent::MouseInput { device_id: DeviceId::dummy(), state, button }
}

fn rad_ereignis(delta: MouseScrollDelta) -> WindowEvent {
    WindowEvent::MouseWheel {
        device_id: DeviceId::dummy(),
        delta,
        phase: winit::event::TouchPhase::Moved,
    }
}

fn zeiger_ereignis(x: f64, y: f64) -> WindowEvent {
    WindowEvent::CursorMoved { device_id: DeviceId::dummy(), position: PhysicalPosition::new(x, y) }
}

// ── Schalter ────────────────────────────────────────────────────────────────

#[test]
fn standard_ist_aus() {
    let mut e = Erfassung::neu();
    assert!(!e.aktiv());
    e.on_window_event(&zeiger_ereignis(100.0, 100.0), Some(lage()), false);
    e.on_window_event(&maus_ereignis(ElementState::Pressed, MouseButton::Left), None, false);
    e.taste(0x1e, true);
    assert!(
        matches!(e.abholen(Instant::now()), Eingabeabgabe::Nichts),
        "ausgeschaltet kodiert nichts"
    );
}

/// Der Hello-Frame MUSS der erste der Sitzung sein (Wire-Spec), und er traegt
/// Version 2.
#[test]
fn einschalten_stellt_hello_voran() {
    let mut e = Erfassung::neu();
    e.taste(0x1e, true); // vor dem Einschalten — gehoert zu keiner Sitzung
    e.einschalten(3, false, Some(SITZUNG));
    e.taste(0x1e, true);
    let frames = alles(&mut e);
    assert_eq!(frames[0], vec![super::rahmen::OP_HELLO, 2]);
    assert_eq!(frames.len(), 2, "vor dem Einschalten wird nichts kodiert");
    assert_eq!(e.slot(), 3);
}

/// **Jedes Einschalten beginnt einen neuen Strom und schickt ein Hello** —
/// auch wenn die Erfassung im Player schon an war.
///
/// Hier stand das Gegenteil („ein zweites Hello waere ein Protokollfehler").
/// Der Vertrag sagt seit dem 2026-08-12 ausdruecklich, dass ein weiteres Hello
/// erlaubt ist und „neuer Eingabestrom" heisst; im Zwei-Geraete-Test war genau
/// das fehlende zweite Hello der Grund, warum der Host jede Eingabe abwies
/// (`Eingabe vor dem Hello-Handschlag`) und die Fernsteuerung stillstand.
/// Der Host gibt beim Hello alles frei — die Menge des Gedrueckten muss der
/// Player deshalb mit vergessen, sonst schickte er spaeter Hoch-Ereignisse
/// fuer Tasten, die drueben laengst oben sind.
#[test]
fn wiederholtes_einschalten_beginnt_einen_neuen_strom() {
    let mut e = eingeschaltet();
    e.taste(0x11, true);
    let _ = alles(&mut e);

    e.einschalten(5, false, Some(SITZUNG));
    assert_eq!(e.slot(), 5, "der Slot wandert mit");
    assert_eq!(alles(&mut e), vec![vec![0x00, 0x02]], "ein zweites Hello, sonst nichts");

    e.ausschalten();
    assert!(e.raeumen().is_empty(), "W hat der Host beim Hello selbst freigegeben");
}

/// Zweimal ausschalten reicht die Hoch-Ereignisse nicht zweimal nach.
#[test]
fn wiederholtes_ausschalten_reicht_nichts_doppelt_nach() {
    let mut e = eingeschaltet();
    e.taste(0x11, true);
    let _ = alles(&mut e);
    e.ausschalten();
    assert_eq!(alles(&mut e).len(), 1);
    e.ausschalten();
    assert!(e.raeumen().is_empty());
}

// ── Jeder Opcode einmal ─────────────────────────────────────────────────────

#[test]
fn jeder_opcode_einmal() {
    let mut e = Erfassung::neu();
    e.einschalten(0, false, Some(SITZUNG)); // 0x00
    e.on_window_event(&zeiger_ereignis(960.0, 540.0), Some(lage()), false); // 0x01
    let m = || Some(lage());
    e.on_window_event(&maus_ereignis(ElementState::Pressed, MouseButton::Left), m(), false); // 0x03
    e.on_window_event(&rad_ereignis(MouseScrollDelta::LineDelta(0.0, 1.0)), m(), false); // 0x04
    e.taste(0x1e, true); // 0x05
    let opcodes: Vec<u8> = alles(&mut e).iter().map(|f| f[0]).collect();
    assert_eq!(opcodes, vec![0x00, 0x01, 0x03, 0x04, 0x05]);

    // 0x02 nur mit gefangenem Zeiger — sonst gilt die absolute Form.
    let mut f = Erfassung::neu();
    f.einschalten(0, true, Some(SITZUNG));
    f.zeigerbewegung(-3.0, 7.0);
    let frames = alles(&mut f);
    assert_eq!(frames[1], vec![0x02, 0xfd, 0xff, 0x07, 0x00]);
}

/// Bei gefangenem Zeiger darf die absolute Form NICHT mehr kommen: der Zeiger
/// steht dann still, seine Fensterposition sagt nichts mehr aus.
#[test]
fn zeigerfang_schaltet_die_absolute_form_ab() {
    let mut e = Erfassung::neu();
    e.einschalten(0, true, Some(SITZUNG));
    e.on_window_event(&zeiger_ereignis(100.0, 100.0), Some(lage()), false);
    assert_eq!(alles(&mut e), vec![vec![0x00, 0x02]], "nur das Hello");
}

// ── Normierung ──────────────────────────────────────────────────────────────

/// Die Randwerte gehen als 0 und 65535 ueber die Leitung, nicht als
/// „ungefaehr".
#[test]
fn randwerte_der_normierung_am_ganzen_weg() {
    let mut e = eingeschaltet();
    e.on_window_event(&zeiger_ereignis(0.0, 0.0), Some(lage()), false);
    assert_eq!(rahmen_von(e.abholen(Instant::now()))[0], vec![0x01, 0x00, 0x00, 0x00, 0x00]);

    let mut e = eingeschaltet();
    e.on_window_event(&zeiger_ereignis(1920.0, 1080.0), Some(lage()), false);
    assert_eq!(rahmen_von(e.abholen(Instant::now()))[0], vec![0x01, 0xff, 0xff, 0xff, 0xff]);
}

/// Ohne Bild gibt es keine Zuordnung — und ohne Zuordnung wird nicht geklickt.
#[test]
fn ohne_bild_keine_bewegung() {
    let mut e = eingeschaltet();
    e.on_window_event(&zeiger_ereignis(10.0, 10.0), None, false);
    assert!(matches!(e.abholen(Instant::now()), Eingabeabgabe::Nichts));
}

/// Der Rand des Fensters gehoert nicht zum Bild und wird nicht gesendet.
#[test]
fn rand_wird_nicht_gesendet() {
    let mut e = eingeschaltet();
    let breit = Bildlage::neu((2000, 1000), (1920, 1080), [0.0, 0.0, 1.0, 1.0]).expect("Lage");
    e.on_window_event(&zeiger_ereignis(5.0, 500.0), Some(breit), false);
    assert!(matches!(e.abholen(Instant::now()), Eingabeabgabe::Nichts));
}

// ── „Auch Knopf und Rad gehoeren ins Bild" ──────────────────────────────────

/// **Der Kern von Fund 1.** Ein Klick auf dem Briefkasten-Rand kaeme beim Host
/// dort an, wo der Zeiger zuletzt IM Bild stand — also irgendwo. Die Wire-Spec
/// sagt seit dem 2026-08-12 ausdruecklich, dass auch Knopf und Rad ins Bild
/// gehoeren.
#[test]
fn klick_und_rad_auf_dem_rand_gehen_nicht_hinaus() {
    let breit = Bildlage::neu((2000, 1000), (1920, 1080), [0.0, 0.0, 1.0, 1.0]).expect("Lage");
    let mut e = eingeschaltet();
    e.on_window_event(&zeiger_ereignis(5.0, 500.0), Some(breit), false); // auf den Rand
    let _ = alles(&mut e);

    e.on_window_event(&maus_ereignis(ElementState::Pressed, MouseButton::Left), Some(breit), false);
    e.on_window_event(&rad_ereignis(MouseScrollDelta::LineDelta(0.0, 3.0)), Some(breit), false);
    assert!(e.raeumen().is_empty(), "vom Rand geht weder Klick noch Rad hinaus");

    // Ein Punkt im Bild derselben Lage geht dagegen durch.
    e.on_window_event(&zeiger_ereignis(1000.0, 500.0), Some(breit), false);
    e.on_window_event(&maus_ereignis(ElementState::Pressed, MouseButton::Left), Some(breit), false);
    let opcodes: Vec<u8> = alles(&mut e).iter().map(|f| f[0]).collect();
    assert_eq!(opcodes, vec![0x01, 0x03]);
}

/// Die Bedienleiste liegt ueber dem Bild — der Bild-Test allein kann sie nicht
/// aussparen. egui sagt deshalb, wenn es den Zeiger fuer sich beansprucht.
#[test]
fn klick_auf_der_bedienleiste_geht_nicht_hinaus() {
    let mut e = eingeschaltet();
    e.on_window_event(&maus_ereignis(ElementState::Pressed, MouseButton::Left), Some(lage()), true);
    e.on_window_event(&rad_ereignis(MouseScrollDelta::LineDelta(0.0, 3.0)), Some(lage()), true);
    assert!(e.raeumen().is_empty(), "der Lautstaerkeregler ist kein Klick am fernen Rechner");
}

/// **Die Kehrseite, und sie ist die wichtigere:** wer im Bild drueckt und
/// ausserhalb loslaesst, darf keinen klemmenden Knopf am fremden Rechner
/// hinterlassen. Das Hoch-Ereignis geht deshalb immer hinaus, solange der Knopf
/// wirklich unten ist.
#[test]
fn loslassen_ausserhalb_des_bildes_geht_trotzdem_hinaus() {
    let breit = Bildlage::neu((2000, 1000), (1920, 1080), [0.0, 0.0, 1.0, 1.0]).expect("Lage");
    let mut e = eingeschaltet();
    e.on_window_event(&zeiger_ereignis(1000.0, 500.0), Some(breit), false);
    e.on_window_event(&maus_ereignis(ElementState::Pressed, MouseButton::Left), Some(breit), false);
    let _ = alles(&mut e);

    // Weiterziehen auf den Rand, dort loslassen — auch ueber der Bedienleiste.
    e.on_window_event(&zeiger_ereignis(5.0, 500.0), Some(breit), false);
    e.on_window_event(&maus_ereignis(ElementState::Released, MouseButton::Left), Some(breit), true);
    assert_eq!(alles(&mut e), vec![vec![0x03, 0x00, 0x00]], "das Loslassen MUSS hinaus");
}

/// Ein Loslassen ohne Druck davor (der Druck fiel auf dem Rand weg) darf nicht
/// als einzelnes Hoch-Ereignis beim Host ankommen.
#[test]
fn loslassen_ohne_druck_wird_nicht_gesendet() {
    let mut e = eingeschaltet();
    e.on_window_event(&maus_ereignis(ElementState::Released, MouseButton::Left), Some(lage()), false);
    assert!(e.raeumen().is_empty());
}

/// Verlaesst der Zeiger das Fenster, ist seine letzte Lage wertlos — ein
/// Rad-Ereignis danach gehoert nicht mehr ins Bild.
#[test]
fn nach_cursor_left_ist_die_lage_unbekannt() {
    let mut e = eingeschaltet();
    e.on_window_event(&WindowEvent::CursorLeft { device_id: DeviceId::dummy() }, None, false);
    e.on_window_event(&rad_ereignis(MouseScrollDelta::LineDelta(0.0, 3.0)), Some(lage()), false);
    e.on_window_event(&maus_ereignis(ElementState::Pressed, MouseButton::Left), Some(lage()), false);
    assert!(e.raeumen().is_empty(), "ohne bekannte Lage wird nicht geklickt");
}

/// Bei gefangenem Zeiger ist die Frage gegenstandslos: der Zeiger steht still,
/// gefuehrt wird ueber Differenzen. Ein Klick muss trotzdem durchgehen.
#[test]
fn mit_zeigerfang_klickt_es_auch_ohne_bekannte_lage() {
    let mut e = Erfassung::neu();
    e.einschalten(0, true, Some(SITZUNG));
    e.on_window_event(&maus_ereignis(ElementState::Pressed, MouseButton::Left), None, false);
    let opcodes: Vec<u8> = alles(&mut e).iter().map(|f| f[0]).collect();
    assert_eq!(opcodes, vec![0x00, 0x03]);
}

// ── Tasten ──────────────────────────────────────────────────────────────────

#[test]
fn erweiterte_taste_geht_mit_e0_ueber_die_leitung() {
    let mut e = eingeschaltet();
    e.on_window_event(&zeiger_ereignis(0.0, 0.0), Some(lage()), false); // damit etwas davor steht
    e.taste(tasten::scancode(winit::keyboard::KeyCode::ArrowLeft).expect("Pfeil links"), true);
    let frames = rahmen_von(e.abholen(Instant::now()));
    assert_eq!(frames.last().expect("Taste"), &vec![0x05, 0x4b, 0xe0, 0x01]);
}

// ── Flutkontrolle ───────────────────────────────────────────────────────────

/// Aufeinanderfolgende absolute Bewegungen ersetzen einander: die alte Position
/// ist ueberholt, sobald die neue da ist.
#[test]
fn absolute_bewegungen_werden_zusammengefasst() {
    let mut e = eingeschaltet();
    for x in [10.0, 20.0, 30.0, 960.0] {
        e.on_window_event(&zeiger_ereignis(x, 540.0), Some(lage()), false);
    }
    let frames = alles(&mut e);
    assert_eq!(frames.len(), 1, "nur die letzte Position bleibt");
    assert_eq!(frames[0][0], 0x01);
    // 960/1920 = 0,5 -> 32768
    assert_eq!(u16::from_le_bytes([frames[0][1], frames[0][2]]), 32768);
}

/// Relative Bewegungen werden AUFSUMMIERT — jede Differenz zaehlt, sonst
/// verschoebe sich der Zeiger beim Zusammenfassen zu wenig.
#[test]
fn relative_bewegungen_werden_aufsummiert() {
    let mut e = Erfassung::neu();
    e.einschalten(0, true, Some(SITZUNG));
    let _ = alles(&mut e);
    for _ in 0..5 {
        e.zeigerbewegung(3.0, -1.0);
    }
    let frames = alles(&mut e);
    assert_eq!(frames.len(), 1);
    assert_eq!(i16::from_le_bytes([frames[0][1], frames[0][2]]), 15);
    assert_eq!(i16::from_le_bytes([frames[0][3], frames[0][4]]), -5);
}

/// **Der Wayland-Fall (Fund 3).** `relative_pointer` liefert beschleunigte
/// Bruchteile; jedes Ereignis fuer sich gerundet ergab bei langsamem Zielen
/// null — der Zeiger beim Host bewegte sich GAR NICHT. Mit Rest summieren sich
/// drei Ereignisse zum ersten ganzen Punkt.
#[test]
fn relative_bruchteile_gehen_nicht_verloren() {
    let mut e = Erfassung::neu();
    e.einschalten(0, true, Some(SITZUNG));
    let _ = alles(&mut e);
    for _ in 0..2 {
        e.zeigerbewegung(0.4, -0.4);
    }
    assert!(e.raeumen().is_empty(), "0,8 Punkte sind noch kein Punkt");
    e.zeigerbewegung(0.4, -0.4);
    let frames = alles(&mut e);
    assert_eq!(frames.len(), 1, "der dritte Bruchteil fuellt den Punkt");
    assert_eq!(i16::from_le_bytes([frames[0][1], frames[0][2]]), 1);
    assert_eq!(i16::from_le_bytes([frames[0][3], frames[0][4]]), -1);

    // Und ueber eine ganze Bewegung stimmt die Summe: 25 x 0,4 = 10 Punkte.
    let mut e = Erfassung::neu();
    e.einschalten(0, true, Some(SITZUNG));
    let _ = alles(&mut e);
    for _ in 0..25 {
        e.zeigerbewegung(0.4, 0.0);
    }
    let frames = alles(&mut e);
    assert_eq!(i16::from_le_bytes([frames[0][1], frames[0][2]]), 10);
}

/// Der Rest gehoert zum Strom, nicht zum Zeiger: ein neuer Strom faengt bei
/// null an.
#[test]
fn der_bewegungsrest_ueberlebt_den_stromwechsel_nicht() {
    let mut e = Erfassung::neu();
    e.einschalten(0, true, Some(SITZUNG));
    e.zeigerbewegung(0.9, 0.9);
    let _ = alles(&mut e);
    e.einschalten(0, true, Some(SITZUNG));
    let _ = alles(&mut e);
    e.zeigerbewegung(0.2, 0.2);
    assert!(e.raeumen().is_empty(), "0,9 aus dem alten Strom zaehlt nicht mit");
}

/// Der Kern der Flutkontrolle: staut sich die Abgabe, fallen **Bewegungen** —
/// **Tasten nie**. Ein verschlucktes Key-Up waere eine klemmende Taste.
#[test]
fn unter_last_fallen_bewegungen_und_keine_tasten() {
    let mut e = eingeschaltet();
    // Abwechselnd, damit die Bewegungen sich nicht gegenseitig zusammenfassen.
    let runden = MAX_WARTEND * 4;
    for i in 0..runden {
        e.taste(0x1e, i % 2 == 0);
        e.on_window_event(&zeiger_ereignis((i % 1920) as f64, 540.0), Some(lage()), false);
    }
    let frames = alles(&mut e);
    let tasten = frames.iter().filter(|f| f[0] == 0x05).count();
    let bewegungen = frames.iter().filter(|f| f[0] == 0x01).count();
    assert_eq!(tasten, runden, "keine einzige Taste darf fallen");
    assert!(bewegungen < runden, "Bewegungen muessen gefallen sein: {bewegungen}");
    assert!(bewegungen <= MAX_WARTEND, "und sie bleiben gedeckelt: {bewegungen}");
    assert_eq!(e.verworfene_bewegungen(), (runden - bewegungen) as u64);
    // Die Warteschlange laeuft dabei ueber die Grenze hinaus, und das ist die
    // Absicht: gedeckelt werden Bewegungen, nicht die Warteschlange.
    assert!(frames.len() > MAX_WARTEND, "{}", frames.len());
}

/// Bleibt nichts Verwerfbares uebrig, waechst die Warteschlange lieber, als
/// eine Taste zu verlieren.
#[test]
fn ohne_bewegungen_wird_nichts_verworfen() {
    let mut e = eingeschaltet();
    let runden = MAX_WARTEND * 3;
    for i in 0..runden {
        e.taste(0x1e, i % 2 == 0);
    }
    assert_eq!(alles(&mut e).len(), runden);
    assert_eq!(e.verworfene_bewegungen(), 0);
}

// ── Takt der Abgabe ─────────────────────────────────────────────────────────

/// Eine Bewegung wartet auf den Takt, eine Taste nicht.
#[test]
fn bewegungen_warten_auf_den_takt_tasten_nicht() {
    let mut e = eingeschaltet();
    let t0 = Instant::now();
    e.on_window_event(&zeiger_ereignis(100.0, 100.0), Some(lage()), false);
    assert!(matches!(e.abholen(t0), Eingabeabgabe::Jetzt { .. }), "die erste Abgabe darf sofort");

    e.on_window_event(&zeiger_ereignis(200.0, 100.0), Some(lage()), false);
    match e.abholen(t0) {
        Eingabeabgabe::Spaeter(termin) => assert_eq!(termin, t0 + BEWEGUNGSTAKT),
        andere => panic!("Bewegung muss warten, bekam {andere:?}"),
    }
    // Eine Taste daneben hebt die Wartezeit auf.
    e.taste(0x1e, true);
    let frames = rahmen_von(e.abholen(t0));
    assert_eq!(frames.iter().map(|f| f[0]).collect::<Vec<_>>(), vec![0x01, 0x05]);

    // Nach dem Takt darf die Bewegung wieder.
    e.on_window_event(&zeiger_ereignis(300.0, 100.0), Some(lage()), false);
    assert!(matches!(e.abholen(t0 + BEWEGUNGSTAKT), Eingabeabgabe::Jetzt { .. }));
}

#[test]
fn leere_warteschlange_meldet_nichts() {
    let mut e = eingeschaltet();
    assert!(matches!(e.abholen(Instant::now()), Eingabeabgabe::Nichts));
    assert!(e.raeumen().is_empty());
}

// ── Alles loslassen ─────────────────────────────────────────────────────────

/// Ausschalten muss fuer alles Gedrueckte das Hoch-Ereignis nachreichen —
/// sonst laeuft die W-Taste im Spiel weiter.
#[test]
fn ausschalten_laesst_alles_los() {
    let mut e = eingeschaltet();
    e.taste(0x11, true); // W
    e.taste(0x1e, true); // A
    e.on_window_event(&maus_ereignis(ElementState::Pressed, MouseButton::Left), Some(lage()), false);
    let _ = alles(&mut e);

    e.ausschalten();
    let frames = alles(&mut e);
    assert_eq!(frames.len(), 3, "zwei Tasten und ein Knopf: {frames:?}");
    assert!(frames.iter().all(|f| f[f.len() - 1] == 0), "alles muss HOCH sein: {frames:?}");
    assert!(frames.contains(&vec![0x05, 0x11, 0x00, 0x00]));
    assert!(frames.contains(&vec![0x05, 0x1e, 0x00, 0x00]));
    assert!(frames.contains(&vec![0x03, 0x00, 0x00]));
    assert!(!e.aktiv());
}

/// Losgelassene Tasten stehen nicht mehr in der Menge — sonst kaeme beim
/// Ausschalten ein zweites Hoch-Ereignis fuer eine laengst freie Taste.
#[test]
fn losgelassenes_wird_nicht_nachgereicht() {
    let mut e = eingeschaltet();
    e.taste(0x11, true);
    e.taste(0x11, false);
    e.on_window_event(&maus_ereignis(ElementState::Pressed, MouseButton::Right), Some(lage()), false);
    e.on_window_event(&maus_ereignis(ElementState::Released, MouseButton::Right), Some(lage()), false);
    let _ = alles(&mut e);
    e.ausschalten();
    assert!(e.raeumen().is_empty(), "nichts mehr nachzureichen");
}

/// Fokus weg heisst: das Hoch-Ereignis kommt nie an. Also selbst nachreichen —
/// aber die Erfassung bleibt an, der Nutzer kommt zurueck.
#[test]
fn fokusverlust_laesst_alles_los_ohne_abzuschalten() {
    let mut e = eingeschaltet();
    e.taste(0x11, true);
    let _ = alles(&mut e);
    e.on_window_event(&WindowEvent::Focused(false), None, false);
    assert_eq!(alles(&mut e), vec![vec![0x05, 0x11, 0x00, 0x00]]);
    assert!(e.aktiv(), "Fokusverlust ist kein Abschalten");
}

/// **Fund 4, und er hing an einem Rennen:** liegt zwischen Aus und Ein kein
/// Abholen, warf das fruehere `clear()` genau die Hoch-Ereignisse weg, die das
/// Ausschalten gerade eingereiht hatte — die Taste blieb beim Host gedrueckt.
///
/// Das Hello steht dabei VORNE: der Host ist fail-closed und beendet den Strom
/// beim ersten Frame vor dem Handschlag (`Eingabe vor dem Hello-Handschlag`,
/// im Zwei-Geraete-Test am 2026-08-12 belegt).
#[test]
fn hoch_ereignisse_ueberleben_das_wiedereinschalten() {
    let mut e = eingeschaltet();
    e.taste(0x11, true); // W
    e.on_window_event(&maus_ereignis(ElementState::Pressed, MouseButton::Left), Some(lage()), false);
    let _ = alles(&mut e);

    e.ausschalten(); // reiht W-hoch und Knopf-hoch ein
    e.einschalten(0, false, Some(SITZUNG)); // ... und hier gingen sie frueher verloren
    let frames = alles(&mut e);
    assert_eq!(frames[0], vec![0x00, 0x02], "das Hello zuerst");
    assert!(frames.contains(&vec![0x05, 0x11, 0x00, 0x00]), "W-hoch fehlt: {frames:?}");
    assert!(frames.contains(&vec![0x03, 0x00, 0x00]), "Knopf-hoch fehlt: {frames:?}");
    assert_eq!(frames.len(), 3);
}

/// Bewegungen des alten Stroms duerfen dabei fallen — sie sind ueberholt, und
/// die Wire-Spec erlaubt genau das. Gezaehlt werden sie trotzdem.
#[test]
fn beim_stromwechsel_fallen_nur_bewegungen() {
    let mut e = eingeschaltet();
    e.on_window_event(&zeiger_ereignis(100.0, 100.0), Some(lage()), false);
    e.taste(0x11, true);
    e.einschalten(0, false, Some(SITZUNG));
    let opcodes: Vec<u8> = alles(&mut e).iter().map(|f| f[0]).collect();
    assert_eq!(opcodes, vec![0x00, 0x05], "die Bewegung faellt, die Taste bleibt");
    assert_eq!(e.verworfene_bewegungen(), 1);
}

// ── Zeigerfang nachfuehren ──────────────────────────────────────────────────

/// **Fund 6.** Windows loest den Griff beim Fokusverlust auf. Wird das nicht
/// nachgefuehrt, verwirft die Erfassung weiter jedes `CursorMoved` — der
/// Nutzer haette einen freien Zeiger, mit dem er nichts mehr treffen kann.
#[test]
fn verlorener_zeigerfang_schaltet_auf_absolute_bewegungen_zurueck() {
    let mut e = Erfassung::neu();
    e.einschalten(0, true, Some(SITZUNG));
    let _ = alles(&mut e);
    e.on_window_event(&zeiger_ereignis(960.0, 540.0), Some(lage()), false);
    assert!(e.raeumen().is_empty(), "gefangen: die Fensterposition sagt nichts");

    e.zeigerfang_nachfuehren(false); // Fokus weg, Griff aufgeloest
    assert!(!e.zeigerfang());
    e.on_window_event(&zeiger_ereignis(960.0, 540.0), Some(lage()), false);
    assert_eq!(alles(&mut e).len(), 1, "jetzt gilt wieder die absolute Form");

    e.zeigerfang_nachfuehren(true); // Fokus zurueck, neu gefangen
    assert!(e.zeigerfang());
    e.on_window_event(&zeiger_ereignis(100.0, 100.0), Some(lage()), false);
    assert!(e.raeumen().is_empty());
    e.zeigerbewegung(4.0, 0.0);
    assert_eq!(alles(&mut e)[0][0], 0x02, "und wieder die relative");
}

/// Ohne Erfassung gibt es keinen Fang — auch nicht ueber diesen Weg.
#[test]
fn nachfuehren_faengt_nicht_ohne_erfassung() {
    let mut e = Erfassung::neu();
    e.zeigerfang_nachfuehren(true);
    assert!(!e.zeigerfang());
}

// ── Tasten ohne Abbildung ───────────────────────────────────────────────────

/// **Fund 7.** Nicht raten ist richtig, schweigend fallen lassen war es nicht:
/// fuer verworfene Bewegungen gab es laengst einen Zaehler, fuer Tasten nichts.
#[test]
fn tasten_ohne_abbildung_werden_gezaehlt_statt_zu_verschwinden() {
    use winit::keyboard::KeyCode;
    let mut e = eingeschaltet();
    e.taste_von_code(KeyCode::F13, true);
    e.taste_von_code(KeyCode::F13, false);
    e.taste_von_code(KeyCode::MediaPlayPause, true);
    assert!(e.raeumen().is_empty(), "geraten wird weiterhin nicht");
    assert_eq!(e.unbekannte_tasten(), 3);

    // Was abgebildet ist, geht davon unberuehrt hinaus.
    e.taste_von_code(KeyCode::KeyW, true);
    assert_eq!(alles(&mut e), vec![vec![0x05, 0x11, 0x00, 0x01]]);
    assert_eq!(e.unbekannte_tasten(), 3);
}

/// Ausgeschaltet zaehlt auch das nicht — es gibt dann keinen Strom.
#[test]
fn ausgeschaltet_zaehlt_keine_unbekannten_tasten() {
    let mut e = Erfassung::neu();
    e.taste_von_code(winit::keyboard::KeyCode::F13, true);
    assert_eq!(e.unbekannte_tasten(), 0);
}

// ── Zuordnungen von winit ───────────────────────────────────────────────────

#[test]
fn knopf_zuordnung_ist_die_der_leitung() {
    assert_eq!(knopf_von_winit(MouseButton::Left), Some(Knopf::Links));
    assert_eq!(knopf_von_winit(MouseButton::Right), Some(Knopf::Rechts));
    assert_eq!(knopf_von_winit(MouseButton::Middle), Some(Knopf::Mitte));
    assert_eq!(knopf_von_winit(MouseButton::Back), Some(Knopf::X1));
    assert_eq!(knopf_von_winit(MouseButton::Forward), Some(Knopf::X2));
    // Unbekannt wird nicht geraten — beim Host beendete das die Sitzung.
    assert_eq!(knopf_von_winit(MouseButton::Other(9)), None);
}

/// Die senkrechte Achse stimmt zwischen winit und Windows ueberein, die
/// waagerechte nicht (Herleitung an [`rad_von_winit`]). Gerechnet wird in
/// ZEILEN — die Rasten entstehen erst im Sammler.
#[test]
fn rad_vorzeichen() {
    assert_eq!(rad_von_winit(MouseScrollDelta::LineDelta(0.0, 1.0)), (1.0, 0.0));
    assert_eq!(rad_von_winit(MouseScrollDelta::LineDelta(0.0, -1.0)), (-1.0, 0.0));
    assert_eq!(rad_von_winit(MouseScrollDelta::LineDelta(1.0, 0.0)), (0.0, -1.0));
    assert_eq!(rad_von_winit(MouseScrollDelta::LineDelta(-1.0, 0.0)), (0.0, 1.0));
    // Touchpad: rund 100 px je Raste.
    let px = MouseScrollDelta::PixelDelta(PhysicalPosition::new(0.0, 200.0));
    assert_eq!(rad_von_winit(px), (2.0, 0.0));
}

/// **Der Touchpad-Fall am ganzen Weg.** Ein Windows-Praezisions-Touchpad
/// liefert `LineDelta` in Schritten von rund 0,33; bis zum 2026-08-12 wurde
/// daraus je eine volle Raste — dreifache Scrollgeschwindigkeit beim Host.
#[test]
fn teilrasten_sammeln_sich_ueber_ereignisse() {
    let mut e = eingeschaltet();
    let stups = rad_ereignis(MouseScrollDelta::LineDelta(0.0, 0.33));
    for _ in 0..3 {
        e.on_window_event(&stups, Some(lage()), false);
    }
    assert!(e.raeumen().is_empty(), "drei Drittel sind noch keine ganze Raste");
    e.on_window_event(&stups, Some(lage()), false);
    assert_eq!(alles(&mut e), vec![vec![0x04, 0x78, 0x00, 0x00, 0x00]], "jetzt eine Raste");

    // Und ueber eine ganze Geste stimmt die Summe: 30 Stupser sind 9,9 Zeilen.
    let mut e = eingeschaltet();
    for _ in 0..30 {
        e.on_window_event(&stups, Some(lage()), false);
    }
    let rasten: i32 = alles(&mut e)
        .iter()
        .map(|f| i32::from(i16::from_le_bytes([f[1], f[2]])) / 120)
        .sum();
    assert_eq!(rasten, 9, "30 x 0,33 Zeilen = 9 volle Rasten, nicht 30");
}

/// Ein neuer Strom faengt ohne den Rest des alten an — sonst loeste der erste
/// Stups im neuen Strom eine Raste aus, die zum vorigen gehoerte.
#[test]
fn der_radrest_ueberlebt_den_stromwechsel_nicht() {
    let mut e = eingeschaltet();
    e.on_window_event(&rad_ereignis(MouseScrollDelta::LineDelta(0.0, 0.9)), Some(lage()), false);
    assert!(e.raeumen().is_empty());
    e.einschalten(0, false, Some(SITZUNG)); // neuer Strom
    // Der neue Strom weiss noch nicht, wo der Zeiger steht — erst damit ist das
    // Rad ueberhaupt wieder im Bild.
    e.on_window_event(&zeiger_ereignis(960.0, 540.0), Some(lage()), false);
    let _ = alles(&mut e);
    e.on_window_event(&rad_ereignis(MouseScrollDelta::LineDelta(0.0, 0.2)), Some(lage()), false);
    assert!(e.raeumen().is_empty(), "0,9 aus dem alten Strom zaehlt nicht mit");
}

/// Ein Rad-Ereignis ohne Bewegung erzeugt keinen Frame.
#[test]
fn rad_ohne_bewegung_erzeugt_nichts() {
    let mut e = eingeschaltet();
    e.on_window_event(&rad_ereignis(MouseScrollDelta::LineDelta(0.0, 0.0)), Some(lage()), false);
    assert!(matches!(e.abholen(Instant::now()), Eingabeabgabe::Nichts));
}

#[test]
fn base64_hin_und_zurueck() {
    for probe in [&b""[..], b"M", b"Ma", b"Man", b"Manx", &[0x00, 0x02], &[0xff, 0xfe, 0xfd]] {
        assert_eq!(entziffern(&rahmen::kodiere(probe)), probe, "{probe:?}");
    }
}

// ── Der Platz ueberlebt das Ausschalten ─────────────────────────────────────

/// **Der Platz darf beim Ausschalten nirgends auf 0 zurechtgebogen werden.**
///
/// Die Hoch-Ereignisse aus [`Erfassung::ausschalten`] gehoeren zu dem Stream,
/// der gerade gesteuert wurde. Bis zum 2026-08-12 trug das Ausschalten einen
/// Platz in der Signatur, den die IPC-Strecke nicht mitfuehrte: aus `stop()`
/// wurde oben eine 0, und die Freigaben einer Steuerung von Platz 2 gingen an
/// Platz 0 — dessen Sidecar nie ein Hello gesehen hatte und deshalb
/// fail-closed einen FREMDEN, laufenden Stream stilllegte.
#[test]
fn ausschalten_behaelt_den_platz_der_steuerung() {
    let mut e = Erfassung::neu();
    e.einschalten(2, false, Some(SITZUNG));
    e.on_window_event(&zeiger_ereignis(960.0, 540.0), Some(lage()), false);
    e.taste(0x11, true);
    let _ = alles(&mut e);

    e.ausschalten();
    assert_eq!(e.slot(), 2, "die Hoch-Ereignisse gehoeren zu Platz 2");
    assert_eq!(alles(&mut e), vec![vec![0x05, 0x11, 0x00, 0x00]]);
    assert_eq!(e.slot(), 2, "und er bleibt stehen, bis ein Einschalten einen neuen nennt");

    e.einschalten(3, false, Some(SITZUNG));
    assert_eq!(e.slot(), 3);
}

// ── Liegengebliebenes und der Zielwechsel ───────────────────────────────────

/// **Frames eines alten Stroms duerfen nicht an eine neue Sitzung gehen.**
///
/// Endet Sitzung A und beginnt binnen einer Sekunde Sitzung B am selben
/// Fenster, gingen A's Hoch-Ereignisse mit B's Kennung hinaus — der Host von B
/// bekaeme ein Loslassen fuer eine Taste, die er nie gedrueckt sah. Verwerfen
/// ist sicher: beim Hello gibt der Host ohnehin alles frei.
#[test]
fn liegengebliebenes_geht_nicht_an_eine_fremde_sitzung() {
    let mut e = eingeschaltet();
    e.taste(0x11, true);
    let _ = alles(&mut e);

    e.ausschalten(); // reiht W-hoch ein
    e.einschalten(0, false, Some("sit-b"));
    assert_eq!(alles(&mut e), vec![vec![0x00, 0x02]], "nur das Hello, kein fremdes W-hoch");
}

/// Derselbe Fehler ueber den Platz: jeder Stream-Platz hat drueben seinen
/// eigenen Sidecar mit eigener Menge des Gedrueckten.
#[test]
fn liegengebliebenes_geht_nicht_an_einen_anderen_platz() {
    let mut e = eingeschaltet();
    e.taste(0x11, true);
    let _ = alles(&mut e);

    e.ausschalten();
    e.einschalten(1, false, Some(SITZUNG));
    assert_eq!(alles(&mut e), vec![vec![0x00, 0x02]], "Platz 1 sah dieses W nie");
}

/// Ohne Kennung ist das Ziel unbekannt — und wer nicht weiss, wem er etwas
/// schickt, schickt es nicht.
#[test]
fn ohne_sitzungskennung_gilt_der_zielwechsel() {
    let mut e = eingeschaltet();
    e.taste(0x11, true);
    let _ = alles(&mut e);

    e.ausschalten();
    e.einschalten(0, false, None);
    assert_eq!(alles(&mut e), vec![vec![0x00, 0x02]]);
}

// ── Knopf und seine Positionierung ──────────────────────────────────────────

/// Jeder positionsgebundene Frame (Knopf, Rad) MUSS eine Bewegung vor sich
/// haben, die im selben Strom steht — sonst klickt der Host dort, wo sein
/// Zeiger zufaellig steht.
///
/// Gilt nur fuer Stroeme OHNE Zeigerfang: bei gefangenem Zeiger wird der ferne
/// Zeiger ueber Differenzen gefuehrt, eine absolute Positionierung gibt es
/// dort gar nicht.
fn positionierung_pruefen(frames: &[Vec<u8>]) {
    let mut positioniert = false;
    for f in frames {
        match f[0] {
            // Hello = neuer Strom; was der Host vorher wusste, gilt nicht mehr.
            rahmen::OP_HELLO => positioniert = false,
            rahmen::OP_MAUS_ABS | rahmen::OP_MAUS_REL => positioniert = true,
            rahmen::OP_MAUS_KNOPF | rahmen::OP_MAUS_RAD => {
                assert!(positioniert, "Knopf/Rad ohne Positionierung davor: {frames:?}");
            }
            _ => {}
        }
    }
}

/// **Beim Stromwechsel fallen Bewegungen — aber nicht die, an der ein Knopf
/// haengt.** Sonst geht der Klick allein hinaus und landet beim Host an der
/// Stelle, an der dessen Zeiger gerade steht.
#[test]
fn der_knopf_behaelt_seine_positionierung_beim_stromwechsel() {
    let mut e = eingeschaltet();
    e.on_window_event(&zeiger_ereignis(100.0, 100.0), Some(lage()), false);
    e.on_window_event(&maus_ereignis(ElementState::Pressed, MouseButton::Left), Some(lage()), false);
    // Diese hier haengt an nichts mehr und ist ueberholt — sie darf fallen.
    e.on_window_event(&zeiger_ereignis(200.0, 200.0), Some(lage()), false);

    e.einschalten(0, false, Some(SITZUNG));
    let frames = alles(&mut e);
    positionierung_pruefen(&frames);
    assert_eq!(
        frames.iter().map(|f| f[0]).collect::<Vec<_>>(),
        vec![rahmen::OP_HELLO, rahmen::OP_MAUS_ABS, rahmen::OP_MAUS_KNOPF],
    );
    let (u, _) = lage().anteil(100.0, 100.0).expect("innen");
    assert_eq!(
        u16::from_le_bytes([frames[1][1], frames[1][2]]),
        rahmen::anteil_zu_u16(u),
        "es muss GENAU die Positionierung des Klicks sein",
    );
    assert_eq!(e.verworfene_bewegungen(), 1, "nur die ueberholte faellt");
}

/// Dasselbe unter Last: die Flutkontrolle kappt die AELTESTEN Bewegungen, und
/// die aelteste ist hier genau die Positionierung des Klicks.
#[test]
fn der_knopf_behaelt_seine_positionierung_auch_unter_last() {
    let mut e = eingeschaltet();
    e.on_window_event(&zeiger_ereignis(100.0, 100.0), Some(lage()), false);
    e.on_window_event(&maus_ereignis(ElementState::Pressed, MouseButton::Left), Some(lage()), false);
    // Tasten treiben die Laenge hoch (sie sind unverwerfbar), die Bewegungen
    // dazwischen loesen das Kappen aus.
    for i in 0..(MAX_WARTEND * 4) {
        e.taste(0x1e, i % 2 == 0);
        e.on_window_event(&zeiger_ereignis((i % 1920) as f64, 540.0), Some(lage()), false);
    }
    let frames = alles(&mut e);
    positionierung_pruefen(&frames);
    assert!(e.verworfene_bewegungen() > 0, "es muss ueberhaupt gekappt worden sein");
}

/// Das Rad haengt genauso an seiner Positionierung wie der Knopf — es traegt
/// ebenfalls keine eigene Koordinate.
#[test]
fn das_rad_behaelt_seine_positionierung_beim_stromwechsel() {
    let mut e = eingeschaltet();
    e.on_window_event(&zeiger_ereignis(100.0, 100.0), Some(lage()), false);
    e.on_window_event(&rad_ereignis(MouseScrollDelta::LineDelta(0.0, 1.0)), Some(lage()), false);

    e.einschalten(0, false, Some(SITZUNG));
    let frames = alles(&mut e);
    positionierung_pruefen(&frames);
    assert_eq!(
        frames.iter().map(|f| f[0]).collect::<Vec<_>>(),
        vec![rahmen::OP_HELLO, rahmen::OP_MAUS_ABS, rahmen::OP_MAUS_RAD],
    );
}

// ── Notbremse ───────────────────────────────────────────────────────────────

/// **Eine reine Tastenflut darf die Warteschlange nicht unbegrenzt wachsen
/// lassen.** Gekappt werden nur Bewegungen; enthaelt die Schlange keine, gab es
/// bis zum 2026-08-12 gar keine Obergrenze. Statt blind Frames zu opfern —
/// es koennte das Hoch-Ereignis sein, dessen Verlust eine Taste am fremden
/// Rechner klemmen laesst — wird der Strom neu begonnen; das Hello gibt beim
/// Host alles frei.
#[test]
fn eine_reine_tastenflut_deckelt_die_warteschlange() {
    let mut e = eingeschaltet();
    for i in 0..(MAX_GESAMT * 3) {
        e.taste(0x1e, i % 2 == 0);
    }
    assert!(e.notbremsen() >= 1, "die Notbremse muss gegriffen haben");
    assert!(e.verworfene_frames() > 0, "und sie zaehlt, was sie gekostet hat");

    let frames = alles(&mut e);
    assert!(frames.len() <= MAX_GESAMT + 1, "gedeckelt, aber {} Frames", frames.len());
    assert_eq!(frames[0], vec![0x00, 0x02], "nach der Notbremse steht ein Hello vorn");
    assert_eq!(e.verworfene_bewegungen(), 0, "es gab hier gar keine Bewegungen");
}

/// Auch eine Flut aus Knopf-Ereignissen (jedes ist unverwerfbar) laeuft in die
/// Notbremse statt ins Unendliche.
#[test]
fn eine_knopfflut_deckelt_die_warteschlange() {
    let mut e = eingeschaltet();
    for i in 0..(MAX_GESAMT * 2) {
        let zustand =
            if i % 2 == 0 { ElementState::Pressed } else { ElementState::Released };
        e.on_window_event(&maus_ereignis(zustand, MouseButton::Left), Some(lage()), false);
    }
    let frames = alles(&mut e);
    assert!(frames.len() <= MAX_GESAMT + 1, "{}", frames.len());
    assert!(e.notbremsen() >= 1);
}

/// Solange niemand umzielt, traegt die Abgabe den eingeschalteten Platz.
#[test]
fn abgabe_traegt_den_eigenen_platz() {
    let mut e = Erfassung::neu();
    e.einschalten(3, false, Some(SITZUNG));
    let batches = e.raeumen();
    assert_eq!(batches.len(), 1, "das Hello sollte in einem Buendel stehen");
    assert_eq!(batches[0].0, 3, "Platz der Abgabe");
    assert_eq!(e.ziel_slot(), 3);
}

/// Zwei Fenster nebeneinander, jedes 1920 breit. Fenster A ist das eigene.
fn zwei_fenster() -> Vec<Nachbar> {
    vec![
        Nachbar { id: 1, slot: 0, ursprung: (0.0, 0.0), lage: lage() },
        Nachbar { id: 2, slot: 1, ursprung: (1920.0, 0.0), lage: lage() },
    ]
}

/// **Der Kern des Ganzen:** eine Bewegung, deren Punkt im NACHBARN liegt, geht
/// mit dessen Platz hinaus — obwohl sie in diesem Fenster erfasst wurde.
#[test]
fn bewegung_ueber_dem_nachbarn_traegt_dessen_platz() {
    let mut e = eingeschaltet();
    e.nachbarschaft_setzen(Some((0.0, 0.0)), zwei_fenster());
    // 2880 auf dem Desktop = Mitte des zweiten Fensters (1920 + 960).
    e.on_window_event(&zeiger_ereignis(2880.0, 540.0), Some(lage()), false);

    // `eingeschaltet()` hat die Warteschlange schon geleert — beim Zielwechsel
    // steht also nichts Altes mehr an, und es bleibt bei EINEM Buendel.
    let buendel = alles_mit_platz(&mut e);
    assert_eq!(buendel.len(), 1, "{buendel:?}");
    assert_eq!(buendel[0].0, 1, "die Bewegung gehoert Platz 1");
    assert_eq!(buendel[0].1[0][0], 0x01, "Opcode MouseMoveAbs");
    assert_eq!(e.ziel_slot(), 1);
}

/// Beim Zielwechsel muss das Liegengebliebene VORHER hinaus, mit dem alten
/// Platz. Ein Buendel traegt genau einen — sonst landete eine Bewegung des
/// einen Bildschirms auf dem anderen.
#[test]
fn zielwechsel_trennt_die_buendel() {
    let mut e = eingeschaltet();
    e.nachbarschaft_setzen(Some((0.0, 0.0)), zwei_fenster());
    // Erst im eigenen Fenster bewegen, dann in den Nachbarn.
    e.on_window_event(&zeiger_ereignis(100.0, 100.0), Some(lage()), false);
    e.on_window_event(&zeiger_ereignis(2880.0, 540.0), Some(lage()), false);

    let buendel = alles_mit_platz(&mut e);
    assert_eq!(buendel.len(), 2, "{buendel:?}");
    assert_eq!(buendel[0].0, 0, "das Liegengebliebene gehoert Platz 0");
    assert_eq!(buendel[1].0, 1, "das Neue gehoert Platz 1");
}

/// Der Zug endet im Nachbarn: das Loslassen geht an DESSEN Platz. Genau daran
/// haengt, ob das gezogene Fenster drueben abgelegt wird.
#[test]
fn loslassen_im_nachbarn_geht_an_dessen_platz() {
    let mut e = eingeschaltet();
    e.nachbarschaft_setzen(Some((0.0, 0.0)), zwei_fenster());
    e.on_window_event(&maus_ereignis(ElementState::Pressed, MouseButton::Left), Some(lage()), false);
    e.on_window_event(&zeiger_ereignis(2880.0, 540.0), Some(lage()), false);
    e.on_window_event(
        &maus_ereignis(ElementState::Released, MouseButton::Left),
        Some(lage()),
        false,
    );

    let buendel = alles_mit_platz(&mut e);
    // Druck (eigenes Fenster, Platz 0) und Loslassen (Nachbar, Platz 1)
    // liegen in getrennten Buendeln — sonst haette eines der beiden den
    // falschen Platz mitbekommen.
    assert_eq!(buendel.len(), 2, "Druck und Loslassen gehoeren getrennten Buendeln: {buendel:?}");
    assert_eq!(buendel[0].0, 0, "der Druck geschah im eigenen Fenster: {buendel:?}");
    let letztes = buendel.last().expect("Buendel");
    assert_eq!(letztes.0, 1, "Loslassen gehoert dem Nachbarn: {buendel:?}");
    let hoch = letztes.1.last().expect("Frame");
    assert_eq!(hoch[0], 0x03, "Opcode MouseButton");
    assert_eq!(hoch[2], 0, "runter=false");
}

/// Ein Punkt, der in keinem Fenster liegt (Luecke, eigener Desktop), sendet
/// nichts — und aendert das Ziel nicht.
#[test]
fn punkt_in_der_luecke_sendet_nichts() {
    let mut e = eingeschaltet();
    e.nachbarschaft_setzen(Some((0.0, 0.0)), zwei_fenster());
    e.on_window_event(&zeiger_ereignis(-500.0, 540.0), Some(lage()), false);
    assert!(alles(&mut e).is_empty(), "ausserhalb aller Fenster geht nichts hinaus");
    assert_eq!(e.ziel_slot(), 0, "das Ziel bleibt, wo es war");
}

/// Ohne bekannte Nachbarschaft (Wayland gibt keine Fensterlagen heraus) bleibt
/// alles beim Verhalten von vorher: eigenes Bild, eigener Platz.
///
/// **Eingeschaltet wird mit Platz 3, nicht ueber [`eingeschaltet`]** (das
/// nimmt 0): 0 ist zugleich der Vorgabewert des Rueckfalls, ein
/// `ziel_bestimmen`, das dort faelschlich die Konstante 0 statt `self.slot`
/// lieferte, bestuende den Test sonst trotzdem.
#[test]
fn ohne_nachbarschaft_bleibt_es_beim_eigenen_bild() {
    let mut e = Erfassung::neu();
    e.einschalten(3, false, Some(SITZUNG));
    e.nachbarschaft_setzen(None, Vec::new());
    e.on_window_event(&zeiger_ereignis(960.0, 540.0), Some(lage()), false);
    let buendel = alles_mit_platz(&mut e);
    assert_eq!(buendel.len(), 1);
    assert_eq!(buendel[0].0, 3, "der Platz bleibt der eigene (3), nicht die Rueckfall-Konstante 0");
    assert_eq!(e.ziel_slot(), 3);
}

/// **C1, der Kern-Regressionstest:** eine `CursorMoved` merkt die Zeigerlage
/// IMMER (auch ohne eigenes Bild), erreicht `zeigerposition`/`ziel_wechseln`
/// aber nur MIT einem. Ohne eigenes Bild bleibt `ziel_slot` also auf dem
/// alten Stand — ein nachfolgender Knopfdruck darf sich davon trotzdem nicht
/// stempeln lassen: das Orts-Tor muss den Platz frisch bestimmen, nicht den
/// zuletzt per Bewegung bestaetigten `ziel_slot` nehmen. Sonst zielt ein
/// Klick ueber dem Nachbarn noch auf das eigene Fenster.
#[test]
fn knopfdruck_zielt_frisch_auch_ohne_bestaetigende_bewegung() {
    let mut e = eingeschaltet();
    e.nachbarschaft_setzen(Some((0.0, 0.0)), zwei_fenster());
    // Kein eigenes Bild bekannt: die Lage wird gemerkt, aber `zeigerposition`
    // (und damit `ziel_wechseln`) laeuft NICHT.
    e.on_window_event(&zeiger_ereignis(2880.0, 540.0), None, false);
    assert_eq!(e.ziel_slot(), 0, "ohne eigenes Bild bleibt ziel_slot unveraendert");

    e.on_window_event(&maus_ereignis(ElementState::Pressed, MouseButton::Left), Some(lage()), false);

    let buendel = alles_mit_platz(&mut e);
    assert_eq!(buendel.len(), 1, "{buendel:?}");
    assert_eq!(buendel[0].0, 1, "der Druck gehoert dem Nachbarn, nicht dem veralteten Ziel 0");
    assert_eq!(e.ziel_slot(), 1);
}

/// I3: `CursorLeft` loescht die Zeigerlage nur, wenn KEIN Knopf unten ist.
/// Waehrend eines Zuges (Knopf unten) bleibt sie stehen, weil das
/// Betriebssystem die Ereignisse weiterhin diesem Fenster zustellt — ein
/// weiterer Druck geht danach noch hinaus. Ohne gehaltenen Knopf ist „ausser
/// Sicht" wieder „kein Klick": derselbe Druck bleibt fail-closed aus.
#[test]
fn cursor_left_haelt_die_lage_nur_bei_gehaltenem_knopf() {
    let mut mit_knopf = eingeschaltet();
    mit_knopf.on_window_event(
        &maus_ereignis(ElementState::Pressed, MouseButton::Left),
        Some(lage()),
        false,
    );
    let _ = alles(&mut mit_knopf); // den Druck selbst wegnehmen
    mit_knopf.on_window_event(&WindowEvent::CursorLeft { device_id: DeviceId::dummy() }, Some(lage()), false);
    mit_knopf.on_window_event(
        &maus_ereignis(ElementState::Pressed, MouseButton::Right),
        Some(lage()),
        false,
    );
    assert!(
        !alles(&mut mit_knopf).is_empty(),
        "mit gehaltenem Knopf bleibt die Lage bekannt, ein weiterer Druck geht hinaus"
    );

    let mut ohne_knopf = eingeschaltet();
    ohne_knopf.on_window_event(&WindowEvent::CursorLeft { device_id: DeviceId::dummy() }, Some(lage()), false);
    ohne_knopf.on_window_event(
        &maus_ereignis(ElementState::Pressed, MouseButton::Right),
        Some(lage()),
        false,
    );
    assert!(
        alles(&mut ohne_knopf).is_empty(),
        "ohne gehaltenen Knopf loescht CursorLeft die Lage, der Druck bleibt aus"
    );
}
