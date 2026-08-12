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
//! Spur ist dann eine `TrackLocalStaticRTP` — Reihenfolge, Marker-Bit und
//! Zeitstempel setzt dieser Weg selbst. Der WERT des Zeitstempels kommt dabei
//! aus dem `pts`, den der Encoder mitgibt, nicht aus einem eigenen Zaehler
//! (Begruendung an `av1::Av1Zustand::zeitstempel`).

pub mod av1;
mod pacer;
mod sdp;

use av1::Av1Zustand;

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use bytes::Bytes;
use rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
use rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use tokio::runtime::Runtime;
use webrtc::api::media_engine::MIME_TYPE_AV1;
use webrtc::ice_transport::ice_server::RTCIceServer;
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

/// Eine Dauer, aus der webrtc-rs **genau** `takte` RTP-Takte macht.
///
/// **Warum das noetig ist** (gemessen 2026-08-02 auf der Windows-Seite,
/// Messakte `streaming/testbench/profiles/ton-2026-08-02-windows-messstand.json`
/// — die Stelle ist dieselbe Datei in webrtc-rs, der Fehler also derselbe hier):
/// `track_local_static_sample.rs:137` rechnet `(dauer.as_secs_f64() * uhr) as
/// u32`, und `as u32` **schneidet ab**. Ein Bild bei 30/s dauert 1/30 s, das mal
/// 90000 ergibt in f64 2999,9999999999995, und daraus wird 2999 statt 3000.
///
/// Ein Takt je Bild klingt nach nichts und ist bei 30 Bildern je Sekunde
/// **20 ms je Minute**: das Bild laeuft dem Ton mit rund 1,3 Sekunden je Stunde
/// davon, ohne dass irgendwo ein Fehler auftaucht. Auf Windows so gemessen
/// (H.264 -21,9 und -20,5 ms/min), waehrend AV1 dort bei -0,5 und -0,0 lag —
/// der eigene AV1-Paketierer rechnet den Zeitstempel ganzzahlig aus der
/// Bildzahl und geht an dieser Stelle vorbei.
///
/// **Auf Linux ungemessen**, aber nicht ungeprueft: es ist dieselbe Fassung
/// derselben fremden Datei, und der Rechenweg haengt an nichts
/// Plattformspezifischem. Die Gegenprobe auf Windows nach dem Einbau: +4,2 und
/// -6,7 ms/min statt -21,9 und -20,5, je 149 Paare — der einseitige Fehler ist
/// weg, der Rest streut um null.
///
/// **Eine halbe Takt-Zugabe, nicht eine ganze.** Damit landet das Abschneiden
/// sicher auf dem gewuenschten Wert, egal wie die f64-Darstellung faellt, und
/// die Dauer bleibt zugleich naeher am Soll als jede Aufrundung auf den
/// naechsten Takt. Der Taktgeber (`pacer`) nimmt weiter die ECHTE Bilddauer;
/// diese hier ist ausschliesslich die Uebergabe an webrtc-rs.
fn dauer_fuer_takte(takte: u32, uhr: u32) -> Duration {
    let ns = (f64::from(takte) + 0.5) * 1e9 / f64::from(uhr);
    Duration::from_nanos(ns.round() as u64)
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
    /// Die Bilddauer, so zurechtgelegt, dass webrtc-rs daraus die RICHTIGE Zahl
    /// RTP-Takte macht (s. [`dauer_fuer_takte`]). **Nur** fuer die Uebergabe an
    /// `write_sample`; wer damit rechnet, rechnet falsch — die echte Bilddauer
    /// bekommt der Taktgeber beim Bau.
    bild_sample_dauer: Duration,
}

impl WhipSender {
    /// Baut die Sitzung auf und kehrt zurueck, sobald das Angebot beantwortet
    /// ist. Blockiert den aufrufenden (synchronen) Faden waehrenddessen.
    pub fn connect(url: &str, codec: &str, fps: u32, breite: u32, hoehe: u32) -> Result<Self> {
        let cap = sdp::codec_capability(codec, breite, hoehe, fps)?;
        let fps = fps.max(1);
        runtime().block_on(async move { Self::connect_async(url, cap, fps).await })
    }

    async fn connect_async(url: &str, cap: RTCRtpCodecCapability, fps: u32) -> Result<Self> {
        // Zwei Dauern, und sie sind NICHT dasselbe: `frame_duration` ist der
        // echte Bildabstand und geht an den Taktgeber, `bild_sample_dauer` ist
        // die Uebergabe an webrtc-rs (s. `dauer_fuer_takte`). Takte je Bild
        // ganzzahlig, wie es der AV1-Paketierer auch tut — bei 90000/fps ohne
        // Rest (24/25/30/50/60...) exakt, sonst der naechstliegende Wert.
        let frame_duration = Duration::from_secs_f64(1.0 / f64::from(fps));
        let bild_sample_dauer = dauer_fuer_takte((90_000 + fps / 2) / fps, 90_000);

        // Baut die Media-Engine so, dass im Angebot GENAU unsere beiden
        // Fassungen stehen (Begruendung und Messung im Kopf von [`sdp`]).
        let audio_cap = sdp::opus_capability();
        let api = sdp::baue_api(&cap, &audio_cap)?;

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
            audio_cap,
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
        Ok(Self { track, audio, pc, resource_url, http, bild_sample_dauer })
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
    ///
    /// `pts` ist der Zeitstempel des Encoder-Pakets in der ENCODER-Zeitbasis
    /// (1/fps, ein Takt also ein Bildabstand) — nicht in RTP-Takten. Der
    /// AV1-Weg rechnet ihn selbst um (`av1::Av1Zustand::zeitstempel`); der
    /// H.264-Weg ignoriert ihn, dort stempelt webrtc-rs aus der Bilddauer.
    pub fn send(&self, data: &[u8], pts: Option<i64>) -> Result<()> {
        match &self.track {
            // H.264: webrtc-rs stempelt selbst aus der Bilddauer, `pts` bleibt
            // hier ungenutzt.
            Bildspur::Fremd(t) => {
                write_to_track(t, data, self.bild_sample_dauer).context("write_sample")
            }
            Bildspur::Selbst { zustand, pacer, track } => {
                let pakete: Vec<Packet> = {
                    let mut z = zustand.lock().expect("AV1-Zustand vergiftet");
                    // Alle Pakete eines Bildes tragen denselben Zeitstempel.
                    let ts = z.zeitstempel(pts);
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
    ///
    /// **Auch hier ueber [`dauer_fuer_takte`]**, obwohl der Ton die Falle heute
    /// nicht trifft: 5 ms mal 48000 faellt in f64 zufaellig knapp UEBER 240 und
    /// wird richtig abgeschnitten. Das ist ein Zufall der Darstellung, keine
    /// Absicht — bei einer anderen Paketlaenge (`OPUS_FRAME_MS`) kann es
    /// andersherum ausgehen, und dann liefe der TON weg statt des Bildes. Ein
    /// gemessener Fehler an einer Stelle heisst, dieselbe Stelle ueberall zu
    /// schliessen.
    pub fn send_audio(&self, data: &[u8], dauer: Duration) -> Result<()> {
        let takte = (dauer.as_secs_f64() * 48_000.0).round() as u32;
        write_to_track(&self.audio, data, dauer_fuer_takte(takte, 48_000))
            .context("write_sample audio")
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

#[cfg(test)]
mod tests {
    use super::*;

    /// **Genau die Rechnung, die webrtc-rs anstellt** — nachgebaut, damit der
    /// Test die Falle prueft und nicht unsere Absicht:
    /// `track_local_static_sample.rs`, `(dauer.as_secs_f64() * uhr) as u32`.
    fn wie_webrtc_rs(dauer: Duration, uhr: u32) -> u32 {
        (dauer.as_secs_f64() * f64::from(uhr)) as u32
    }

    /// Die alte Rechnung verliert bei 30 Bildern je Sekunde einen Takt je Bild.
    /// Dieser Test haelt den GEMESSENEN Fehler fest (2026-08-02, rund 20 ms je
    /// Minute); faellt er irgendwann weg, weil webrtc-rs rundet, darf die
    /// Zugabe verschwinden — vorher nicht.
    #[test]
    fn die_alte_rechnung_verliert_einen_takt() {
        let alt = Duration::from_secs_f64(1.0 / 30.0);
        assert_eq!(wie_webrtc_rs(alt, 90_000), 2999, "das war der Fehler");
        let verlust_je_minute = 30.0 * 60.0 * f64::from(3000 - 2999) / 90_000.0 * 1000.0;
        assert!((verlust_je_minute - 20.0).abs() < 0.001, "20 ms je Minute");
    }

    /// Und die berichtigte trifft — fuer jede Bildrate, die hier vorkommt.
    #[test]
    fn dauer_fuer_takte_trifft_den_takt() {
        for fps in [24u32, 25, 30, 50, 60, 90, 120, 144] {
            let takte = (90_000 + fps / 2) / fps;
            let d = dauer_fuer_takte(takte, 90_000);
            assert_eq!(wie_webrtc_rs(d, 90_000), takte, "fps {fps}");
            // Die Zugabe darf die Dauer nicht spuerbar verschieben: hoechstens
            // ein halber Takt, also 5,6 Mikrosekunden.
            let soll = f64::from(takte) / 90_000.0;
            assert!((d.as_secs_f64() - soll).abs() < 6e-6, "fps {fps} zu weit weg");
        }
    }

    /// Dasselbe fuer den Ton, ueber alle zulaessigen Opus-Paketlaengen.
    #[test]
    fn dauer_fuer_takte_trifft_auch_den_ton() {
        for ms in [2.5f64, 5.0, 10.0, 20.0, 40.0, 60.0] {
            let takte = (ms * 48.0).round() as u32;
            let d = dauer_fuer_takte(takte, 48_000);
            assert_eq!(wie_webrtc_rs(d, 48_000), takte, "{ms} ms");
        }
    }
}
