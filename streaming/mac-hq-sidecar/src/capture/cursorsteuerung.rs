//! Host-Zeiger zur Laufzeit aus der Aufnahme nehmen — die macOS-Haelfte des
//! Cursor-Echos der Fernsteuerung.
//!
//! **Warum, wann, und wessen Zeiger das ist**, steht beim Zwilling
//! (`win-hq-sidecar/src/capture/cursorsteuerung.rs`) und wird hier nicht
//! abgeschrieben: der Steuernde saehe sonst ZWEI Zeiger — seinen eigenen
//! sofort und den des Hosts eine volle Kreislaufzeit spaeter —, und genau das
//! fuehlt sich als „Lag" an. Umgeschaltet wird am Frame-Opcode: absolute
//! Mausbewegung → verbergen, relative (Zeigerfang) → zeigen. Der Host sieht
//! seinen Zeiger auf dem eigenen Schirm unveraendert; andere Zuschauer sehen
//! waehrend einer Fernsteuerung keinen.
//!
//! **Die Zustandsfuehrung steht nicht hier**, sondern in
//! `pulse_fernsteuerung::zeigerschalter` — samt ihren drei Zusagen (nie ueber
//! den Ausgangszustand hinaus, nur der Wechsel loest aus, asymmetrische
//! Fehlerbehandlung), ihrer Begruendung und ihren Tests. Hier bleibt die
//! Uebersetzung in den Plattform-Aufruf.
//!
//! ## Drei Dinge, die auf macOS anders sind als auf Windows
//!
//! **1. Es gibt keinen Einzelschalter am laufenden Strom.** WGC bietet
//! `SetIsCursorCaptureEnabled` direkt auf der Session; ScreenCaptureKit kennt
//! nur `updateConfiguration:completionHandler:` — und das nimmt eine GANZE
//! [`SCStreamConfiguration`]. Deshalb haelt der Platz die
//! Einstellungs-Instanz, mit der der Strom gestartet wurde, und kippt an ihr
//! genau eine Eigenschaft. Eine frisch gebaute Einstellung waere der Fehler,
//! der hier am leichtesten passiert: sie verloere still Breite, Hoehe,
//! Bildabstand, Pixelformat und Warteschlangentiefe — die Aufnahme liefe
//! danach in SCK-Vorgaben weiter, ohne dass irgendetwas fehlschluege.
//!
//! **2. Der Aufruf ist asynchron, die Buchung haengt aber an seinem Ausgang.**
//! Gebucht wird erst nach `Ok` (s. `Schalter::gelungen`) — sonst hielte der
//! Sidecar den Zeiger fuer verborgen, waehrend er im Bild steht. Also wird auf
//! den Abschluss-Block gewartet, wie beim Start und beim Stopp des Stroms
//! ([`super::mit_abschluss`]). Dass dieses Warten kein Selbstschloss ist, ist
//! in dieser Kiste seit jeher belegt: `shareable_content()` blockiert
//! denselben Faden auf denselben Mechanismus, und `list_monitors` lebt davon.
//!
//! **3. Nur der BILD-Strom gehoert hierher.** Seit dem 2026-08-20 faehrt der
//! Sidecar zwei Stroeme (Begruendung in [`super::filter`]); der Ton-Strom
//! traegt keinen Zeiger und wird nicht angemeldet.
//!
//! Aufgerufen wird aus zwei Faeden — dem Verteiler (je Eingabe-Nachricht) und
//! dem Wecker der Wache (Vorrang-Uebergang). SCK-Objekte sind fadensicher
//! (Modulkopf in [`super`]), und die Sperre unten ordnet die Aufrufe.

use std::sync::Mutex;
use std::time::Duration;

use objc2::rc::Retained;
use objc2_screen_capture_kit::{SCStream, SCStreamConfiguration};
use pulse_fernsteuerung::zeigerschalter::{Schalter, Wirkung};

use super::AssumeSend;

/// Wie lange auf den Abschluss von `updateConfiguration` gewartet wird.
///
/// **Kuerzer als beim Start (10 s) und beim Stopp (5 s)**, weil dieser Aufruf
/// im Eingabeweg sitzt: eine haengende SCK darf den Verteiler nicht laenger
/// festhalten als noetig.
///
/// Gemessen (2026-08-23, macOS 15.7.3, `examples/probe_zeigerecho.rs`,
/// laufende 1280x720-Aufnahme von Bildschirm 1): je 4 echte Umschaltungen
/// **14,6–17,3 ms**. Bei 5 fps statt 30 dieselben Zahlen — die Dauer haengt
/// also NICHT am Bildabstand der Aufnahme (die naheliegende Vermutung „SCK
/// wendet es beim naechsten Bild an" ist damit widerlegt; ~15 ms passt eher
/// zum 60-Hz-Takt des Schirms, das ist aber nur eine Vermutung). Die Frist
/// liegt gut zwei Groessenordnungen darueber und greift nur, wenn wirklich
/// etwas steht.
///
/// Ein weggefilterter Ruf (kein Wechsel) kostet 0,000 ms — er geht gar nicht
/// erst hinaus.
///
/// **Der Preis einer Zeitueberschreitung**, ehrlich benannt: sie gilt als
/// Fehlschlag, und beim Verbergen raeumt der Schalter daraufhin den Platz.
/// Landet die Umstellung danach doch noch, bleibt der Zeiger bis zum
/// Strom-Ende draussen. Hingenommen — eine Zeitueberschreitung hier heisst,
/// dass der Strom selbst haengt, und die Gegenrichtung (jede weitere
/// Eingabe-Nachricht blockiert erneut zwei Sekunden) waere schlimmer.
const FRIST: Duration = Duration::from_secs(2);

/// Der eine Cursor-Platz dieses Prozesses.
///
/// Ein Prozess faehrt genau einen Bild-Strom (s. `remote_input::ziel`),
/// deshalb genuegt EIN Platz — eine neue Aufnahme ueberschreibt ihn.
struct Platz {
    /// Der laufende Bild-Strom. Bewusst KEIN Zugriff auf den [`super::Capturer`]:
    /// der lebt als lokale Variable im Strom-Faden, und ihn dafuer in einen
    /// weiteren globalen Platz zu heben, fuegte Zustand hinzu, den niemand
    /// sonst braucht.
    strom: AssumeSend<Retained<SCStream>>,
    /// **Dieselbe** Instanz, mit der der Strom gestartet wurde — s. Punkt 1 im
    /// Modulkopf.
    einstellungen: AssumeSend<Retained<SCStreamConfiguration>>,
    /// Die plattformfreie Zustandsfuehrung aus
    /// `pulse_fernsteuerung::zeigerschalter`.
    schalter: Schalter,
}

static PLATZ: Mutex<Option<Platz>> = Mutex::new(None);

/// Die Sperre nehmen — auch eine vergiftete, aus demselben Grund wie beim
/// Zwilling und wie bei der Sperre der Fernsteuer-Sitzung: der
/// Wiederherstellungspfad laeuft auch beim Prozessende und darf an keiner
/// fremden Panik scheitern.
fn sperre() -> std::sync::MutexGuard<'static, Option<Platz>> {
    PLATZ.lock().unwrap_or_else(|e| e.into_inner())
}

/// Eine frisch gestartete Aufnahme meldet ihren Bild-Strom an.
///
/// `basis_sichtbar` ist das `show_cursor` der Start-Anfrage — der
/// Ausgangszustand, ueber den hinaus nie gezeigt wird.
///
/// Ueberschreibt einen etwaigen Vorgaenger: der ist dann entweder tot
/// (Strom-Neustart) oder die Hinterlassenschaft eines Faden-Absturzes, bei dem
/// [`abmelden`] ausfiel.
pub(super) fn anmelden(
    strom: Retained<SCStream>,
    einstellungen: Retained<SCStreamConfiguration>,
    basis_sichtbar: bool,
) {
    *sperre() = Some(Platz {
        strom: AssumeSend(strom),
        einstellungen: AssumeSend(einstellungen),
        schalter: Schalter::neu(basis_sichtbar),
    });
}

/// Die Aufnahme ist beendet — Platz raeumen. Kein Wiederherstellen noetig: die
/// Einstellung stirbt mit dem Strom, und der naechste startet mit seinem
/// eigenen `show_cursor`.
///
/// **Auf macOS ist das Pflicht, nicht Hoeflichkeit** — derselbe Grund wie bei
/// `remote_input::ziel::strom_beendet`: der Sidecar bleibt zwischen zwei
/// Stroemen warm, hier raeumt kein Prozesswechsel hinterher.
pub(super) fn abmelden() {
    *sperre() = None;
}

/// Zeiger aus der Aufnahme nehmen (Fernsteuerung mit absoluter Mausfuehrung).
/// No-op ohne laufende Aufnahme, ohne Zeiger im Ausgangszustand oder wenn
/// bereits verborgen.
pub fn verbergen() {
    setzen(true);
}

/// Zurueck auf den Ausgangszustand des Stroms. No-op, wenn nichts verborgen
/// ist.
pub fn zeigen() {
    setzen(false);
}

/// Was die Aufnahme gerade zeigen soll, aus der gehaltenen Einstellung
/// gelesen; `None` ohne angemeldeten Platz.
///
/// **Nur fuer den Pruefling** (`examples/probe_zeigerecho.rs`) — im
/// ausgelieferten Weg ruft das niemand. Und es belegt genau eines: was DIESE
/// Seite geschrieben hat. Dass SCK es auch angewandt hat, zeigt erst das Bild
/// beim Zuschauer (Zwei-Geraete-Lauf).
pub fn zeiger_in_der_aufnahme() -> Option<bool> {
    sperre().as_ref().map(|p| unsafe { p.einstellungen.0.showsCursor() })
}

fn setzen(verbergen: bool) {
    let mut platz = sperre();
    // Feldweise ausgepackt, damit der Schalter veraenderlich geliehen werden
    // kann, waehrend der Verschluss Strom und Einstellung liest.
    let Some(Platz { strom, einstellungen, schalter }) = platz.as_mut() else { return };
    if ablauf(schalter, verbergen, |v| umstellen(&strom.0, &einstellungen.0, v)) {
        *platz = None;
    }
}

/// Der Ablauf ohne Plattform: fragen, ob etwas zu tun ist — nur dann rufen —
/// und **erst nach einem gelungenen Ruf** buchen. Liefert `true`, wenn der
/// Platz zu raeumen ist.
///
/// Der Verschluss ist die Naht, an der die Plattform haengt: mit ihr laesst
/// sich diese Reihenfolge ohne laufenden `SCStream` pruefen (s. Tests unten),
/// und genau daran haengt das Netz — der Aufruf selbst ([`umstellen`]) hat
/// keines und gehoert in den Pruefling.
fn ablauf(
    schalter: &mut Schalter,
    verbergen: bool,
    ruf: impl FnOnce(bool) -> Result<(), String>,
) -> bool {
    // Ob es hier ueberhaupt etwas zu tun gibt (Ausgangszustand,
    // Wechsel-Filter) entscheidet der Schalter — Begruendung samt Tests in
    // `pulse_fernsteuerung::zeigerschalter`.
    let Wirkung::Umschalten(v) = schalter.setzen(verbergen) else { return false };
    match ruf(v) {
        Ok(()) => {
            schalter.gelungen(v);
            eprintln!(
                "[cursor] Host-Zeiger {} (Fernsteuerung)",
                if v { "aus der Aufnahme genommen" } else { "wieder in der Aufnahme" }
            );
            false
        }
        // Die asymmetrische Fehlerbehandlung (scheitert das VERBERGEN, wird
        // der Platz geraeumt; scheitert das ZEIGEN, bleibt er stehen) sitzt in
        // `Schalter::gescheitert` — hier bleibt nur, ihr Ergebnis umzusetzen:
        // `true` heisst raeumen. Gebucht wird in diesem Zweig NICHTS.
        Err(e) => {
            eprintln!("[cursor] updateConfiguration(showsCursor={}): {e}", !v);
            let raeumen = schalter.gescheitert(v);
            if raeumen {
                eprintln!("[cursor] Cursor-Echo aus");
            }
            raeumen
        }
    }
}

/// Die eine Plattform-Zeile — und das Warten darauf.
///
/// `!verbergen` ist die Uebersetzung, die der Schalter dem Aufrufer
/// ausdruecklich ueberlaesst (`Wirkung::Umschalten` traegt die angefragte
/// RICHTUNG, nicht das Argument des Plattform-Rufs). `true` kommt hier nur an,
/// wenn der Ausgangszustand sichtbar war — die Zusage „nie ueber den
/// Ausgangszustand hinaus" traegt der Schalter, nicht diese Zeile.
fn umstellen(
    strom: &SCStream,
    einstellungen: &SCStreamConfiguration,
    verbergen: bool,
) -> Result<(), String> {
    unsafe { einstellungen.setShowsCursor(!verbergen) };
    super::mit_abschluss(FRIST, |h| unsafe {
        strom.updateConfiguration_completionHandler(einstellungen, Some(h))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Faehrt [`ablauf`] mit einer Attrappe statt der Plattform und schreibt
    /// jeden Ruf mit — geprueft wird die REIHENFOLGE (fragen, rufen, buchen),
    /// nicht SCK.
    fn lauf(
        schalter: &mut Schalter,
        verbergen: bool,
        antwort: Result<(), String>,
        rufe: &mut Vec<bool>,
    ) -> bool {
        ablauf(schalter, verbergen, |v| {
            rufe.push(v);
            antwort
        })
    }

    /// **Nie ueber den Ausgangszustand hinaus.** Wer ohne Zeiger streamt,
    /// bekommt durch eine Fernsteuerung keinen — und es geht auch kein
    /// `updateConfiguration` hinaus.
    #[test]
    fn ohne_zeiger_im_ausgangszustand_kein_plattform_aufruf() {
        let mut s = Schalter::neu(false);
        let mut rufe = Vec::new();
        assert!(!lauf(&mut s, true, Ok(()), &mut rufe));
        assert!(!lauf(&mut s, false, Ok(()), &mut rufe));
        assert!(rufe.is_empty(), "nichts zu verbergen, also nichts zu rufen: {rufe:?}");
    }

    /// Nur der Zustandswechsel loest den Plattform-Aufruf aus — bei bis zu 125
    /// Eingabe-Nachrichten je Sekunde waere ein `updateConfiguration` je
    /// Nachricht vermeidbare Arbeit.
    #[test]
    fn nur_der_wechsel_ruft_die_plattform() {
        let mut s = Schalter::neu(true);
        let mut rufe = Vec::new();
        lauf(&mut s, true, Ok(()), &mut rufe);
        lauf(&mut s, true, Ok(()), &mut rufe);
        assert_eq!(rufe, vec![true], "zweites Verbergen ist schon erreicht");
        lauf(&mut s, false, Ok(()), &mut rufe);
        lauf(&mut s, false, Ok(()), &mut rufe);
        assert_eq!(rufe, vec![true, false], "zweites Zeigen ist schon erreicht");
    }

    /// **Gebucht wird erst nach gelungenem Aufruf.** Scheitert das Zeigen,
    /// bleibt der Zeiger verborgen — also muss der naechste Versuch wieder
    /// hinausgehen, und ein Verbergen dazwischen bleibt ein No-op. Wer im
    /// Fehlerzweig buchte, kehrte beides um.
    #[test]
    fn ein_gescheiterter_ruf_wird_nicht_gebucht() {
        let mut s = Schalter::neu(true);
        let mut rufe = Vec::new();
        lauf(&mut s, true, Ok(()), &mut rufe);
        lauf(&mut s, false, Err("kaputt".into()), &mut rufe);
        assert_eq!(rufe, vec![true, false]);

        assert!(!lauf(&mut s, true, Ok(()), &mut rufe));
        assert_eq!(rufe, vec![true, false], "verborgen ist er ja noch — nichts zu tun");
        lauf(&mut s, false, Ok(()), &mut rufe);
        assert_eq!(rufe, vec![true, false, false], "das Zeigen muss erneut hinaus");
    }

    /// Die asymmetrische Fehlerbehandlung, wie sie hier ankommt: gescheitertes
    /// VERBERGEN raeumt den Platz (sonst wiederholte sich der Fehlschlag samt
    /// Log-Zeile mit jeder Eingabe-Nachricht), gescheitertes ZEIGEN nicht (der
    /// Platz ist die einzige Moeglichkeit, den Zeiger zurueckzuholen).
    #[test]
    fn scheitern_raeumt_nur_in_einer_richtung() {
        let mut s = Schalter::neu(true);
        let mut rufe = Vec::new();
        assert!(lauf(&mut s, true, Err("kaputt".into()), &mut rufe), "verbergen → raeumen");

        let mut s = Schalter::neu(true);
        lauf(&mut s, true, Ok(()), &mut rufe);
        assert!(
            !lauf(&mut s, false, Err("kaputt".into()), &mut rufe),
            "zeigen → stehen lassen"
        );
    }

    /// Ohne angemeldete Aufnahme sind beide Richtungen stille No-ops. Mehr
    /// laesst sich an den oeffentlichen Wegen ohne laufenden `SCStream` nicht
    /// pruefen — was daran haengt, gehoert in `examples/probe_zeigerecho.rs`
    /// und in den Zwei-Geraete-Lauf.
    #[test]
    fn ohne_aufnahme_sind_beide_richtungen_no_ops() {
        abmelden();
        verbergen();
        zeigen();
        assert_eq!(zeiger_in_der_aufnahme(), None);
    }
}
