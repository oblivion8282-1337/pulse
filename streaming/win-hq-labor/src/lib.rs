//! Pulse Windows-HQ-Labor - Bibliotheks-Flaeche.
//!
//! Die Module sind `pub`, damit `examples/` (Proben) direkt darauf zugreifen
//! koennen. Die Protokoll-Schleife selbst lebt in `src/main.rs` - gleiche
//! Aufteilung wie im ausgelieferten Sidecar.

pub mod auffrischung;
pub mod bildabzug;
pub mod grenzen;
pub mod logging;
pub mod senke;
pub mod vkimport;
pub mod vulkan_encoder;
pub mod whep;
pub mod whip;
