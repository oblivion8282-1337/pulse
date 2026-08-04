//! Ein Bild aus der laufenden Kette zurückholen und **ansehen**.
//!
//! **Wozu.** Zwischen „die D3D11-Textur ist richtig beschrieben" und „der
//! Encoder liest sie richtig" liegt der Vulkan-Import, und ein Fehler darin
//! zeigt sich in keiner Kennzahl — nur am Bild. Dieser Abzug holt genau an der
//! Stelle, an der das importierte Bild an `avcodec_send_frame` geht, den Inhalt
//! zurück in den Hauptspeicher und schreibt ihn roh weg. Was danach in der
//! Datei steht, hat den Encoder **nicht** gesehen; damit trennt der Abzug die
//! beiden Verdächtigen sauber.
//!
//! **Warum es das braucht, obwohl es schon eine Probe gab.** Die Probe
//! (`examples/probe_vulkan_encode_import.rs`) prüfte den Rückweg gegen eine
//! Chroma-Ebene, die überall denselben Wert hatte. Gegen ein konstantes Feld
//! ist eine verschobene Ebene aber nicht zu sehen — jeder Versatz liest wieder
//! denselben Wert. Aus „Chroma kommt richtig zurück" wurde deshalb am
//! 2026-08-02 zu Unrecht „der Import ist ausgeschlossen". Hier ist die Quelle
//! ein echtes Bildschirmbild, und da fällt ein Versatz auf.
//!
//! **Nur auf Anforderung** und nur für **ein** Bild: der Rückweg ist eine volle
//! Kopie über den Bus und hätte im Takt nichts zu suchen.
//!
//! ```text
//! $env:PULSE_LABOR_BILDABZUG = "abzug.yuv"      # das erste Bild
//! $env:PULSE_LABOR_BILDABZUG = "abzug.yuv@45"   # das 46. Bild
//! ffmpeg -f rawvideo -pix_fmt p010le -s 1280x720 -i abzug.yuv -y abzug.png
//! ```
//!
//! **Die Nummer ist nicht Zierrat.** Bild 0 ist das Vollbild und stimmt auch
//! dann, wenn alle folgenden es nicht tun — ein Werkzeug, das nur Bild 0 kann,
//! beantwortet die Frage nicht, für die es gebaut wurde. Genau daran hat der
//! 10-Bit-Fehler zwei Tage gehangen.

use ffmpeg_next as ffmpeg;
use ffmpeg::ffi::*;

/// Was der Abzug tun soll, einmal aus der Umgebung gelesen.
pub struct Abzug {
    pfad: String,
    /// Nummer des Bildes, gezählt ab dem ersten, das der Encoder sieht.
    nummer: u64,
    gezaehlt: u64,
    erledigt: bool,
}

impl Abzug {
    /// Aus `PULSE_LABOR_BILDABZUG` lesen — `<pfad>` oder `<pfad>@<nummer>`.
    /// `None`, wenn nichts angefordert ist; dann kostet der Abzug im Takt einen
    /// Vergleich gegen `Option::None`.
    pub fn aus_umgebung() -> Option<Self> {
        let wert = std::env::var("PULSE_LABOR_BILDABZUG").ok()?;
        // Von HINTEN trennen: Windows-Pfade duerfen selbst ein `@` enthalten.
        let (pfad, nummer) = match wert.rsplit_once('@') {
            Some((p, n)) if !p.is_empty() => match n.parse() {
                Ok(n) => (p.to_string(), n),
                // Eine unlesbare Nummer still als Teil des Pfades zu behandeln
                // hiesse, ein anderes Bild abzuziehen als angefordert — und das
                // faellt an einer .yuv-Datei niemandem auf.
                Err(e) => {
                    eprintln!("[bildabzug] '{n}' ist keine Bildnummer ({e}) — kein Abzug");
                    return None;
                }
            },
            _ => (wert, 0),
        };
        eprintln!("[bildabzug] Bild {nummer} wird nach {pfad} abgezogen");
        Some(Self { pfad, nummer, gezaehlt: 0, erledigt: false })
    }

    /// Bei jedem Bild aufrufen, bevor es an den Encoder geht.
    ///
    /// Zählt selbst, statt sich auf den pts zu verlassen: der entsteht aus der
    /// vergangenen Zeit mal der Bildrate und wird gerundet, fängt also nicht
    /// verlässlich bei 0 an. Ein Abzug, der wegen einer halben Bilddauer
    /// Verzögerung gar nicht erst ausgelöst wird, sieht aus wie ein kaputtes
    /// Werkzeug.
    ///
    /// # Safety
    ///
    /// `frame` muss ein gültiger `AVFrame` mit gesetztem `hw_frames_ctx` sein.
    pub unsafe fn vielleicht(&mut self, frame: *const AVFrame) {
        if self.erledigt {
            return;
        }
        let dran = self.gezaehlt == self.nummer;
        self.gezaehlt += 1;
        if !dran {
            return;
        }
        self.erledigt = true;
        // SAFETY: Vertrag dieser Funktion.
        if let Err(e) = unsafe { self.schreibe(frame) } {
            eprintln!("[bildabzug] {e}");
        }
    }

    /// # Safety
    ///
    /// Wie [`Self::vielleicht`].
    unsafe fn schreibe(&self, frame: *const AVFrame) -> anyhow::Result<()> {
        let mut cpu = ffmpeg::frame::Video::empty();
        // Zielformat NICHT vorgeben: `av_hwframe_transfer_data` wählt selbst
        // das passende Software-Format. Es zu raten hiesse, den Abzug an eine
        // Annahme zu binden, die der Bildweg jederzeit ändern kann.
        // SAFETY: Vertrag dieser Funktion; `cpu` ist leer, FFmpeg legt es an.
        let rc = unsafe { av_hwframe_transfer_data(cpu.as_mut_ptr(), frame, 0) };
        if rc < 0 {
            anyhow::bail!("Rueckweg scheiterte (rc={rc})");
        }

        // **Die Ebenen packt FFmpeg selbst.** `av_image_copy_to_buffer` liest
        // Ebenenzahl, Zeilenbreite und Unterabtastung aus dem Pixelformat.
        // Von Hand („zwei Ebenen, Zeile = Breite * 2 Byte") wäre es eine
        // 4:2:0-Annahme, die bei jedem anderen Format ein schräg laufendes Bild
        // ergäbe — also genau die Sorte Fehlerbild, für deren Beurteilung
        // dieses Werkzeug da ist.
        // SAFETY: nach erfolgreichem Transfer sind Format, Masse und Ebenen gesetzt.
        let (format, breite, hoehe, daten, abstaende) = unsafe {
            let c = cpu.as_ptr();
            (
                std::mem::transmute::<i32, AVPixelFormat>((*c).format),
                (*c).width,
                (*c).height,
                (*c).data.as_ptr() as *const *const u8,
                (*c).linesize.as_ptr(),
            )
        };
        // Ausrichtung 1 = ohne Polsterung, also genau das, was `-f rawvideo`
        // erwartet.
        let groesse = unsafe { av_image_get_buffer_size(format, breite, hoehe, 1) };
        if groesse <= 0 {
            anyhow::bail!("av_image_get_buffer_size lieferte {groesse}");
        }
        let mut roh = vec![0u8; groesse as usize];
        // SAFETY: `roh` ist genau `groesse` gross, die Zeiger stammen aus `cpu`.
        let rc = unsafe {
            av_image_copy_to_buffer(
                roh.as_mut_ptr(),
                groesse,
                daten,
                abstaende,
                format,
                breite,
                hoehe,
                1,
            )
        };
        if rc < 0 {
            anyhow::bail!("av_image_copy_to_buffer rc={rc}");
        }
        std::fs::write(&self.pfad, &roh)?;

        // Den Formatnamen von FFmpeg holen, nicht aus der Bittiefe zurueck-
        // rechnen: die Zeile ist die Vorlage fuer den ffmpeg-Aufruf, und ein
        // falscher `-pix_fmt` erzeugt genau das Fehlerbild, das man sucht.
        // SAFETY: `av_get_pix_fmt_name` liefert einen statischen C-String oder NULL.
        let name = unsafe {
            let p = av_get_pix_fmt_name(format);
            if p.is_null() {
                "?".to_string()
            } else {
                std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned()
            }
        };
        eprintln!(
            "[bildabzug] Bild {} geschrieben: ffmpeg -f rawvideo -pix_fmt {name} \
             -s {breite}x{hoehe} -i {}",
            self.nummer, self.pfad
        );
        Ok(())
    }
}
