//! Probe auf den KMS-Helfer: kommt ein Bild herein, und sagt der Weg auch
//! Nein, wenn er Nein sagen muss?
//!
//! Das Werkzeug zur Messakte `hdr-2026-08-08-kms-helfer-linux.json`. Es faehrt
//! **dieselbe** Gegenstelle wie der ausgelieferte Sidecar
//! (`capture::kms_helfer`), nicht eine zweite daneben — sonst misst es etwas
//! anderes, als der Nutzer bekommt.
//!
//! ```text
//! kms_helfer_probe --liste            Ausgaenge (braucht KEINE Berechtigung)
//! kms_helfer_probe DP-1 30            30 Bilder ueber den Helfer holen
//! kms_helfer_probe DP-1 1 --fassung 99  falsche Protokollfassung senden
//! ```
//!
//! Der HDR-Zustand spielt hier keine Rolle: gemessen wird der Weg, nicht die
//! Farbe. Ein SDR-Ausgang genuegt und ist die ehrlichere Probe — er zeigt, dass
//! nichts am Bildschirmzustand haengt.

use std::time::Instant;

use anyhow::{Result, bail};
use pulse_kms_helfer::protokoll as p;
use pulse_kms_helfer::uebertragung as u;
use pulse_linux_hq_sidecar::capture::kms::KmsKarte;
use pulse_linux_hq_sidecar::capture::kms_helfer::{Helfer, installationsbefehl, socket_pfad, vorhanden};

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|a| a == "--liste") {
        let karte = KmsKarte::erste_mit_ausgaengen()?;
        println!("Helfer eingerichtet: {}", vorhanden());
        println!("Socket:              {}", socket_pfad().display());
        println!("Einrichten mit:      {}", installationsbefehl());
        for a in karte.ausgaenge()? {
            println!(
                "  {:<12} crtc={:<5} HDR={}",
                a.name,
                a.crtc_id,
                if a.ist_hdr() { "ja (PQ)" } else { "nein" }
            );
        }
        return Ok(());
    }

    let Some(ausgang) = args.first().cloned() else {
        bail!("Aufruf: kms_helfer_probe <Ausgang|--liste> [Bilder] [--fassung <n>]");
    };
    let bilder: u32 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(10);

    // Der Sonderfall zuerst: eine absichtlich falsche Fassung senden. Das ist
    // die Probe, die auch Nein sagen kann — ohne sie waere „der Handschlag
    // funktioniert" nur eine Behauptung.
    if let Some(i) = args.iter().position(|a| a == "--fassung") {
        let falsch: u32 = args[i + 1].parse()?;
        return handschlag_pruefen(&ausgang, falsch);
    }

    let start = Instant::now();
    let mut helfer = Helfer::verbinden_oder_starten()?;
    println!("verbunden nach {:.1} ms", start.elapsed().as_secs_f64() * 1000.0);

    let mut erstes = None;
    let lauf = Instant::now();
    for n in 0..bilder {
        let bild = helfer.bild(&ausgang, n as u64, 0)?;
        if erstes.is_none() {
            println!(
                "{}x{} fourcc={} modifier={:#x} Ebenen={}",
                bild.width,
                bild.height,
                String::from_utf8_lossy(&bild.drm_fourcc.to_le_bytes()),
                bild.modifier,
                bild.planes.len()
            );
            for e in &bild.planes {
                // Ein DMABUF hat eine Groesse; ein zufaellig durchgereichter
                // Deskriptor haette sie nicht. Das ist die Gegenprobe darauf,
                // dass hier wirklich ein Puffer ankommt.
                let mut st: libc::stat = unsafe { std::mem::zeroed() };
                let rc = unsafe { libc::fstat(e.fd, &mut st) };
                println!("  Ebene: stride={} offset={} bytes={}", e.stride, e.offset, {
                    if rc == 0 { st.st_size } else { -1 }
                });
            }
            erstes = Some(());
        }
    }
    let s = lauf.elapsed().as_secs_f64();
    println!(
        "{bilder} Bilder in {s:.2} s ({:.0}/s) — alle Deskriptoren wieder geschlossen",
        bilder as f64 / s
    );
    Ok(())
}

/// Mit einer erfundenen Fassung anfragen und sehen, was zurueckkommt.
fn handschlag_pruefen(ausgang: &str, fassung: u32) -> Result<()> {
    // Absichtlich an der Gegenstelle vorbei: sie wuerde immer die richtige
    // Fassung senden. Hier soll ein FALSCHER Client nachgestellt werden.
    let mut helfer = Helfer::verbinden_oder_starten()?;
    let sock = pulse_linux_hq_sidecar::capture::kms_helfer::sock_fd(&mut helfer);
    let mut anfrage = p::Anfrage::bild(ausgang);
    anfrage.fassung = fassung;
    u::senden(sock, &anfrage.kodieren(), &[])?;
    let mut puffer = [0u8; p::ANTWORT_LEN];
    let (n, fds) = u::empfangen(sock, &mut puffer)?;
    let antwort = p::Antwort::dekodieren(&puffer[..n]).map_err(|e| anyhow::anyhow!("{e}"))?;
    println!(
        "gesendete Fassung {fassung} -> Ergebnis {} (erwartet {}), Helfer meldet Fassung {}, {} Deskriptoren",
        antwort.ergebnis,
        p::FEHLER_FASSUNG,
        antwort.fassung,
        fds.len()
    );
    if antwort.ergebnis != p::FEHLER_FASSUNG {
        bail!("der Handschlag hat eine fremde Fassung NICHT abgewiesen");
    }
    if !fds.is_empty() {
        bail!("bei abgewiesener Fassung darf kein Bild mitkommen");
    }
    println!("gut: abgewiesen, und kein Bild dabei");
    Ok(())
}
