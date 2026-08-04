//! **Der Encoder, um den es im Labor geht:** `av1_vulkan` mit Intra-Refresh.
//!
//! Das ist die Stelle, an der die ganze Kette zusammenkommt. Warum sie so
//! aussieht, in einem Satz je Glied:
//!
//! * **Intra-Refresh statt periodischer Vollbilder** ist das Ziel des Labors —
//!   die Auffrischung über viele Bilder verteilt statt in Stößen.
//! * **Nur der Vulkan-Encoder kann es hier.** AMF ignoriert die Einstellung
//!   byte-identisch (gemessen 2026-08-01), D3D12 liefert nichts Brauchbares.
//! * **Nur ein gepatchtes FFmpeg bietet die Option an**
//!   (`VK_KHR_video_encode_intra_refresh`) — das ausgelieferte kennt
//!   `-intra_refresh` nicht. Deshalb linkt das Labor gegen `ffmpeg-patched/`.
//!   Ein zweiter Patch kommt dazu, ohne den `h264_vulkan` mit **keiner**
//!   Ziel-Bitrate öffnet; beide samt Herleitung in `ffmpeg-patches/`.
//! * **Das Bild muss ohne CPU-Umweg nach Vulkan.** Die Aufnahme liefert eine
//!   D3D11-Textur; FFmpeg hat dafür keine Brücke, also [`crate::vkimport`].
//! * **Und es braucht einen Rückkanal**, weil ein Intra-Refresh-Strom nach dem
//!   Start kein Vollbild mehr hat: ohne Anforderung käme ein neu einsteigender
//!   Zuschauer nie ins Bild (und nach Verlust heilt er nicht von selbst,
//!   `decoder-2026-07-29-intra-refresh.json`). Deshalb der eigene WHIP-Weg.
//!
//! Die Pipeline (Aufnahme, Skalierung, Taktung, A/V-Verankerung) bleibt die
//! des Sidecars — hier hängt sich nur der Encoder ein
//! (`encode::bildencoder`).
//!
//! **Der Ton kommt unverändert aus der Bibliothek** (`encode::audio`). Er war
//! bis 2026-08-02 nicht angeschlossen, weil dem gepatchten FFmpeg-Bau
//! `libopus` fehlte; seit dem Neubau ist es dabei. Nachgebaut wird hier
//! nichts — `AudioPipeline` kennt den Muxer ohnehin nur optional, weil der
//! Regelweg sie schon für den WHIP-Sendeweg ohne Container benutzt.

use std::time::Instant;

use anyhow::{Context, Result, anyhow, bail};
use ffmpeg_next as ffmpeg;
use ffmpeg::ffi::*;
use pulse_win_hq_sidecar::audio::CapturedAudio;
use pulse_win_hq_sidecar::encode::audio::AudioPipeline;
use pulse_win_hq_sidecar::encode::latency::EncodeLatency;
use pulse_win_hq_sidecar::encode::senke_writer::SenkenWriter;
use pulse_win_hq_sidecar::encode::{
    BildEncoder, EncoderAuftrag, EncoderBauer, OwnedHwFrame, registriere_encoder_bauer,
};
use pulse_win_hq_sidecar::keyframe::Anforderungen;
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows::core::Interface;

use crate::vkimport::{AVVkFrame, VK_FORMAT_NV12, VK_FORMAT_P010, Videocodec, VulkanImport};

/// Wie viele Bilder ein voller Auffrischungs-Zyklus dauern soll.
///
/// Der Treiber deckelt das selbst und sagt es auch — auf einer Radeon 780M
/// liegt die Grenze bei **32 Bildern** ("exceeds the driver maximum of 32
/// frames, clamping"). Wir fragen nach `fps`, also einer Sekunde, und lassen
/// uns herunterregeln: so ist der Wert auf einer Karte mit größerem Spielraum
/// nicht künstlich klein.
fn refresh_periode(fps: u32) -> u32 {
    fps.max(1)
}

/// Abstand regulärer Vollbilder. Bewusst **sehr groß**: mit Intra-Refresh soll
/// es keine geben. Nicht 0 — dann setzte FFmpeg seinen eigenen Vorgabewert.
const GOP_OHNE_VOLLBILDER: u32 = 6000;

/// Beim Programmstart aufrufen.
pub fn anmelden() {
    registriere_encoder_bauer(EncoderBauer {
        // Der Import geht über ein geteiltes NT-Handle — ohne das lehnt
        // `CreateSharedHandle` ab.
        geteilte_texturen: true,
        // Das Format, das der Video-Encoder als Quelle nimmt. Der
        // Video-Prozessor wandelt BGRA dorthin beim Skalieren mit, kostet also
        // keine eigene Fahrt über die GPU. P010 für 10 bit, NV12 sonst — die
        // beiden Vulkan-Formate dazu stehen in `vkimport`.
        //
        // **Bleibt bei P010, obwohl 10 bit hier kaputt ist.** Hier NV12 zu
        // antworten wäre der bequeme Weg: die Pipeline liest die Bittiefe aus
        // dem Pool zurück, meldete den Rückfall und liefe in 8 bit weiter. Für
        // ein Labor ist genau das falsch — die Begründung steht bei
        // [`crate::grenzen::zehn_bit_pruefen`], das den Lauf stattdessen
        // abbricht. Wer hier etwas ändert, muss dort mitlesen.
        pool_format: |ten_bit| {
            if ten_bit {
                AVPixelFormat::AV_PIX_FMT_P010LE
            } else {
                AVPixelFormat::AV_PIX_FMT_NV12
            }
        },
        baue: |a| Ok(Box::new(VulkanEncoder::neu(a)?)),
    });
}

pub struct VulkanEncoder {
    vk: VulkanImport,
    encoder: ffmpeg::codec::encoder::Video,
    ausgabe: SenkenWriter,
    /// `None`, wenn der Aufruf ohne Tonspur kam.
    ton: Option<AudioPipeline>,
    /// Vollbilder auf Anforderung — dieselbe Buchführung wie im Regelweg, damit
    /// „empfangen" und „eingelöst" auf beiden Wegen vergleichbar bleiben.
    vollbilder_angefordert: Anforderungen,
    /// Bildmaße. Als Feld statt `encoder.width()` je Bild: das sind zwei
    /// FFI-Zugriffe im Takt für zwei Zahlen, die seit `neu()` feststehen.
    breite: u32,
    hoehe: u32,
    last_send_us: u64,
    last_mux_us: u64,
    /// **Dieselbe Rechnung wie im Regelweg**, nicht eine eigene: `EncodeLatency`
    /// paart Einschieben und Paket über den pts. Selbst gezählte
    /// `elapsed()`-Werte um `avcodec_send_frame` wären etwas anderes (nur die
    /// Übergabe, nicht die Encoder-Warteschlange) — und dieselbe
    /// Trait-Methode lieferte dann je nach Weg zwei verschiedene Größen. Eine
    /// Vulkan-Messung wäre gegen eine AMF-Messung nicht mehr haltbar.
    lat: EncodeLatency,
    /// Diagnose-Abzug eines einzelnen Bildes, `None` im Regelbetrieb
    /// (s. [`crate::bildabzug`]).
    abzug: Option<crate::bildabzug::Abzug>,
}

impl VulkanEncoder {
    fn neu(a: &EncoderAuftrag) -> Result<Self> {
        ffmpeg::init().context("ffmpeg::init")?;
        crate::grenzen::zehn_bit_pruefen(a.cfg.ten_bit)?;

        // Das Vulkan-Format muss zum DXGI-Format des Pools passen — und den hat
        // die Pipeline nach `pool_format` (oben) angelegt. Beide Seiten aus
        // derselben Angabe abzuleiten ist der Punkt: eine zweite Fallunter-
        // scheidung wäre die Stelle, an der 10 bit still auf einen 8-bit-Import
        // träfe.
        let vk_format = if a.cfg.ten_bit { VK_FORMAT_P010 } else { VK_FORMAT_NV12 };
        // Der Codec geht mit in den Import: er steht im Video-Profil, mit dem
        // die Bilder erzeugt werden (s. `vkimport::profil`).
        let vk_codec = match a.cfg.codec.slug() {
            "av1" => Videocodec::Av1,
            _ => Videocodec::H264,
        };
        // SAFETY: `lock_ptr` kommt aus dem Vertrag von `EncoderAuftrag` — er
        // zeigt auf die Section des Pools und lebt länger als der Encoder.
        let vk = unsafe {
            VulkanImport::new(
                a.d3d_device,
                a.d3d_context,
                a.lock_ptr,
                a.cfg.dst_w,
                a.cfg.dst_h,
                vk_format,
                vk_codec,
            )
        }
        .context("Vulkan-Import aufbauen")?;

        // Die Absage für alles andere ist der Punkt dieser Fallunterscheidung:
        // ein zusammengesetztes `{slug}_vulkan` würde einen unbekannten Codec
        // erst beim Öffnen bemerken, und die Meldung wäre dann eine andere.
        let name = match a.cfg.codec.slug() {
            "av1" => "av1_vulkan",
            "h264" => "h264_vulkan",
            other => bail!("kein Vulkan-Encoder fuer {other}"),
        };
        let desc = ffmpeg::codec::encoder::find_by_name(name)
            .ok_or_else(|| anyhow!("'{name}' fehlt im gelinkten FFmpeg"))?;
        let mut enc = ffmpeg::codec::context::Context::new_with_codec(desc).encoder().video()?;
        enc.set_width(a.cfg.dst_w);
        enc.set_height(a.cfg.dst_h);
        enc.set_format(ffmpeg::format::Pixel::VULKAN);
        enc.set_time_base(ffmpeg::Rational::new(1, a.cfg.fps as i32));
        enc.set_frame_rate(Some(ffmpeg::Rational::new(a.cfg.fps as i32, 1)));
        // **Beide Codecs fahren auf die Ziel-Bitrate.** H.264 konnte das bis
        // 2026-08-02 nicht: `h264_vulkan` scheiterte mit jeder
        // bitratengesteuerten Betriebsart schon beim Öffnen („Unable to parse
        // feedback units, bad drivers"), und der Weg fuhr ersatzweise mit
        // festem QP — ohne Bitraten-Zusage, für einen echten Strom über eine
        // Leitung also unbrauchbar. Die Ursache lag zur Hälfte in FFmpeg;
        // behoben in `ffmpeg-patches/0002-…`, wo die Herleitung steht.
        enc.set_bit_rate((a.cfg.bitrate_kbps as usize).saturating_mul(1000));
        enc.set_max_bit_rate((a.cfg.bitrate_kbps as usize).saturating_mul(1000));
        enc.set_gop(GOP_OHNE_VOLLBILDER);
        enc.set_max_b_frames(0);

        // **KEIN globaler Kopf.** Über RTP müssen die Parametersätze im Strom
        // mitlaufen — ein später einsteigender Zuschauer hat keinen Kopf, den
        // er nachlesen könnte (gleiche Begründung wie in `encoder_hw`).

        // Der Frames-Kontext MUSS vor `open` hängen.
        unsafe {
            let p = enc.as_mut_ptr();
            let r = av_buffer_ref(vk.frames_ref());
            if r.is_null() {
                bail!("av_buffer_ref(vulkan frames) lieferte NULL");
            }
            (*p).hw_frames_ctx = r;
        }

        let mut opts = ffmpeg::Dictionary::new();
        // **Das hier ist der Zweck der ganzen Übung.**
        //
        // `PULSE_LABOR_KEIN_IR=1` schaltet es ab — **nur zur Halbierung**, nicht
        // als Betriebsart. Es gibt genau eine Frage, für die man das braucht:
        // liegt ein Verhalten am Intra-Refresh oder am `av1_vulkan`-Bitstrom
        // überhaupt? Am 2026-08-02 war das die Frage, warum Chromiums
        // Hardware-Decoder unseren Strom ablehnt und den der AMF-Fassung nicht.
        // Ohne diesen Schalter liessen sich die beiden Ursachen nicht trennen.
        let intra_refresh = !pulse_win_hq_sidecar::env::flag("PULSE_LABOR_KEIN_IR");
        if intra_refresh {
            opts.set("intra_refresh", "1");
            opts.set("intra_refresh_period", &refresh_periode(a.cfg.fps).to_string());
        } else {
            // Ohne Intra-Refresh braucht der Strom wieder regelmässige
            // Vollbilder, sonst vergleicht man zwei verschiedene Dinge.
            enc.set_gop(a.cfg.fps.saturating_mul(2).max(1));
        }
        opts.set("tune", "ll");
        // **CBR ausdrücklich, nicht der Vorgabe überlassen.** Ohne diese Zeile
        // wählt FFmpeg zusammen mit dem Treiber, und die Wahl kann sich
        // zwischen Karten, Treibern und Codecs unterscheiden — zwei Messungen
        // wären dann nicht mehr vergleichbar, ohne dass man sähe, warum.
        //
        // CBR und nicht VBR, weil der Strom über eine Leitung geht: eine
        // gleichmässige Datenrate ist dort planbar. Der Preis ist bei
        // Bildschirminhalt sichtbar — bei stehendem Bild füllt CBR auf die
        // angeforderte Rate auf (gemessen 2026-08-02: H.264 braucht 2673
        // Pakete, wo AV1 mit 1623 auskommt). Ob VBR für diesen Zweck besser
        // passt, ist eine offene Frage und NICHT gemessen.
        opts.set("rc_mode", "cbr");
        // **Kein `forced_idr` — hier nicht nötig, und das ist nachgemessen.**
        //
        // Auf dem AMF-Weg ist die Option Pflicht: ohne sie macht FFmpeg aus
        // `pict_type = I` ein Intra-Only-Bild ohne Sequenzkopf, für einen
        // einsteigenden Zuschauer wertlos (`opts.rs`, Messakte
        // `rueckkanal-2026-08-02-windows.json`). Naheliegend, dasselbe hier zu
        // vermuten — stimmt aber nicht: `av1_vulkan` kennt den Schlüssel gar
        // nicht und liefert trotzdem echte Vollbilder. Am 2026-08-02 geprüft,
        // mit laufendem Intra-Refresh und `-force_key_frames` bei 2 und 4 s:
        // `ffprobe` findet Vollbilder bei genau 0, 2 und 4 s.

        let opened = enc
            .open_with(opts)
            .with_context(|| format!("'{name}' oeffnen (Intra-Refresh)"))?;
        // **Dieselbe Zeile wie die drei Encoder der Bibliothek** — sie ist der
        // einzige Ort, an dem steht, welcher Encoder wirklich lief, und eine
        // Messung unter falschem Etikett sieht vollkommen plausibel aus. Der
        // Zusatz zum Intra-Refresh kommt danach, nicht stattdessen.
        pulse_win_hq_sidecar::encode::log_encoder_open(
            name,
            "vulkan",
            a.cfg.dst_w,
            a.cfg.dst_h,
            a.cfg.fps,
            a.cfg.bitrate_kbps,
        );
        if intra_refresh {
            eprintln!(
                "[vulkan-enc] INTRA-REFRESH an, Zyklus <= {} Bilder",
                refresh_periode(a.cfg.fps)
            );
        } else {
            eprintln!(
                "[vulkan-enc] HALBIERUNGSBETRIEB: Intra-Refresh AUS (PULSE_LABOR_KEIN_IR) \
                 — diese Messung sagt NICHTS ueber das Ziel des Labors"
            );
        }

        // **Ohne Container**: `output = None`. Die Zeit kommt hier aus der
        // RTP-Uhr, nicht aus einer Stream-Timebase — deshalb entfällt auch das
        // `set_stream_time_base`, das der Muxer-Weg nach `write_header`
        // braucht.
        let ton = a
            .audio
            .map(|t| {
                AudioPipeline::create(None, t.sample_rate, t.channels, t.bitrate_kbps, t.av_offset_ms)
            })
            .transpose()
            .context("Tonspur fuer den Vulkan-Weg")?;
        if ton.is_some() {
            eprintln!("[vulkan-enc] Tonspur an (libopus)");
        }

        let senke =
            crate::senke::baue_sendeweg(a.url, a.cfg.codec.slug(), a.cfg.fps, a.cfg.dst_w, a.cfg.dst_h)
                .context("Sendeweg fuer den Vulkan-Encoder")?;
        // Die Ton-Paketlänge aus der Bibliothek, nicht als Zahl hier: eine
        // abweichende Zahl wäre eine stille A/V-Verschiebung.
        let ausgabe =
            SenkenWriter::start(senke, pulse_win_hq_sidecar::encode::audio::opus_frame_dauer())?;

        Ok(Self {
            vk,
            encoder: opened,
            ausgabe,
            ton,
            vollbilder_angefordert: Anforderungen::default(),
            breite: a.cfg.dst_w,
            hoehe: a.cfg.dst_h,
            last_send_us: 0,
            last_mux_us: 0,
            lat: EncodeLatency::default(),
            abzug: crate::bildabzug::Abzug::aus_umgebung(),
        })
    }

    fn drain(&mut self) -> Result<()> {
        let mut mux_us = 0u64;
        loop {
            let mut paket = ffmpeg::Packet::empty();
            match self.encoder.receive_packet(&mut paket) {
                Ok(()) => {}
                Err(ffmpeg::Error::Eof) => break,
                Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::error::EAGAIN => break,
                Err(e) => return Err(e.into()),
            }
            // Zuordnen VOR dem Absenden — danach gehoert das Paket der Senke.
            self.lat.packet(paket.pts());
            let t = Instant::now();
            self.ausgabe.video(paket)?;
            mux_us += t.elapsed().as_micros() as u64;
        }
        self.last_mux_us = mux_us;
        Ok(())
    }
}

/// Die D3D11-Textur eines Pool-Bildes ausleihen und damit arbeiten.
///
/// **Als Closure und nicht als Rückgabewert**, weil `from_raw_borrowed` eine
/// Referenz auf den lokalen Zeiger liefert — die darf die Funktion nicht
/// überleben. Der Pool bleibt Eigentümer der Textur; hier wird nichts
/// referenzgezählt.
///
/// # Safety
///
/// `frame` muss den Aufruf überleben.
unsafe fn mit_textur<T>(
    frame: &OwnedHwFrame,
    f: impl FnOnce(&ID3D11Texture2D) -> Result<T>,
) -> Result<T> {
    let roh = frame.texture_raw();
    if roh.is_null() {
        bail!("Pool-Bild ohne D3D11-Textur");
    }
    let tex = unsafe { ID3D11Texture2D::from_raw_borrowed(&roh) }
        .ok_or_else(|| anyhow!("Textur-Zeiger nicht als ID3D11Texture2D lesbar"))?;
    f(tex)
}

impl BildEncoder for VulkanEncoder {
    /// **Vor dem Blt auf den Encoder warten.** Ohne das schriebe der
    /// Video-Prozessor in eine Textur, die Vulkan noch liest — der Fehler
    /// zeigte sich später als zerrissenes Bild oder Geräteverlust, und nur
    /// manchmal. Der Regelweg braucht das nicht: dort hält FFmpeg die Referenz
    /// auf den Pool-Frame selbst.
    fn vor_dem_schreiben(&mut self, ziel: &OwnedHwFrame) -> Result<()> {
        let vk = &mut self.vk;
        // SAFETY: `ziel` lebt über diesen Aufruf hinaus (die Pipeline hält es);
        // die Textur gehoert zum Pool dieses Importers.
        unsafe { mit_textur(ziel, |tex| vk.warte_auf_encoder(tex)) }
    }

    fn send_hw(&mut self, frame: &mut OwnedHwFrame, pts: i64) -> Result<()> {
        // Die D3D11-Textur des Pool-Bildes. Der Video-Prozessor hat sie eben
        // beschrieben (NV12), jetzt geht sie ohne Kopie nach Vulkan.
        //
        // **Nur noch Schritt 3**: warten, bis der Blt fertig ist, bevor Vulkan
        // liest. Geschrieben hat die Pipeline schon, und das Warten auf den
        // Encoder (Schritt 1) ist ebenfalls erledigt — es lief in
        // `vor_dem_schreiben`, also VOR dem Blt, wo es hingehört.
        let vk = &mut self.vk;
        // SAFETY: `frame` lebt ueber diesen Aufruf hinaus; die Textur gehoert
        // zum Pool dieses Importers, und auf den Encoder wurde gewartet.
        let vkf = unsafe { mit_textur(frame, |tex| vk.uebergib(tex, || Ok(()))) }?;

        let angefordert = self.vollbilder_angefordert.naechstes_bild(pts);
        let t_send = Instant::now();
        let mut bild = ffmpeg::frame::Video::empty();
        unsafe {
            let f = bild.as_mut_ptr();
            (*f).format = AVPixelFormat::AV_PIX_FMT_VULKAN as i32;
            (*f).width = self.breite as i32;
            (*f).height = self.hoehe as i32;
            (*f).data[0] = vkf as *mut u8;
            // `buf[0]` MUSS gesetzt sein, sonst lehnt `avcodec_send_frame` mit
            // EINVAL ab. Der Puffer gehoert dem Importer, also ein Freigeben,
            // das nichts tut.
            unsafe extern "C" fn nichts(_: *mut std::ffi::c_void, _: *mut u8) {}
            (*f).buf[0] = av_buffer_create(
                vkf as *mut u8,
                std::mem::size_of::<AVVkFrame>(),
                Some(nichts),
                std::ptr::null_mut(),
                AV_BUFFER_FLAG_READONLY,
            );
            (*f).hw_frames_ctx = av_buffer_ref(self.vk.frames_ref());
            (*f).pts = pts;
            // Vollbild auf Anforderung — der Rueckkanal. Ohne ihn kaeme ein neu
            // einsteigender Zuschauer bei Intra-Refresh nie ins Bild.
            // Pro Bild zuruecksetzen, sonst waere jedes folgende ein Vollbild;
            // `Anforderungen` erledigt beides und fuehrt die Zahl mit, die den
            // Rueckkanal messbar macht.
            (*f).pict_type = if angefordert {
                AVPictureType::AV_PICTURE_TYPE_I
            } else {
                AVPictureType::AV_PICTURE_TYPE_NONE
            };
            // Auf Anforderung EIN Bild zurueckholen und wegschreiben — damit
            // laesst sich „die Textur ist schon falsch" von „der Encoder liest
            // sie falsch" trennen (s. `crate::bildabzug`).
            if let Some(abzug) = self.abzug.as_mut() {
                abzug.vielleicht(f);
            }
            let rc = avcodec_send_frame(self.encoder.as_mut_ptr(), f);
            if rc < 0 {
                bail!("avcodec_send_frame (vulkan) rc={rc}");
            }
        }
        self.last_send_us = t_send.elapsed().as_micros() as u64;
        self.lat.submitted(pts, t_send);
        self.drain()
    }

    fn send_audio(&mut self, captured: &CapturedAudio) -> Result<()> {
        let Some(ton) = self.ton.as_mut() else { return Ok(()) };
        for paket in ton.send(captured)? {
            self.ausgabe.audio(paket)?;
        }
        Ok(())
    }

    fn set_audio_origin(&mut self, origin: Instant, origin_qpc: Option<i64>) {
        if let Some(ton) = self.ton.as_mut() {
            ton.set_stream_origin(origin, origin_qpc);
        }
    }

    fn last_send_us(&self) -> u64 {
        self.last_send_us
    }

    fn last_mux_us(&self) -> u64 {
        self.last_mux_us
    }

    fn take_encode_latency(&mut self) -> (u64, u64, u64) {
        self.lat.take()
    }

    fn finish(&mut self) -> Result<()> {
        self.encoder.send_eof().context("send_eof")?;
        self.drain()?;
        // Den Ton VOR dem Schliessen leeren — danach nimmt die Senke nichts
        // mehr an, und die letzten Pakete waeren still weg.
        if let Some(ton) = self.ton.as_mut() {
            for paket in ton.flush()? {
                self.ausgabe.audio(paket)?;
            }
        }
        self.ausgabe.finish()
    }
}
