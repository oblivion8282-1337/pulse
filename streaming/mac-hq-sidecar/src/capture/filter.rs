//! Inhaltsfilter fuer Bild und Ton — GETRENNT, und das ist der ganze Punkt.
//!
//! **Warum zwei Funktionen.** ScreenCaptureKit kennt je Stream genau EINEN
//! `SCContentFilter`, und der schneidet Bild und Ton gemeinsam zu. Solange
//! beides an einem Stream haengt, formt also jeder Ton-Wunsch mit, was der
//! Zuschauer SIEHT. Bis zum 2026-08-20 war das so gebaut, mit zwei Fehlern als
//! Folge — beide vom Nutzer gemeldet, beide nicht offensichtlich:
//!
//! 1. **Ton einer App zu waehlen schrumpfte das Bild auf diese App.** Wer den
//!    Monitor uebertrug und Safari als Tonquelle waehlte, sendete nur noch
//!    Safari. Der Filter fuer "nur Safaris Ton" schnitt eben auch das Bild zu.
//! 2. **Pulse war im eigenen Monitor-Stream unsichtbar.** Damit sich die
//!    Stimmen der anderen Sprachteilnehmer nicht selbst wieder aufnehmen
//!    (Echo), wird Pulse aus dem TON ausgeschlossen — und flog damit
//!    zwangslaeufig auch aus dem BILD. Wer seinen Bildschirm zeigte, zeigte
//!    alles ausser der App, ueber die er gerade sprach.
//!
//! Deshalb baut der Capturer seit dem 2026-08-20 **zwei** Streams, und deshalb
//! gibt es hier zwei Funktionen, die einander nicht kennen:
//! [`bild_filter`] sieht nur den Bildwunsch, [`ton_filter`] nur den Ton-Wunsch.
//!
//! **Wer sie "aus Symmetriegruenden" wieder zusammenlegt, baut beide Fehler
//! neu ein.** Die Aufteilung sieht wie eine Doppelung aus, ist aber genau das
//! Gegenteil: die Trennung zweier Belange, die SCK faelschlich koppelt.

use anyhow::{Result, anyhow};
use objc2::AllocAnyThread;
use objc2::rc::Retained;
use objc2_foundation::NSArray;
use objc2_screen_capture_kit::{SCContentFilter, SCShareableContent, SCWindow};

use super::{AudioScope, find_window, pick_display, resolve_applications};

/// Der Filter fuer das BILD — kennt den Ton-Wunsch nicht.
///
/// Zwei Faelle, mehr gibt es nicht:
/// * ein ausdruecklich gewaehltes Fenster → genau dieses Fenster
/// * sonst → der ganze Bildschirm, **ohne jeden Ausschluss**
///
/// Das "ohne jeden Ausschluss" ist die eigentliche Behebung der beiden oben
/// beschriebenen Fehler. Ein ganzer Monitor heisst hier ein ganzer Monitor —
/// einschliesslich Pulse selbst. Was der Nutzer nicht hoeren will, regelt
/// [`ton_filter`]; was er nicht SEHEN will, waehlt er ueber die Quelle.
pub(crate) fn bild_filter(
    content: &SCShareableContent,
    display_index: usize,
    window_id: Option<u32>,
) -> Result<Retained<SCContentFilter>> {
    let leere_fenster: Retained<NSArray<SCWindow>> = NSArray::new();

    if let Some(wid) = window_id {
        let window = find_window(content, wid)
            .ok_or_else(|| anyhow!("Fenster {wid} nicht gefunden (geschlossen?)"))?;
        return Ok(unsafe {
            SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &window)
        });
    }

    let display = pick_display(content, display_index)?;
    Ok(unsafe {
        SCContentFilter::initWithDisplay_excludingWindows(
            SCContentFilter::alloc(),
            &display,
            &leere_fenster,
        )
    })
}

/// Der Filter fuer den TON — kennt den Bildwunsch nicht.
///
/// `pulse_pid` ist die Prozessnummer der Pulse-App (der Electron-Elternprozess,
/// `getppid()`). Sie wird IMMER mit ausgeschlossen, wenn Desktop-Ton
/// aufgenommen wird: sonst nimmt der Stream die Stimmen der anderen
/// Sprachteilnehmer wieder auf, die gerade aus denselben Lautsprechern kommen
/// — hoerbar als Echo. Genau dieser Ausschluss ist der Grund, warum Bild und
/// Ton ueberhaupt getrennt werden mussten.
///
/// Gibt `None` zurueck, wenn gar kein Ton gewuenscht ist — dann baut der
/// Aufrufer keinen zweiten Stream. Bewusst kein Vollfilter als Rueckfall: ein
/// stillschweigend aufgemachter Ton-Stream waere schlimmer als keiner.
pub(crate) fn ton_filter(
    content: &SCShareableContent,
    display_index: usize,
    audio_scope: &AudioScope,
    pulse_pid: Option<i32>,
) -> Result<Option<Retained<SCContentFilter>>> {
    let leere_fenster: Retained<NSArray<SCWindow>> = NSArray::new();

    match audio_scope {
        AudioScope::None => Ok(None),

        AudioScope::App(app_name) => {
            let apps = resolve_applications(content, std::slice::from_ref(app_name), None);
            if apps.is_empty() {
                return Err(anyhow!("App '{app_name}' nicht gefunden (läuft sie?)"));
            }
            let arr = NSArray::from_retained_slice(&apps);
            let display = pick_display(content, display_index)?;
            Ok(Some(unsafe {
                SCContentFilter::initWithDisplay_includingApplications_exceptingWindows(
                    SCContentFilter::alloc(),
                    &display,
                    &arr,
                    &leere_fenster,
                )
            }))
        }

        AudioScope::Desktop { exclude } => {
            let display = pick_display(content, display_index)?;
            let apps = resolve_applications(content, exclude, pulse_pid);
            if apps.is_empty() {
                Ok(Some(unsafe {
                    SCContentFilter::initWithDisplay_excludingWindows(
                        SCContentFilter::alloc(),
                        &display,
                        &leere_fenster,
                    )
                }))
            } else {
                let arr = NSArray::from_retained_slice(&apps);
                Ok(Some(unsafe {
                    SCContentFilter::initWithDisplay_excludingApplications_exceptingWindows(
                        SCContentFilter::alloc(),
                        &display,
                        &arr,
                        &leere_fenster,
                    )
                }))
            }
        }
    }
}
