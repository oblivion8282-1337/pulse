//! Eine Anfrage beantworten — der Teil des Helfers, der die eigentliche Arbeit
//! tut. Getrennt von `main.rs`, das nur den Aufbau und die Schleife haelt.
//!
//! **Gehoert zum Programm, nicht zur Bibliothek.** Das hier ist die Seite mit
//! den erhoehten Rechten; die Gegenstelle im Sidecar hat damit nichts zu tun
//! und soll es auch nicht einbinden koennen.
//!
//! Zwei Dinge sind an diesem Modul nicht offensichtlich:
//!
//! * **Der Fassungs-Handschlag kommt vor allem anderen.** Eine Anfrage, deren
//!   Aufbau wir nicht kennen, darf nicht versehentlich als Bildanfrage
//!   durchgehen — sonst antworten wir auf etwas, das gar nicht gefragt wurde.
//! * **Fehlertexte werden hier bewusst verkuerzt.** Die Meldung wandert in das
//!   Log der App; im inneren Text koennten Geraetepfade stehen, und Pfade
//!   gehoeren nicht ins Protokoll (Projektregel).

use std::os::fd::{AsRawFd, OwnedFd, RawFd};

use anyhow::{Context, Result};

use pulse_kms_helfer::karte::{BildFehler, Karte};
use pulse_kms_helfer::protokoll as p;
use pulse_kms_helfer::uebertragung as u;

/// Eine Anfrage beantworten. `Ok(false)` heisst: die Gegenseite hat aufgelegt.
///
/// Die Karte wird beim ersten Bild geoeffnet und dann behalten — sie erneut zu
/// oeffnen kostet bei jedem Bild einen Geraetezugriff, und die Ausgaenge werden
/// ohnehin je Anfrage frisch aufgeloest.
pub fn bedienen(client: RawFd, karte: &mut Option<Karte>) -> Result<bool> {
    let mut puffer = [0u8; p::ANFRAGE_LEN];
    let (n, _) = u::empfangen(client, &mut puffer)?;
    if n == 0 {
        return Ok(false);
    }
    let anfrage = match p::Anfrage::dekodieren(&puffer[..n]) {
        Ok(a) => a,
        Err(e) => {
            antworten(client, &p::Antwort::fehler(p::FEHLER_SONST, e), &[])?;
            return Ok(true);
        }
    };
    if anfrage.fassung != p::FASSUNG {
        antworten(
            client,
            &p::Antwort::fehler(p::FEHLER_FASSUNG, "andere Protokollfassung"),
            &[],
        )?;
        return Ok(true);
    }
    if anfrage.op != p::OP_BILD {
        antworten(
            client,
            &p::Antwort::fehler(p::FEHLER_SONST, "unbekannte Operation"),
            &[],
        )?;
        return Ok(true);
    }

    let (antwort, fds) = bild_holen(karte, &anfrage.ausgang);
    antworten(client, &antwort, &fds)?;
    Ok(true)
}

fn bild_holen(karte: &mut Option<Karte>, ausgang: &str) -> (p::Antwort, Vec<OwnedFd>) {
    if karte.is_none() {
        match Karte::erste_mit_ausgaengen() {
            Ok(k) => *karte = Some(k),
            Err(_) => {
                return (
                    p::Antwort::fehler(p::FEHLER_SONST, "keine DRM-Karte mit aktivem Ausgang"),
                    Vec::new(),
                );
            }
        }
    }
    let k = karte.as_ref().expect("gerade gesetzt");
    // Jedes Mal neu aufloesen: Ausgaenge kommen und gehen (Kabel, Umschalten).
    let crtc = k.ausgaenge_roh().ok().and_then(|alle| {
        alle.into_iter()
            .find(|a| a.name.eq_ignore_ascii_case(ausgang))
            .map(|a| a.crtc_id)
    });
    let Some(crtc) = crtc else {
        return (
            p::Antwort::fehler(p::FEHLER_AUSGANG, "Ausgang unbekannt oder nicht aktiv"),
            Vec::new(),
        );
    };

    match k.bild(crtc) {
        Ok(bild) => {
            let mut antwort = p::Antwort::fehler(p::OK, "");
            antwort.width = bild.width;
            antwort.height = bild.height;
            antwort.fourcc = bild.fourcc;
            antwort.modifier = bild.modifier;
            let mut fds = Vec::new();
            for e in bild.ebenen {
                antwort.ebenen.push(p::Ebene { pitch: e.pitch, offset: e.offset });
                fds.push(e.fd);
            }
            (antwort, fds)
        }
        Err(BildFehler::KeineRechte) => (
            p::Antwort::fehler(
                p::FEHLER_RECHTE,
                "der Helfer traegt CAP_SYS_ADMIN nicht — bitte neu installieren",
            ),
            Vec::new(),
        ),
        Err(BildFehler::KeinBild) => (
            p::Antwort::fehler(p::FEHLER_SONST, "der Ausgang zeigt gerade kein Bild"),
            Vec::new(),
        ),
        Err(BildFehler::Sonst(_)) => (
            p::Antwort::fehler(p::FEHLER_SONST, "Scanout-Puffer nicht lesbar"),
            Vec::new(),
        ),
    }
}

fn antworten(client: RawFd, antwort: &p::Antwort, fds: &[OwnedFd]) -> Result<()> {
    let rohe: Vec<RawFd> = fds.iter().map(|f| f.as_raw_fd()).collect();
    u::senden(client, &antwort.kodieren(), &rohe).context("Antwort senden")
}
