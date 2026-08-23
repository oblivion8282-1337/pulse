//! Op handlers — one module per JSON-RPC op.
//!
//! Every handler is a free function `fn handle(params) -> Result<Map>`.
//!
//! **Diese Tabelle stand bis zum 2026-08-23 auf dem Stand des ersten Tages** und
//! log an mehreren Stellen: `start` als „stub (error)", obwohl es 269 Zeilen
//! echter Code sind, `list_monitors` und `list_application_audio` als
//! „stub (`[]`)", obwohl beide an `SCShareableContent` haengen — und
//! `list_windows` fehlte ganz, obwohl das Modul existiert. Nachgesehen und
//! richtiggestellt; **wer hier etwas aendert, prueft die Zeile mit.** Eine
//! Statustabelle, der man nicht glauben kann, ist schlechter als keine.
//!
//! | Op                     | Stand   | Wovon er lebt                            |
//! |------------------------|---------|------------------------------------------|
//! | health                 | echt    | Fähigkeiten + Freigaben (`berechtigung`)  |
//! | gpu_info               | Stub    | wartet auf die Metal-Geräteabfrage        |
//! | list_monitors          | echt    | `capture::list_displays`                  |
//! | list_windows           | echt    | `capture::list_capture_windows`           |
//! | list_application_audio | echt    | `capture::list_audio_applications`        |
//! | build_argv             | echt    | Diagnose-argv (Token maskiert)            |
//! | start                  | echt    | ScreenCaptureKit + VideoToolbox + WHIP    |
//! | stop                   | echt    | `StreamController`, idempotent            |
//! | state                  | echt    | Schnappschuss des `StreamController`      |
//! | keyframe               | echt    | Vollbild auf Anforderung                  |
//! | remote_input           | echt    | Fernsteuerung: Frames einspielen          |
//! | remote_input_end       | echt    | Fernsteuerung: Sitzung schliessen         |

pub mod build_argv;
pub mod gpu_info;
pub mod health;
pub mod keyframe;
pub mod list_application_audio;
pub mod list_monitors;
pub mod list_windows;
pub mod remote_input;
pub mod remote_input_end;
pub mod start;
pub mod state;
pub mod stop;
