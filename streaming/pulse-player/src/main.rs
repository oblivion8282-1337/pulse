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

#[cfg(test)]
mod ablage;
mod abriss;
mod app;
mod audio;
mod bildmarke;
mod decode;
mod decodefaden;
mod decoderwahl;
mod depacket;
mod dump;
mod einfrieren;
mod fec;
mod fernsteuerung;
mod jitter;
mod mediasink;
mod messen;
mod neuaufbau;
mod overlay;
mod probe;
mod proto;
mod recorder;
mod render;
mod rpc;
mod session;
mod stockung;
mod theme;
mod whep;
mod zeigerbild;
mod zerocopy;

use anyhow::Result;
use winit::event_loop::{ControlFlow, EventLoop};

use app::{App, UserEvent};

fn main() -> Result<()> {
    // Systemtimer auf 1 ms, VOR der Messpfad-Weiche (Bughunt 2026-08-13):
    // dahinter platziert hatte dasselbe Binary zwei Uhrengranularitaeten —
    // die Messpfade (`--robustheit` taktet ueber `thread::sleep`) fuhren mit
    // 15,6 ms, der Live-Betrieb mit 1 ms, und `erstes_bild_ms` aus dem
    // Messstand war gegen Live-Laeufe nicht vergleichbar. Der Rest der
    // Begruendung steht unten am zweiten Kommentar dieser Art.
    #[cfg(windows)]
    unsafe {
        if windows::Win32::Media::timeBeginPeriod(1) != 0 {
            eprintln!("pulse-player: timeBeginPeriod(1) abgelehnt — Systemtimer bleibt grob");
        }
    }

    // Messpfad VOR allem anderen: er braucht weder TLS noch Fenster noch
    // Tokio, und er darf stdout benutzen — im Normalbetrieb gehoert stdout
    // dem JSON-RPC, hier gibt es keins.
    let argv: Vec<String> = std::env::args().skip(1).collect();
    match argv.first().map(String::as_str) {
        Some("--stufen") => return messen::ausfuehren(&argv[1..]),
        Some("--farbwerte") => return messen::farbwerte::ausfuehren(),
        // Haelt der Bildweg einen unsauberen Strom aus? Gehoert zu den
        // Messpfaden: kein Fenster, kein Netz, kein JSON-RPC auf stdout.
        Some("--robustheit") => return messen::robustheit::ausfuehren(&argv[1..]),
        // Fragt nur die Decoder ab und beendet sich. Gehoert hierher zu den
        // anderen Messpfaden: kein Fenster, kein Netz, kein JSON-RPC auf
        // stdout. Der Weg, auf einer fremden Maschine zu erfahren, WARUM sie
        // in Software dekodiert (`pulse-player --decoder`).
        Some("--decoder") => {
            for codec in [whep::Codec::Av1, whep::Codec::H264] {
                println!("{}:", codec.as_str());
                for (name, art, fehler) in decode::VideoDecoder::sonde(codec) {
                    match fehler {
                        None => println!("  {name} ({art}): geht"),
                        Some(e) => println!("  {name} ({art}): geht nicht — {e}"),
                    }
                }
            }
            return Ok(());
        }
        _ => {}
    }

    // Muss VOR dem ersten TLS-Aufbau stehen. Der Abhaengigkeitsbaum enthaelt
    // zwei rustls-Krypto-Provider (`ring` ueber webrtc-rs' dtls, `aws-lc-rs`
    // ueber reqwest/hyper-rustls). Bei mehr als einem waehlt rustls nicht
    // selbst, sondern panickt — und zwar erst beim ersten `https://`-Request,
    // also mitten im WHEP-Aufbau in einem Tokio-Worker. Das sah wie ein
    // haengendes "Verbinde mit dem Stream" aus, weil nur der Task starb.
    // `aws-lc-rs`, weil reqwest ihn ohnehin zieht und er in
    // THIRD-PARTY-NOTICES.md schon gefuehrt wird.
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .map_err(|_| anyhow::anyhow!("rustls-CryptoProvider bereits installiert"))?;

    // (Der `timeBeginPeriod(1)`-Ruf steht oben VOR der Messpfad-Weiche.)
    // Warum ueberhaupt: Winits `WaitUntil` braucht das NICHT — es laeuft seit
    // 0.30 ueber `CREATE_WAITABLE_TIMER_HIGH_RESOLUTION` (in winit-0.30.13
    // `platform_impl/windows/event_loop.rs:642` nachgelesen, nicht vermutet).
    // Was daran haengt, sind die Tokio-Seiten des Players: der 2-ms-Poll des
    // Jitter-Puffers (`session::POLL_INTERVAL`), der 10-ms-NACK-Erzeuger und
    // die NACK-Sperrfrist (`whep.rs`) warten ueber Condvar/IOCP-Timeouts, und
    // deren Aufloesung ist die des Systemtimers. Mit 15,6 ms kann ein
    // 10-ms-Takt nur 15,6 sein — bei der Fernsteuerung zahlt das der
    // geschlossene Kreis. Prozessweit seit Win10 2004, faellt mit dem Prozess;
    // ein Scheitern ist eine Meldung wert, kein Abbruchgrund.
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
