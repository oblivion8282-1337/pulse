//! Aufbau und Aushandlung der PeerConnection des Direktpfads.
//!
//! Der Sidecar ist hier ANTWORTER: das Angebot kommt vom Player, die Answer
//! geht als ein ganzer Block zurück (nicht-trickle — das Gathering läuft bis
//! zum Abschluss, bevor `connect` zurückkehrt). Derselbe Umriss wie
//! `infra/self-host/direct-adapter/src/rtc.rs::answer`, nur ohne Mux: jede
//! Sitzung hat ihren eigenen UDP-Socket, und genau deshalb sammelt
//! webrtc-rs hier srflx selbst — sobald ein STUN-Server steht. Der
//! srflx-Fallback ([`super::sdp`]) greift nur, wenn trotzdem keiner im
//! Answer landet.
//!
//! **Zwei Fallstricke aus dem Projekt sind hier eingebaut** (Plan
//! `docs/plans/2026-07-09-direct-path-webrtc.md`):
//!
//! 1. **rustls-CryptoProvider explizit wählen.** Ziehe zwei Provider in
//!    dieselbe Binary (hier: `ring` über webrtc), rät rustls NICHT und panict
//!    erst beim ersten DTLS-Handschlag — nicht beim Start. Im Sidecar-Graph
//!    ist `ring` heute der einzige Provider; die Wahl wird trotzdem
//!    ausgeschrieben, damit der Fehler, falls er je zuschlägt, beim Bau und
//!    nicht in der Fernwartung auffällt.
//! 2. **ICE-Filter ist Pflicht.** Schleifen- und virtuelle Adapter
//!    (Docker/vEthernet/WSL/…) liefern Kandidaten, auf deren Prüfung der
//!    Aufbau Zeit verschwendet — und auf Maschinen mit Hyper-V ist der
//!    erste Kandidat regelmäßig einer, den nur der eigene Rechner erreicht.

use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use webrtc::api::API;
use webrtc::api::setting_engine::SettingEngine;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;

use super::sdp::{self, host_kandidaten};
use super::stun;

/// Der STUN-Server des Direktpfads. Vorgabe der Schnittstelle; kein TURN —
/// Stufe 1 scheitert sichtbar, wenn die Leitung keinen Direktweg hergibt.
pub const STUN_URLS: &[&str] = &["stun:stun.l.google.com:19302"];

/// Obergrenze fürs Kandidaten-Sammeln, bevor der Answer trotzdem rausgeht —
/// derselbe Kompromiss wie im WHIP-Weg (`ICE_GATHERING_TIMEOUT` dort), nur
/// großzügiger: hier muss die STUN-Antwort des Heim-Routers mit hinein, und
/// der Answer ist die EINZIGE Chance (kein Trickle, keine Nachverhandlung).
const SAMMEL_TIMEOUT: Duration = Duration::from_secs(5);

/// Wählt den rustls-Krypto-Provider einmalig und explizit. Begründung im
/// Modulkopf; zweiter Aufruf ist ein No-op (Provider steht dann schon).
pub fn sorge_krypto_provider() {
    use rustls::crypto::CryptoProvider;
    let _ = CryptoProvider::install_default(rustls::crypto::ring::default_provider());
}

/// Ist das ein Interface, auf dem ein ICE-Kandidat Sinn hat?
///
/// Namensfilter für die üblichen Verdächtigen — die Liste ist der Vorlage aus
/// dem Projektplan nachempfunden und deckt Linux- wie Windows-Namen ab:
/// Schleife, Container-Bridges, Hyper-V/WSL- und VMware-Adapter, VPN-Zwänge.
/// Ein Kandidat auf solchen Adaptern macht die ICE-Prüfung nicht nur
/// sinnlos-lang, er ist regelmäßig DER Grund, warum der falsche Weg gewinnt.
fn nuetzliches_interface(name: &str) -> bool {
    const VIRTUELL: &[&str] = &[
        "loopback", "docker", "vethernet", "veth", "virbr", "br-", "wsl", "vmware",
        "virtualbox", "hyper-v", "tailscale", "hamachi", "zerotier", "bluetooth",
    ];
    let n = name.to_ascii_lowercase();
    !VIRTUELL.iter().any(|m| n.contains(m))
}

/// Ist das eine Adresse, die ein Gegenstelle erreichen könnte?
///
/// IPv6 bleibt bewusst draußen — derselbe Schnitt wie im direct-adapter: der
/// IPv6-Leak aus virtuellen Adaptern hat bei WHEP schon minutenlange
/// Aufbauten verursacht, und der Heim-Sidecar hat seinen Weg über IPv4 plus
/// srflx. Docker-Bridges (172.16/12) und CGNAT/Tailscale (100.64/10) raus,
/// Loopback und Link-Local ebenfalls.
fn nuetzliche_ip(ip: IpAddr) -> bool {
    let IpAddr::V4(v4) = ip else { return false };
    let [a, b, ..] = v4.octets();
    let docker_bridge = a == 172 && (16..=31).contains(&b);
    let cgnat_tailscale = a == 100 && (64..=127).contains(&b);
    !(docker_bridge || cgnat_tailscale || v4.is_loopback() || v4.is_link_local())
}

/// Die fertige webrtc-rs-API des Direktpfads: dieselbe Media-Engine wie der
/// WHIP-Weg (genau unsere Codecs, Bildmarke, Standard-Interceptor samt
/// NACK-Responder), aber mit Setting-Engine für die ICE-Filter.
pub fn baue_api(
    video: &RTCRtpCodecCapability,
    audio: &RTCRtpCodecCapability,
) -> Result<API> {
    let mut se = SettingEngine::default();
    se.set_interface_filter(Box::new(nuetzliches_interface));
    se.set_ip_filter(Box::new(nuetzliche_ip));
    crate::sdp::baue_api_mit_settings(video, audio, se)
}

/// Beantwortet ein Angebot vollständig: Offer setzen, Answer erzeugen,
/// Kandidaten sammeln (nicht-trickle), srflx notfalls nachreichen.
/// Liefert den fertigen Answer-SDP-Text.
pub async fn beantworte(pc: &Arc<RTCPeerConnection>, offer_sdp: &str) -> Result<String> {
    pc.set_remote_description(RTCSessionDescription::offer(offer_sdp.to_owned())?)
        .await
        .context("Angebot annehmen")?;

    let antwort = pc.create_answer(None).await.context("Answer erzeugen")?;
    pruefe_medien(&antwort.sdp)?;

    // Nicht-trickle: die Zusage muss VOR `set_local_description` stehen
    // (dieselbe Reihenfolge wie im WHIP-Weg und im direct-adapter), danach
    // wird aufs Ende des Sammelns gewartet.
    let mut gesammelt = pc.gathering_complete_promise().await;
    pc.set_local_description(antwort)
        .await
        .context("Answer als lokale Beschreibung setzen")?;
    let _ = tokio::time::timeout(SAMMEL_TIMEOUT, gesammelt.recv()).await;

    let lokal = pc
        .local_description()
        .await
        .context("keine local description nach dem Sammeln")?;
    if lokal.sdp.contains(" typ srflx") {
        return Ok(lokal.sdp);
    }
    // Der Regelfall ist hier NICHT der Fall: ohne gesammeltes srflx (STUN
    // blockiert, Zeitablauf) reichen wir die Außenadresse nach. Scheitert
    // auch das, geht der Answer mit den Host-Kandidaten raus — im Heimnetz
    // trägt der, von außen nicht; die Meldung sagt, woran es lag.
    match srflx_nachreichen(&lokal.sdp).await {
        Ok(sdp) => Ok(sdp),
        Err(e) => {
            eprintln!("[direct] srflx-Nachreichen fehlgeschlagen: {e:#} — \
                       Answer enthält nur Host-Kandidaten");
            Ok(lokal.sdp)
        }
    }
}

/// Ein Answer, dessen m-Lines auf Port 0 stehen, ist eine ABLEHNUNG — der
/// Player bekäme keinen Strom und wir eine vermeintlich erfolgreiche
/// Aushandlung. Beides ist der Fehlerklasse „sieht gesund aus, antwortet auf
/// eine andere Frage" zuzurechnen: lieber hier mit klarem Text abbrechen.
fn pruefe_medien(answer_sdp: &str) -> Result<()> {
    for (marke, spur) in [("m=video 0", "Bild"), ("m=audio 0", "Ton")] {
        if answer_sdp.lines().any(|l| l.starts_with(marke)) {
            bail!(
                "die Gegenseite bietet unsere {spur}-Fassung nicht an — \
                 Answer hätte die {spur}-Spur abgelehnt"
            );
        }
    }
    Ok(())
}

/// Ermittelt die öffentliche Adresse per STUN und hängt die srflx-Kandidaten
/// an. Probiert zuerst denselben Port wie der Host-Kandidat (Port-
/// Preservation macht den Kandidaten dann vollständig richtig), fällt auf
/// einen Wegwerf-Port zurück, wenn der belegt ist (dann stimmt wenigstens
/// die IP — Begründung in [`super::sdp`]).
async fn srflx_nachreichen(sdp_text: &str) -> Result<String> {
    let hosts = host_kandidaten(sdp_text);
    anyhow::ensure!(!hosts.is_empty(), "keine Host-Kandidaten im Answer");

    let mut oeffentlich = None;
    for k in &hosts {
        if let Ok(a) = stun::oeffentliche_adresse(Some(k.port)).await {
            oeffentlich = Some(a);
            break;
        }
    }
    let oeffentlich = match oeffentlich {
        Some(a) => a,
        None => stun::oeffentliche_adresse(None).await.context("STUN-Probe auf Wegwerf-Port")?,
    };
    eprintln!(
        "[direct] srflx nachgereicht: {oeffentlich} ({} Host-Kandidaten)",
        hosts.len()
    );
    Ok(sdp::inject_srflx(sdp_text, oeffentlich))
}

/// Die ICE-Konfiguration des Direktpfads: STUN ja, TURN nein, keine
/// weiteren Server.
pub fn eis_konfiguration() -> RTCConfiguration {
    RTCConfiguration {
        ice_servers: vec![RTCIceServer {
            urls: STUN_URLS.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }],
        ..Default::default()
    }
}
