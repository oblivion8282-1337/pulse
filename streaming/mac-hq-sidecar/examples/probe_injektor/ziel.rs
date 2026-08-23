//! Das Zielfenster und die Handgriffe drumherum: TextEdit öffnen, seine Lage
//! erfragen, klicken, kopieren, Zwischenablage lesen und schreiben.
//!
//! Alles hier ist Beiwerk der Messung, nicht die Messung selbst — die steht in
//! [`crate::maus`] und [`crate::tastatur`].

use std::io::Write;
use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::Duration;

use pulse_fernsteuerung::druck::Druck;
use pulse_fernsteuerung::plattform::Injektor;
use pulse_mac_hq_sidecar::remote_input::injektion::MacInjektor;

/// Der Text, den TextEdit für uns bereithält. Erste Zeile lang genug, dass ein
/// Ziehen darin mehrere Wörter überstreicht.
pub(crate) const TEXT: &str = "Hallo Welt Pulse Fernsteuerung\nzweite Zeile\n";
pub(crate) const MARKE: &str = "ZWISCHENABLAGE-LEER";
/// Länge einer Zeile der Rolldatei in UTF-16-Einheiten, samt Zeilenumbruch —
/// „Zeile 001 — zum Rollen." sind 23, der Umbruch macht 24. Damit wird aus dem
/// sichtbaren Zeichenbereich eine Zeilennummer.
pub(crate) const ZEILENLAENGE: f64 = 24.0;

/// Linke Befehlstaste, C, A — Scancodes Satz 1.
pub(crate) const CMD: u16 = 0xe05b;
pub(crate) const TASTE_C: u16 = 0x2e;

/// Wo im Text geklickt werden darf: die linke obere Ecke des Fensters plus ein
/// Versatz in den Textbereich hinein.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Fenster {
    pub(crate) x: i32,
    pub(crate) y: i32,
}

impl Fenster {
    /// Mitten im ersten Wort der ersten Zeile. Der Versatz ist an einem
    /// Bildschirmfoto abgemessen: TextEdit setzt den Text im Klartext-Modus
    /// direkt unter die Titelleiste, ohne nennenswerten Rand.
    pub(crate) fn wort(&self) -> (i32, i32) {
        (self.x + 20, self.y + 35)
    }
}

/// TextEdit mit unserer Datei öffnen, nach vorn holen und seine Fensterlage
/// erfragen. Die Lage kommt über System Events — dieselbe Freigabe, die auch
/// die Injektion braucht, also kein zusätzliches Recht.
pub(crate) fn ziel_oeffnen(text: &str) -> anyhow::Result<Fenster> {
    let pfad = std::env::temp_dir().join("pulse-injektor-pruefling.txt");
    std::fs::write(&pfad, text)?;
    lauf("open", &["-a", "TextEdit", pfad.to_str().unwrap()])?;
    sleep(Duration::from_millis(1500));
    lauf("osascript", &["-e", "tell application \"TextEdit\" to activate"])?;
    sleep(Duration::from_millis(800));
    let (x, y) = fensterlage()?;
    Ok(Fenster { x, y })
}

/// Die heutige Lage der linken oberen Ecke des TextEdit-Fensters.
pub(crate) fn fensterlage() -> anyhow::Result<(i32, i32)> {
    let lage = lauf("osascript", &[
        "-e",
        "tell application \"System Events\" to tell process \"TextEdit\" \
         to get position of window 1",
    ])?;
    let zahlen: Vec<i32> =
        lage.trim().split(',').filter_map(|s| s.trim().parse().ok()).collect();
    let [x, y] = zahlen[..] else {
        anyhow::bail!("Fensterlage nicht lesbar: {lage:?}");
    };
    Ok((x, y))
}

/// `MacInjektor::neu` meldet seinen Fehler als Text; hier wird daraus einmal ein
/// `anyhow::Error`, statt in jedem Lauf dieselbe Umhüllung zu tippen.
pub(crate) fn injektor() -> anyhow::Result<MacInjektor> {
    MacInjektor::neu().map_err(anyhow::Error::msg)
}

pub(crate) fn klick(inj: &MacInjektor, druck: &Druck, ort: (i32, i32)) {
    inj.maus_setzen(ort, druck);
    inj.maus_knopf(0, true);
    sleep(Duration::from_millis(40));
    inj.maus_knopf(0, false);
}

/// Doppelklick, um ein Wort zu markieren.
pub(crate) fn markieren(inj: &MacInjektor, druck: &mut Druck, ort: (i32, i32)) {
    klick(inj, druck, ort);
    sleep(Duration::from_millis(80));
    klick(inj, druck, ort);
    sleep(Duration::from_millis(300));
}

/// Vor einem Lauf: irgendwohin klicken, damit eine etwaige alte Auswahl weg
/// ist, und die Zwischenablage auf die Marke setzen. Ohne die Marke wäre ein
/// späteres „nichts markiert" von einem alten Inhalt nicht zu unterscheiden.
pub(crate) fn auswahl_leeren(inj: &MacInjektor, druck: &Druck, f: &Fenster) -> anyhow::Result<()> {
    klick(inj, druck, (f.x + 300, f.y + 200));
    sleep(Duration::from_millis(700));
    zwischenablage_setzen(MARKE)
}

/// Nach einem Lauf: die Auswahl kopieren und melden, was in ihr stand. Steht
/// noch die Marke da, hat der Lauf nichts markiert.
pub(crate) fn auswahl_melden(inj: &MacInjektor, leer: &str, getroffen: &str) -> anyhow::Result<()> {
    kopieren(inj);
    let inhalt = zwischenablage_lesen()?;
    println!("Markiert war: {inhalt:?}");
    println!("-> {}", if inhalt.trim() == MARKE { leer } else { getroffen });
    Ok(())
}

/// Cmd+C über den Injektor, mit gefüllter Gedrückt-Menge.
fn kopieren(inj: &MacInjektor) {
    let mut druck = Druck::default();
    inj.taste(CMD, true, &druck);
    druck.taste(CMD, true);
    sleep(Duration::from_millis(60));
    inj.taste(TASTE_C, true, &druck);
    sleep(Duration::from_millis(60));
    inj.taste(TASTE_C, false, &druck);
    sleep(Duration::from_millis(60));
    inj.taste(CMD, false, &druck);
    druck.taste(CMD, false);
    sleep(Duration::from_millis(400));
}

pub(crate) fn zwischenablage_setzen(inhalt: &str) -> anyhow::Result<()> {
    let mut kind = Command::new("pbcopy").stdin(Stdio::piped()).spawn()?;
    // `take` schliesst das Rohr am Ende dieser Zeile — `pbcopy` wartet sonst auf
    // sein Dateiende, statt sich zu beenden.
    kind.stdin.take().expect("pbcopy hat eine Standardeingabe").write_all(inhalt.as_bytes())?;
    kind.wait()?;
    Ok(())
}

pub(crate) fn zwischenablage_lesen() -> anyhow::Result<String> {
    lauf("pbpaste", &[])
}

pub(crate) fn lauf(programm: &str, args: &[&str]) -> anyhow::Result<String> {
    let aus = Command::new(programm).args(args).output()?;
    if !aus.status.success() {
        anyhow::bail!("{programm} scheiterte: {}", String::from_utf8_lossy(&aus.stderr));
    }
    Ok(String::from_utf8_lossy(&aus.stdout).to_string())
}
