//! Eigener WebRTC-Sendeweg (WHIP) — statt ffmpegs Muxer.
//!
//! **Warum es das gibt.** Zwei Dinge kann ffmpegs WHIP-Muxer nicht, und beide
//! sind entscheidend:
//!
//! 1. **Kein Rueckkanal zur Anwendung.** Eine Vollbild-Anforderung des
//!    Zuschauers (RTCP PLI/FIR) koennte den Encoder nie erreichen. Gemessen am
//!    2026-07-28: ohne sie steht das Bild nach einem Paketverlust bis zum
//!    naechsten regulaeren Vollbild — bei 0,2 % Verlust in 7 bis 9 von 17
//!    Sekunden. MIT ihr sind es 0 bis 1, und die Bildrate geht von 0 auf 60.
//!    MediaMTX reicht die Anforderung nachweislich durch; es fehlte nur ein
//!    Sender, der sie empfaengt.
//! 2. **Kein AV1.** In ffmpeg 8.1 und im aktuellen master traegt `whip.c`
//!    ausschliesslich H.264 (`.p.video_codec = AV_CODEC_ID_H264`, ein einziger
//!    Payload-Typ). Es lohnt nicht, auf ein Update zu warten.
//!
//! **Aufbau.** Die Verbindung ist ein `RTCPeerConnection` mit genau einem
//! Video-Track. Encodierte Pakete kommen aus dem synchronen Encode-Faden
//! herein ([`WhipSender::send`]) und gehen ueber `write_sample` hinaus; die
//! Paketierung in RTP macht webrtc-rs. Ein eigener Faden liest das
//! zurueckkommende RTCP und ruft bei PLI oder FIR
//! [`crate::encode::request_keyframe`].
//!
//! **Nicht-Trickle.** WHIP ist ein einziger POST mit dem fertigen Angebot,
//! deshalb wird das Sammeln der ICE-Kandidaten abgewartet. Das unterscheidet
//! diesen Weg von `pulse-remote-webrtc` (Fernsteuerung), das als Answerer mit
//! Trickle-ICE arbeitet — dieselben Bauteile, andere Form.
//!
//! **Zwei Bildspuren, je nach Codec.** H.264 laesst webrtc-rs paketieren. AV1
//! nicht: dessen `Av1Payloader` schreibt Laengenfelder ab 128 falsch (Nachweis
//! und Zahlen in [`av1`]). Dafuer gibt es einen eigenen Paketierer, und die
//! Spur ist dann eine `TrackLocalStaticRTP` — Reihenfolge, Zeitstempel und
//! Marker-Bit setzt dieser Weg selbst.

pub mod av1;
mod pacer;

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use bytes::Bytes;
use rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
use rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use tokio::runtime::Runtime;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_AV1, MIME_TYPE_H264, MIME_TYPE_OPUS};
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::media::Sample;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp::header::Header;
use webrtc::rtp::packet::Packet;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::{TrackLocal, TrackLocalWriter};

/// Obergrenze fuers Sammeln der ICE-Kandidaten, bevor das Angebot trotzdem
/// rausgeht. Wie im Player (`pulse-player/src/whep.rs`).
const ICE_GATHERING_TIMEOUT: Duration = Duration::from_secs(2);

/// Eigene Laufzeit fuer den Sendeweg — bewusst getrennt von der des Portals.
///
/// Das Portal verhandelt einmal beim Start und ist danach still; dieser Weg
/// laeuft die ganze Sitzung. Sie sich teilen zu lassen hiesse, dass ein
/// haengender Portal-Aufruf den Medienstrom mit anhaelt.
fn runtime() -> &'static Runtime {
    static RT: OnceLock<Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("whip tokio runtime bauen")
    })
}

/// Fassung fuer den Codec, wie sie im Angebot steht.
fn codec_capability(codec: &str) -> Result<RTCRtpCodecCapability> {
    match codec {
        "h264" => Ok(RTCRtpCodecCapability {
            mime_type: MIME_TYPE_H264.to_owned(),
            clock_rate: 90000,
            // `packetization-mode=1` ist Pflicht fuer fragmentierte NAL-Units;
            // `profile-level-id` nennt Baseline 3.1 — die Fassung, auf die sich
            // Browser und MediaMTX ohne Nachfrage einigen.
            sdp_fmtp_line: "level-asymmetry-allowed=1;packetization-mode=1;\
                            profile-level-id=42e01f"
                .to_owned(),
            ..Default::default()
        }),
        // `profile-id=0` muss dastehen, weil die Fassung Wort fuer Wort zu der
        // passen muss, die `register_default_codecs` anmeldet — sonst findet
        // die Spur beim Binden ihren Codec nicht.
        "av1" => Ok(RTCRtpCodecCapability {
            mime_type: MIME_TYPE_AV1.to_owned(),
            clock_rate: 90000,
            sdp_fmtp_line: "profile-id=0".to_owned(),
            ..Default::default()
        }),
        andere => bail!("WHIP: Codec {andere} nicht unterstuetzt"),
    }
}

/// Fassung fuer die Tonspur — immer Opus, der Ton-Encoder kennt nichts anderes
/// (s. [`crate::encode::audio`]).
fn opus_capability() -> RTCRtpCodecCapability {
    RTCRtpCodecCapability {
        mime_type: MIME_TYPE_OPUS.to_owned(),
        clock_rate: 48000,
        channels: 2,
        // `stereo=1` verlangt, dass der Empfaenger zweikanalig ausgibt; ohne
        // die Angabe mischt er nach RFC 7587 auf mono. Dieselbe Falle wie im
        // Browser-Client (s. `whep.ts`).
        sdp_fmtp_line: "minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1".to_owned(),
        ..Default::default()
    }
}

/// Ein Sample auf eine Spur schreiben. Wird aus dem synchronen Encode-Faden
/// gerufen; `write_sample` reiht nur ein, blockiert also nicht spuerbar.
fn write_to_track(track: &TrackLocalStaticSample, data: &[u8], dauer: Duration) -> Result<()> {
    let sample = Sample {
        data: Bytes::copy_from_slice(data),
        duration: dauer,
        ..Default::default()
    };
    runtime().block_on(track.write_sample(&sample)).map_err(Into::into)
}

/// Fortlaufender Zustand des eigenen AV1-Paketierers.
///
/// Beides gehoert hierher und nicht in den Encode-Faden: `TrackLocalStaticRTP`
/// vergibt weder Sequenznummern noch Zeitstempel — es ueberschreibt nur SSRC
/// und Payload-Typ je Bindung.
struct Av1Zustand {
    seq: u16,
    /// Bilder seit Beginn. Der Zeitstempel wird daraus JEDES MAL neu gerechnet
    /// (`bilder * 90000 / fps`) statt aufaddiert: bei 280 fps sind 90000/fps
    /// keine ganze Zahl, und ein aufaddierter Schritt liefe um rund eine
    /// Millisekunde je Sekunde davon.
    bilder: u64,
    fps: u32,
}

impl Av1Zustand {
    fn neu(fps: u32) -> Self {
        // Zufaelliger Startpunkt fuer die Sequenznummern, wie es auch
        // webrtc-rs' eigener Zaehler macht. Die Uhr reicht dafuer — eine
        // Zufallsquelle waere hier eine Abhaengigkeit fuer nichts.
        let seq = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos() as u16);
        Self { seq, bilder: 0, fps }
    }

    /// Zeitstempel DIESES Bildes; zaehlt den Bildzaehler danach weiter.
    fn zeitstempel_und_weiter(&mut self) -> u32 {
        let ts = (self.bilder * 90_000 / u64::from(self.fps)) as u32;
        self.bilder += 1;
        ts
    }

    /// Sequenznummer fuer das naechste Paket; laeuft bei 65535 ueber.
    fn naechste_seq(&mut self) -> u16 {
        let seq = self.seq;
        self.seq = self.seq.wrapping_add(1);
        seq
    }
}

/// Wie die Bild-Pakete auf die Leitung kommen.
enum Bildspur {
    /// H.264 — webrtc-rs paketiert, zaehlt und stempelt selbst.
    Fremd(Arc<TrackLocalStaticSample>),
    /// AV1 — eigener Paketierer (s. [`av1`]).
    Selbst {
        zustand: Mutex<Av1Zustand>,
        /// Verteilt die Pakete eines Bildes ueber die Zeit statt sie als
        /// Schwall zu senden — normalerweise `None`, weil diese Fassung
        /// gemessen SCHLECHTER ist (Zahlen und Ursache in [`pacer`]).
        /// `PULSE_WHIP_PACING=1` schaltet sie zum Weitermessen ein.
        pacer: Option<pacer::Pacer>,
        track: Arc<TrackLocalStaticRTP>,
    },
}

impl Bildspur {
    /// Dieselbe Spur in der Form, die `add_track` erwartet.
    fn als_track_local(&self) -> Arc<dyn TrackLocal + Send + Sync> {
        match self {
            Bildspur::Fremd(t) => Arc::clone(t) as _,
            Bildspur::Selbst { track, .. } => Arc::clone(track) as _,
        }
    }
}

pub struct WhipSender {
    track: Bildspur,
    /// Ton als EIGENE Spur.
    ///
    /// Der entscheidende Unterschied zum Muxer-Weg: dort liegen Bild und Ton
    /// auf EINER Zeitleiste, und der Muxer gibt ein Bild erst frei, wenn Ton mit
    /// passendem Zeitstempel vorliegt — der Rueckstand des Tons wird damit 1:1
    /// zur Bild-Latenz. Genau das kostete am 2026-07-28 ueber die echte Leitung
    /// rund 25 ms (RTMPS mit Ton 143, ohne Ton 116,8). Zwei getrennte Spuren
    /// koennen sich so nicht gegenseitig aufhalten.
    audio: Arc<TrackLocalStaticSample>,
    pc: Arc<RTCPeerConnection>,
    /// Aus dem `Location`-Kopf der Antwort — fuer das abschliessende DELETE.
    resource_url: Option<String>,
    http: reqwest::Client,
    /// Dauer eines Bildes; `write_sample` braucht sie fuer den Zeitstempel.
    frame_duration: Duration,
}

impl WhipSender {
    /// Baut die Sitzung auf und kehrt zurueck, sobald das Angebot beantwortet
    /// ist. Blockiert den aufrufenden (synchronen) Faden waehrenddessen.
    pub fn connect(url: &str, codec: &str, fps: u32) -> Result<Self> {
        let cap = codec_capability(codec)?;
        let fps = fps.max(1);
        runtime().block_on(async move { Self::connect_async(url, cap, fps).await })
    }

    async fn connect_async(url: &str, cap: RTCRtpCodecCapability, fps: u32) -> Result<Self> {
        let frame_duration = Duration::from_secs_f64(1.0 / f64::from(fps));
        let mut media = MediaEngine::default();
        media.register_default_codecs().context("Codecs registrieren")?;
        let mut registry = Registry::new();
        registry = register_default_interceptors(registry, &mut media)
            .context("Interceptor-Registry")?;
        let api = APIBuilder::new()
            .with_media_engine(media)
            .with_interceptor_registry(registry)
            .build();

        // Kein STUN: der Weg zum eigenen Server laeuft entweder ueber die
        // Schleife oder ueber eine gewoehnliche ausgehende Verbindung. Ein
        // STUN-Server waere ein zusaetzlicher Aussenkontakt ohne Nutzen.
        let config = RTCConfiguration { ice_servers: vec![RTCIceServer::default()], ..Default::default() };
        let pc = Arc::new(api.new_peer_connection(config).await?);

        // Nur AV1 paketieren wir selbst (Grund und Nachweis in [`av1`]).
        let track = if cap.mime_type == MIME_TYPE_AV1 {
            let av1_track = Arc::new(TrackLocalStaticRTP::new(
                cap,
                "video".to_owned(),
                "pulse-hq".to_owned(),
            ));
            // Reihenfolge der Felder ist hier nicht frei: `pacer` leiht sich die
            // Spur, `track` gibt sie ab — und Feld-Initialisierer laufen in der
            // Reihenfolge, in der sie stehen.
            Bildspur::Selbst {
                zustand: Mutex::new(Av1Zustand::neu(fps)),
                // AUS als Vorgabe: gemessen macht die Verteilung es in dieser
                // Fassung schlechter, nicht besser (s. [`pacer`]).
                pacer: (std::env::var("PULSE_WHIP_PACING").as_deref() == Ok("1")).then(|| {
                    pacer::Pacer::start(runtime(), Arc::clone(&av1_track), frame_duration)
                }),
                track: av1_track,
            }
        } else {
            Bildspur::Fremd(Arc::new(TrackLocalStaticSample::new(
                cap,
                "video".to_owned(),
                "pulse-hq".to_owned(),
            )))
        };
        let sender = pc.add_track(track.als_track_local()).await?;

        // Ton-Spur IMMER anbieten, auch wenn kein Ton kommt.
        //
        // Die Spuren werden beim Handschlag ausgehandelt; eine nachtraeglich
        // hinzugefuegte verlangt eine neue Aushandlung, und die kennt WHIP in
        // seiner einfachen Form nicht (ein POST, eine Antwort). Eine angebotene
        // und stumme Spur kostet dagegen nichts — anders als beim Muxer, wo ein
        // angekuendigter, aber stummer Strom den Interleaver puffern liesse.
        let audio = Arc::new(TrackLocalStaticSample::new(
            opus_capability(),
            "audio".to_owned(),
            "pulse-hq".to_owned(),
        ));
        let audio_sender = pc
            .add_track(Arc::clone(&audio) as Arc<dyn TrackLocal + Send + Sync>)
            .await?;

        // Auch der Ton-Sender MUSS gelesen werden. Sein RTCP interessiert uns
        // inhaltlich nicht (eine Vollbild-Anforderung gibt es fuer Ton nicht),
        // aber ungelesene Rueckmeldungen laufen intern auf und bremsen den
        // Sender aus.
        tokio::spawn(async move {
            let mut buf = vec![0u8; 1500];
            while audio_sender.read(&mut buf).await.is_ok() {}
        });

        // RTCP lesen. PLI und FIR sind die Bitte um ein Vollbild; alles andere
        // wird verworfen, MUSS aber gelesen werden, sonst staut der Sender.
        //
        // `PULSE_WHIP_IGNORE_PLI=1` liest weiter, antwortet aber nicht. Das ist
        // kein Betriebsschalter, sondern der Trennschnitt einer Messung: nur so
        // laesst sich sagen, ob eine Verbesserung unter Verlust von den
        // Vollbildern kommt oder vom Transportweg selbst.
        let antworten = std::env::var("PULSE_WHIP_IGNORE_PLI").as_deref() != Ok("1");
        tokio::spawn(async move {
            let mut angefordert: u64 = 0;
            // Fehler beim Lesen duerfen den Rueckkanal NICHT dauerhaft
            // schliessen.
            //
            // Zuerst stand hier `while let Ok(..) = read_rtcp().await` — und
            // damit verliess ein einziger Lesefehler die Schleife fuer immer.
            // Am 2026-07-28 auf der Leitung nachgesehen: MediaMTX schickte zehn
            // Vollbild-Anforderungen, angekommen ist genau EINE, und zwar bei
            // jedem Verlustgrad von 0,2 bis 8 % dieselbe eine. Das sah nach
            // "der Server leitet nicht weiter" aus und war ein Fehler bei uns.
            let mut fehler_am_stueck = 0u32;
            loop {
                let (pakete, _) = match sender.read_rtcp().await {
                    Ok(v) => {
                        fehler_am_stueck = 0;
                        v
                    }
                    Err(e) => {
                        fehler_am_stueck += 1;
                        // Ein paar Fehler hintereinander heissen "Verbindung
                        // ist weg" — dann darf die Schleife enden, sonst
                        // liefe sie heiss.
                        if fehler_am_stueck >= 5 {
                            tracing::debug!(target: "whip", "RTCP-Lesen beendet: {e}");
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        continue;
                    }
                };
                for p in &pakete {
                    let any = p.as_any();
                    if any.downcast_ref::<PictureLossIndication>().is_some()
                        || any.downcast_ref::<FullIntraRequest>().is_some()
                    {
                        if antworten {
                            crate::encode::request_keyframe();
                        }
                        angefordert += 1;
                        // JEDE melden, nicht nur jede zwanzigste. Der erste
                        // Anlauf meldete "die erste und dann jede zwanzigste" —
                        // damit sahen 1 und 19 Anforderungen identisch aus, und
                        // genau diese Unterscheidung war die Frage. Sie sind
                        // selten genug (rund zehn in 18 s bei 3 % Verlust), als
                        // dass das Log ueberliefe.
                        tracing::info!(
                            target: "whip",
                            "Vollbild angefordert (insgesamt {angefordert})"
                        );
                    }
                }
            }
        });

        let (resource_url, http) = Self::negotiate(&pc, url).await?;
        Ok(Self { track, audio, pc, resource_url, http, frame_duration })
    }

    /// Angebot erzeugen, Kandidaten sammeln, POST, Antwort setzen.
    async fn negotiate(
        pc: &Arc<RTCPeerConnection>,
        url: &str,
    ) -> Result<(Option<String>, reqwest::Client)> {
        let offer = pc.create_offer(None).await.context("create_offer")?;
        pc.set_local_description(offer).await.context("set_local_description")?;

        // Nicht-Trickle: warten, bis das Angebot alle Kandidaten traegt.
        let mut gathering = pc.gathering_complete_promise().await;
        let _ = tokio::time::timeout(ICE_GATHERING_TIMEOUT, gathering.recv()).await;
        let sdp = pc
            .local_description()
            .await
            .ok_or_else(|| anyhow!("keine local description nach dem Sammeln"))?
            .sdp;

        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .context("HTTP-Client")?;
        let res = http
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, "application/sdp")
            .body(sdp)
            .send()
            .await
            // NICHT `.context(...)`: reqwest haengt die volle URL an den Fehler,
            // und die traegt den Publish-Token. Projektregel: niemals Tokens
            // loggen.
            .map_err(|e| anyhow!("WHIP-Server nicht erreichbar: {}", crate::redact::redact_url(&e.to_string())))?;
        if !res.status().is_success() {
            bail!("WHIP-POST fehlgeschlagen: HTTP {}", res.status());
        }
        let location = res
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let answer = res.text().await.context("Answer-Body")?;
        if !answer.contains("v=") {
            bail!("WHIP-Antwort war kein gueltiges SDP");
        }
        pc.set_remote_description(RTCSessionDescription::answer(answer)?)
            .await
            .context("set_remote_description")?;
        Ok((location, http))
    }

    /// Ein encodiertes Bild senden.
    pub fn send(&self, data: &[u8]) -> Result<()> {
        match &self.track {
            Bildspur::Fremd(t) => {
                write_to_track(t, data, self.frame_duration).context("write_sample")
            }
            Bildspur::Selbst { zustand, pacer, track } => {
                let pakete: Vec<Packet> = {
                    let mut z = zustand.lock().expect("AV1-Zustand vergiftet");
                    // Alle Pakete eines Bildes tragen denselben Zeitstempel.
                    let ts = z.zeitstempel_und_weiter();
                    av1::paketiere(data, av1::MTU)?
                        .into_iter()
                        .map(|p| Packet {
                            header: Header {
                                version: 2,
                                marker: p.letztes,
                                sequence_number: z.naechste_seq(),
                                timestamp: ts,
                                ..Default::default()
                            },
                            payload: Bytes::from(p.daten),
                        })
                        .collect()
                };
                match pacer {
                    Some(p) => p.send(pakete),
                    None => {
                        for paket in pakete {
                            runtime().block_on(track.write_rtp(&paket)).context("write_rtp")?;
                        }
                        Ok(())
                    }
                }
            }
        }
    }

    /// Ein encodiertes Ton-Paket senden.
    ///
    /// `dauer` ist die Laenge des Opus-Pakets (heute 5 ms, s.
    /// `encode::audio::opus_frame_ms`) — webrtc-rs leitet daraus den
    /// RTP-Zeitstempel ab. Ein falscher Wert verschoebe den Ton gegen das Bild,
    /// ohne dass irgendwo ein Fehler auftaucht.
    pub fn send_audio(&self, data: &[u8], dauer: Duration) -> Result<()> {
        write_to_track(&self.audio, data, dauer).context("write_sample audio")
    }

    /// Sitzung abbauen. Idempotent.
    ///
    /// Nimmt `&self`, weil der Sender geteilt wird: der Ton-Faden haelt eine
    /// eigene Referenz. Das abschliessende DELETE ist ohnehin best-effort —
    /// zweimal geschickt ist harmlos, der Server laesst die Sitzung sonst
    /// auslaufen.
    pub fn close(&self) {
        let pc = Arc::clone(&self.pc);
        let url = self.resource_url.clone();
        let http = self.http.clone();
        runtime().block_on(async move {
            let _ = pc.close().await;
            if let Some(u) = url {
                let _ = http.delete(&u).send().await;
            }
        });
    }
}
