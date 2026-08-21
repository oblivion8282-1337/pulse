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
//! herein ([`WhipSender::send`]), werden dort in RTP-Pakete zerlegt und
//! gehen — per Vorgabe ueber den Taktgeber [`pacer`] verteilt — als
//! `write_rtp` hinaus. Ein eigener Faden liest das zurueckkommende RTCP und
//! ruft bei PLI oder FIR [`crate::keyframe::request_keyframe`].
//!
//! **Nicht-Trickle.** WHIP ist ein einziger POST mit dem fertigen Angebot,
//! deshalb wird das Sammeln der ICE-Kandidaten abgewartet. Das unterscheidet
//! diesen Weg von `pulse-remote-webrtc` (Fernsteuerung), das als Answerer mit
//! Trickle-ICE arbeitet — dieselben Bauteile, andere Form.
//!
//! **Eine Bildspur, immer selbst gestempelt.** Die Spur ist fuer beide Codecs
//! eine `TrackLocalStaticRTP` — Reihenfolge, Marker-Bit und Zeitstempel setzt
//! dieser Weg selbst, und der WERT des Zeitstempels kommt aus dem `pts`, den
//! der Encoder mitgibt, nicht aus einem eigenen Zaehler (Begruendung an
//! `av1::SpurZustand::zeitstempel`). Nur die ZERLEGUNG unterscheidet sich:
//! AV1 paketiert ein eigener Paketierer (webrtc-rs' `Av1Payloader` schreibt
//! Laengenfelder ab 128 falsch — Nachweis und Zahlen in [`av1`]), H.264
//! zerlegt webrtc-rs' `H264Payloader` (Annex-B → FU-A/STAP-A, daran ist
//! nichts auszusetzen). **Bis 2026-08-14 lief H.264 als Sample-Spur**, bei
//! der webrtc-rs den Zeitstempel aus einer FESTEN Bilddauer hochzaehlte —
//! jedes ausgelassene Bild (verspaeteter Takt, EAGAIN-Verwurf) verschob die
//! Video-Uhr dauerhaft gegen Wanduhr und Ton. Fuer AV1 war genau das am
//! 2026-08-03 behoben worden; H.264 zieht hiermit nach.
//!
//! **Und das ist jetzt der einzige Schutz.** Seit `av1.rs` und `sdp.rs` am
//! 2026-08-20 gemeinsam in `pulse-whip` liegen, sind `mod.rs` und `pacer.rs`
//! die beiden LETZTEN Dateien des Sendewegs, die noch je Plattform doppelt
//! vorliegen — und kein Test haelt sie zusammen.

pub mod bildmarke;
pub mod av1;
mod bandbreite;
mod pacer;
mod sdp;
pub mod senke;

use av1::SpurZustand;

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use bytes::Bytes;
use rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
use rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use rtcp::payload_feedbacks::receiver_estimated_maximum_bitrate::ReceiverEstimatedMaximumBitrate;
use tokio::runtime::Runtime;
use webrtc::api::media_engine::MIME_TYPE_AV1;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::media::Sample;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp::codecs::h264::H264Payloader;
use webrtc::rtp::header::Header;
use webrtc::rtp::packet::Packet;
use webrtc::rtp::packetizer::Payloader;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::{TrackLocal, TrackLocalWriter};

/// Obergrenze fuers Sammeln der ICE-Kandidaten, bevor das Angebot trotzdem
/// rausgeht. Wie im Player (`pulse-player/src/whep.rs`).
const ICE_GATHERING_TIMEOUT: Duration = Duration::from_secs(2);

/// Der Server hat den Sendeweg abgewiesen — eine Aussage ueber die
/// BERECHTIGUNG, nicht ueber die Hardware.
///
/// **Wozu ein eigener Typ statt `bail!` mit Text.** Der Aufrufer in
/// `encode/bildencoder.rs` faengt beim Codec AV1 jeden Fehler ab und faellt auf
/// H.264 zurueck — gedacht fuer NVIDIA-Karten vor Ada, die AV1 gar nicht
/// koennen. Ein HTTP 401 lief da mit hinein und kam beim Nutzer als
/// „av1 HW encoder nicht verfuegbar" an, samt stillem Codec-Wechsel. Ein
/// abgelaufener Token gab sich damit als Eigenschaft der Grafikkarte aus und
/// schickte die Fehlersuche in die falsche Ecke (am 2026-08-05 gegen die
/// Produktion beobachtet).
///
/// Auf den Text zu pruefen waere die naheliegende Abkuerzung und genau so
/// bruechig, wie sie klingt: die Meldung wandert, und niemand merkt es.
/// Deshalb ein Marker, den `bildencoder.rs` per `downcast_ref` findet.
///
/// Traegt nur den Status, nicht die URL — die enthaelt den Publish-Token
/// (s. die `map_err`-Begruendung beim POST weiter unten).
#[derive(Debug, Clone, Copy)]
pub struct SendewegAbgewiesen(pub u16);

impl std::fmt::Display for SendewegAbgewiesen {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "der Server hat den Sendeweg abgewiesen (HTTP {}) — Zugangsdaten \
             oder Kanal pruefen, nicht den Encoder",
            self.0
        )
    }
}

impl std::error::Error for SendewegAbgewiesen {}

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
/// diese hier ist ausschliesslich die Uebergabe an webrtc-rs. (Seit
/// 2026-08-14 geht nur noch der TON hier durch — das Bild stempelt selbst,
/// s. Modulkopf; die Video-Zahlen oben bleiben als Beleg der Falle stehen.)
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


/// Wie ein encodiertes Bild in RTP-Nutzlasten zerfaellt.
enum Paketierer {
    /// Eigener AV1-Paketierer (s. [`av1`]).
    Av1,
    /// webrtc-rs' H.264-Zerleger (Annex-B → FU-A/STAP-A). Stateful: er merkt
    /// sich SPS/PPS und buendelt sie vor jedes Vollbild — deshalb liegt er
    /// mit im Spur-Zustand unter dem Lock.
    H264(H264Payloader),
}

/// Die Bildspur: eigene RTP-Pakete fuer beide Codecs.
struct Bildspur {
    /// Zeitstempel-/Sequenz-Zustand + Paketierer unter EINEM Lock — beides
    /// wird pro Bild in einem Zug gebraucht.
    zustand: Mutex<(SpurZustand, Paketierer)>,
    /// Verteilt die Pakete eines Bildes ueber die Zeit statt sie als Schwall
    /// zu senden (Zahlen in [`pacer`]). `PULSE_WHIP_PACING=0` schaltet die
    /// Verteilung zum Gegenmessen ab.
    pacer: Option<pacer::Pacer>,
    track: Arc<TrackLocalStaticRTP>,
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
    /// Die ausgehandelte Nummer der Bildmarke; 0 = nicht ausgehandelt.
    ///
    /// Atomar, weil sie erst NACH dem Handschlag feststeht, `send` aber nur
    /// `&self` hat. Null als „gibt es nicht" ist zulaessig: RFC 8285 vergibt
    /// die Nummern ab 1.
    marken_id: std::sync::atomic::AtomicU8,
}

/// Eine REMB-Schaetzung der Gegenseite einordnen: melden, was die Wacht sagt,
/// und im eigenen Takt eine Zeile fuers Messprotokoll.
///
/// Getrennt vom RTCP-Leser, damit dessen Schleife von Lesefehlern handelt und
/// nicht von Bandbreite. Die beiden Meldungen unterscheiden sich NUR im
/// Ereignisnamen und im Wortlaut der Log-Zeile — das Ereignis selbst wird
/// deshalb an einer Stelle abgesetzt.
fn remb_auswerten(wacht: &mut bandbreite::BandbreitenWacht, bps: f32, ziel_kbps: u32) {
    let jetzt = std::time::Instant::now();
    if let Some(meldung) = wacht.messung(bps, jetzt) {
        let (ev, schaetzung_kbps) = match meldung {
            bandbreite::Meldung::Eng { schaetzung_kbps } => {
                eprintln!(
                    "[whip] Leitung eng: Gegenseite schätzt {schaetzung_kbps} kbps, \
                     Ziel {ziel_kbps} kbps"
                );
                ("bandwidth_low", schaetzung_kbps)
            }
            bandbreite::Meldung::Erholt { schaetzung_kbps } => {
                eprintln!(
                    "[whip] Leitung wieder tragfähig: {schaetzung_kbps} kbps (Ziel {ziel_kbps})"
                );
                ("bandwidth_ok", schaetzung_kbps)
            }
        };
        crate::events::emit(serde_json::json!({
            "ev": ev,
            "estimate_kbps": schaetzung_kbps,
            "target_kbps": ziel_kbps,
        }));
    }
    if wacht.log_faellig(jetzt) {
        eprintln!("[whip] REMB: Gegenseite schätzt {:.0} kbps", bps / 1000.0);
    }
}

/// Traegt dieser H.264-Zeitabschnitt ein Vollbild (IDR)?
///
/// Der Payloader von webrtc-rs sagt es nicht, und die Bildmarke braucht es fuer
/// die Wahl der Schablone. Gesucht wird ueber die Annex-B-Startcodes, weil der
/// Encoder in diesem Format liefert — dasselbe, was `H264Payloader` erwartet.
///
/// H.264-Vollbild-Erkennung — liegt seit dem 2026-08-21 gemeinsam in
/// `pulse-whip::h264`. Hier nur noch durchgereicht, damit die Aufrufstelle
/// unveraendert bleibt.
use pulse_whip::h264::h264_ist_vollbild;

impl WhipSender {
    /// Baut die Sitzung auf und kehrt zurueck, sobald das Angebot beantwortet
    /// ist. Blockiert den aufrufenden (synchronen) Faden waehrenddessen.
    pub fn connect(
        url: &str,
        codec: &str,
        fps: u32,
        breite: u32,
        hoehe: u32,
        bitrate_kbps: u32,
    ) -> Result<Self> {
        let cap = sdp::codec_capability(codec, breite, hoehe, fps)?;
        let fps = fps.max(1);
        runtime().block_on(async move { Self::connect_async(url, cap, fps, bitrate_kbps).await })
    }

    async fn connect_async(
        url: &str,
        cap: RTCRtpCodecCapability,
        fps: u32,
        bitrate_kbps: u32,
    ) -> Result<Self> {
        // Der echte Bildabstand — geht an den Taktgeber (`pacer`). Die
        // Bild-Zeitstempel selbst kommen aus dem Encoder-`pts`
        // (`av1::SpurZustand::zeitstempel`), nicht aus einer Dauer.
        let frame_duration = Duration::from_secs_f64(1.0 / f64::from(fps));

        // Baut die Media-Engine so, dass im Angebot GENAU unsere beiden
        // Fassungen stehen (Begruendung und Messung im Kopf von [`sdp`]).
        let audio_cap = sdp::opus_capability();
        let api = sdp::baue_api(&cap, &audio_cap)?;

        // Kein STUN: der Weg zum eigenen Server laeuft entweder ueber die
        // Schleife oder ueber eine gewoehnliche ausgehende Verbindung. Ein
        // STUN-Server waere ein zusaetzlicher Aussenkontakt ohne Nutzen.
        let config = RTCConfiguration { ice_servers: vec![RTCIceServer::default()], ..Default::default() };
        let pc = Arc::new(api.new_peer_connection(config).await?);

        // Beide Codecs stempeln selbst; nur der Zerleger unterscheidet sich
        // (Grund und Nachweis in [`av1`] bzw. im Modulkopf).
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
            // AN als Vorgabe seit dem Neubau mit absoluten Zeitpunkten und
            // Paket-Gruppen (s. [`pacer`]); `PULSE_WHIP_PACING=0` ist der
            // Gegenmess-Schalter.
            pacer: (std::env::var("PULSE_WHIP_PACING").as_deref() != Ok("0")).then(|| {
                pacer::Pacer::start(runtime(), Arc::clone(&video_track), frame_duration)
            }),
            track: video_track,
        };
        let sender = pc
            .add_track(Arc::clone(&track.track) as Arc<dyn TrackLocal + Send + Sync>)
            .await?;
        // Zweite Referenz: `sender` wandert gleich in die RTCP-Schleife, die
        // ausgehandelte Nummer der Bildmarke steht aber erst nach dem
        // Handschlag fest und wird weiter unten gelesen.
        let sender_fuer_marke = Arc::clone(&sender);

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
            // REMB nicht mehr wegwerfen: die Bandbreitenschätzung der
            // Gegenseite wird eingeordnet und als Event gemeldet
            // (`bandbreite.rs` — Meldung, keine automatische Adaption).
            let mut bandbreite = bandbreite::BandbreitenWacht::neu(bitrate_kbps);
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
                            eprintln!("[whip] RTCP-Lesen beendet: {e}");
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        continue;
                    }
                };
                for p in &pakete {
                    let any = p.as_any();
                    if let Some(remb) = any.downcast_ref::<ReceiverEstimatedMaximumBitrate>() {
                        remb_auswerten(&mut bandbreite, remb.bitrate, bitrate_kbps);
                        continue;
                    }
                    if any.downcast_ref::<PictureLossIndication>().is_some()
                        || any.downcast_ref::<FullIntraRequest>().is_some()
                    {
                        if antworten {
                            crate::keyframe::request_keyframe();
                        }
                        angefordert += 1;
                        // JEDE melden, nicht nur jede zwanzigste. Der erste
                        // Anlauf meldete "die erste und dann jede zwanzigste" —
                        // damit sahen 1 und 19 Anforderungen identisch aus, und
                        // genau diese Unterscheidung war die Frage. Sie sind
                        // selten genug (rund zehn in 18 s bei 3 % Verlust), als
                        // dass das Log ueberliefe.
                        eprintln!("[whip] Vollbild angefordert (insgesamt {angefordert})");
                    }
                }
            }
        });

        let (resource_url, http) = Self::negotiate(&pc, url).await?;

        // Die Nummer, unter der die Bildmarke ausgehandelt wurde. Nach
        // `set_remote_description` liefert webrtc-rs hier genau die
        // ausgehandelten Erweiterungen; kennt der Server sie nicht, ist die
        // Liste leer und wir schreiben nichts. Der Zuschauer urteilt dann gar
        // nicht — „Marke oder nichts".
        let marken_id = sender_fuer_marke
            .get_parameters()
            .await
            .rtp_parameters
            .header_extensions
            .iter()
            .find(|e| e.uri == bildmarke::EXTMAP_URI)
            .map_or(0u8, |e| u8::try_from(e.id).unwrap_or(0));
        // Anders als der Linux-Zwilling schreibt dieser Sidecar mit `eprintln!`
        // nach stderr (Electron fängt das in `sidecar.log` auf) — `tracing`
        // ist hier weder Abhängigkeit noch je initialisiert. Eine gespiegelte
        // `tracing::info!` übersetzt deshalb gar nicht erst; und `tracing`
        // bloß nachzurüsten wäre die schlechtere Reparatur gewesen, weil sie
        // ohne Subscriber wortlos verschluckt würde — ausgerechnet die Zeile,
        // an der der Nachweis der Bildmarke hängt.
        match marken_id {
            0 => eprintln!(
                "[whip] Bildmarke nicht ausgehandelt — der Zuschauer kann fehlende Bilder \
                 nicht erkennen (Server ohne Patch 0006?)"
            ),
            id => eprintln!("[whip] Bildmarke ausgehandelt als extmap {id}"),
        }

        Ok(Self {
            track,
            audio,
            pc,
            resource_url,
            http,
            marken_id: std::sync::atomic::AtomicU8::new(marken_id),
        })
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
            .map_err(|e| anyhow!("WHIP-Server nicht erreichbar: {}", crate::redact::secrets(&e.to_string())))?;
        if !res.status().is_success() {
            return Err(anyhow::Error::new(SendewegAbgewiesen(res.status().as_u16())));
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
    /// — und die ist seit dem 2026-08-14 dieselbe 90-kHz-Uhr wie RTP
    /// (`crate::zeitbasis`). Beide Codec-Wege reichen ihn deshalb unveraendert
    /// durch (`av1::SpurZustand::zeitstempel`).
    pub fn send(&self, data: &[u8], pts: Option<i64>) -> Result<()> {
        let Bildspur { zustand, pacer, track } = &self.track;
        let pakete: Vec<Packet> = {
            let mut g = zustand.lock().expect("Spur-Zustand vergiftet");
            let (z, paketierer) = &mut *g;
            // Alle Pakete eines Bildes tragen denselben Zeitstempel.
            let ts = z.zeitstempel(pts);
            let marken_id = self.marken_id.load(std::sync::atomic::Ordering::Relaxed);
            // Erst paketieren, DANN nummerieren. Geht nichts hinaus, wird auch
            // keine Bildnummer verbraucht — daran erkennt der Zuschauer, dass
            // nichts verlorenging (`crate::whip::bildmarke`).
            //
            // Je Eintrag: Nutzlast, erstes Paket, letztes Paket, Vollbild.
            let teile: Vec<(Bytes, bool, bool, bool)> = match paketierer {
                Paketierer::Av1 => av1::paketiere(data, av1::MTU)?
                    .into_iter()
                    .map(|p| (Bytes::from(p.daten), p.erstes, p.letztes, p.vollbild))
                    .collect(),
                Paketierer::H264(p) => {
                    // Der Payloader von webrtc-rs sagt nicht, ob ein Vollbild
                    // dabei war; die Bildmarke braucht es fuer die Schablone.
                    let vollbild = h264_ist_vollbild(data);
                    let teile = p
                        .payload(av1::MTU, &Bytes::copy_from_slice(data))
                        .context("H.264 paketieren")?;
                    // Leer ist legitim: ein Paket, das nur SPS/PPS trug, wird
                    // vom Payloader gemerkt und erst vor dem naechsten
                    // Vollbild ausgegeben.
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
                        // Ein Fehler waere hier ein Programmierfehler (unzu-
                        // laessige Nummer), kein Betriebsfall. Ein Strom ohne
                        // Marke ist besser als kein Strom, deshalb kein `?`.
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
                    runtime().block_on(track.write_rtp(&paket)).context("write_rtp")?;
                }
                Ok(())
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

    /// Die Bildmarke waehlt ihre Schablone daran. Ein SPS/PPS-Paket ohne
    /// Vollbild darf NICHT als Vollbild gelten — der Payloader haelt es
    /// zurueck, und eine Schablone fuer ein Bild, das gar nicht hinausgeht,
    /// waere schon deshalb falsch.
    #[test]
    fn h264_idr_wird_erkannt() {
        assert!(h264_ist_vollbild(&[0, 0, 0, 1, 0x65, 0xAA]), "langer Startcode, NAL-Typ 5");
        assert!(h264_ist_vollbild(&[0, 0, 1, 0x65, 0xAA]), "kurzer Startcode, NAL-Typ 5");
        assert!(!h264_ist_vollbild(&[0, 0, 0, 1, 0x41, 0xAA]), "NAL-Typ 1 ist ein Differenzbild");
        assert!(
            h264_ist_vollbild(&[0, 0, 1, 0x67, 0, 0, 1, 0x68, 0, 0, 1, 0x65]),
            "SPS und PPS vor dem IDR"
        );
        assert!(!h264_ist_vollbild(&[0, 0, 1, 0x67, 0, 0, 1, 0x68]), "SPS und PPS allein");
        assert!(!h264_ist_vollbild(&[]));
        assert!(!h264_ist_vollbild(&[0, 0, 1]), "Startcode ohne Kopf laeuft nicht ueber");
    }
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
