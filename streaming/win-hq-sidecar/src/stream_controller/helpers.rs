//! Reine Helfer rund um den Stream-Controller — Adapter-Auswahl, Event-
//! Emission, Diagnose-argv, Auflösungs-Fit. Kein State, deshalb getrennt von
//! der eigentlichen Zustandsverwaltung in `stream_controller::mod`.

use anyhow::{Result, anyhow};
use serde_json::json;

use crate::events;
use crate::system::{dxgi, gpu_wahl};

use super::StartParams;

/// Die Grafikkarte für **Aufnahme und Encoder**.
///
/// **Bis zum 2026-08-17 stand hier nur „nimm die erste"**, und das war die
/// halbe Wahrheit: Diese Karte bestimmte den Encoder, aber nicht die Aufnahme —
/// die baute `windows-capture` auf der Karte, die Windows ihr gab. Auf Rechnern
/// mit zwei Karten liefen die beiden auseinander, und `pipeline_hw` richtete
/// sich am Ende nach der Aufnahme (`system::dxgi::device_vendor`). Seither
/// reicht der Aufrufer die hier gewählte Karte über `StartParams::gpu` bis in
/// die Aufnahme durch, und die Wahl gilt wieder für beides.
///
/// Die Regel selbst steht in [`crate::system::gpu_wahl`] — dort auch die
/// Begründung, warum der eigene Videospeicher mitentscheidet und die
/// Reihenfolge allein nicht genügt.
///
/// **`PULSE_HQ_ADAPTER_VENDOR=nvidia|amd|intel` bleibt** als Labor-Notbremse
/// und schlägt weiterhin alles: Wer den QSV- oder AMF-Weg gegenprüfen will,
/// soll das ohne Umweg über die Oberfläche können.
pub(super) fn select_adapter(wunsch: &gpu_wahl::Wunsch) -> Result<dxgi::Adapter> {
    let adapters = dxgi::list_adapters()?;
    if let Some(want) = std::env::var("PULSE_HQ_ADAPTER_VENDOR").ok().filter(|v| !v.is_empty()) {
        let adapter = adapters
            .into_iter()
            .find(|a| a.vendor() == want)
            .ok_or_else(|| anyhow!("no DXGI adapter with vendor={want}"))?;
        eprintln!(
            "[stream-pipeline] GPU: {} (vendor={}) — erzwungen über PULSE_HQ_ADAPTER_VENDOR",
            adapter.description,
            adapter.vendor()
        );
        return Ok(adapter);
    }

    let karten: Vec<gpu_wahl::Karte> = adapters.iter().map(dxgi::Adapter::karte).collect();
    let wahl = gpu_wahl::waehlen(
        &karten,
        wunsch,
        crate::encode::vendor_traegt_zero_copy,
        dxgi::sortiert_nach_leistung(),
    )
    .ok_or_else(|| anyhow!("no DXGI adapter for encode"))?;
    let adapter = adapters
        .into_iter()
        .nth(wahl.index)
        .expect("gpu_wahl liefert nur Stellen aus der übergebenen Liste");

    if wahl.wunsch_verfehlt {
        eprintln!(
            "[stream-pipeline] Die eingestellte GPU steckt nicht (mehr) in diesem Rechner — \
             es wird automatisch gewählt."
        );
    }
    // **Diese Zeile ist der Beleg**, an dem eine Rückmeldung von einem
    // Doppel-GPU-Rechner hängt: sie sagt, welche Karte gewollt war. Ob die
    // Aufnahme auch dort gelandet ist, sagt erst `pipeline_hw` — die beiden
    // gehören zusammen gelesen.
    eprintln!(
        "[stream-pipeline] GPU: {} (vendor={}, {} MB eigener Speicher) — {}",
        adapter.description,
        adapter.vendor(),
        adapter.vram_mb,
        match wahl.grund {
            gpu_wahl::Grund::Gewuenscht => "so eingestellt",
            gpu_wahl::Grund::SchnellsterWeg => "automatisch gewählt",
            gpu_wahl::Grund::ErsteAusReihenfolge =>
                "automatisch gewählt (keine Karte trägt den schnellen Weg)",
        }
    );
    Ok(adapter)
}

/// Der Satz, mit dem der Start abbricht, wenn die Karte den Sendeweg nicht
/// bedienen kann (`run_pipeline`).
///
/// **Zwei Fassungen, weil es zwei Lagen sind.** Wer die Karte gar nicht
/// eingestellt hat, soll erfahren, dass es dafür ein Feld gibt. Wer sie
/// ausdrücklich eingestellt hat — `Wunsch::Genau` umgeht die Automatik
/// absichtlich — bekäme mit demselben Satz den Rat, genau das zu tun, was er
/// gerade getan hat. Das liest sich, als hätte das Programm nicht bemerkt, was
/// man ihm gesagt hat.
pub(crate) fn gpu_sackgasse(adapter: &dxgi::Adapter, wunsch: &gpu_wahl::Wunsch) -> String {
    let karte = format!("{} ({})", adapter.description, adapter.vendor());
    match wunsch {
        gpu_wahl::Wunsch::Genau { .. } => format!(
            "Über {karte} kann Pulse zurzeit nicht senden. Diese Karte ist in den \
             Streameinstellungen unter „GPU“ fest eingestellt — mit „Automatisch“ oder einer \
             anderen Karte lässt sich der Stream starten."
        ),
        gpu_wahl::Wunsch::Automatisch => format!(
            "Über {karte} kann Pulse zurzeit nicht senden. Steckt eine zweite Grafikkarte im \
             Rechner, lässt sie sich in den Streameinstellungen unter „GPU“ auswählen."
        ),
    }
}

pub(crate) fn emit_state(state: &str, running: bool, uptime_s: f64) {
    events::emit(json!({
        "ev": "state",
        "state": state,
        "running": running,
        "uptime_s": uptime_s,
    }));
}

/// Pseudo-argv für die `start`-Response — wie auf Linux gibt's das nur zur
/// Diagnose im Renderer, ohne den Stream-Key. Wenig informativ, aber shape-
/// kompatibel zu `gsr-sidecar`'s argv-Form.
pub(crate) fn build_argv_redacted(params: &StartParams) -> Vec<String> {
    vec![
        "pulse-win-hq-sidecar.exe".to_string(),
        "--profile".into(),
        params.profile_name.clone(),
        "--codec".into(),
        // Den GEWAEHLTEN Codec melden, nicht den des Profils.
        //
        // Bis 2026-07-30 stand hier `params.profile.codec` — waehrend `--fps`
        // und `--bitrate` zwei Zeilen weiter den Override respektieren. Wer
        // AV1 waehlte, bekam in der Antwort und damit im Log `--codec h264` zu
        // sehen und hielt einen AV1-Lauf fuer einen H.264-Lauf. Genau daran
        // ist am 2026-07-30 eine Auswertung falsch abgebogen.
        //
        // Auch das bleibt aber der GEWUENSCHTE Codec: die Rueckfaelle
        // (WHIP kann kein AV1, AV1 verlaesst den d3d12va-Pfad) greifen erst
        // spaeter. Was wirklich lief, sagt die Zeile "Encoder offen" aus
        // `encode/`, und die ist die verbindliche.
        params.codec().slug().to_string(),
        "--fps".into(),
        params
            .override_fps
            .unwrap_or(params.profile.fps)
            .to_string(),
        "--bitrate".into(),
        format!(
            "{}k",
            params
                .override_bitrate_kbps
                .unwrap_or(params.profile.bitrate_kbps)
        ),
        "--audio-codec".into(),
        params.profile.audio_codec.to_string(),
        "--container".into(),
        params.profile.container.to_string(),
        "--out".into(),
        crate::redact::secrets(&params.push_url),
    ]
}

/// Capture-Maße aspektwahrend in eine Box einpassen — nie hochskalieren, Maße
/// auf gerade Werte runden (4:2:0-Encoder-Anforderung). Gleiche Semantik wie
/// `ResolutionRequest::target_for` im Linux-Rust-Sidecar; vorher wurde die Box
/// wörtlich genommen und Ultrawide auf 16:9 gestaucht. Von allen drei
/// Pipelines genutzt (CPU hier, `pipeline_hw`, `pipeline_d3d12`).
pub(crate) fn fit_within_box(native_w: u32, native_h: u32, box_w: u32, box_h: u32) -> (u32, u32) {
    let even = |n: u32| (n & !1).max(2);
    let scale = f64::min(
        box_w as f64 / native_w.max(1) as f64,
        box_h as f64 / native_h.max(1) as f64,
    )
    .min(1.0); // kein Upscale
    let w = (native_w as f64 * scale).round() as u32;
    let h = (native_h as f64 * scale).round() as u32;
    (even(w), even(h))
}

/// Die Zielmaße eines Streams aus Aufnahmemaßen und gewünschter Box.
///
/// **Eine Funktion und nicht zwei Zeilen an jeder Aufrufstelle**, seit es zwei
/// Stellen gibt, die dieselbe Antwort brauchen und dabei nicht auseinanderlaufen
/// dürfen: der Taktfaden (`pipeline_hw`) und — wenn die Farbwandlung schon im
/// Aufnahme-Rückruf läuft — die Aufnahme selbst (`capture::aufnahmeziel`).
/// Wichen sie ab, entstünde ein Pool in der einen Größe und ein Encoder in der
/// anderen.
pub(crate) fn zielmasse(breite: u32, hoehe: u32, kasten: Option<(u32, u32)>) -> (u32, u32) {
    match kasten {
        Some((box_w, box_h)) => fit_within_box(breite, hoehe, box_w, box_h),
        // Native: nur die Gerade-Rundung für 4:2:0 (Fenster-Capture liefert
        // beliebige Client-Größen), sonst unverändert.
        None => (breite & !1, hoehe & !1),
    }
}

#[cfg(test)]
mod fit_tests {
    use super::fit_within_box;

    #[test]
    fn fit_keeps_aspect_never_upscales() {
        // 16:9-Quelle + passende Box → exakt die Box.
        assert_eq!(fit_within_box(3840, 2160, 1920, 1080), (1920, 1080));
        // 21:9-Ultrawide + 1080p-Box → volle Breite, Höhe aspektwahrend < 1080.
        let (w, h) = fit_within_box(3440, 1440, 1920, 1080);
        assert_eq!(w, 1920);
        assert!(h < 1080 && h % 2 == 0, "aspektwahrend + gerade: {h}");
        // Quelle kleiner als Box → native Maße (kein Upscale).
        assert_eq!(fit_within_box(1280, 720, 1920, 1080), (1280, 720));
        // Ungerade Ergebnisse werden auf gerade Maße gerundet.
        let (_, h) = fit_within_box(2560, 1080, 1920, 1080);
        assert_eq!(h % 2, 0);
    }
}
