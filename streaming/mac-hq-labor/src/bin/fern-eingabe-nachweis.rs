//! Abnahme der Eingabe-Injektion auf macOS: echte Frames durch den echten
//! Sidecar, aufgefangen vom Eingabe-Pruefziel.
//!
//! Gegenstueck zu `streaming/win-hq-labor/testbench/fern-eingabe-nachweis.ps1`.
//!
//! ## Was hier geprueft wird — und was nicht
//!
//! Geprueft wird die **Host-Haelfte** der Fernsteuerung: kommt ein Frame, das
//! der Spezifikation entspricht, als die richtige Eingabe am richtigen Punkt
//! an? Nicht geprueft wird die Strecke darueber (Player, Electron,
//! chat-gateway) und nicht die zweite Maschine.
//!
//! **Warum das ohne zweiten Rechner geht:** der Steuernde erzeugt Frames, der
//! Host spielt sie ein. Wer die Frames erzeugt, ist dem Host gleichgueltig —
//! deshalb darf sie hier der Pruefstand erzeugen.
//!
//! ## Aufruf
//!
//! ```text
//! fern-eingabe-nachweis [--sidecar PFAD] [--pruefziel PFAD] [--sekunden N] [--log PFAD]
//! ```
//!
//! **Nur der Hauptbildschirm.** Der Sidecar nimmt ohne Strom `CGMainDisplayID`
//! als Quelle (`PULSE_LABOR_EINGABE_MONITOR` koennte das umbiegen), das
//! Pruefziel-Fenster geht aber immer auf den Hauptbildschirm. Beide auf
//! verschiedene Schirme zu stellen ergaebe Zahlen, die nichts messen — der Lauf
//! prueft deshalb ausdruecklich, dass Fenster und Quelle dasselbe Rechteck
//! haben, und bricht sonst als **ungueltig** ab.

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use pulse_fernsteuerung::base64::kodiere;
use pulse_fernsteuerung::bauen::{self, Rahmen};
use pulse_mac_hq_labor::{treiber, ziele};

const SITZUNG: &str = "nachweis";
/// Abstand zwischen zwei `remote_input`-Nachrichten. Gross genug, dass jede
/// Bewegung einzeln am Fenster ankommt (macOS fasst dicht aufeinanderfolgende
/// zusammen) und der Klickzaehler die beiden Klicks noch als Paar sieht.
const ABSTAND: Duration = Duration::from_millis(140);

struct Argumente {
    sidecar: String,
    pruefziel: String,
    sekunden: u64,
    log: String,
}

fn main() {
    let a = argumente();
    let (ursprung, breite, hoehe) = hauptschirm();
    let meine_ziele = ziele::ziele_fuer(ursprung, breite, hoehe);
    eprintln!("Quell-Bildschirm: {breite}x{hoehe} ab {},{}", ursprung.0, ursprung.1);

    let _ = std::fs::remove_file(&a.log);
    let mut kind = match pruefziel_starten(&a, &meine_ziele) {
        Ok(k) => k,
        Err(e) => beenden(2, &format!("Pruefziel nicht gestartet: {e}")),
    };

    let bereit = match auf_bereit_warten(&a.log, Duration::from_secs(20)) {
        Ok(z) => z,
        Err(e) => {
            let _ = kind.kill();
            beenden(2, &format!("Pruefziel meldet sich nicht: {e}"));
        }
    };
    if let Err(e) = geometrie_pruefen(&bereit, &meine_ziele) {
        let _ = kind.kill();
        beenden(2, &e);
    }

    let nachrichten = treiber::nachrichten(
        &meine_ziele,
        ursprung,
        breite,
        hoehe,
        (ursprung.0 + (breite / 2.0).floor(), ursprung.1 + (hoehe / 2.0).floor()),
        treiber_tasten(),
    );
    let sidecar_sagt = match sidecar_fahren(&a.sidecar, &nachrichten) {
        Ok(t) => t,
        Err(e) => {
            let _ = kind.kill();
            beenden(2, &format!("Sidecar: {e}"));
        }
    };

    let ausgang = kind.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
    eprintln!("\n=== Sidecar-Antworten ===");
    for zeile in sidecar_sagt.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev() {
        eprintln!("  {zeile}");
    }
    bericht(&a.log);
    std::process::exit(ausgang);
}

/// Die Tastenfolge des Nachweises. Dieselbe wie in der Selbstprobe — damit ein
/// Fehlschlag hier gegen einen gruenen Selbstproben-Lauf gehalten werden kann
/// und die Frage „Messmittel oder Sidecar?" eine Antwort hat.
fn treiber_tasten() -> &'static [u16] {
    pulse_mac_hq_labor::eigenfahrt::TASTENFOLGE
}

fn argumente() -> Argumente {
    let hier = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut a = Argumente {
        sidecar: hier
            .join("../mac-hq-sidecar/target/release/pulse-mac-hq-sidecar")
            .to_string_lossy()
            .into_owned(),
        pruefziel: hier.join("target/release/eingabe-pruefziel").to_string_lossy().into_owned(),
        // Der Lauf dauert so lange wie diese Frist: das Pruefziel schreibt
        // seine Zusammenfassung erst, wenn es sich selbst abschaltet, und ein
        // Abschiessen von aussen wuerde sie verschlucken. Gefahren wird in
        // rund sechs Sekunden (Anlauf 1,2 s, dann rund 20 Nachrichten zu
        // 140 ms) — der Rest ist Luft.
        sekunden: 15,
        log: std::env::temp_dir().join("pulse-fern-nachweis.jsonl").to_string_lossy().into_owned(),
    };
    let mut it = std::env::args().skip(1);
    while let Some(x) = it.next() {
        match x.as_str() {
            "--sidecar" => a.sidecar = it.next().unwrap_or_default(),
            "--pruefziel" => a.pruefziel = it.next().unwrap_or_default(),
            "--sekunden" => a.sekunden = it.next().and_then(|v| v.parse().ok()).unwrap_or(15),
            "--log" => a.log = it.next().unwrap_or_default(),
            andere => beenden(64, &format!("unbekanntes Argument: {andere}")),
        }
    }
    a
}

fn hauptschirm() -> ((f64, f64), f64, f64) {
    let r = objc2_core_graphics::CGDisplayBounds(objc2_core_graphics::CGMainDisplayID());
    ((r.origin.x, r.origin.y), r.size.width, r.size.height)
}

fn pruefziel_starten(a: &Argumente, ziele: &[(f64, f64)]) -> std::io::Result<Child> {
    let scans: Vec<String> = treiber_tasten().iter().map(|s| format!("{s:#06x}")).collect();
    let _ = ziele;
    Command::new(&a.pruefziel)
        .args(["--sekunden", &a.sekunden.to_string()])
        .args(["--datei", &a.log])
        .args(["--soll-klicks", "4"])
        .args(["--soll-klickstaende", "1,1,2,2"])
        .args(["--soll-raeder", "1"])
        .args(["--soll-scancodes", &scans.join(",")])
        .stdout(Stdio::null())
        .spawn()
}

/// Wartet auf die `bereit`-Zeile des Pruefziels. Sie steht erst, wenn das
/// Fenster wirklich oben ist — vorher zu injizieren hiesse, in den Uebergang
/// hinein zu messen.
fn auf_bereit_warten(log: &str, frist: Duration) -> Result<serde_json::Value, String> {
    let bis = Instant::now() + frist;
    while Instant::now() < bis {
        if let Ok(inhalt) = std::fs::read_to_string(log) {
            for zeile in inhalt.lines() {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(zeile) else { continue };
                match v.get("art").and_then(|a| a.as_str()) {
                    Some("bereit") => return Ok(v),
                    // Das Pruefziel kann sich schon vor der Messung abmelden.
                    Some("ende") => return Err(format!("es endete vorher: {v}")),
                    _ => {}
                }
            }
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    Err("keine bereit-Zeile innerhalb der Frist".into())
}

/// **Die Pruefung, ohne die der ganze Lauf nichts misst:** faengt das Fenster
/// genau den Bereich auf, den der Sidecar als Quelle nimmt? Weichen sie ab,
/// zielen beide Seiten auf verschiedene Rechtecke, und jede Abweichung waere
/// eine Eigenschaft des Aufbaus statt des Injektors.
fn geometrie_pruefen(bereit: &serde_json::Value, meine: &[(f64, f64)]) -> Result<(), String> {
    let seine: Vec<(f64, f64)> = bereit
        .get("ziele")
        .and_then(|z| z.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|p| {
                    let p = p.as_array()?;
                    Some((p.first()?.as_f64()?, p.get(1)?.as_f64()?))
                })
                .collect()
        })
        .unwrap_or_default();
    if seine == meine {
        return Ok(());
    }
    Err(format!(
        "Pruefziel und Treiber zielen auf verschiedene Rechtecke.\n  Pruefziel: {seine:?}\n  \
         Treiber:   {meine:?}\nDas Fenster deckt nicht die Quelle des Sidecars ab — jede Zahl \
         waere erfunden."
    ))
}

fn sidecar_fahren(pfad: &str, nachrichten: &[Vec<Rahmen>]) -> Result<String, String> {
    let mut kind = Command::new(pfad)
        // Ohne laufenden Strom gibt es kein Quell-Rechteck. Der Labor-Schalter
        // nimmt dann den Hauptbildschirm — nur damit sich die Injektion ohne
        // echten Bildschirm-Push pruefen laesst. Kein Produktweg.
        .env("PULSE_LABOR_EINGABE_OHNE_STREAM", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{pfad}: {e} (gebaut? cargo build --release)"))?;

    {
        // **stdin MUSS offen bleiben, solange gefahren wird.** Kaeme die Anfrage
        // aus einer Datei, saehe der Sidecar nach der letzten Zeile EOF und
        // fuehre korrekt herunter — mitten im Lauf. Von aussen sieht das wie ein
        // Fehler aus (testbench/README.md, Fallen im Messaufbau).
        let mut ein = kind.stdin.take().ok_or("keine stdin")?;
        let mut id = 0u64;
        let mut schicken = |wert: serde_json::Value| -> Result<(), String> {
            id += 1;
            let mut w = wert;
            w["id"] = id.into();
            writeln!(ein, "{w}").map_err(|e| e.to_string())?;
            ein.flush().map_err(|e| e.to_string())?;
            std::thread::sleep(ABSTAND);
            Ok(())
        };
        // **Der Handschlag zuerst.** Ohne ihn gibt es keine Sitzung, und jede
        // folgende Nachricht endet in `unknown_slot` — der Labor-Schalter
        // wirkt erst danach.
        schicken(nachricht(&[bauen::hello()]))?;
        for n in nachrichten {
            schicken(nachricht(n))?;
        }
        schicken(serde_json::json!({ "op": "remote_input_end" }))?;
    }

    let mut aus = String::new();
    if let Some(mut o) = kind.stdout.take() {
        let _ = o.read_to_string(&mut aus);
    }
    // stderr am Ende in einem Stueck lesen — zeilenweise mitlesen hat in diesem
    // Repo schon einmal ausgerechnet die aussagekraeftigen Zeilen verschluckt.
    if let Some(mut e) = kind.stderr.take() {
        let mut fehler = String::new();
        let _ = e.read_to_string(&mut fehler);
        for zeile in fehler.lines().filter(|z| !z.trim().is_empty()).rev().take(6) {
            eprintln!("  [sidecar] {zeile}");
        }
    }
    let _ = kind.wait();
    Ok(aus)
}

fn nachricht(rahmen: &[Rahmen]) -> serde_json::Value {
    serde_json::json!({
        "op": "remote_input",
        "slot": 0,
        "session_id": SITZUNG,
        "frames": rahmen.iter().map(|r| kodiere(r.as_slice())).collect::<Vec<_>>(),
    })
}

fn bericht(log: &str) {
    let Ok(datei) = std::fs::File::open(log) else {
        eprintln!("kein Protokoll unter {log}");
        return;
    };
    let letzte = BufReader::new(datei)
        .lines()
        .map_while(Result::ok)
        .filter_map(|z| serde_json::from_str::<serde_json::Value>(&z).ok())
        .filter(|v| v.get("art").and_then(|a| a.as_str()) == Some("zusammenfassung"))
        .last();
    match letzte {
        None => eprintln!("keine Zusammenfassung im Protokoll — Lauf abgebrochen?"),
        Some(z) => {
            eprintln!("\n=== Zusammenfassung ===");
            eprintln!("  Urteil                  : {}", z["urteil"]);
            eprintln!("  Groesste Abweichung     : {} Punkte", z["groesste_abweichung_punkte"]);
            eprintln!("  Ziele ohne Ereignis     : {}", z["ziele_ohne_ereignis"]);
            eprintln!("  Klickstaende            : {}", z["klicks"]);
            eprintln!("  Rad                     : {}", z["raeder"]);
            eprintln!("  Scancodes empfangen     : {}", z["scancodes_empfangen"]);
            eprintln!("  Grund                   : {}", z["grund"]);
            eprintln!("\n  Rohwerte: {log}");
        }
    }
}

fn beenden(code: i32, was: &str) -> ! {
    eprintln!("{was}");
    std::process::exit(code)
}
