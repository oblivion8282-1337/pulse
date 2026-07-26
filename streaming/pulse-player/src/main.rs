//! pulse-player — nativer HQ-Stream-Player fuer die Pulse-Desktop-App.
//!
//! Warum es ihn gibt (gemessen am 2026-07-26 auf der Dev-Maschine):
//! Chromium legt seinen Wayland-Fensterpuffer immer als `ABGR8888` an, also
//! 8 bit pro Kanal — in SDR, mit erzwungenem scRGB-Linear und selbst mit
//! aktivem HDR, wo es zwar PQ signalisiert, aber trotzdem 8 bit liefert. KWin
//! bietet daneben 10- und 16-bit-Formate an. Ausserdem nutzt Chromium auf
//! Linux/NVIDIA kein NVDEC (`dec`-Zaehler durchgehend 0 %). Dieser Player
//! trifft beide Entscheidungen selbst.
//!
//! Er ist **additiv**: Browser-Nutzer bekommen den Stream unveraendert ueber
//! den bestehenden WHEP-Weg im `<video>`-Element. Nur die Electron-App kann
//! optional hierher umschalten.
//!
//! stdout gehoert dem JSON-RPC. Diagnose geht ausschliesslich nach stderr.

mod app;
mod audio;
mod decode;
mod depacket;
mod jitter;
mod mediasink;
mod proto;
mod recorder;
mod render;
mod rpc;
mod session;
mod whep;

use anyhow::Result;
use winit::event_loop::{ControlFlow, EventLoop};

use app::{App, UserEvent};

fn main() -> Result<()> {
    let event_loop = EventLoop::<UserEvent>::with_user_event().build()?;
    event_loop.set_control_flow(ControlFlow::Wait);
    let proxy = event_loop.create_proxy();

    // Netzwerk und Decode laufen im Tokio-Kontext, die Fensterschleife auf dem
    // Hauptthread — winit verlangt das.
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;

    rpc::spawn_stdin_reader(proxy.clone());

    let mut app = App::new(proxy, runtime.handle().clone());
    event_loop.run_app(&mut app)?;
    Ok(())
}
