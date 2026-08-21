//! Fährt die D3D12-Fähigkeitsabfrage (`system::encode_caps`) über JEDEN
//! Adapter und stellt sie neben das, was `supported_video_codecs` ausliefert.
//!
//! **Wofür.** Die Abfrage beantwortet auf AMD und Intel die Frage, welche
//! Codecs die Oberfläche anbieten darf. Auf einer NVIDIA-Maschine läuft sie im
//! Betrieb gar nicht (dort bleibt die NVENC-Open-Probe zuständig) — genau
//! deshalb ist sie dort prüfbar: beide Wege müssen dasselbe sagen, und das ist
//! eine Gegenprobe aus unabhängiger Quelle statt einer Selbstbestätigung.
//!
//! ```text
//! cargo run --example probe_encode_caps
//! ```

use pulse_win_hq_sidecar::system::{dxgi, encode_caps};

fn main() -> anyhow::Result<()> {
    let adapters = dxgi::list_adapters()?;
    if adapters.is_empty() {
        println!("kein Hardware-Adapter gefunden");
        return Ok(());
    }
    for (i, a) in adapters.iter().enumerate() {
        println!(
            "\n── Adapter {i}: {} ({}, {:#06X}:{:#06X})",
            a.description,
            a.vendor(),
            a.vendor_id,
            a.device_id
        );
        match encode_caps::kodierbare_codecs(a) {
            Ok(codecs) => println!("   D3D12-Abfrage:  {codecs:?}"),
            Err(e) => println!("   D3D12-Abfrage:  FEHLER {e:#}"),
        }
        println!("   ausgeliefert:   {:?}", a.supported_video_codecs());
        // **Gegenprobe, dass die Abfrage überhaupt Nein sagen kann.** Eine
        // Karte, die alle drei Codecs kodiert, belegt für sich genommen nur,
        // dass dreimal „ja" herauskommt — das täte eine kaputte Abfrage mit
        // falscher Struktur-Größe womöglich auch. Eine Kennziffer, die es
        // nicht gibt, muss ein Nein geben.
        match encode_caps::traegt_kennziffer(a, 99) {
            Ok(true) => println!("   Kennziffer 99:  JA — die Abfrage sagt immer ja, VERDÄCHTIG"),
            Ok(false) => println!("   Kennziffer 99:  nein (erwartet)"),
            Err(e) => println!("   Kennziffer 99:  FEHLER {e:#}"),
        }
    }
    Ok(())
}
