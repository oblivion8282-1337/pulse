//! Der Direktpfad-Sender: derselbe schmale Zuschnitt wie `WhipSender` in den
//! Sidecars (`connect`/`send`/`send_audio`/`close`), nur ist er ANTWORTER
//! statt Angeboter.
//!
//! **Warum hier und nicht (nur) im Sidecar.** Paketierung, Taktgeber,
//! SDP-Bau und Bildmarke liegen seit dem 2026-08-20 gemeinsam in dieser
//! Crate — der Direktpfad braucht dieselben Teile. Was er NICHT hier tut:
//! Rückkanal-Behandlung. PLI/FIR müssen beim Aufrufer landen (im Sidecar:
//! `crate::keyframe::request_keyframe`), und die Zustandsmeldungen der
//! Verbindung sind dessen Ereignis-Sprache. Deshalb stellt [`DirectSender`]
//! Spur und PC bereit ([`DirectSender::video_sender`],
//! [`DirectSender::pc`]); wer die Rückkanäle liest und welche Zustands-
//! übersicht er daraus macht, bleibt Sache des Aufrufers. **Es darf nur EIN
//! Zustands-Handler je PC angemeldet werden** (webrtc-rs ersetzt, nicht
//! stapelt) — der Sender meldet keinen eigenen an.
//!
//! **Aushandlung.** `connect` bekommt das ANGEBOT des Players (nicht die
//! Answer — die erzeugt es selbst, ein Antworter kann ohne Angebot keine
//! bauen) und kehrt erst zurück, wenn der Answer alle Kandidaten trägt
//! (nicht-trickle). Ab da ist die Sitzung verdrahtet: `send`/`send_audio`
//! paketieren und takten wie im WHIP-Weg, nur dass die Gegenseite der Player
//! ist und kein MediaMTX.
//!
//! **Kein FlexFEC auf diesem Weg.** MediaMTX erzeugte ihn auf dem Server-Pfad;
//! der Player bietet ihn nicht an. Verlust-Reparatur läuft deshalb über den
//! NACK-Responder (`register_default_interceptors`, an unserer `nack`-
//! Rückmeldung) und die Vollbild-Anforderung — der Responder ist mit dem
//! selben Media-Engine-Aufbau aktiv wie im WHIP-Weg.

pub mod rtc;
pub mod sdp;
pub mod stun;
mod spur;

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{Context, Result};
use bytes::Bytes;
use webrtc::api::media_engine::MIME_TYPE_AV1;
use webrtc::media::Sample;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp::codecs::h264::H264Payloader;
use webrtc::rtp::header::Header;
use webrtc::rtp::packet::Packet;
use webrtc::rtp::packetizer::Payloader;
use webrtc::rtp_transceiver::rtp_sender::RTCRtpSender;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::{TrackLocal, TrackLocalWriter};

use pulse_bildmarke as bildmarke;
use pulse_bildmarke::EXTMAP_URI;

use crate::av1::{self, SpurZustand};
use crate::h264::h264_ist_vollbild;
use crate::pacer;
use spur::{melde_verteilung, Bildspur, Paketierer};
pub use spur::{dauer_fuer_takte, Konfig};

/// Eigene Laufzeit des Direktpfads — bewusst getrennt von anderen Wegen,
/// dieselbe Begründung wie beim WHIP-Sender des Sidecars: ein hängender
/// Aushandlungs-Aufruf darf den Medienstrom nicht mit anhalten.
///
/// Öffentlich, weil der Aufrufer seinen RTCP-Lesefaden auf DENSELBEN Pool
/// stellen soll, statt einen zweiten zu bauen.
pub fn laufzeit() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("direct tokio runtime bauen")
    })
}

pub struct DirectSender {
    track: Bildspur,
    audio: Arc<TrackLocalStaticSample>,
    pc: Arc<RTCPeerConnection>,
    /// Der Video-Sender — der Aufrufer liest hier RTCP ab (PLI/FIR/REMB).
    video_sender: Arc<RTCRtpSender>,
    codec_slug: &'static str,
    /// Die beim Aufbau gesetzte Bildrate (s. [`Konfig::fps`]).
    fps: u32,
    /// Die ausgehandelte Nummer der Bildmarke; 0 = nicht ausgehandelt
    /// (genau wie im WHIP-Sender: „Marke oder nichts").
    marken_id: AtomicU8,
    geschlossen: AtomicBool,
}

impl DirectSender {
    /// Baut PC und Spuren. Noch KEINE Aushandlung — die passiert in
    /// [`DirectSender::connect`]. Getrennt, damit der Aufrufer Baufehler
    /// (Konfigurationsseite) von Aushandlungsfehlern (Gegenseite)
    /// unterscheiden kann.
    pub fn neu(konfig: &Konfig) -> Result<Self> {
        rtc::sorge_krypto_provider();
        let konfig = konfig.clone();
        laufzeit().block_on(Self::neu_async(konfig))
    }

    async fn neu_async(konfig: Konfig) -> Result<Self> {
        let cap = crate::sdp::codec_capability(
            konfig.codec_slug,
            konfig.breite,
            konfig.hoehe,
            konfig.fps,
        )?;
        let audio_cap = crate::sdp::opus_capability();
        let fps = konfig.fps.max(1);
        // Der echte Bildabstand — geht an den Taktgeber. Die Bild-Zeitstempel
        // selbst kommen aus dem Encoder-`pts` (`SpurZustand::zeitstempel`),
        // nicht aus einer Dauer — dieselbe Trennung wie im WHIP-Sender.
        let frame_dauer = Duration::from_secs_f64(1.0 / f64::from(fps));

        let api = rtc::baue_api(&cap, &audio_cap)?;
        let pc = Arc::new(
            api.new_peer_connection(rtc::eis_konfiguration())
                .await
                .context("PeerConnection des Direktpfads")?,
        );

        // Beide Codecs stempeln selbst; nur der Zerleger unterscheidet sich
        // (Grund und Nachweis in [`av1`] bzw. im WHIP-Sender).
        let paketierer = if cap.mime_type == MIME_TYPE_AV1 {
            Paketierer::Av1
        } else {
            Paketierer::H264(H264Payloader::default())
        };
        let video_track = Arc::new(TrackLocalStaticRTP::new(
            cap,
            "video".to_owned(),
            "pulse-hq".to_owned(),
        ));
        let track = Bildspur {
            zustand: Mutex::new((SpurZustand::neu(fps), paketierer)),
            pacer: (std::env::var("PULSE_WHIP_PACING").as_deref() != Ok("0")).then(|| {
                pacer::Pacer::start(
                    laufzeit(),
                    Arc::clone(&video_track),
                    frame_dauer,
                    melde_verteilung,
                )
            }),
            track: video_track,
        };
        let sender = pc
            .add_track(Arc::clone(&track.track) as Arc<dyn TrackLocal + Send + Sync>)
            .await
            .context("Bildspur anmelden")?;

        // Ton-Spur IMMER anbieten, auch wenn kein Ton kommt — dieselbe
        // Begruendung wie im WHIP-Sender: nachtraeglich angemeldete Spuren
        // verlangen eine neue Aushandlung, und der Direktpfad kennt wie WHIP
        // genau EINEN Handschlag. Eine angebotene und stumme Spur kostet
        // nichts.
        let audio = Arc::new(TrackLocalStaticSample::new(
            audio_cap,
            "audio".to_owned(),
            "pulse-hq".to_owned(),
        ));
        let audio_sender = pc
            .add_track(Arc::clone(&audio) as Arc<dyn TrackLocal + Send + Sync>)
            .await
            .context("Tonspur anmelden")?;
        // Auch der Ton-Sender MUSS gelesen werden (ungelesene Rueckmeldungen
        // stauen und bremsen den Sender); inhaltlich interessiert sein RTCP
        // nicht — eine Vollbild-Anforderung gibt es fuer Ton nicht.
        laufzeit().spawn(async move {
            let mut buf = vec![0u8; 1500];
            while audio_sender.read(&mut buf).await.is_ok() {}
        });

        Ok(Self {
            track,
            audio,
            pc,
            video_sender: sender,
            codec_slug: konfig.codec_slug,
            fps: konfig.fps,
            marken_id: AtomicU8::new(0),
            geschlossen: AtomicBool::new(false),
        })
    }

    /// Beantwortet das Angebot und liefert den fertigen Answer-SDP-Text —
    /// vollständig gesammelt (nicht-trickle), Blockieren des aufrufenden
    /// Fadens wie im WHIP-Handschlag. Der Aufrufer hängt SEINEN Zustands-
    /// Handler an [`DirectSender::pc`], BEVOR er hier aufruft: der PC kann
    /// während des Sammelns bereits `Connected` werden? Nein — verbinden
    /// kann er sich erst, wenn der Player die Answer hat. Aber `Failed`
    /// (unbrauchbares Angebot) feuert schon vorher.
    pub fn connect(&self, offer_sdp: &str) -> Result<String> {
        let answer = laufzeit().block_on(rtc::beantworte(&self.pc, offer_sdp))?;
        // Die Nummer, unter der die Bildmarke ausgehandelt wurde — dieselbe
        // Stelle wie im WHIP-Sender. Kennt der Player die Erweiterung nicht,
        // ist die Liste leer und wir schreiben nichts: „Marke oder nichts".
        let marken_id = laufzeit().block_on(async {
            self.video_sender
                .get_parameters()
                .await
                .rtp_parameters
                .header_extensions
                .iter()
                .find(|e| e.uri == EXTMAP_URI)
                .map_or(0u8, |e| u8::try_from(e.id).unwrap_or(0))
        });
        self.marken_id.store(marken_id, Ordering::Relaxed);
        match marken_id {
            0 => eprintln!(
                "[direct] Bildmarke nicht ausgehandelt — der Player kann fehlende \
                 Bilder nicht erkennen"
            ),
            id => eprintln!("[direct] Bildmarke ausgehandelt als extmap {id}"),
        }
        Ok(answer)
    }

    /// Ein encodiertes Bild senden. `pts` in der ENCODER-Zeitbasis (1/90000),
    /// unverändert durchgereicht — Begründung und Falle im WHIP-Sender
    /// (`WhipSender::send`), dessen Weg hier 1:1 nachfährt.
    pub fn send(&self, daten: &[u8], pts: Option<i64>) -> Result<()> {
        let Bildspur { zustand, pacer, track } = &self.track;
        let marken_id = self.marken_id.load(Ordering::Relaxed);
        let pakete: Vec<Packet> = {
            let mut g = zustand.lock().expect("Spur-Zustand vergiftet");
            let (z, paketierer) = &mut *g;
            // Alle Pakete eines Bildes tragen denselben Zeitstempel.
            let ts = z.zeitstempel(pts);
            // Erst paketieren, DANN nummerieren — genau wie im WHIP-Sender:
            // geht nichts hinaus, wird keine Bildnummer verbraucht.
            //
            // Je Eintrag: Nutzlast, erstes Paket, letztes Paket, Vollbild.
            let teile: Vec<(Bytes, bool, bool, bool)> = match paketierer {
                Paketierer::Av1 => av1::paketiere(daten, av1::MTU)?
                    .into_iter()
                    .map(|p| (Bytes::from(p.daten), p.erstes, p.letztes, p.vollbild))
                    .collect(),
                Paketierer::H264(p) => {
                    let vollbild = h264_ist_vollbild(daten);
                    let teile = p
                        .payload(av1::MTU, &Bytes::copy_from_slice(daten))
                        .context("H.264 paketieren")?;
                    // Leer ist legitim: SPS/PPS wird gehalten und vor dem
                    // nächsten Vollbild gebündelt.
                    let n = teile.len();
                    teile
                        .into_iter()
                        .enumerate()
                        .map(|(i, b)| (b, i == 0, i + 1 == n, vollbild))
                        .collect()
                }
            };
            if teile.is_empty() {
                return Ok(());
            }
            let nummer = z.naechste_bildnummer();
            teile
                .into_iter()
                .map(|(daten, erstes, letztes, vollbild)| {
                    let mut header = Header {
                        version: 2,
                        // `letztes` = letztes Paket des Bildes (→ Marker-Bit).
                        marker: letztes,
                        sequence_number: z.naechste_seq(),
                        timestamp: ts,
                        ..Default::default()
                    };
                    if marken_id != 0 {
                        let marke = bildmarke::Bildmarke {
                            anfang: erstes,
                            ende: letztes,
                            vollbild,
                            nummer,
                        };
                        // Ein Fehler hier wäre ein Programmierfehler (unzu-
                        // lässige Nummer). Ein Strom ohne Marke ist besser
                        // als kein Strom — deshalb kein `?`.
                        let _ = header
                            .set_extension(marken_id, Bytes::from(bildmarke::schreiben(&marke)));
                    }
                    Packet { header, payload: daten }
                })
                .collect()
        };
        match pacer {
            Some(p) => p.send(pakete),
            None => {
                for paket in pakete {
                    laufzeit().block_on(track.write_rtp(&paket)).context("write_rtp")?;
                }
                Ok(())
            }
        }
    }

    /// Ein encodiertes Ton-Paket senden. `dauer` ist die Opus-Paketlänge —
    /// daraus leitet webrtc-rs den RTP-Zeitstempel ab, ein falscher Wert
    /// verschiebt den Ton gegen das Bild (Begründung im WHIP-Sender).
    pub fn send_audio(&self, daten: &[u8], dauer: Duration) -> Result<()> {
        let takte = (dauer.as_secs_f64() * 48_000.0).round() as u32;
        let sample = Sample {
            data: Bytes::copy_from_slice(daten),
            duration: dauer_fuer_takte(takte, 48_000),
            ..Default::default()
        };
        laufzeit()
            .block_on(self.audio.write_sample(&sample))
            .context("write_sample audio")
    }

    /// Sitzung abbauen. Idempotent — Senke und Sitzung können beide
    /// aufräumen, wer zuerst kommt, baut ab; der zweite Aufruf ist ein No-op.
    pub fn close(&self) {
        if self.geschlossen.swap(true, Ordering::SeqCst) {
            return;
        }
        let pc = Arc::clone(&self.pc);
        laufzeit().block_on(async move {
            let _ = pc.close().await;
        });
    }

    /// Der Video-Sender — die Lese-Seite des Rückkanals (PLI/FIR/REMB).
    /// Der Aufrufer spawnpt seinen Lesefaden selbst, auf [`laufzeit()`].
    pub fn video_sender(&self) -> Arc<RTCRtpSender> {
        Arc::clone(&self.video_sender)
    }

    /// Die PeerConnection — für DEN Zustands-Handler des Aufrufers
    /// (Begruendung im Modulkopf).
    pub fn pc(&self) -> Arc<RTCPeerConnection> {
        Arc::clone(&self.pc)
    }

    /// Der Codec, für den diese Sitzung ausgehandelt ist bzw. wird.
    pub fn codec_slug(&self) -> &'static str {
        self.codec_slug
    }

    /// Die Bildrate, mit der die Spur getaktet ist — die Pipeline vergleicht
    /// ihren Auftrag dagegen (`nimm_senke` im Sidecar); eine Abweichung
    /// wäre ein Programmfehler, kein Betriebsfall.
    pub fn fps(&self) -> u32 {
        self.fps
    }
}
