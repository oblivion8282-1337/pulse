//! `gpu_info` — DXGI-Adapter-Enum.
//!
//! Linux-Form: `{ok, vendor, card_path, display_server, video_codecs}` für
//! **eine** GPU (die GSR aktiv nutzt). Auf Windows machen wir's sprechender:
//! `vendor` + `video_codecs` zeigen die Karte, die ein Start ohne Einstellung
//! bekäme (`system::gpu_wahl`, seit 2026-08-17 nicht mehr schlicht der
//! HIGH_PERFORMANCE-Adapter), `adapters` listet zusätzlich alle
//! Hardware-Adapter (für Diagnose-Page / Stats-Overlay).
//!
//! `card_path` gibt's auf Windows nicht — Linux meint damit `/dev/dri/cardN`.
//! Wir setzen das Feld auf null (Renderer toleriert das).

use anyhow::{Result, bail};
use serde_json::{Map, Value, json};

use crate::system::dxgi;

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    let adapters = dxgi::list_adapters()?;
    if adapters.is_empty() {
        bail!("no hardware video adapter found (DXGI enumeration empty)");
    }
    // **Nicht `adapters[0]`** — dieselbe Überlegung wie in `ops::health`: seit
    // die Karte wählbar ist, meldet die erste nicht mehr zwangsläufig das
    // Codec-Angebot der Karte, auf der encodiert wird. `vendor` und
    // `video_codecs` gehören deshalb an die Karte, die die Automatik nähme.
    // `adapters` darunter listet weiterhin ALLE — daraus baut die Oberfläche
    // ihre Auswahl.
    let primary = dxgi::vorgabe_adapter(&adapters, crate::encode::vendor_traegt_zero_copy)
        .unwrap_or(&adapters[0]);

    let adapter_list: Vec<Value> = adapters
        .iter()
        .map(|a| {
            json!({
                // **Die Kennung, unter der die Oberfläche eine Karte zurück
                // bestellt** (`start` → `overrides.gpu`, gelesen von
                // `ops::start::parse_gpu`). Bewusst ein undurchsichtiger
                // Text: der Renderer soll ihn durchreichen, nicht zerlegen —
                // sonst gäbe es eine zweite Stelle, die das Zahlenformat
                // kennt, und die liefe irgendwann auseinander.
                "id": format!("{:04X}:{:04X}", a.vendor_id, a.device_id),
                "description": a.description,
                "vendor": a.vendor(),
                "vendor_id": format!("0x{:04X}", a.vendor_id),
                "device_id": format!("0x{:04X}", a.device_id),
                "vram_mb": a.vram_mb,
            })
        })
        .collect();

    let mut out = Map::new();
    out.insert("vendor".to_string(), Value::String(primary.vendor().to_string()));
    out.insert("card_path".to_string(), Value::Null);
    out.insert("display_server".to_string(), Value::String("windows".to_string()));
    out.insert(
        "video_codecs".to_string(),
        Value::Array(
            primary
                .supported_video_codecs()
                .iter()
                .map(|c| Value::String(c.clone()))
                .collect(),
        ),
    );
    // Windows-spezifisches Extra — die Linux-Variante hat das nicht, der Renderer
    // toleriert unbekannte Felder (alle gsr.ts-Types haben optionale Felder).
    out.insert("adapters".to_string(), Value::Array(adapter_list));
    Ok(out)
}
