//! Tests der Erfassung. Kein Fenster, keine GPU, kein Netz.
//!
//! `WindowEvent::KeyboardInput` fehlt hier: `KeyEvent` traegt ein
//! `pub(crate)`-Feld und ist ausserhalb von winit nicht zu bauen. Die
//! Tastenseite wird deshalb ueber [`Erfassung::taste`] und
//! [`super::tasten::scancode`] geprueft — zusammen decken die beiden denselben
//! Weg ab, den `on_window_event` fuer Tasten nimmt.

use super::*;
use winit::dpi::PhysicalPosition;
use winit::event::{DeviceId, MouseButton, MouseScrollDelta};

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

fn rahmen_von(abgabe: Abgabe) -> Vec<Vec<u8>> {
    match abgabe {
        Abgabe::Jetzt(frames) => frames.iter().map(|f| entziffern(f)).collect(),
        andere => panic!("Frames erwartet, bekam {andere:?}"),
    }
}

/// Alles herausholen, ohne auf den Bewegungstakt zu warten.
fn alles(e: &mut Erfassung) -> Vec<Vec<u8>> {
    e.raeumen().map_or_else(Vec::new, |f| f.iter().map(|s| entziffern(s)).collect())
}

fn lage() -> Bildlage {
    // Fenster und Quelle im selben Verhaeltnis: kein Rand, die Ecken sind
    // dadurch exakt 0,0 und 1,1.
    Bildlage::neu((1920, 1080), (1920, 1080), [0.0, 0.0, 1.0, 1.0]).expect("Lage")
}

fn eingeschaltet() -> Erfassung {
    let mut e = Erfassung::neu();
    e.setzen(true, 0, false);
    // Hello wegnehmen, damit die Tests nur ihren eigenen Frame sehen.
    assert_eq!(alles(&mut e), vec![vec![0x00, 0x02]]);
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
    e.on_window_event(&zeiger_ereignis(100.0, 100.0), Some(lage()));
    e.on_window_event(&maus_ereignis(ElementState::Pressed, MouseButton::Left), None);
    e.taste(0x1e, true);
    assert_eq!(e.abholen(Instant::now()), Abgabe::Nichts, "ausgeschaltet kodiert nichts");
}

/// Der Hello-Frame MUSS der erste der Sitzung sein (Wire-Spec), und er traegt
/// Version 2.
#[test]
fn einschalten_stellt_hello_voran() {
    let mut e = Erfassung::neu();
    e.taste(0x1e, true); // vor dem Einschalten — gehoert zu keiner Sitzung
    e.setzen(true, 3, false);
    e.taste(0x1e, true);
    let frames = alles(&mut e);
    assert_eq!(frames[0], vec![super::rahmen::OP_HELLO, 2]);
    assert_eq!(frames.len(), 2, "vor dem Einschalten wird nichts kodiert");
    assert_eq!(e.slot(), 3);
}

/// Ein ZWEITES Hello mitten im Strom waere beim Host ein Protokollfehler und
/// beendete die Sitzung. Wiederholtes Einschalten (etwa nur mit anderem Slot)
/// darf deshalb keins erzeugen — und darf auch nicht die Menge der gedrueckten
/// Tasten vergessen.
#[test]
fn wiederholtes_einschalten_erzeugt_kein_zweites_hello() {
    let mut e = eingeschaltet();
    e.taste(0x11, true);
    let _ = alles(&mut e);

    e.setzen(true, 5, false);
    assert_eq!(e.slot(), 5, "der Slot wandert trotzdem nach");
    assert!(e.raeumen().is_none(), "kein zweites Hello");

    e.setzen(false, 5, false);
    assert_eq!(alles(&mut e), vec![vec![0x05, 0x11, 0x00, 0x00]], "W ist noch bekannt");
}

/// Zweimal ausschalten reicht die Hoch-Ereignisse nicht zweimal nach.
#[test]
fn wiederholtes_ausschalten_reicht_nichts_doppelt_nach() {
    let mut e = eingeschaltet();
    e.taste(0x11, true);
    let _ = alles(&mut e);
    e.setzen(false, 0, false);
    assert_eq!(alles(&mut e).len(), 1);
    e.setzen(false, 0, false);
    assert!(e.raeumen().is_none());
}

// ── Jeder Opcode einmal ─────────────────────────────────────────────────────

#[test]
fn jeder_opcode_einmal() {
    let mut e = Erfassung::neu();
    e.setzen(true, 0, false); // 0x00
    e.on_window_event(&zeiger_ereignis(960.0, 540.0), Some(lage())); // 0x01
    e.on_window_event(&maus_ereignis(ElementState::Pressed, MouseButton::Left), None); // 0x03
    e.on_window_event(&rad_ereignis(MouseScrollDelta::LineDelta(0.0, 1.0)), None); // 0x04
    e.taste(0x1e, true); // 0x05
    let opcodes: Vec<u8> = alles(&mut e).iter().map(|f| f[0]).collect();
    assert_eq!(opcodes, vec![0x00, 0x01, 0x03, 0x04, 0x05]);

    // 0x02 nur mit gefangenem Zeiger — sonst gilt die absolute Form.
    let mut f = Erfassung::neu();
    f.setzen(true, 0, true);
    f.zeigerbewegung(-3.0, 7.0);
    let frames = alles(&mut f);
    assert_eq!(frames[1], vec![0x02, 0xfd, 0xff, 0x07, 0x00]);
}

/// Bei gefangenem Zeiger darf die absolute Form NICHT mehr kommen: der Zeiger
/// steht dann still, seine Fensterposition sagt nichts mehr aus.
#[test]
fn zeigerfang_schaltet_die_absolute_form_ab() {
    let mut e = Erfassung::neu();
    e.setzen(true, 0, true);
    e.on_window_event(&zeiger_ereignis(100.0, 100.0), Some(lage()));
    assert_eq!(alles(&mut e), vec![vec![0x00, 0x02]], "nur das Hello");
}

// ── Normierung ──────────────────────────────────────────────────────────────

/// Die Randwerte gehen als 0 und 65535 ueber die Leitung, nicht als
/// „ungefaehr".
#[test]
fn randwerte_der_normierung_am_ganzen_weg() {
    let mut e = eingeschaltet();
    e.on_window_event(&zeiger_ereignis(0.0, 0.0), Some(lage()));
    assert_eq!(rahmen_von(e.abholen(Instant::now()))[0], vec![0x01, 0x00, 0x00, 0x00, 0x00]);

    let mut e = eingeschaltet();
    e.on_window_event(&zeiger_ereignis(1920.0, 1080.0), Some(lage()));
    assert_eq!(rahmen_von(e.abholen(Instant::now()))[0], vec![0x01, 0xff, 0xff, 0xff, 0xff]);
}

/// Ohne Bild gibt es keine Zuordnung — und ohne Zuordnung wird nicht geklickt.
#[test]
fn ohne_bild_keine_bewegung() {
    let mut e = eingeschaltet();
    e.on_window_event(&zeiger_ereignis(10.0, 10.0), None);
    assert_eq!(e.abholen(Instant::now()), Abgabe::Nichts);
}

/// Der Rand des Fensters gehoert nicht zum Bild und wird nicht gesendet.
#[test]
fn rand_wird_nicht_gesendet() {
    let mut e = eingeschaltet();
    let breit = Bildlage::neu((2000, 1000), (1920, 1080), [0.0, 0.0, 1.0, 1.0]).expect("Lage");
    e.on_window_event(&zeiger_ereignis(5.0, 500.0), Some(breit));
    assert_eq!(e.abholen(Instant::now()), Abgabe::Nichts);
}

// ── Tasten ──────────────────────────────────────────────────────────────────

#[test]
fn erweiterte_taste_geht_mit_e0_ueber_die_leitung() {
    let mut e = eingeschaltet();
    e.on_window_event(&zeiger_ereignis(0.0, 0.0), Some(lage())); // damit etwas davor steht
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
        e.on_window_event(&zeiger_ereignis(x, 540.0), Some(lage()));
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
    e.setzen(true, 0, true);
    let _ = alles(&mut e);
    for _ in 0..5 {
        e.zeigerbewegung(3.0, -1.0);
    }
    let frames = alles(&mut e);
    assert_eq!(frames.len(), 1);
    assert_eq!(i16::from_le_bytes([frames[0][1], frames[0][2]]), 15);
    assert_eq!(i16::from_le_bytes([frames[0][3], frames[0][4]]), -5);
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
        e.on_window_event(&zeiger_ereignis((i % 1920) as f64, 540.0), Some(lage()));
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
    e.on_window_event(&zeiger_ereignis(100.0, 100.0), Some(lage()));
    assert!(matches!(e.abholen(t0), Abgabe::Jetzt(_)), "die erste Abgabe darf sofort");

    e.on_window_event(&zeiger_ereignis(200.0, 100.0), Some(lage()));
    match e.abholen(t0) {
        Abgabe::Spaeter(termin) => assert_eq!(termin, t0 + BEWEGUNGSTAKT),
        andere => panic!("Bewegung muss warten, bekam {andere:?}"),
    }
    // Eine Taste daneben hebt die Wartezeit auf.
    e.taste(0x1e, true);
    let frames = rahmen_von(e.abholen(t0));
    assert_eq!(frames.iter().map(|f| f[0]).collect::<Vec<_>>(), vec![0x01, 0x05]);

    // Nach dem Takt darf die Bewegung wieder.
    e.on_window_event(&zeiger_ereignis(300.0, 100.0), Some(lage()));
    assert!(matches!(e.abholen(t0 + BEWEGUNGSTAKT), Abgabe::Jetzt(_)));
}

#[test]
fn leere_warteschlange_meldet_nichts() {
    let mut e = eingeschaltet();
    assert_eq!(e.abholen(Instant::now()), Abgabe::Nichts);
    assert!(e.raeumen().is_none());
}

// ── Alles loslassen ─────────────────────────────────────────────────────────

/// Ausschalten muss fuer alles Gedrueckte das Hoch-Ereignis nachreichen —
/// sonst laeuft die W-Taste im Spiel weiter.
#[test]
fn ausschalten_laesst_alles_los() {
    let mut e = eingeschaltet();
    e.taste(0x11, true); // W
    e.taste(0x1e, true); // A
    e.on_window_event(&maus_ereignis(ElementState::Pressed, MouseButton::Left), None);
    let _ = alles(&mut e);

    e.setzen(false, 0, false);
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
    e.on_window_event(&maus_ereignis(ElementState::Pressed, MouseButton::Right), None);
    e.on_window_event(&maus_ereignis(ElementState::Released, MouseButton::Right), None);
    let _ = alles(&mut e);
    e.setzen(false, 0, false);
    assert!(e.raeumen().is_none(), "nichts mehr nachzureichen");
}

/// Fokus weg heisst: das Hoch-Ereignis kommt nie an. Also selbst nachreichen —
/// aber die Erfassung bleibt an, der Nutzer kommt zurueck.
#[test]
fn fokusverlust_laesst_alles_los_ohne_abzuschalten() {
    let mut e = eingeschaltet();
    e.taste(0x11, true);
    let _ = alles(&mut e);
    e.on_window_event(&WindowEvent::Focused(false), None);
    assert_eq!(alles(&mut e), vec![vec![0x05, 0x11, 0x00, 0x00]]);
    assert!(e.aktiv(), "Fokusverlust ist kein Abschalten");
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
/// waagerechte nicht (Herleitung an [`rad_von_winit`]).
#[test]
fn rad_vorzeichen() {
    assert_eq!(rad_von_winit(MouseScrollDelta::LineDelta(0.0, 1.0)), (120, 0));
    assert_eq!(rad_von_winit(MouseScrollDelta::LineDelta(0.0, -1.0)), (-120, 0));
    assert_eq!(rad_von_winit(MouseScrollDelta::LineDelta(1.0, 0.0)), (0, -120));
    assert_eq!(rad_von_winit(MouseScrollDelta::LineDelta(-1.0, 0.0)), (0, 120));
    // Touchpad: rund 100 px je Raste.
    let px = MouseScrollDelta::PixelDelta(PhysicalPosition::new(0.0, 200.0));
    assert_eq!(rad_von_winit(px), (240, 0));
    // Ein Streichen unter einer Raste bleibt eine Raste, sonst bewegte sich
    // nichts.
    let winzig = MouseScrollDelta::PixelDelta(PhysicalPosition::new(0.0, 4.0));
    assert_eq!(rad_von_winit(winzig), (120, 0));
}

/// Ein Rad-Ereignis ohne Bewegung erzeugt keinen Frame.
#[test]
fn rad_ohne_bewegung_erzeugt_nichts() {
    let mut e = eingeschaltet();
    e.on_window_event(&rad_ereignis(MouseScrollDelta::LineDelta(0.0, 0.0)), None);
    assert_eq!(e.abholen(Instant::now()), Abgabe::Nichts);
}

#[test]
fn base64_hin_und_zurueck() {
    for probe in [&b""[..], b"M", b"Ma", b"Man", b"Manx", &[0x00, 0x02], &[0xff, 0xfe, 0xfd]] {
        assert_eq!(entziffern(&rahmen::base64(probe)), probe, "{probe:?}");
    }
}
