//! Die Wayland-Haelfte der geteilten Zwischenablage: `wl_data_device` als
//! [`Beobachter`], `wl_data_source` als [`Eigentum`].
//!
//! **Beim LIEFERN ist verzoegertes Rendern genau das, was das Protokoll
//! vorsieht.** Ein `wl_data_source` hinterlegt keine Daten; es bietet
//! Mime-Typen an, und erst wenn jemand einfuegt, kommt `send` mit einem
//! Dateideskriptor. Genau dort — und nur dort — geht `hol` ueber die Leitung.
//! Geschrieben wird auf einem eigenen Faden, die Ereignisschleife des Players
//! wartet dabei nicht.
//!
//! **Beim LESEN gilt das NICHT von selbst**, und der Entwurfssatz „auf Linux
//! entfaellt das Problem" deckt nur die Gegenrichtung. `wl_data_offer.receive`
//! liefert den Inhalt ueber einen Deskriptor, aus dem gelesen werden muss —
//! und ob der fremde Eigentuemer je schreibt, sagt das Protokoll nicht zu.
//! Auf der Fensterschleife gelesen stuende waehrenddessen **Bild und
//! Eingabe**. Deshalb laeuft auch das Lesen auf einem eigenen Faden
//! ([`Lesen`]); die Antwort auf ein `hol` faellt einen Takt spaeter an, was
//! `pulse_ablage::sitzung::ABRUF_FRIST_MS` (2 s) muehelos traegt.
//!
//! **Der Anspruch wird eingereiht, nicht sofort eingeloest.** `set_selection`
//! verlangt eine Seriennummer aus einem frischen Eingabeereignis, und ein
//! Klient **ohne Fokus kann die Auswahl nicht setzen** — der Compositor
//! verwirft es **still**. Genau der Fall tritt ein, wenn der Nutzer zu einem
//! lokalen Programm wechselt und drueben kopiert wird. Die Rechnung dazu steht
//! samt Tests in `pulse_ablage::eigentum::Anspruch` und wird hier **benutzt,
//! nicht nachgebaut**; dieses Modul liefert nur die Nummer
//! (`Ablagequelle::seriennummer`, dieselbe `DruckNummer`, aus der auch der Zug
//! seine bezieht).
//!
//! **Der Zug-Zustand wird hier nicht angefasst.** Die Zwischenablage hat mit
//! dem Ziehen nichts zu tun; `wayland_zug_abbau` raeumt weiterhin
//! ausschliesslich Zug-Zustand, und dieses Modul haengt an keinem seiner
//! Felder ausser der Seriennummer, die dem DRUCK gehoert und nicht dem Zug.
//!
//! **Ungeprueft, weil ohne Compositor nicht pruefbar:** alles in dieser Datei.
//! Geprueft ist, was darueber liegt — die Zustandsfuehrung in `app::ablage`
//! und die Kiste `pulse-ablage`. Dieselbe Trennung wie beim Zug (s.
//! [`super`]-Modulkopf, „Ungeprueft bleibt").

mod auswahl;

use std::io::Write;
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::net::UnixStream;

use pulse_ablage::beobachter::Beobachter;
use pulse_ablage::eigentum::Eigentum;

use super::verbindung::Gastverbindung;
use crate::app::ablage::Ablagequelle;
pub(super) use auswahl::AblageZustand;
use auswahl::Lesen;

impl Gastverbindung {
    /// Die Auswahl auf eine frische eigene Quelle setzen.
    ///
    /// `sofort` entscheidet, was ein `send` bekommt: `None` heisst „erst
    /// drueben holen" (der Normalfall, verzoegertes Rendern), `Some` heisst
    /// „diesen Text unmittelbar" (nur der zurueckgeschriebene Vorbestand).
    fn auswahl_setzen(&mut self, sofort: Option<String>) -> Result<(), String> {
        let serial = self.zustand.druck.aktuell().ok_or("keine Seriennummer")?;
        let geraet = self.datengeraete.first().ok_or("kein Datengeraet")?;
        let quelle = self.manager.create_data_source(&self.qh, ());
        for mime in auswahl::MIMES {
            quelle.offer((*mime).to_string());
        }
        geraet.set_selection(Some(&quelle), serial);
        let _ = self.conn.flush();
        // **Erst die neue Auswahl setzen, dann die alte Quelle zerstoeren.**
        // Andersherum stuende zwischendurch gar keine Auswahl, und ein
        // Einfuegen in genau diesem Moment bekaeme nichts.
        if let Some(alt) = self.zustand.ablage.quelle.replace(quelle) {
            alt.destroy();
        }
        self.zustand.ablage.eigene_quelle(sofort);
        Ok(())
    }

    /// Den Lesevorgang eroeffnen: `receive` + `flush` bleiben hier (billig),
    /// das Warten auf den fremden Klienten wandert auf einen eigenen Faden.
    fn lese_kanal_oeffnen(&self) -> Lesen {
        let a = &self.zustand.ablage;
        // Nie die eigene Auswahl lesen: das `receive` ginge an unsere EIGENE
        // Quelle, deren `send` erst im naechsten `nachfassen` ankaeme — und was
        // dort liegt, kam ohnehin von der Gegenseite. Wir haben nichts Eigenes
        // anzubieten.
        if a.eigene() {
            return Lesen::Fertig(None);
        }
        // **Genau der Typ, der wirklich angeboten wurde** (Review C4). Ein fest
        // verdrahtetes `text/plain;charset=utf-8` gegen einen Eigentuemer, der
        // nur `STRING` fuehrt (aeltere X11-Programme ueber die Bruecke, manche
        // Terminals), liefe im guenstigen Fall in ein sofortiges Dateiende, im
        // unguenstigen in die volle Frist — und der Nutzer erlebte „Einfuegen
        // tut nichts" samt Aussetzer.
        let (Some(angebot), Some(mime)) = (a.angebot(), a.mime_typ()) else {
            return Lesen::Fertig(None);
        };
        let Ok((hier, dort)) = UnixStream::pair() else {
            return Lesen::Fertig(None);
        };
        angebot.receive(mime.to_string(), dort.as_fd());
        let _ = self.conn.flush();
        // Das eigene Schreibende schliessen, sonst kommt nie ein Dateiende und
        // es bliebe bei der Frist.
        drop(dort);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(auswahl::vom_deskriptor(hier));
        });
        Lesen::Laeuft(rx)
    }
}

impl Beobachter for Gastverbindung {
    fn geaendert(&mut self) -> bool {
        self.zustand.ablage.aenderung_abholen()
    }

    /// Das Ergebnis des zuletzt abgeschlossenen Lesevorgangs — **blockiert
    /// nie**.
    ///
    /// Steht noch keines bereit, ist `None` die sichere Antwort: sie kostet
    /// ein Einfuegen, nie einen falschen Inhalt. Der Aufrufer fragt vorher
    /// `Ablagequelle::lesen_bereit` (s. `app::ablage::Ablagelage::takt`) und
    /// laeuft deshalb im Normalfall nicht hier hinein.
    fn lesen(&self) -> Option<String> {
        self.zustand.ablage.gelesenes()
    }
}

impl Eigentum for Gastverbindung {
    fn beanspruchen(&mut self) -> Result<(), String> {
        self.auswahl_setzen(None)
    }

    fn liefern(&mut self, text: &str) {
        for fd in self.zustand.ablage.lieferungen_nehmen() {
            schreiben(fd, text.to_string());
        }
    }

    fn freigeben(&mut self, zurueck: Option<&str>) {
        if !self.zustand.ablage.eigene() {
            // Jemand anders haelt die Auswahl laengst — sie mit einem
            // Merkposten von vorhin zu ueberschreiben waere derselbe stille
            // Verlust, gegen den der Merkposten ueberhaupt gebaut ist.
            return;
        }
        // **In beiden Zweigen zuerst die wartenden Einfuegevorgaenge
        // abraeumen** (Review C6): wir liefern ihnen nichts mehr, und ein
        // offen liegender Deskriptor liesse den Einfuegenden bis in SEINE
        // Frist warten. Der Rueckschreib-Zweig hatte das frueher nicht.
        for fd in self.zustand.ablage.lieferungen_nehmen() {
            drop(fd);
        }
        if let Some(text) = zurueck {
            // **Auf Wayland laesst sich fremdes Eigentum nicht zurueckgeben** —
            // wer die Auswahl haelt, IST ihr Eigentuemer. Zurueckschreiben
            // heisst deshalb: eine neue eigene Quelle mit dem gemerkten Text.
            // Der Nutzer sieht seinen Inhalt wieder; er gehoert ab da diesem
            // Prozess. Der Unterschied faellt erst auf, wenn der Player endet.
            if let Err(grund) = self.auswahl_setzen(Some(text.to_string())) {
                eprintln!(
                    "pulse-player: Vorbestand der Zwischenablage nicht zurueckgeschrieben \
                     ({grund}) — die Auswahl bleibt, wie sie ist."
                );
            }
            return;
        }
        if let (Some(serial), Some(geraet)) =
            (self.zustand.druck.aktuell(), self.datengeraete.first())
        {
            geraet.set_selection(None, serial);
            let _ = self.conn.flush();
        }
        self.zustand.ablage.abgeloest();
    }
}

impl Ablagequelle for Gastverbindung {
    fn einfuegen_wartet(&mut self) -> bool {
        self.zustand.ablage.einfuegen_wartet()
    }

    /// Dieselbe Nummer, aus der auch `start_drag` seine bezieht (s.
    /// [`super::zustand::DruckNummer`]) — sie gehoert dem DRUCK, nicht dem
    /// Zug.
    fn seriennummer(&self) -> Option<u32> {
        self.zustand.druck.aktuell()
    }

    fn eigentuemer(&self) -> bool {
        self.zustand.ablage.eigene()
    }

    /// Diese Verbindung steht nur, wenn Registry, Datengeraet-Manager und
    /// mindestens ein Sitzplatz gebunden werden konnten (s. `aufbauen`) —
    /// gibt es sie, ist die Zwischenablage wirksam.
    fn wirksam(&self) -> bool {
        true
    }

    fn lesen_anstossen(&mut self) {
        if !self.zustand.ablage.lesen_offen() {
            return;
        }
        let lesen = self.lese_kanal_oeffnen();
        self.zustand.ablage.lesen_setzen(lesen);
    }

    fn lesen_bereit(&mut self) -> bool {
        self.zustand.ablage.lesen_bereit()
    }
}

/// Auf einem eigenen Faden in den Deskriptor schreiben und ihn schliessen.
///
/// **Warum nicht im Schleifen-Faden:** der Deskriptor kommt vom einfuegenden
/// Klienten und ist in aller Regel eine Roehre; deren Puffer fasst unter Linux
/// vorgabemaessig 64 KiB — also genau `MAX_TEXT_BYTE`. Ein Schreiben hier
/// koennte deshalb blockieren, bis der Klient liest, und das mitten in der
/// Ereignisschleife des Players. **Aus der Puffergroesse gefolgert, nicht
/// gemessen** — ein Faden kostet an dieser Stelle nichts, ein Haenger der
/// Schleife alles.
fn schreiben(fd: OwnedFd, text: String) {
    std::thread::spawn(move || {
        let mut datei = std::fs::File::from(fd);
        let _ = datei.write_all(text.as_bytes());
    });
}
