//! Mitschnitt roher RTP-Nutzlasten zur Fehlersuche — aus **einem** Grund:
//! Der AV1-Depacketizer war nur gegen den Payloader des `rtp`-Crates geprueft,
//! nie gegen einen echten Sender. Als am 2026-07-26 zwei voneinander
//! unabhaengige Decoder (`av1_cuvid` und `libdav1d`) denselben Strom
//! zurueckwiesen, liess sich das ohne die tatsaechlichen Bytes nicht
//! entscheiden — jede Diagnose allein aus dem Code waere geraten gewesen.
//! Genau daran ist ein frueherer Anlauf schon einmal gescheitert (die
//! zurueckgenommene "OFFENER FEHLER"-Meldung in Commit d24109bd).
//!
//! Nur aktiv, wenn `PULSE_PLAYER_DUMP_RTP` auf einen Pfad zeigt; ohne die
//! Variable kostet es einen `Option`-Test pro Paket.
//!
//! Format, bewusst trivial, damit ein Test es in zehn Zeilen liest:
//! ```text
//! je Paket:  u32 LE Nutzlastlaenge | u8 Marker (0/1) | Nutzlast
//! ```
//! Die Nutzlast ist der RTP-Payload **ohne** Header, also genau das, was
//! `Av1Assembler::push` bekommt.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct RtpDump {
    out: Mutex<BufWriter<File>>,
    path: PathBuf,
}

impl RtpDump {
    /// `None`, wenn die Variable nicht gesetzt ist — der Normalfall.
    /// Ein nicht anlegbarer Pfad ist eine Warnung, kein Sitzungsfehler:
    /// Diagnose darf die Wiedergabe nie verhindern.
    pub fn from_env(suffix: &str) -> Option<Self> {
        let base = std::env::var_os("PULSE_PLAYER_DUMP_RTP")?;
        let mut path = PathBuf::from(base);
        let name = match path.file_name() {
            Some(n) => format!("{}-{suffix}.rtpdump", n.to_string_lossy()),
            None => format!("{suffix}.rtpdump"),
        };
        path.set_file_name(name);
        match File::create(&path) {
            Ok(f) => {
                eprintln!("pulse-player: RTP-Mitschnitt nach {}", path.display());
                Some(Self { out: Mutex::new(BufWriter::new(f)), path })
            }
            Err(e) => {
                eprintln!("pulse-player: RTP-Mitschnitt {} nicht moeglich: {e}", path.display());
                None
            }
        }
    }

    pub fn write(&self, payload: &[u8], marker: bool) {
        let Ok(mut out) = self.out.lock() else { return };
        let len = payload.len() as u32;
        let _ = out.write_all(&len.to_le_bytes());
        let _ = out.write_all(&[u8::from(marker)]);
        let _ = out.write_all(payload);
    }
}

impl Drop for RtpDump {
    fn drop(&mut self) {
        if let Ok(mut out) = self.out.lock() {
            let _ = out.flush();
        }
        eprintln!("pulse-player: RTP-Mitschnitt {} geschlossen", self.path.display());
    }
}

/// Liest ein Dump zurueck. Gegenstueck zu [`RtpDump::write`]; von den Tests
/// des Depacketizers benutzt, um gegen echte Daten zu pruefen.
///
/// **Hier stand bis zum 2026-08-11 `#[cfg(test)]`.** Seit `--robustheit`
/// (`messen::robustheit`) liest auch ein Messpfad im ausgelieferten Programm
/// diese Dateien; unter der Test-Sperre haette es die Funktion dort nicht
/// gegeben. Sie kostet nichts, solange niemand sie ruft.
pub fn read_dump(bytes: &[u8]) -> Vec<(Vec<u8>, bool)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 5 <= bytes.len() {
        let len = u32::from_le_bytes(bytes[i..i + 4].try_into().unwrap()) as usize;
        let marker = bytes[i + 4] != 0;
        i += 5;
        if i + len > bytes.len() {
            break; // abgeschnittenes Dump (Prozess hart beendet) — Rest ignorieren
        }
        out.push((bytes[i..i + len].to_vec(), marker));
        i += len;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dump_laesst_sich_zurueckgelesen() {
        let mut raw = Vec::new();
        for (payload, marker) in [(vec![1u8, 2, 3], false), (vec![9u8], true)] {
            raw.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            raw.push(u8::from(marker));
            raw.extend_from_slice(&payload);
        }
        let back = read_dump(&raw);
        assert_eq!(back, vec![(vec![1, 2, 3], false), (vec![9], true)]);
    }

    /// Ein hart beendeter Prozess hinterlaesst ein halbes Paket — das darf
    /// den Leser nicht umbringen, sonst ist der Mitschnitt genau dann
    /// wertlos, wenn er am interessantesten ist.
    #[test]
    fn abgeschnittenes_dump_liefert_den_gueltigen_teil() {
        let mut raw = Vec::new();
        raw.extend_from_slice(&3u32.to_le_bytes());
        raw.push(1);
        raw.extend_from_slice(&[1, 2, 3]);
        raw.extend_from_slice(&99u32.to_le_bytes());
        raw.push(0);
        raw.extend_from_slice(&[7, 7]); // versprochen 99 Byte, geliefert 2
        assert_eq!(read_dump(&raw), vec![(vec![1, 2, 3], true)]);
    }
}
