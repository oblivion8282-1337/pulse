//! Der Zustand der Auswahl: was angeboten ist, wem sie gehoert, wer auf
//! Inhalt wartet — und der Lesevorgang, der dafuer auf einem eigenen Faden
//! laeuft.
//!
//! Abgetrennt von [`super`], wo die Trait-Umsetzungen an der
//! `Gastverbindung` haengen: hier steht, was ein Ereignis am Zustand
//! aendert, dort, was der Ablauf darueber daraus macht. Groessen-Begruendung
//! wie ueberall hier (`PLAN.md` §12.1).

use std::collections::HashMap;
use std::io::Read;
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::sync::mpsc::{Receiver, TryRecvError};
use std::time::Duration;

use wayland_backend::sys::client::ObjectId;
use wayland_client::protocol::{wl_data_offer, wl_data_source};
use wayland_client::Proxy;

use pulse_ablage::format::MAX_TEXT_BYTE;

/// Was wir anbieten. Angefordert wird beim Lesen dagegen **der Typ, den die
/// Gegenseite wirklich genannt hat** (s. [`AblageZustand::mime`]).
pub(super) const MIMES: &[&str] =
    &["text/plain;charset=utf-8", "text/plain", "UTF8_STRING", "STRING"];

/// Wie lange auf den schreibenden Klienten gewartet wird.
///
/// **Gefolgert, nicht gemessen:** das Protokoll sagt nicht zu, dass der
/// Eigentuemer der Auswahl je schreibt (er kann beschaeftigt oder abgestuerzt
/// sein), und `receive` hat keine Antwort. Der Wert liegt deutlich unter
/// `pulse_ablage::sitzung::ABRUF_FRIST_MS` (2 s), damit die Antwort noch
/// innerhalb der Frist des Abrufenden ankommt. Er blockiert **keinen**
/// Schleifen-Faden mehr, sondern nur den eigens dafuer gestarteten.
const LESE_FRIST: Duration = Duration::from_millis(500);

/// Wie gut ein angebotener Mime-Typ passt — kleiner ist besser, `None` heisst
/// „kein Text".
///
/// Toleriert Gross-/Kleinschreibung und Leerzeichen im Parameterteil: in freier
/// Wildbahn stehen `text/plain;charset=utf-8`, `text/plain; charset=UTF-8` und
/// `UTF8_STRING` nebeneinander, und ein Vergleich auf die eine Schreibweise
/// verfehlte die anderen.
fn textrang(mime: &str) -> Option<u8> {
    let eng: String =
        mime.chars().filter(|z| !z.is_ascii_whitespace()).flat_map(char::to_lowercase).collect();
    match eng.as_str() {
        "text/plain;charset=utf-8" => Some(0),
        "utf8_string" => Some(1),
        "text/plain" => Some(2),
        "string" | "text" => Some(3),
        _ => None,
    }
}

/// Ein Lesevorgang auf der fremden Auswahl.
pub(super) enum Lesen {
    /// Nichts angestossen — der naechste `lesen_anstossen` eroeffnet einen.
    Nichts,
    /// Ein eigener Faden wartet auf den fremden Klienten.
    Laeuft(Receiver<Option<String>>),
    /// Ergebnis liegt vor. Gilt fuer die AKTUELLE Auswahl und wird mit ihr
    /// verworfen.
    Fertig(Option<String>),
}

/// Alles, was die Zwischenablage einen `nachfassen`-Aufruf ueberleben lassen
/// muss. Haengt im [`super::super::zustand::Zustand`] neben dem Zug-Zustand,
/// weil beide auf demselben `wl_data_device` ankommen.
pub(in crate::fernsteuerung::wayland) struct AblageZustand {
    /// Das zuletzt per `selection` gemeldete Angebot. **Nicht zu verwechseln
    /// mit `Zustand::angebot`** — das ist das Angebot eines ZUGS und wird beim
    /// `Leave` zerstoert; dieses hier wird beim naechsten `selection` ersetzt.
    angebot: Option<wl_data_offer::WlDataOffer>,
    /// Welchen Text-Mime das aktuelle Angebot fuehrt — genau die Zeichenkette,
    /// die es genannt hat. `None` heisst „kein Text darin".
    mime: Option<String>,
    /// Je Angebot der beste genannte Text-Mime. Der `offer`-Ereignisstrom
    /// kommt VOR dem `selection`, das sie benennt — ohne diesen Vorrat waere
    /// beim `selection` nicht mehr bekannt, was das Angebot kann.
    text_mimes: HashMap<ObjectId, String>,
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
    /// Die Reihenfolge, in der ein Compositor `selection` und `cancelled`
    /// zustellt, ist **gleichgueltig**, und zwar seit [`Self::abgeloest`] den
    /// Zaehler selbst hochzieht: kommt das `selection` zuerst, faellt es hier
    /// zwar durch (`eigene` steht noch), aber der Eigentumsverlust holt die
    /// Meldung nach. Ohne dieses Nachholen zeigten `angebot` und `mime` auf
    /// den NEUEN Inhalt, waehrend die angekuendigte Generation noch die alte
    /// war — und `beantworte` haette ihn ausgeliefert, ohne dass er je
    /// angekuendigt wurde.
    eigene: bool,
    /// Unsere Quelle, solange wir Eigentuemer sind.
    pub(super) quelle: Option<wl_data_source::WlDataSource>,
    /// Text, den unsere Quelle SOFORT ausliefert, statt ihn erst drueben zu
    /// holen. Genau ein Fall: der zurueckgeschriebene Vorbestand.
    sofort: Option<String>,
    /// Einfuegevorgaenge, die auf Inhalt warten. Mehrere, weil zwei Programme
    /// gleichzeitig einfuegen koennen — jedes bringt seinen eigenen
    /// Deskriptor mit.
    lieferungen: Vec<OwnedFd>,
    lesen: Lesen,
}

impl Default for AblageZustand {
    fn default() -> Self {
        Self {
            angebot: None,
            mime: None,
            text_mimes: HashMap::new(),
            stand: 0,
            gesehen: 0,
            eigene: false,
            quelle: None,
            sofort: None,
            lieferungen: Vec::new(),
            lesen: Lesen::Nichts,
        }
    }
}

impl AblageZustand {
    /// `wl_data_offer.offer` — ein Angebot nennt einen seiner Mime-Typen.
    pub(in crate::fernsteuerung::wayland) fn mime(
        &mut self,
        angebot: &wl_data_offer::WlDataOffer,
        mime: &str,
    ) {
        let Some(rang) = textrang(mime) else { return };
        let eintrag = self.text_mimes.entry(angebot.id()).or_insert_with(|| mime.to_string());
        // Ein besserer Typ ersetzt den gemerkten; ein schlechterer nicht.
        if textrang(eintrag).is_none_or(|bisher| rang < bisher) {
            *eintrag = mime.to_string();
        }
    }

    /// Ein Angebot ist fort (Zug vorbei) — seine Mime-Auskunft mit ihm.
    /// Ohne das waechst [`Self::text_mimes`] bei jedem fremden Zug ueber ein
    /// Player-Fenster um einen Eintrag, der nie wieder gebraucht wird.
    pub(in crate::fernsteuerung::wayland) fn vergessen(
        &mut self,
        angebot: &wl_data_offer::WlDataOffer,
    ) {
        self.text_mimes.remove(&angebot.id());
    }

    /// `wl_data_device.selection` — die Auswahl hat gewechselt.
    pub(in crate::fernsteuerung::wayland) fn auswahl(
        &mut self,
        angebot: Option<wl_data_offer::WlDataOffer>,
    ) {
        if let Some(alt) = self.angebot.take() {
            self.text_mimes.remove(&alt.id());
            alt.destroy();
        }
        self.mime = angebot.as_ref().and_then(|a| self.text_mimes.get(&a.id()).cloned());
        self.angebot = angebot;
        // Ein Ergebnis gehoert der Auswahl, aus der es stammt.
        self.lesen = Lesen::Nichts;
        // **Nur TEXT bewegt den Zaehler.** Ein kopiertes Bild anzukuendigen
        // brachte der Gegenseite nichts: sie beanspruchte daraufhin ihre
        // Ablage — und loeschte damit den Vorbestand ihres Nutzers — nur um
        // beim Einfuegen ein `weg` zu bekommen. Ein leergeraeumtes
        // Ablagefach (`angebot == None`) faellt aus demselben Grund darunter.
        if !self.eigene && self.mime.is_some() {
            self.stand += 1;
        }
    }

    /// `wl_data_source.send` — jemand fuegt ein und will den Inhalt.
    pub(in crate::fernsteuerung::wayland) fn send(&mut self, fd: OwnedFd) {
        match self.sofort.clone() {
            Some(text) => super::schreiben(fd, text),
            // **Hier passiert das verzoegerte Rendern:** der Deskriptor bleibt
            // offen liegen, `app::ablage` sieht ihn im naechsten Takt und
            // schickt erst dann `hol` hinaus.
            None => self.lieferungen.push(fd),
        }
    }

    /// `wl_data_source.cancelled` — jemand anders hat die Auswahl uebernommen.
    ///
    /// **Der Eigentumsverlust IST eine unverbuchte Aenderung**, deshalb zieht
    /// er den Zaehler hoch. Fail-closed statt gemessen: welche Reihenfolge ein
    /// Compositor zwischen `selection` und `cancelled` waehlt, muss danach
    /// niemand wissen. Kam das `selection` zuerst, ist die Meldung hiermit
    /// nachgeholt (sie fiel dort durch, weil `eigene` noch stand); kam es
    /// danach, zaehlt sie dort — die zweite Meldung kostet eine ueberzaehlige
    /// Ankuendigung, nie Inhalt.
    ///
    /// **Der Preis, und er ist bekannt:** ueber den Weg
    /// `Eigentum::freigeben(None)` raeumen wir die Auswahl selbst und melden
    /// danach trotzdem eine Aenderung. Kuendigt eine noch wache Sitzung sie an,
    /// beansprucht die Gegenseite ihre Ablage fuer ein leeres Fach — genau das,
    /// was [`Self::auswahl`] fuer den `selection`-Weg ausdruecklich vermeidet.
    /// Die Abwaegung ist eindeutig: dort kostet es eine kurz verdraengte
    /// fremde Ablage (der Vorbestand drueben bleibt gemerkt und kommt zurueck),
    /// hier ginge unangekuendigter Inhalt hinaus.
    pub(in crate::fernsteuerung::wayland) fn abgeloest(&mut self) {
        self.eigene = false;
        self.stand += 1;
        self.sofort = None;
        // Die wartenden Deskriptoren schliessen: wir werden nie liefern, und
        // ein offener Deskriptor liesse den Einfuegenden bis in SEINE Frist
        // warten.
        self.lieferungen.clear();
        if let Some(quelle) = self.quelle.take() {
            quelle.destroy();
        }
    }

    /// Eine frische eigene Quelle steht — ab jetzt gehoert die Auswahl uns.
    pub(super) fn eigene_quelle(&mut self, sofort: Option<String>) {
        self.sofort = sofort;
        self.eigene = true;
    }

    pub(super) fn eigene(&self) -> bool {
        self.eigene
    }

    pub(super) fn angebot(&self) -> Option<&wl_data_offer::WlDataOffer> {
        self.angebot.as_ref()
    }

    pub(super) fn mime_typ(&self) -> Option<&str> {
        self.mime.as_deref()
    }

    pub(super) fn einfuegen_wartet(&self) -> bool {
        !self.lieferungen.is_empty()
    }

    pub(super) fn lieferungen_nehmen(&mut self) -> Vec<OwnedFd> {
        std::mem::take(&mut self.lieferungen)
    }

    /// Verbrauchend, wie `Beobachter::geaendert` es verlangt.
    pub(super) fn aenderung_abholen(&mut self) -> bool {
        let neu = self.stand != self.gesehen;
        self.gesehen = self.stand;
        neu
    }

    /// Ist noch kein Lesevorgang eroeffnet?
    pub(super) fn lesen_offen(&self) -> bool {
        matches!(self.lesen, Lesen::Nichts)
    }

    pub(super) fn lesen_setzen(&mut self, lesen: Lesen) {
        self.lesen = lesen;
    }

    /// Liegt ein Ergebnis vor? Holt es dabei vom Faden ab.
    pub(super) fn lesen_bereit(&mut self) -> bool {
        if let Lesen::Laeuft(rx) = &self.lesen {
            match rx.try_recv() {
                Ok(ergebnis) => self.lesen = Lesen::Fertig(ergebnis),
                Err(TryRecvError::Empty) => return false,
                // Der Faden ist ohne Antwort verschwunden. Als „nichts"
                // werten statt ewig zu warten — ein haengender Abruf waere
                // schlimmer als ein leeres Einfuegen.
                Err(TryRecvError::Disconnected) => self.lesen = Lesen::Fertig(None),
            }
        }
        matches!(self.lesen, Lesen::Fertig(_))
    }

    pub(super) fn gelesenes(&self) -> Option<String> {
        match &self.lesen {
            Lesen::Fertig(text) => text.clone(),
            _ => None,
        }
    }
}

/// Den Deskriptor leerlesen — **laeuft auf einem eigenen Faden**, s.
/// [`LESE_FRIST`].
pub(super) fn vom_deskriptor(mut hier: UnixStream) -> Option<String> {
    hier.set_read_timeout(Some(LESE_FRIST)).ok()?;
    let mut roh = Vec::new();
    let mut puffer = [0u8; 8192];
    loop {
        match hier.read(&mut puffer) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                roh.extend_from_slice(&puffer[..n]);
                // Ueber dem Deckel wird nicht weitergelesen — `zerlegen` wird
                // daraus ohnehin ein `zu_gross` machen.
                if roh.len() > MAX_TEXT_BYTE {
                    break;
                }
            }
        }
    }
    if roh.is_empty() {
        return None;
    }
    // **Verlustbehaftet umgewandelt, und das ist hier richtig:** am Deckel kann
    // ein Mehrbyte-Buchstabe zerschnitten sein, und ein strenges `from_utf8`
    // machte daraus ein `weg` statt des zutreffenden `zu_gross`. Ersatzzeichen
    // sind nie kuerzer als das, was sie ersetzen, der Deckel bleibt also
    // ueberschritten.
    Some(String::from_utf8_lossy(&roh).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    use pulse_ablage::beobachter::Beobachter;
    use pulse_ablage::format::{Grund, Rahmen};
    use pulse_ablage::sitzung::Ankuendiger;

    /// Derselbe Beobachter, den `Gastverbindung` stellt — nur ohne Compositor:
    /// die Aenderungsmeldung kommt aus dem echten [`AblageZustand`], gelesen
    /// wird ein fester Text. Mehr braucht der Weg nicht; `wl_data_offer` laesst
    /// sich ohne Verbindung ohnehin nicht bauen.
    struct Sicht<'a>(&'a mut AblageZustand, &'a str);

    impl Beobachter for Sicht<'_> {
        fn geaendert(&mut self) -> bool {
            self.0.aenderung_abholen()
        }
        fn lesen(&self) -> Option<String> {
            Some(self.1.to_string())
        }
    }

    /// **C1, und es ist die Kernzusicherung des ganzen Entwurfs.**
    ///
    /// Wir halten die Auswahl, der Nutzer kopiert lokal ein Passwort. Raeumt
    /// der Compositor das `selection` VOR dem `cancelled` ein, faellt es in
    /// [`AblageZustand::auswahl`] durch (`eigene` steht noch) — der Zaehler
    /// bewegt sich also nur, wenn der Eigentumsverlust ihn selbst hochzieht.
    /// Tut er das nicht, stimmt beim naechsten `hol` die Generation, und
    /// `beantworte` schickt das Passwort hinaus, ohne dass es je angekuendigt
    /// wurde.
    #[test]
    fn eigentumsverlust_zaehlt_als_unverbuchte_aenderung() {
        let mut a = Ankuendiger::neu();
        let mut z = AblageZustand::default();
        z.eigene_quelle(None);
        z.aenderung_abholen(); // Stand quittiert — hier ist noch alles sauber.
        a.geaendert(); // gen 1: angekuendigt wurde, was DRUEBEN liegt.

        // Das `selection` mit dem frisch kopierten Passwort kam zuerst und ist
        // durchgefallen; jetzt erst meldet der Compositor den Eigentumsverlust.
        z.abgeloest();

        let antwort =
            a.beantworte(&Rahmen::Hol { generation: 1, id: 5 }, &mut Sicht(&mut z, "hunter2"));
        for r in &antwort {
            let j = serde_json::to_string(&r.nach_json()).expect("serialisierbar");
            assert!(!j.contains("hunter2"), "unangekuendigter Inhalt in der Antwort: {j}");
        }
        assert!(
            matches!(antwort.first(), Some(Rahmen::Leer { grund: Grund::Veraltet, .. })),
            "der Abruf muss als veraltet abgewiesen werden, bekam: {antwort:?}"
        );
    }

    /// Die Rangfolge entscheidet, welchen Typ wir beim Lesen anfordern — und
    /// ein Vergleich auf genau eine Schreibweise verfehlte die anderen.
    #[test]
    fn textrang_erkennt_die_ueblichen_schreibweisen() {
        assert_eq!(textrang("text/plain;charset=utf-8"), Some(0));
        assert_eq!(textrang("text/plain; charset=UTF-8"), Some(0));
        assert_eq!(textrang("UTF8_STRING"), Some(1));
        assert_eq!(textrang("text/plain"), Some(2));
        assert_eq!(textrang("STRING"), Some(3));
        assert_eq!(textrang("image/png"), None);
        assert_eq!(textrang("text/uri-list"), None, "Dateien sind Stufe 2, nicht Text");
    }

    /// Der bessere Typ gewinnt, unabhaengig von der Reihenfolge, in der die
    /// `offer`-Ereignisse eintreffen.
    #[test]
    fn rangfolge_ist_unabhaengig_von_der_ereignisfolge() {
        assert!(textrang("text/plain;charset=utf-8") < textrang("text/plain"));
        assert!(textrang("UTF8_STRING") < textrang("STRING"));
    }
}
