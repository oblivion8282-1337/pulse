//! Verlustfreier Mitschnitt dessen, was in den Encoder GEHT.
//!
//! Zweck: eine Referenz für die Bildqualität. Ohne sie ist nur „Variante A gegen
//! Variante B" messbar, nicht „gegen das Original" — und damit keine Aussage
//! darüber, was eine Einstellung überhaupt kostet.
//!
//! Nur mit `PULSE_DUMP_RAW=<pfad>` aktiv; im Normalbetrieb existiert das Ding
//! nicht. Es ist ausdrücklich ein MESSWERKZEUG, kein Feature: der Mitschnitt ist
//! unkomprimiert, bei 2560x1440 und 60 fps sind das gut 660 MB je Sekunde.
//! Deshalb gibt es eine Bildgrenze (`PULSE_DUMP_RAW_FRAMES`, Standard 180) und
//! deshalb gehört der Pfad auf eine SSD, nicht in ein tmpfs wie `/tmp` (das
//! wäre Arbeitsspeicher).
//!
//! Zwei Dinge sind nicht offensichtlich:
//!
//! * **Der Mitschnitt läuft NACH der Farbumrechnung**, greift also genau den
//!   Encoder-Eingang ab (P010 bei 10 bit). Das ist die richtige Referenz, um den
//!   ENCODER zu bewerten: alles davor (Aufnahme, Shader) steckt in beiden Seiten
//!   des Vergleichs gleichermaßen und fällt heraus.
//! * **Zu jedem Bild wird sein pts mitgeschrieben** (`<pfad>.pts`). Der
//!   Vergleich muss die Bilder einander zuordnen können, und die Empfangsseite
//!   hat ihre eigene Zeitleiste. Ohne diese Liste bliebe nur Raten.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;

use anyhow::{Context, Result, anyhow};
use ffmpeg_next as ffmpeg;
use ffmpeg::ffi::*;

/// Standard-Bildgrenze. 180 Bilder sind 3 s bei 60 fps und rund 2 GB — genug
/// für eine Qualitätsmessung, klein genug, dass es niemandem die Platte füllt.
const DEFAULT_FRAMES: u64 = 180;

pub struct RawDump {
    data: BufWriter<File>,
    pts_list: BufWriter<File>,
    /// Ziel der Rückübertragung aus dem Grafikspeicher. Wird einmal angelegt und
    /// wiederverwendet — pro Bild neu zu allozieren wäre bei 11 MB je Bild eine
    /// eigene Bremse.
    ///
    /// **Setzt voraus, dass Größe und Format über den Lauf gleich bleiben.** Das
    /// gilt heute: `out_w`/`out_h`, Encoder und Frame-Kontext entstehen einmal
    /// vor der Encode-Schleife. Käme je ein Auflösungswechsel mitten im Stream
    /// hinzu, muss diese Struktur neu angelegt werden — sonst schreibt sie mit
    /// der alten Größe weiter.
    sw: *mut AVFrame,
    width: u32,
    height: u32,
    remaining: u64,
    written: u64,
    path: PathBuf,
}

impl RawDump {
    /// `None`, wenn `PULSE_DUMP_RAW` nicht gesetzt ist. Fehler nur, wenn der
    /// Mitschnitt gewollt war und nicht aufgesetzt werden konnte — still
    /// weiterzulaufen wäre hier falsch, weil die Messung sonst ins Leere greift.
    pub fn from_env(width: u32, height: u32, fps: u32) -> Result<Option<Self>> {
        let Some(path) = std::env::var_os("PULSE_DUMP_RAW") else {
            return Ok(None);
        };
        let path = PathBuf::from(path);
        let frames = std::env::var("PULSE_DUMP_RAW_FRAMES")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(DEFAULT_FRAMES);
        let data = BufWriter::with_capacity(
            8 << 20,
            File::create(&path).with_context(|| format!("Mitschnitt anlegen: {}", path.display()))?,
        );
        let pts_path = path.with_extension("pts");
        let pts_list = BufWriter::new(
            File::create(&pts_path)
                .with_context(|| format!("pts-Liste anlegen: {}", pts_path.display()))?,
        );
        // SAFETY: `av_frame_alloc` gibt entweder einen gültigen Zeiger oder null.
        let sw = unsafe { av_frame_alloc() };
        if sw.is_null() {
            return Err(anyhow!("av_frame_alloc für den Mitschnitt"));
        }
        tracing::info!(
            target: "stream",
            pfad = %path.display(), bilder = frames, breite = width, hoehe = height, fps,
            "Rohmitschnitt aktiv (Encoder-Eingang, unkomprimiert)"
        );
        Ok(Some(Self {
            data,
            pts_list,
            sw,
            width,
            height,
            remaining: frames,
            written: 0,
            path,
        }))
    }

    /// Ein Bild mitschreiben. Nach Erreichen der Grenze eine reine Rückkehr —
    /// der Stream läuft weiter, nur der Mitschnitt endet.
    ///
    /// # Safety
    ///
    /// `hw` muss ein gültiger HW-Frame sein (derselbe, der an den Encoder geht).
    pub unsafe fn note(&mut self, hw: *mut AVFrame, pts: i64) -> Result<()> {
        if self.remaining == 0 {
            return Ok(());
        }
        unsafe {
            // Format NUR beim ersten Bild offen lassen, damit ffmpeg das zum
            // HW-Format passende Software-Format selbst wählt (P010LE bei
            // 10 bit, NV12 bei 8) — es zu erraten wäre der sichere Weg in einen
            // Formatfehler, sobald der Aufnahmepfad sich ändert.
            //
            // Ab dem zweiten Bild trägt der Rahmen schon Speicher, und dann ist
            // ein Zurücksetzen auf "unbestimmt" schädlich: die Beschreibung
            // passt nicht mehr zum Inhalt. Gemessen am 2026-07-27 kam dabei ein
            // Bild heraus, das wie `yuv420p` aussah (4.608.000 Bytes statt
            // 11.059.200) und die dritte Ebene fehlte — die Abbruchmeldung
            // "Ebene 2 fehlt" war die Folge, nicht die Ursache.
            if (*self.sw).data[0].is_null() {
                (*self.sw).format = AVPixelFormat::AV_PIX_FMT_NONE as i32;
            }
            let rc = av_hwframe_transfer_data(self.sw, hw, 0);
            if rc < 0 {
                self.remaining = 0;
                return Err(anyhow!("av_hwframe_transfer_data für den Mitschnitt (rc={rc})"));
            }
            let fmt = std::mem::transmute::<i32, AVPixelFormat>((*self.sw).format);
            if self.written == 0 {
                // Erst jetzt bekannt: das Format gehört in die pts-Datei, damit
                // der Vergleich weiß, wie die Rohbytes zu lesen sind.
                let name = pix_fmt_name(fmt);
                writeln!(self.pts_list, "# pix_fmt={name} size={}x{}", self.width, self.height)?;
                tracing::info!(target: "stream", format = %name, "Rohmitschnitt: Format bestimmt");
            }
            // Zeilenweise schreiben, ohne die Auffüllung am Zeilenende: `linesize`
            // ist in der Regel größer als die Bildbreite, und die Fülldaten
            // würden das Bild beim Zurücklesen verschieben.
            for plane in 0..plane_count(fmt) {
                let rows = plane_rows(fmt, self.height, plane);
                let bytes = plane_row_bytes(fmt, self.width, plane);
                let src = (*self.sw).data[plane];
                let stride = (*self.sw).linesize[plane] as usize;
                if src.is_null() {
                    self.remaining = 0;
                    return Err(anyhow!("Ebene {plane} des Mitschnitts fehlt"));
                }
                for y in 0..rows {
                    let row = std::slice::from_raw_parts(src.add(y * stride), bytes);
                    self.data.write_all(row)?;
                }
            }
        }
        // Neben dem pts die WANDUHR beim Einschieben. Damit wird die Kette
        // teilbar: im mitgeschriebenen Bild steht (beim Latenz-Versuch) die
        // Uhrzeit, zu der es GEMALT wurde, hier steht die Uhrzeit, zu der es beim
        // Encoder ankam. Die Differenz ist der Anteil von Aufnahme und
        // Farbumrechnung — der einzige Posten der Kette, der sonst nur aus dem
        // Vergleich zweier Bildraten erschlossen war.
        let wall_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        writeln!(self.pts_list, "{pts} {wall_ms}")?;
        self.written += 1;
        self.remaining -= 1;
        if self.remaining == 0 {
            self.data.flush()?;
            self.pts_list.flush()?;
            tracing::info!(
                target: "stream", bilder = self.written, pfad = %self.path.display(),
                "Rohmitschnitt vollständig"
            );
        }
        Ok(())
    }
}

impl Drop for RawDump {
    fn drop(&mut self) {
        let _ = self.data.flush();
        let _ = self.pts_list.flush();
        // SAFETY: `sw` kommt aus `av_frame_alloc` und wird hier genau einmal
        // freigegeben.
        unsafe { av_frame_free(&mut self.sw) };
    }
}

fn pix_fmt_name(fmt: AVPixelFormat) -> &'static str {
    match fmt {
        AVPixelFormat::AV_PIX_FMT_P010LE => "p010le",
        AVPixelFormat::AV_PIX_FMT_NV12 => "nv12",
        AVPixelFormat::AV_PIX_FMT_YUV420P => "yuv420p",
        AVPixelFormat::AV_PIX_FMT_YUV420P10LE => "yuv420p10le",
        _ => "unbekannt",
    }
}

/// Anzahl der Ebenen — halbplanare Formate haben zwei, planare drei.
fn plane_count(fmt: AVPixelFormat) -> usize {
    match fmt {
        AVPixelFormat::AV_PIX_FMT_P010LE | AVPixelFormat::AV_PIX_FMT_NV12 => 2,
        _ => 3,
    }
}

/// Zeilen einer Ebene. Die Farbebenen sind in der Höhe halbiert (4:2:0).
fn plane_rows(fmt: AVPixelFormat, height: u32, plane: usize) -> usize {
    let h = height as usize;
    match (fmt, plane) {
        (_, 0) => h,
        _ => h / 2,
    }
}

/// Nutzbare Bytes je Zeile einer Ebene, ohne die Auffüllung.
///
/// Bei den halbplanaren Formaten trägt die zweite Ebene BEIDE Farbkanäle
/// verschränkt und ist deshalb genauso breit wie die Helligkeit — ein häufiger
/// Rechenfehler an dieser Stelle.
fn plane_row_bytes(fmt: AVPixelFormat, width: u32, plane: usize) -> usize {
    let w = width as usize;
    let bytes_per_sample = match fmt {
        AVPixelFormat::AV_PIX_FMT_P010LE | AVPixelFormat::AV_PIX_FMT_YUV420P10LE => 2,
        _ => 1,
    };
    if plane_count(fmt) == 2 || plane == 0 {
        w * bytes_per_sample
    } else {
        (w / 2) * bytes_per_sample
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn halbplanare_farbebene_ist_so_breit_wie_die_helligkeit() {
        // Der Rechenfehler, den dieser Test verhindert: die UV-Ebene von P010
        // traegt zwei Kanaele verschraenkt. Haelfte der Breite mal zwei Kanaele
        // mal zwei Bytes = wieder die volle Zeilenbreite. Wer hier halbiert,
        // schreibt ein zerrissenes Bild.
        let f = AVPixelFormat::AV_PIX_FMT_P010LE;
        assert_eq!(plane_row_bytes(f, 2560, 0), 5120);
        assert_eq!(plane_row_bytes(f, 2560, 1), 5120);
        assert_eq!(plane_rows(f, 1440, 0), 1440);
        assert_eq!(plane_rows(f, 1440, 1), 720);
        assert_eq!(plane_count(f), 2);
    }

    #[test]
    fn planares_format_halbiert_die_farbebenen() {
        let f = AVPixelFormat::AV_PIX_FMT_YUV420P;
        assert_eq!(plane_count(f), 3);
        assert_eq!(plane_row_bytes(f, 2560, 0), 2560);
        assert_eq!(plane_row_bytes(f, 2560, 1), 1280);
        assert_eq!(plane_row_bytes(f, 2560, 2), 1280);
    }

    #[test]
    fn zehn_bit_kostet_zwei_bytes_je_wert() {
        assert_eq!(plane_row_bytes(AVPixelFormat::AV_PIX_FMT_NV12, 100, 0), 100);
        assert_eq!(plane_row_bytes(AVPixelFormat::AV_PIX_FMT_P010LE, 100, 0), 200);
    }

    /// Ohne gesetzte Umgebungsvariable darf gar nichts entstehen — der
    /// Mitschnitt ist ein Messwerkzeug und kein Nebeneffekt des Normalbetriebs.
    #[test]
    fn ohne_umgebungsvariable_kein_mitschnitt() {
        // SAFETY: Test laeuft einzeln; die Variable wird nur hier geleert.
        unsafe { std::env::remove_var("PULSE_DUMP_RAW") };
        assert!(RawDump::from_env(1920, 1080, 60).unwrap().is_none());
    }
}
