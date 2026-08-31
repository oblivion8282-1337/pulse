//! Die Wayland-Haelfte der geteilten Zwischenablage: `wl_data_device` als
//! [`Beobachter`], `wl_data_source` als [`Eigentum`].
//!
//! **Auf Wayland ist verzoegertes Rendern kein Kunstgriff, sondern wie das
//! Protokoll gedacht ist.** Ein `wl_data_source` hinterlegt keine Daten; es
//! bietet Mime-Typen an, und erst wenn jemand einfuegt, kommt `send` mit einem
//! Dateideskriptor. Genau dort — und nur dort — geht `hol` ueber die Leitung.
//! Niemand blockiert dabei: geschrieben wird auf einem eigenen Faden, und der
//! einfuegende Klient liest, wann er will.
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

use std::collections::HashSet;
use std::io::{Read, Write};
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::time::Duration;

use wayland_backend::sys::client::ObjectId;
use wayland_client::protocol::{wl_data_offer, wl_data_source};
use wayland_client::Proxy;

use pulse_ablage::beobachter::Beobachter;
use pulse_ablage::eigentum::Eigentum;
use pulse_ablage::format::MAX_TEXT_BYTE;

use super::verbindung::Gastverbindung;
use crate::app::ablage::Ablagequelle;

/// Was wir anbieten und was wir anfragen. Der erste Eintrag ist der, mit dem
/// gelesen wird — die uebrigen stehen nur im Angebot, damit auch aeltere
/// Programme (X11-Bruecke, Terminals) etwas finden, das sie kennen.
const MIMES: &[&str] = &["text/plain;charset=utf-8", "text/plain", "UTF8_STRING", "STRING"];

/// Wie lange auf den schreibenden Klienten gewartet wird.
///
/// **Gefolgert, nicht gemessen:** das Protokoll sagt nicht zu, dass der
/// Eigentuemer der Auswahl je schreibt (er kann beschaeftigt oder abgestuerzt
/// sein), und `receive` hat keine Antwort. Ohne Frist haenge die
/// Ereignisschleife des Players an einem fremden Programm. Der Wert liegt
/// deutlich unter `pulse_ablage::sitzung::ABRUF_FRIST_MS` (2 s), damit die
/// Antwort noch innerhalb der Frist des Abrufenden ankommt.
const LESE_FRIST: Duration = Duration::from_millis(500);

/// Alles, was die Zwischenablage einen `nachfassen`-Aufruf ueberleben lassen
/// muss. Haengt im [`super::zustand::Zustand`] neben dem Zug-Zustand, weil
/// beide auf demselben `wl_data_device` ankommen.
#[derive(Default)]
pub(super) struct AblageZustand {
    /// Das zuletzt per `selection` gemeldete Angebot. **Nicht zu verwechseln
    /// mit `Zustand::angebot`** — das ist das Angebot eines ZUGS und wird beim
    /// `Leave` zerstoert; dieses hier wird beim naechsten `selection` ersetzt.
    angebot: Option<wl_data_offer::WlDataOffer>,
    /// Bietet das aktuelle Angebot Text an? Ohne diese Auskunft liefe jedes
    /// `receive` auf ein Bild in die volle [`LESE_FRIST`].
    text: bool,
    /// Welche Angebote Text anbieten. Der `offer`-Ereignisstrom kommt VOR dem
    /// `selection`, das sie benennt — ohne diesen Vorrat waere beim `selection`
    /// nicht mehr bekannt, was das Angebot kann.
    text_angebote: HashSet<ObjectId>,
    /// Zaehlt Wechsel der Auswahl — die Nachbildung von
    /// `NSPasteboard.changeCount` ist Absicht (s.
    /// `pulse_ablage::pruefstand::TestAblage`).
    stand: u64,
    gesehen: u64,
    /// **Halten WIR die Auswahl?** Dann sind eintreffende `selection`-
    /// Ereignisse unsere eigenen und duerfen `stand` nicht bewegen — sonst
    /// kuendigten wir der Gegenseite ihren eigenen Inhalt als Neuigkeit
    /// zurueck, sie beanspruchte daraufhin, und das ginge endlos.
    ///
    /// **Geraeumt wird der Merker von `cancelled`**, dem einzigen Ereignis,
    /// das „jemand anders hat die Auswahl uebernommen" verlaesslich meldet.
    /// **Ungemessen bleibt die Reihenfolge:** stellt ein Compositor das
    /// `selection` VOR dem `cancelled` zu, geht genau eine Aenderungsmeldung
    /// verloren — die naechste kommt an.
    eigene: bool,
    /// Unsere Quelle, solange wir Eigentuemer sind.
    quelle: Option<wl_data_source::WlDataSource>,
    /// Text, den unsere Quelle SOFORT ausliefert, statt ihn erst drueben zu
    /// holen. Genau ein Fall: der zurueckgeschriebene Vorbestand (s.
    /// [`Gastverbindung::freigeben`]).
    sofort: Option<String>,
    /// Einfuegevorgaenge, die auf Inhalt warten. Mehrere, weil zwei Programme
    /// gleichzeitig einfuegen koennen — jedes bringt seinen eigenen
    /// Deskriptor mit.
    lieferungen: Vec<OwnedFd>,
}

impl AblageZustand {
    /// `wl_data_offer.offer` — ein Angebot nennt einen seiner Mime-Typen.
    pub(super) fn mime(&mut self, angebot: &wl_data_offer::WlDataOffer, mime: &str) {
        if ist_text(mime) {
            self.text_angebote.insert(angebot.id());
        }
    }

    /// Ein Angebot ist fort (Zug vorbei) — seine Mime-Auskunft mit ihm.
    /// Ohne das waechst [`Self::text_angebote`] bei jedem fremden Zug ueber
    /// ein Player-Fenster um einen Eintrag, der nie wieder gebraucht wird.
    pub(super) fn vergessen(&mut self, angebot: &wl_data_offer::WlDataOffer) {
        self.text_angebote.remove(&angebot.id());
    }

    /// `wl_data_device.selection` — die Auswahl hat gewechselt.
    pub(super) fn auswahl(&mut self, angebot: Option<wl_data_offer::WlDataOffer>) {
        if let Some(alt) = self.angebot.take() {
            self.text_angebote.remove(&alt.id());
            alt.destroy();
        }
        self.text = angebot.as_ref().is_some_and(|a| self.text_angebote.contains(&a.id()));
        self.angebot = angebot;
        // **Nur TEXT bewegt den Zaehler.** Ein kopiertes Bild anzukuendigen
        // brachte der Gegenseite nichts: sie beanspruchte daraufhin ihre
        // Ablage — und loeschte damit den Vorbestand ihres Nutzers — nur um
        // beim Einfuegen ein `weg` zu bekommen. Ein leergeraeumtes
        // Ablagefach (`angebot == None`) faellt aus demselben Grund darunter.
        if !self.eigene && self.text {
            self.stand += 1;
        }
    }

    /// `wl_data_source.send` — jemand fuegt ein und will den Inhalt.
    pub(super) fn send(&mut self, fd: OwnedFd) {
        match self.sofort.clone() {
            Some(text) => schreiben(fd, text),
            // **Hier passiert das verzoegerte Rendern:** der Deskriptor bleibt
            // offen liegen, `app::ablage` sieht ihn im naechsten Takt und
            // schickt erst dann `hol` hinaus.
            None => self.lieferungen.push(fd),
        }
    }

    /// `wl_data_source.cancelled` — jemand anders hat die Auswahl uebernommen.
    pub(super) fn abgeloest(&mut self) {
        self.eigene = false;
        self.sofort = None;
        // Die wartenden Deskriptoren schliessen: wir werden nie liefern, und
        // ein offener Deskriptor liesse den Einfuegenden bis in SEINE Frist
        // warten.
        self.lieferungen.clear();
        if let Some(quelle) = self.quelle.take() {
            quelle.destroy();
        }
    }
}

/// Ist dieser Mime-Typ etwas, das wir als Text lesen koennen?
fn ist_text(mime: &str) -> bool {
    mime.starts_with("text/plain") || matches!(mime, "UTF8_STRING" | "STRING" | "TEXT")
}

/// Auf einem eigenen Faden in den Deskriptor schreiben und ihn schliessen.
///
/// **Warum nicht im Schleifen-Faden:** der Deskriptor kommt vom einfuegenden
/// Klienten und ist in aller Regel eine Roehre; deren Puffer fasst unter Linux
/// vorgabemaessig 64 KiB — also genau [`MAX_TEXT_BYTE`]. Ein Schreiben hier
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
        for mime in MIMES {
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
        self.zustand.ablage.sofort = sofort;
        self.zustand.ablage.eigene = true;
        Ok(())
    }
}

impl Beobachter for Gastverbindung {
    fn geaendert(&mut self) -> bool {
        let a = &mut self.zustand.ablage;
        let neu = a.stand != a.gesehen;
        a.gesehen = a.stand;
        neu
    }

    fn lesen(&self) -> Option<String> {
        let a = &self.zustand.ablage;
        // **Nie die eigene Auswahl lesen.** Das `receive` ginge an unsere
        // EIGENE Quelle; ihr `send` erreicht uns erst im naechsten
        // `nachfassen`, waehrend dieser Aufruf hier blockiert wartet. Es kaeme
        // also nichts, die Frist liefe voll ab — und das `send` bliebe danach
        // als Phantom-Einfuegen liegen und loeste eine sinnlose Anfrage an die
        // Gegenseite aus. Halten wir die Auswahl, liegt darin ohnehin, was
        // von drueben kam: wir haben nichts Eigenes anzubieten.
        if a.eigene || !a.text {
            return None;
        }
        let angebot = a.angebot.as_ref()?;
        let (mut hier, dort) = UnixStream::pair().ok()?;
        angebot.receive(MIMES[0].to_string(), dort.as_fd());
        let _ = self.conn.flush();
        // Das eigene Ende des Paares schliessen, sonst kommt nie ein
        // Dateiende und es bliebe bei der Frist.
        drop(dort);
        hier.set_read_timeout(Some(LESE_FRIST)).ok()?;
        let mut roh = Vec::new();
        let mut puffer = [0u8; 8192];
        loop {
            match hier.read(&mut puffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    roh.extend_from_slice(&puffer[..n]);
                    // Ueber dem Deckel wird nicht weitergelesen — `zerlegen`
                    // wird daraus ohnehin ein `zu_gross` machen.
                    if roh.len() > MAX_TEXT_BYTE {
                        break;
                    }
                }
            }
        }
        // **Verlustbehaftet umgewandelt, und das ist hier richtig:** am Deckel
        // kann ein Mehrbyte-Buchstabe zerschnitten sein, und ein strenges
        // `from_utf8` machte daraus ein `weg` statt des zutreffenden
        // `zu_gross`. Ersatzzeichen sind nie kuerzer als das, was sie
        // ersetzen, der Deckel bleibt also ueberschritten.
        Some(String::from_utf8_lossy(&roh).into_owned())
    }
}

impl Eigentum for Gastverbindung {
    fn beanspruchen(&mut self) -> Result<(), String> {
        self.auswahl_setzen(None)
    }

    fn liefern(&mut self, text: &str) {
        for fd in std::mem::take(&mut self.zustand.ablage.lieferungen) {
            schreiben(fd, text.to_string());
        }
    }

    fn freigeben(&mut self, zurueck: Option<&str>) {
        if !self.zustand.ablage.eigene {
            // Jemand anders haelt die Auswahl laengst — sie mit einem
            // Merkposten von vorhin zu ueberschreiben waere derselbe stille
            // Verlust, gegen den der Merkposten ueberhaupt gebaut ist.
            return;
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
        !self.zustand.ablage.lieferungen.is_empty()
    }

    /// Dieselbe Nummer, aus der auch `start_drag` seine bezieht (s.
    /// [`super::zustand::DruckNummer`]) — sie gehoert dem DRUCK, nicht dem
    /// Zug.
    fn seriennummer(&self) -> Option<u32> {
        self.zustand.druck.aktuell()
    }

    fn eigentuemer(&self) -> bool {
        self.zustand.ablage.eigene
    }
}
