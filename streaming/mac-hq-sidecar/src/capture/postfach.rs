//! Die Bild-Post: ein Ein-Slot-Fach fuer Capture-Bilder — neuestes gewinnt.
//!
//! **Warum kein Kanal.** Bis zum 2026-08-24 war der Weg vom SCK-Rueckruf in
//! den Medien-Loop ein ungebundener `mpsc`-Kanal, und jeder Eintrag hielt
//! einen zurueckbehaltenen IOSurface-Puffer (4K BGRA: rund 33 MB). Blockiert
//! der Verbraucher — der Mux-Weg wartet bei vollem Socket bis zu 10 s auf
//! seinen `rw_timeout` —, staut sich der Kanal mit hunderten Bildern auf:
//! mehrere GB GPU-Speicherdruck genau im Stoerungsfall, wenn die Maschine
//! ohnehin schon kaempft.
//!
//! Das Fach haelt stattdessen EIN Bild. Ein neues wirft das alte samt Puffer
//! weg (die `CFRetained`-Freigabe laeuft im Drop), und der Verbraucher sieht
//! nach einem Stau den NEUESTEN Stand statt des Stall-Anfangs — dasselbe
//! Fach wie im Linux-Zwilling (`FrameMailbox` in
//! `linux-hq-sidecar/src/capture/pipewire_stream.rs`, dort aus derselben
//! Sorge gebaut: bounded statt EMFILE-Gefahr, latest-wins statt Stall).
//!
//! Zweiter Unterschied zum Kanal: `einwerfen` kann nie blockieren und nie
//! fehlschlagen — der SCK-Rueckruf braucht weder Fehlerbehandlung noch
//! Rueckstau.

use std::sync::{Condvar, Mutex};
use std::time::Instant;

/// Ein-Slot-Postfach. Der Erzeuger ruft [`Postfach::einwerfen`], der
/// Verbraucher [`Postfach::nehmen`] (sofort) oder [`Postfach::warten_bis`]
/// (mit Frist). Beide Seiten duerfen aus mehreren Faden zugreifen; die
/// Reihenfolge unter gleichzeitigen Einwuerfen entscheidet die Sperre.
pub struct Postfach<T> {
    fach: Mutex<Option<T>>,
    geweckt: Condvar,
}

impl<T> Postfach<T> {
    pub fn neu() -> Self {
        Self { fach: Mutex::new(None), geweckt: Condvar::new() }
    }

    /// Ein Gut einwerfen; ein noch liegendes wird dabei verworfen (und dabei
    /// fallen gelassen — bei Bildern genau der Punkt).
    pub fn einwerfen(&self, gut: T) {
        let mut fach = self.fach.lock().unwrap();
        *fach = Some(gut);
        drop(fach);
        self.geweckt.notify_one();
    }

    /// Das liegende Gut nehmen, falls eines da ist.
    pub fn nehmen(&self) -> Option<T> {
        self.fach.lock().unwrap().take()
    }

    /// Auf ein Gut warten, hoechstens bis zur Frist. Kommt kurz vor der Frist
    /// noch eines, gewinnt es (erst das Fach, dann die Uhr — dieselbe
    /// Zahlungsweise wie `recv_timeout`).
    pub fn warten_bis(&self, frist: Instant) -> Option<T> {
        let mut fach = self.fach.lock().unwrap();
        loop {
            if let Some(gut) = fach.take() {
                return Some(gut);
            }
            let jetzt = Instant::now();
            if jetzt >= frist {
                return None;
            }
            let (wache, abgelaufen) = self.geweckt.wait_timeout(fach, frist - jetzt).unwrap();
            // Spontanes Aufwachen ohne Gut: neu rechnen, die Schleife prueft
            // zuerst das Fach und danach die Restzeit. `abgelaufen` allein
            // waere falsch — ein Gut kann auch MIT dem Timeout ankommen.
            let _ = abgelaufen;
            fach = wache;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::Duration;

    /// Der Kern: das Fach behaelt nur das NEUESTE — das aeltere ist bei der
    /// Rueckgabe schon fallen gelassen (bei Bildern: Puffer freigegeben).
    #[test]
    fn neuestes_gewinnt() {
        let post = Postfach::neu();
        post.einwerfen(1);
        post.einwerfen(2);
        post.einwerfen(3);
        assert_eq!(post.nehmen(), Some(3));
        assert_eq!(post.nehmen(), None, "das Fach muss danach leer sein");
    }

    /// Die Frist bleibt eine Frist: ohne Ankunft kommt None, nicht Blockade.
    #[test]
    fn warten_bis_haelt_die_frist() {
        let post: Postfach<u32> = Postfach::neu();
        let bis = Instant::now() + Duration::from_millis(20);
        assert_eq!(post.warten_bis(bis), None);
        assert!(Instant::now() >= bis, "vor der Frist zurueckgekommen");
    }

    /// Eine Ankunft WECKT den Waeter — das ist der Unterschied zum Pollen und
    /// die Voraussetzung dafuer, dass der Medien-Loop sein `frame_interval`
    /// ausschlaeft, solange der Bildschirm stillsteht.
    #[test]
    fn ankunft_weckt_den_waeter() {
        let post = Postfach::neu();
        let griff = &post;
        thread::scope(|s| {
            s.spawn(move || {
                thread::sleep(Duration::from_millis(10));
                griff.einwerfen(7);
            });
            let bis = Instant::now() + Duration::from_secs(2);
            assert_eq!(post.warten_bis(bis), Some(7));
        });
    }
}
