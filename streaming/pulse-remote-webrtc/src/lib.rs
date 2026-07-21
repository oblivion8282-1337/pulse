//! Pulse Remote-Control — plattformunabhängiger WebRTC-Kern.
//!
//! Eine `RemoteSession` ist genau eine Steuer-Verbindung Host↔Controller:
//! webrtc-rs-PeerConnection (DTLS/SRTP/ICE), ein H.264-Video-Track, in den der
//! Host seine encodierten Frames füttert, und ein DataChannel, über den der
//! Controller Input schickt. Diese Crate hat **keine** ffmpeg-/Windows-
//! Abhängigkeit: der H.264-Bitstrom kommt als rohe Bytes rein (`feed_frame`),
//! der Input geht als rohe Bytes über einen Callback raus (`on_input`) — der
//! Sidecar hängt dort seine `SendInput`-Injektion an. Dadurch auf Linux voll
//! test- und wiederverwendbar (auch für den mac-Sidecar).
//!
//! Signaling ist **Trickle-ICE** und protokoll-agnostisch: der Controller ist
//! der Offerer (wie im Interop-Spike bewiesen), die Session ist der Answerer.
//! `handle_offer` gibt die Answer sofort zurück; ICE-Kandidaten fließen einzeln
//! über `on_local_ice` raus und `add_ice` rein — das passt zum
//! `remote_signal{kind:offer|answer|ice}`-Relay des chat-gateways.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use bytes::Bytes;
use rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
use rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_H264};
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::media::Sample;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

/// Ein STUN-/TURN-Server. `username`/`credential` leer lassen für reines STUN.
#[derive(Clone, Debug, Default)]
pub struct IceServer {
    pub urls: Vec<String>,
    pub username: String,
    pub credential: String,
}

impl IceServer {
    pub fn stun(url: impl Into<String>) -> Self {
        Self { urls: vec![url.into()], ..Default::default() }
    }
}

type InputCb = Arc<dyn Fn(Bytes) + Send + Sync>;
type IceCb = Arc<dyn Fn(String) + Send + Sync>;
type StateCb = Arc<dyn Fn(String) + Send + Sync>;
type KeyframeCb = Arc<dyn Fn() + Send + Sync>;

/// Aufbau-Parameter einer Session. Die drei Callbacks müssen `Send + Sync` sein,
/// weil webrtc-rs sie aus seinen eigenen Tasks aufruft.
#[derive(Clone)]
pub struct SessionConfig {
    pub ice_servers: Vec<IceServer>,
    /// Rohe Bytes eines DataChannel-Frames vom Controller (Input). Der Sidecar
    /// dekodiert sie und ruft `SendInput`. Auf Linux nur geloggt.
    pub on_input: InputCb,
    /// Ein lokaler ICE-Kandidat (JSON von `RTCIceCandidateInit`) → der Caller
    /// reicht ihn per `remote_signal{kind:ice}` an den Controller weiter.
    pub on_local_ice: IceCb,
    /// Verbindungszustand als String ("connected"/"failed"/...).
    pub on_state: StateCb,
    /// Der Controller bittet per RTCP-PLI/FIR um ein Keyframe — beim
    /// Verbindungsaufbau und nach Paketverlust. Der Sidecar forced daraufhin ein
    /// IDR im Encoder; sonst wartet der Viewer bis zum nächsten GOP-Keyframe
    /// (bis ~2 s → sichtbare Startverzögerung). Auf Linux nur geloggt.
    pub on_keyframe_request: KeyframeCb,
}

pub struct RemoteSession {
    pc: Arc<RTCPeerConnection>,
    video: Arc<TrackLocalStaticSample>,
}

impl RemoteSession {
    /// Baut die PeerConnection, hängt den H.264-Track ein und verdrahtet die
    /// Callbacks. Der DataChannel wird vom Controller eröffnet (`on_data_channel`).
    pub async fn new(config: SessionConfig) -> Result<Self> {
        let mut media = MediaEngine::default();
        media.register_default_codecs()?;
        let mut registry = Registry::new();
        registry = register_default_interceptors(registry, &mut media)?;
        let api = APIBuilder::new()
            .with_media_engine(media)
            .with_interceptor_registry(registry)
            .build();

        let ice_servers = config
            .ice_servers
            .iter()
            .map(|s| RTCIceServer {
                urls: s.urls.clone(),
                username: s.username.clone(),
                credential: s.credential.clone(),
                ..Default::default()
            })
            .collect();
        // ICE-Policy `All`: direkt-first, TURN nur als Fallback (Messung
        // 2026-07-21: reine Consumer-Anschlüsse brauchen oft TURN).
        let pc = Arc::new(
            api.new_peer_connection(RTCConfiguration { ice_servers, ..Default::default() })
                .await?,
        );

        let video = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability {
                mime_type: MIME_TYPE_H264.to_owned(),
                clock_rate: 90000,
                sdp_fmtp_line:
                    "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"
                        .to_owned(),
                ..Default::default()
            },
            "video".to_owned(),
            "pulse-remote".to_owned(),
        ));
        let sender = pc
            .add_track(Arc::clone(&video) as Arc<dyn TrackLocal + Send + Sync>)
            .await?;
        // RTCP vom Controller lesen: ein PLI (Picture Loss Indication) oder FIR
        // (Full Intra Request) ist eine Keyframe-Bitte (Verbindungsstart / nach
        // Paketverlust) → Callback, der Sidecar forced dann ein IDR. Die übrigen
        // RTCP-Pakete (NACK/REMB) werden verworfen, MÜSSEN aber gelesen werden,
        // sonst staut der Sender.
        let keyframe_cb = config.on_keyframe_request.clone();
        tokio::spawn(async move {
            while let Ok((packets, _)) = sender.read_rtcp().await {
                for pkt in &packets {
                    let any = pkt.as_any();
                    if any.downcast_ref::<PictureLossIndication>().is_some()
                        || any.downcast_ref::<FullIntraRequest>().is_some()
                    {
                        keyframe_cb();
                    }
                }
            }
        });

        // Lokale ICE-Kandidaten einzeln nach außen reichen (Trickle).
        let ice_cb = config.on_local_ice.clone();
        pc.on_ice_candidate(Box::new(move |cand| {
            let ice_cb = ice_cb.clone();
            Box::pin(async move {
                if let Some(c) = cand {
                    if let Ok(init) = c.to_json() {
                        if let Ok(json) = serde_json::to_string(&init) {
                            ice_cb(json);
                        }
                    }
                }
            })
        }));

        let state_cb = config.on_state.clone();
        pc.on_peer_connection_state_change(Box::new(move |s| {
            state_cb(s.to_string());
            Box::pin(async {})
        }));

        // Input-DataChannel: der Controller eröffnet ihn; jede Nachricht → Callback.
        let input_cb = config.on_input.clone();
        pc.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
            let input_cb = input_cb.clone();
            Box::pin(async move {
                dc.on_message(Box::new(move |msg: DataChannelMessage| {
                    input_cb(msg.data);
                    Box::pin(async {})
                }));
            })
        }));

        Ok(Self { pc, video })
    }

    /// Remote-Offer setzen, Answer erzeugen und sofort zurückgeben (Trickle:
    /// nicht auf ICE-Gathering warten — Kandidaten kommen über `on_local_ice`).
    pub async fn handle_offer(&self, offer_sdp: &str) -> Result<String> {
        let offer = RTCSessionDescription::offer(offer_sdp.to_owned())?;
        self.pc.set_remote_description(offer).await?;
        let answer = self.pc.create_answer(None).await?;
        self.pc.set_local_description(answer).await?;
        self.pc
            .local_description()
            .await
            .map(|d| d.sdp)
            .ok_or_else(|| anyhow!("keine local description nach set_local_description"))
    }

    /// Einen Remote-ICE-Kandidaten (JSON von `RTCIceCandidateInit`) hinzufügen.
    pub async fn add_ice(&self, candidate_json: &str) -> Result<()> {
        let init: RTCIceCandidateInit = serde_json::from_str(candidate_json)?;
        self.pc.add_ice_candidate(init).await?;
        Ok(())
    }

    /// Einen encodierten H.264-Frame (Annex-B/AVCC, ganze Access-Unit) an den
    /// Track geben. webrtc-rs paketiert ihn selbst in RTP. `duration` = 1/fps.
    pub async fn feed_frame(&self, data: Bytes, duration: Duration) -> Result<()> {
        self.video
            .write_sample(&Sample { data, duration, ..Default::default() })
            .await?;
        Ok(())
    }

    pub async fn close(&self) -> Result<()> {
        self.pc.close().await?;
        Ok(())
    }
}
