//! DTLS-Identität des Adapters: persistentes Zertifikat + Fingerprint.
//!
//! Das Zertifikat MUSS Neustarts überleben (`/data/direct-adapter/cert.pem`),
//! sonst bricht das TOFU-Pinning der Clients bei jedem Container-Restart.
//! Fingerprint-Format wie die SDP-Zeile: "sha-256 AB:CD:…" — exakt das, was
//! die Cloud im Telefonbuch speichert und Clients später vergleichen.

use std::path::PathBuf;

use anyhow::{Context, Result};
use webrtc::peer_connection::certificate::RTCCertificate;

pub struct Identity {
    pub certificate: RTCCertificate,
    /// "sha-256 <hex-doppelpunkt-getrennt>"
    pub fingerprint: String,
}

fn cert_path(data_path: &str) -> PathBuf {
    PathBuf::from(data_path).join("direct-adapter").join("cert.pem")
}

/// Lädt das persistierte Zertifikat oder erzeugt + speichert ein neues.
pub fn load_or_create(data_path: &str) -> Result<Identity> {
    let path = cert_path(data_path);
    let certificate = match std::fs::read_to_string(&path) {
        Ok(pem) => RTCCertificate::from_pem(&pem)
            .with_context(|| format!("Zertifikat unlesbar: {}", path.display()))?,
        Err(_) => {
            let key_pair = rcgen::KeyPair::generate()?;
            let cert = RTCCertificate::from_key_pair(key_pair)
                .context("Zertifikat-Erzeugung fehlgeschlagen")?;
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            std::fs::write(&path, cert.serialize_pem())?;
            cert
        }
    };
    let fp = certificate
        .get_fingerprints()
        .into_iter()
        .next()
        .context("Zertifikat ohne Fingerprint")?;
    Ok(Identity {
        fingerprint: format!("{} {}", fp.algorithm, fp.value.to_uppercase()),
        certificate,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_then_reload_keeps_fingerprint() {
        let dir = std::env::temp_dir().join(format!("da-test-{}", std::process::id()));
        let data = dir.to_string_lossy().to_string();
        let first = load_or_create(&data).unwrap();
        let second = load_or_create(&data).unwrap();
        assert_eq!(first.fingerprint, second.fingerprint);
        assert!(first.fingerprint.starts_with("sha-256 "));
        std::fs::remove_dir_all(&dir).ok();
    }
}
