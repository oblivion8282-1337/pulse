//! stdio-JSON-RPC — identisches Rahmenformat wie die HQ-Capture-Sidecars.
//!
//! Eine JSON-Zeile pro Nachricht:
//!   Request   `{"op": "...", "id": 1, ...}`      (`id` optional)
//!   Response  `{"id": 1, "ok": true, ...}`       (`error` statt Nutzdaten bei `ok=false`)
//!   Event     `{"ev": "...", ...}`               (kein `id`, kein `ok`)
//!
//! WICHTIG: stdout gehoert ausschliesslich dem Protokoll. Jede Diagnose geht
//! nach stderr, sonst zerlegt sie den Frame-Strom auf der Electron-Seite.

use serde::{Deserialize, Serialize};

/// Eingehender Request. `op` entscheidet, welche Felder gelesen werden.
#[derive(Debug, Deserialize)]
pub struct Request {
    pub op: String,
    #[serde(default)]
    pub id: Option<i64>,

    // --- open ---
    /// WHEP-URL inklusive `?token=` (wird unveraendert durchgereicht).
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    /// Index aus `list_monitors`; ohne Angabe entscheidet der Compositor.
    /// Noch nicht ausgewertet — Fensterplatzierung folgt.
    #[allow(dead_code)]
    #[serde(default)]
    pub monitor: Option<usize>,
    #[serde(default)]
    pub fullscreen: Option<bool>,

    // --- close / set_option / stats / screenshot / clip ---
    #[serde(default)]
    pub session: Option<u64>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub value: Option<serde_json::Value>,
    /// Zielpfad fuer `screenshot`/`clip` — beide Ops sind noch nicht gebaut,
    /// die Felder stehen aber schon im Protokoll.
    #[allow(dead_code)]
    #[serde(default)]
    pub path: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    pub seconds: Option<f64>,

    /// Startwerte fuer `open` — dieselben Schluessel wie bei `set_option`.
    #[serde(default)]
    pub options: Option<PlayerOptions>,
}

/// Alles, was zur Laufzeit umgeschaltet werden kann.
///
/// `None` heisst durchgehend "unveraendert lassen", nicht "Standardwert" —
/// deshalb ist jedes Feld optional und wird einzeln angewendet.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct PlayerOptions {
    /// Ziel-Fuellstand des Jitter-Puffers in Millisekunden.
    /// Messung aus `docs/2026-07-21-remote-control-latenz-messung.md`: 5-15 ms
    /// reichen auf einer gesunden Strecke. Chromiums WebRTC-Puffer laesst sich
    /// nicht dorthin zwingen — das ist einer der Gruende fuer diesen Player.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jitter_ms: Option<u32>,

    /// Debanding-Staerke 0.0 (aus) bis 1.0. Glaettet Kompressions-Banding in
    /// dunklen Verlaeufen. Wirkt auch bei 8-bit-Quellen und ist damit der
    /// wirksamste Bildhebel, ohne die Encode-Kette anzufassen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deband: Option<f32>,

    /// Dithering beim Quantisieren auf das Ausgabeformat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dither: Option<bool>,

    /// Zoomfaktor (1.0 = ganzes Bild). Skaliert aus dem dekodierten Vollbild,
    /// nicht aus einem bereits herunterskalierten Fensterinhalt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zoom: Option<f32>,
    /// Bildmittelpunkt beim Zoomen, jeweils 0.0-1.0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pan_x: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pan_y: Option<f32>,

    /// 0.0-1.0 regulaer, darueber Verstaerkung (entspricht `volumeBoost.ts`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume: Option<f32>,
    /// Positiv = Ton spaeter (entspricht `AvOffsetSlider.svelte`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub av_offset_ms: Option<i32>,

    /// Standbild ohne Verbindungsabbruch: die Sitzung laeuft weiter, nur die
    /// Darstellung friert ein. Beim Fortsetzen ist man sofort wieder live.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused: Option<bool>,

    /// Hardware-Decode erzwingen/verbieten. `None` = automatisch (Hardware
    /// zuerst, Software als Rueckfall).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hwdec: Option<bool>,
}

/// Erzeugt [`PlayerOptions::apply`] und [`PlayerOptions::any_set`] aus **einer**
/// Feldliste. Beide muessen dieselben Felder kennen; standen sie getrennt da,
/// hiess eine neue Option, zwei Stellen zu pflegen — und wer `any_set`
/// vergisst, bekommt fuer die neue Option ein stilles `ok: true` ohne Wirkung.
macro_rules! umschaltbare_felder {
    ($($f:ident),+ $(,)?) => {
        impl PlayerOptions {
            /// Uebernimmt nur die gesetzten Felder aus `patch`.
            pub fn apply(&mut self, patch: &PlayerOptions) {
                $( if patch.$f.is_some() { self.$f = patch.$f; } )+
            }

            /// Ob ueberhaupt ein Feld gesetzt ist. Dient dazu, einen Patch zu
            /// erkennen, der aus einem unbekannten Schluessel entstanden ist.
            pub fn any_set(&self) -> bool {
                [$(self.$f.is_some()),+].into_iter().any(|gesetzt| gesetzt)
            }
        }
    };
}

umschaltbare_felder!(
    jitter_ms,
    deband,
    dither,
    zoom,
    pan_x,
    pan_y,
    volume,
    av_offset_ms,
    paused,
    hwdec,
);

impl PlayerOptions {
    /// Startwerte. Bewusst konservativ: Debanding an (der sichtbare Gewinn),
    /// Jitter-Puffer auf dem gemessenen unteren Ende mit etwas Reserve.
    pub fn defaults() -> Self {
        Self {
            jitter_ms: Some(20),
            deband: Some(0.6),
            dither: Some(true),
            zoom: Some(1.0),
            pan_x: Some(0.5),
            pan_y: Some(0.5),
            volume: Some(1.0),
            av_offset_ms: Some(0),
            paused: Some(false),
            hwdec: None,
        }
    }

    /// Grenzen hart ziehen, damit ein fehlerhafter Aufruf nicht die
    /// Darstellung zerlegt (z. B. Zoom 0 => Division durch null im Shader).
    pub fn clamp(&mut self) {
        if let Some(v) = self.jitter_ms.as_mut() {
            *v = (*v).clamp(0, 2000);
        }
        if let Some(v) = self.deband.as_mut() {
            *v = v.clamp(0.0, 1.0);
        }
        if let Some(v) = self.zoom.as_mut() {
            *v = v.clamp(1.0, 16.0);
        }
        for v in [self.pan_x.as_mut(), self.pan_y.as_mut()].into_iter().flatten() {
            *v = v.clamp(0.0, 1.0);
        }
        if let Some(v) = self.volume.as_mut() {
            *v = v.clamp(0.0, 4.0);
        }
        if let Some(v) = self.av_offset_ms.as_mut() {
            *v = (*v).clamp(-2000, 2000);
        }
    }
}

/// Antwortrahmen. `data` wird flach in das Objekt gemischt, damit die
/// Nutzdaten wie bei den Capture-Sidecars direkt neben `ok` liegen.
#[derive(Debug, Serialize)]
pub struct Response {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl Response {
    pub fn ok(id: Option<i64>, data: serde_json::Value) -> Self {
        Self { id, ok: true, error: None, data: Some(data) }
    }

    pub fn bare(id: Option<i64>) -> Self {
        Self { id, ok: true, error: None, data: None }
    }

    pub fn err(id: Option<i64>, msg: impl Into<String>) -> Self {
        Self { id, ok: false, error: Some(msg.into()), data: None }
    }
}

/// Ereignisrahmen (`ev`), ohne `id`/`ok`.
#[derive(Debug, Serialize)]
pub struct Event {
    pub ev: &'static str,
    #[serde(flatten)]
    pub data: serde_json::Value,
}

impl Event {
    pub fn new(ev: &'static str, data: serde_json::Value) -> Self {
        Self { ev, data }
    }
}

/// Zustand einer Wiedergabe-Sitzung, wie er nach vorne gemeldet wird.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    /// WHEP-Aushandlung laeuft.
    Connecting,
    /// Frames kommen an und werden dargestellt.
    Playing,
    /// Verbindung steht, aber es kommen keine Frames mehr.
    /// Wird noch nicht gemeldet — die Stillstandserkennung fehlt.
    #[allow(dead_code)]
    Stalled,
    /// Regulaer beendet (auch: Nutzer hat das Fenster geschlossen).
    Closed,
    /// Abgebrochen; Ursache steht im `error`-Feld des Events.
    Failed,
}

impl SessionState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Connecting => "connecting",
            Self::Playing => "playing",
            Self::Stalled => "stalled",
            Self::Closed => "closed",
            Self::Failed => "failed",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_uebernimmt_nur_gesetzte_felder() {
        let mut base = PlayerOptions::defaults();
        let patch = PlayerOptions { deband: Some(0.0), ..Default::default() };
        base.apply(&patch);
        assert_eq!(base.deband, Some(0.0));
        // unveraendert geblieben, obwohl im Patch nicht enthalten
        assert_eq!(base.jitter_ms, Some(20));
        assert_eq!(base.volume, Some(1.0));
    }

    #[test]
    fn clamp_zieht_grenzen() {
        let mut o = PlayerOptions {
            zoom: Some(0.0),
            deband: Some(5.0),
            volume: Some(-1.0),
            av_offset_ms: Some(999_999),
            ..Default::default()
        };
        o.clamp();
        assert_eq!(o.zoom, Some(1.0));
        assert_eq!(o.deband, Some(1.0));
        assert_eq!(o.volume, Some(0.0));
        assert_eq!(o.av_offset_ms, Some(2000));
    }

    #[test]
    fn response_serialisiert_flach() {
        let r = Response::ok(Some(7), serde_json::json!({"session": 1}));
        let s = serde_json::to_string(&r).unwrap();
        assert!(s.contains("\"id\":7"), "{s}");
        assert!(s.contains("\"ok\":true"), "{s}");
        assert!(s.contains("\"session\":1"), "{s}");
        assert!(!s.contains("error"), "{s}");
    }

    #[test]
    fn event_hat_kein_id_und_kein_ok() {
        let e = Event::new("player:state", serde_json::json!({"state": "playing"}));
        let s = serde_json::to_string(&e).unwrap();
        assert!(s.contains("\"ev\":\"player:state\""), "{s}");
        assert!(!s.contains("\"ok\""), "{s}");
        assert!(!s.contains("\"id\""), "{s}");
    }
}
