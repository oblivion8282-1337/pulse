//! Der Takt der Zeigerform: die Buchfuehrung anschliessen, melden — und den
//! Host-Zeiger ins Bild zurueckholen, wenn es keine Form mehr zu melden gibt.
//!
//! **Welche** Form der Zeiger hat, beantwortet [`super::zeigerform`]; **wann**
//! daraus eine Nachricht wird und wie sie aussieht,
//! [`pulse_fernsteuerung::zeigerbuch`]. Hier steht das Stueck dazwischen: die
//! vier Pflichten, die der Kopf des Zeigerbuchs ausdruecklich beim Sender
//! laesst — der Takt, der [`Stand`], die Vorrang-Weiche und das Einreihen
//! ausserhalb der eigenen Sperre. Der Windows-Zwilling hat dieselben vier
//! beisammen in `win-hq-sidecar/src/remote_input/zeigerform.rs::tick`.
//!
//! **An der Buchfuehrung wird nichts geaendert.** Was hier fehlt, fehlt der
//! Windows-Seite auch — und gehoerte dann in die gemeinsame Kiste.
//!
//! ## Der Rueckfall, den Windows nicht hat
//!
//! `NSCursor.currentSystemCursor` ist abgekuendigt; der SDK-Kopf sagt woertlich,
//! die Eigenschaft werde in einer kuenftigen macOS-Fassung immer `nil` liefern
//! (Begruendung und Messung in [`super::zeigerform`]). Damit die Fernsteuerung
//! dann **altert statt auszufallen**, gibt es den zweiten Weg: liefert die
//! Abfrage nichts, holt der Sidecar den Host-Zeiger in die Aufnahme zurueck und
//! sagt dem Steuernden, dass er seinen lokalen ausblenden soll. Der Host-Zeiger
//! reitet dann im Video mit — von Natur aus formrichtig, aber der Hand um die
//! Stroemungsverzoegerung hinterher. Schlechter, nicht kaputt.
//!
//! **Die beiden Haelften gehoeren zusammen, und einzeln ist jede falsch.** Nur
//! die Meldung: der Steuernde blendet seinen Zeiger aus und hat gar keinen. Nur
//! die Aufnahme: er hat zwei. Deshalb stehen sie in einer Funktion
//! ([`umschalten`]), und deshalb hat die einen Test mit Mitschreiber.
//!
//! ## Warum der Rueckfall das Cursor-Echo ueberstimmt
//!
//! Das Cursor-Echo nimmt den Host-Zeiger bei jeder absoluten Mausbewegung aus
//! der Aufnahme (bis zu 125 Nachrichten je Sekunde), der Rueckfall will ihn
//! drin haben. Schrieben beide unabhaengig auf `capture::cursorsteuerung`,
//! kaempften sie: der Wecker holte ihn zehnmal je Sekunde herein, die naechste
//! Mausbewegung wuerfe ihn wieder hinaus, und der Steuernde saehe ein Flackern
//! statt eines Zeigers. Deshalb kommen beide Wuensche hier zusammen
//! ([`Zeigerlage`]) und werden von **einer** Regel entschieden
//! ([`zeiger_gehoert_in_die_aufnahme`]): der Rueckfall sticht.
//!
//! Was er **nicht** sticht, ist die Zusage des Schalters „nie ueber den
//! Ausgangszustand hinaus" — wer ohne Zeiger streamt, bekommt auch durch den
//! Rueckfall keinen. Die haelt `pulse_fernsteuerung::zeigerschalter` eine Ebene
//! tiefer, ohne dass dieses Modul davon wissen muss.
//!
//! ## Die Empfaengerseite
//!
//! Die Meldung geht als Sidecar-Ereignis `{"ev":"remote_pointer_in_frame",
//! "aktiv":…}` hinaus; der Renderer des Hosts reicht sie als `remote_signal`
//! `kind:"zeiger_im_bild"` weiter, gedeutet wird sie in
//! `web/src/lib/remote/zeigerImBild.ts`. Ein **geltender** Rueckfall wird je
//! Sekunde wiederholt ([`WIEDERHOLUNG_TAKTE`]), ein beendeter geht einmal
//! hinaus.
//!
//! **Am Sitzungsende geht KEIN `aktiv:false` hinaus**: die Sitzung ist dann
//! vorbei, der Rahmen erreichte den Steuernden nur noch zufaellig, und ein Weg,
//! der manchmal traegt, ist schlechter als eine klare Zusage. Der Empfaenger
//! setzt beim Sitzungsende selbst zurueck.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use pulse_fernsteuerung::zeigerbuch::{Stand, VORGABE, Zeigerbuch};

use super::{wache, zeigerform};

/// Wie oft ein **geltender** Rueckfall wiederholt gemeldet wird, gezaehlt in
/// Weckern à 100 ms — also einmal je Sekunde.
///
/// Derselbe Grund wie beim Vorrang des Hosts und bei der Zeigerform: der
/// `remote_signal`-Weiterleiter des Gateways verwirft ueber seinem
/// Sekundendeckel **still** (60/s,
/// `ws_remote_handlers.py::_SIGNAL_MAX_MESSAGES_PER_S`), und den teilt sich
/// diese Meldung mit dem Vorrang, der Zeigerform und dem ganzen P2P-Handschlag
/// samt ICE-Schwall. Ohne Wiederholung bliebe ein verworfenes „aktiv" fuer den
/// Rest der Sitzung verloren, und der Steuernde saehe zwei Zeiger.
///
/// **Nur solange er GILT**, wie beim Vorrang. Ein „nicht mehr aktiv" geht
/// einmal hinaus und heilt nicht von selbst; dagegen stehen auf der
/// Empfaengerseite zwei Netze (`zeigerImBild.ts::beenden` und im Player das
/// Ende der Erfassung). Die Gegenrichtung waere ein „nicht aktiv" je Sekunde
/// fuer jede laufende Sitzung — Dauerlast fuer einen schon zweifach
/// abgefangenen Fall.
///
/// **Dieselbe Zahl mit derselben Begruendung steht noch zweimal** — in
/// `pulse_fernsteuerung::zeigerbuch` und in
/// `pulse_fernsteuerung::sitzung::vorrang`. Zusammengelegt wird sie
/// ausdruecklich nicht (Begruendung dort); wer dagegen den Sekundendeckel des
/// Gateways aendert, muss alle drei finden.
const WIEDERHOLUNG_TAKTE: u64 = 10;

/// Die Buchfuehrung des Rueckfalls: gilt er, und wie viele Wecker ist die
/// letzte Meldung her.
///
/// **Beides in einem Wert**, weil es nur zusammen einen Sinn ergibt — der
/// Zaehler misst den Abstand zu genau dieser Auskunft, und jede Meldung setzt
/// beides zugleich.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Rueckfallstand {
    gilt: bool,
    seit_meldung: u64,
}

/// Die eine Buchfuehrung dieses Prozesses.
///
/// Sie liegt hier und nicht in der Kiste: die haelt bewusst **keinen** globalen
/// Zustand, damit ihre Tests ohne prozessweite Reihenfolge auskommen. Womit ein
/// Wirt seine eine Buchfuehrung schuetzt, ist seine Sache.
static BUCH: Mutex<Zeigerbuch> = Mutex::new(Zeigerbuch::LEER);

/// Woran sich entscheidet, ob der Host-Zeiger in der Aufnahme steht — beide
/// Wuensche an einer Stelle (s. Modulkopf).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Zeigerlage {
    /// Was die Sitzung zuletzt wollte (`true` = Zeiger in der Aufnahme).
    /// Geschrieben vom Verteiler-Faden ueber [`zeiger_der_sitzung`].
    wunsch: bool,
    /// Gilt der Rueckfall? Geschrieben vom Wecker-Faden ueber [`tick`].
    ///
    /// Nur der Wahrheitswert, nicht der ganze [`Rueckfallstand`]: hier steht,
    /// was die AUFNAHME angeht, und der Wiederholungs-Zaehler geht sie nichts
    /// an. Er liegt in [`SEIT_MELDUNG`], das nur der Wecker-Faden anfasst.
    rueckfall: bool,
}

/// Die Ausgangslage: Zeiger drin, kein Rueckfall. Ohne laufende Fernsteuerung
/// verbirgt niemand etwas.
const LAGE_ANFANG: Zeigerlage = Zeigerlage { wunsch: true, rueckfall: false };

static LAGE: Mutex<Zeigerlage> = Mutex::new(LAGE_ANFANG);

/// Wecker seit der letzten Rueckfall-Meldung.
///
/// Gelesen und fortgeschrieben wird nur vom Wecker-Faden; [`zuruecksetzen`]
/// nullt ihn aus dem Verteiler-Faden. Mehr als `Relaxed` braucht das nicht: ein
/// Zaehler, der einmal einen Takt daneben liegt, verschiebt eine Wiederholung
/// um 100 ms und sonst nichts.
static SEIT_MELDUNG: AtomicU64 = AtomicU64::new(0);

/// Die Sperre des Buchs nehmen — auch eine vergiftete, aus demselben Grund wie
/// bei der Sperre der Fernsteuer-Sitzung: [`zuruecksetzen`] liegt auf jedem
/// Ausstiegsweg der Sitzung und darf an keiner fremden Panik scheitern.
fn buch() -> std::sync::MutexGuard<'static, Zeigerbuch> {
    BUCH.lock().unwrap_or_else(|e| e.into_inner())
}

/// Steht der Host-Zeiger in der Aufnahme?
///
/// Reine Rechnung, damit die eine Regel ohne laufenden `SCStream` pruefbar ist:
/// **der Rueckfall sticht** (Modulkopf).
fn zeiger_gehoert_in_die_aufnahme(lage: Zeigerlage) -> bool {
    lage.rueckfall || lage.wunsch
}

/// Die Lage aendern — und gleich anwenden.
///
/// **Die Sperre wird ueber den Plattform-Aufruf gehalten, und das ist Absicht.**
/// Zwei Faeden aendern hier: der Verteiler den Wunsch, der Wecker den
/// Rueckfall. Wer nur unter der Sperre rechnet und danach ruft, kann vom
/// anderen Faden ueberholt werden — dann steht am Ende die aeltere Wahrheit in
/// der Aufnahme, und sie heilt **nicht** von selbst, denn es kommt kein
/// weiterer Uebergang. `cursorsteuerung` wartet bis zu zwei Sekunden auf
/// ScreenCaptureKit; denselben Preis zahlt der Verteiler schon heute, ohne dass
/// es diese Sperre gaebe.
///
/// Was daraus wird — No-op ohne Aufnahme, No-op ohne Wechsel, No-op wenn der
/// Strom ohne Zeiger begann —, entscheidet `capture::cursorsteuerung` samt
/// `pulse_fernsteuerung::zeigerschalter`. Hier wird nur gesagt, was gelten
/// soll.
fn lage_aendern(aenderung: impl FnOnce(&mut Zeigerlage)) {
    lage_aendern_mit(aenderung, |in_die_aufnahme| {
        if in_die_aufnahme {
            crate::capture::cursorsteuerung::zeigen();
        } else {
            crate::capture::cursorsteuerung::verbergen();
        }
    });
}

/// Aendern und anwenden, aber ohne Plattform — der Verschluss ist die Naht.
///
/// Gleiches Muster wie `capture::cursorsteuerung::ablauf`, und aus demselben
/// Grund: so laesst sich pruefen, dass die neue Lage ueberhaupt **angewandt**
/// wird und mit welchem Wert. Ein Rueckfall, der nur seinen Merker setzt und
/// die Aufnahme nie anfasst, saehe von aussen wie ein Erfolg aus.
///
/// **Was auch damit ungeprueft bleibt**, ehrlich benannt: die vier Zeilen
/// darueber, die aus dem `bool` `zeigen()` oder `verbergen()` machen. Eine
/// Vertauschung dort faellt erst am Bild auf — `examples/probe_zeigerecho.rs`
/// und der Zwei-Geraete-Lauf.
fn lage_aendern_mit(aenderung: impl FnOnce(&mut Zeigerlage), anwenden: impl FnOnce(bool)) {
    let mut lage = LAGE.lock().unwrap_or_else(|e| e.into_inner());
    aenderung(&mut lage);
    anwenden(zeiger_gehoert_in_die_aufnahme(*lage));
}

/// Das Cursor-Echo der Sitzung: Host-Zeiger in die Aufnahme (`true`) oder
/// heraus (`false`). Der eine Weg, ueber den `Umgebung::host_zeiger_zeigen`
/// hier hereinkommt.
pub(super) fn zeiger_der_sitzung(zeigen: bool) {
    lage_aendern(|l| l.wunsch = zeigen);
}

/// Die Meldung des Rueckfalls, so wie sie den Sidecar verlaesst.
///
/// Eigenes Ereignis statt eines Feldes an `remote_pointer`: der Renderer reicht
/// es als eigene Signalart weiter, und ein Feld an einer Meldung, die dem
/// Wechselfilter des Renderers unterliegt, ginge bei einer Wiederholung
/// verloren.
fn meldung(aktiv: bool) -> serde_json::Value {
    serde_json::json!({ "ev": "remote_pointer_in_frame", "aktiv": aktiv })
}

/// **Beide Haelften des Rueckfalls in einer Funktion** — einzeln ist jede
/// falsch (Modulkopf). Die zwei Verschluesse sind die Naht, an der die
/// Plattform haengt; der Test daneben faehrt sie mit einem Mitschreiber und
/// faellt durch, sobald eine der beiden Zeilen fehlt oder ihr Argument kippt.
///
/// Die **Reihenfolge** ist kein Hebel: die Meldung fliegt ueber Gateway und
/// Leitung, kommt also ohnehin eine Umlaufzeit spaeter an als die Umstellung
/// der Aufnahme. Sie steht hier so, wie man sie liest.
fn umschalten(aktiv: bool, zeiger_ins_bild: impl FnOnce(bool), melden: impl FnOnce(bool)) {
    zeiger_ins_bild(aktiv);
    melden(aktiv);
}

/// Was ein Wecker ergibt. Alles daraus geht **ausserhalb** der Sperre des Buchs
/// hinaus (Kopf von [`pulse_fernsteuerung::zeigerbuch`]).
struct Runde {
    /// Die Meldung der Zeigerform, falls in dieser Runde eine faellig ist.
    form: Option<serde_json::Value>,
    /// Der fortgeschriebene Rueckfall-Stand — immer, auch wenn sich nichts
    /// geaendert hat.
    rueckfall: Rueckfallstand,
    /// Diesen Stand melden (Wechsel **oder** Wiederholung); `None` = still.
    melden: Option<bool>,
}

/// Den Rueckfall fortschreiben und sagen, ob gemeldet wird. Reine Rechnung,
/// damit die Regel ohne Betriebssystem und ohne laufende Sitzung pruefbar ist.
///
/// Zwei Anlaesse: der **Wechsel** und die **Wiederholung** — letztere nur,
/// solange der Rueckfall gilt (s. [`WIEDERHOLUNG_TAKTE`]). Der Zaehler wird wie
/// im Zeigerbuch **vor** dem Vergleich erhoeht: nach einer Meldung folgen genau
/// neun stille Wecker, der zehnte meldet wieder.
fn rueckfall_fortschreiben(vorher: Rueckfallstand, soll: bool) -> (Rueckfallstand, Option<bool>) {
    let seit_meldung = vorher.seit_meldung + 1;
    if vorher.gilt != soll || (soll && seit_meldung >= WIEDERHOLUNG_TAKTE) {
        (Rueckfallstand { gilt: soll, seit_meldung: 0 }, Some(soll))
    } else {
        (Rueckfallstand { gilt: soll, seit_meldung }, None)
    }
}

/// Die ganze Entscheidung eines Weckers — ohne AppKit, ohne `SCStream`, ohne
/// Ereigniskanal, damit sie auf jeder Maschine nachfahrbar ist.
///
/// **Bei Vorrang des Hosts geht [`VORGABE`] hinaus, und `ermitteln` laeuft gar
/// nicht erst.** Der Host fuehrt dann seinen eigenen Zeiger, der wieder im Bild
/// ist; der Steuernde soll nicht mit einem I-Balken dastehen, der zu einer
/// Bewegung gehoert, die nicht seine ist. Das Ueberspringen ist kein
/// Feinschliff: die Abfrage kostet AppKit-Aufrufe und einen Zeichenvorgang,
/// waehrend der Host selbst arbeitet.
///
/// **Der Rueckfall kann dabei nicht kippen** — ueber eine uebersprungene
/// Abfrage sagt niemand etwas darueber aus, ob sie noch traegt; deshalb geht
/// sein eigener Stand als Soll herein. Seine **Wiederholung** laeuft trotzdem
/// weiter: sie heilt einen verworfenen Rahmen, und ein Vorrang des Hosts dauert
/// fuenf Sekunden, in denen sonst nichts nachkaeme.
fn runde(
    buch: &mut Zeigerbuch,
    rueckfall: Rueckfallstand,
    vorrang: bool,
    ermitteln: impl FnOnce() -> Stand,
) -> Runde {
    let (form, soll) = if vorrang {
        (buch.nachricht(&Stand::Name(VORGABE)), rueckfall.gilt)
    } else {
        let stand = ermitteln();
        // Kein eigenes Bild heisst: von dieser Maschine ist gerade keine Form
        // zu bekommen — genau der Fall, fuer den es den Rueckfall gibt. Ein
        // Name kommt hier nur als [`VORGABE`] vor; macOS hat keine
        // Namenstabelle ([`super::zeigerform`]).
        let soll = !matches!(stand, Stand::Eigen(_));
        (buch.nachricht(&stand), soll)
    };
    let (neu, melden) = rueckfall_fortschreiben(rueckfall, soll);
    Runde { form, rueckfall: neu, melden }
}

/// Der Wecker der Wache (alle 100 ms, aus ihrem eigenen Faden) — angeschlossen
/// in `super::hueterin`.
///
/// Kein eigener Faden: die Abfrage kostet nach Messung 0,16 bis 0,18 ms
/// ([`super::zeigerform`]) und faellt gegen den 100-ms-Takt nicht ins Gewicht.
pub(super) fn tick() {
    // Nur waehrend einer Fernsteuerung: der Wecker ueberlebt das Sitzungsende
    // um bis zu einen Takt, und ohne Steuernden gibt es niemanden, den die Form
    // angeht.
    if !super::fern_aktiv() {
        return;
    }
    let vorrang = wache::host_regt_sich();
    // Im laufenden Betrieb schreibt beide Merker nur dieser Faden. Die eine
    // Ausnahme ist das Sitzungsende ([`zuruecksetzen`], Verteiler-Faden) — s.
    // den zweiten Blick auf `fern_aktiv` weiter unten.
    let vorher = Rueckfallstand {
        gilt: LAGE.lock().unwrap_or_else(|e| e.into_inner()).rueckfall,
        seit_meldung: SEIT_MELDUNG.load(Ordering::Relaxed),
    };
    // Die Sperre des Buchs endet mit dieser Anweisung. Alles Weitere fasst
    // fremde Kanaele und fremde Sperren an und hat unter der eigenen nichts zu
    // suchen.
    let runde = runde(&mut buch(), vorher, vorrang, zeigerform::ermitteln);
    SEIT_MELDUNG.store(runde.rueckfall.seit_meldung, Ordering::Relaxed);
    if let Some(n) = runde.form {
        crate::events::emit(n);
    }
    let Some(aktiv) = runde.melden else { return };
    // **Zweiter Blick, und zwar gegen das Sitzungsende.** Es kann in genau
    // diesem Wecker gefallen sein, und dann hat [`zuruecksetzen`] den Merker
    // soeben geraeumt — ihn hier wieder zu setzen hiesse, dass die naechste
    // Sitzung den Rueckfall schon gesetzt vorfaende, keinen Uebergang mehr
    // haette und ihren Steuernden mit zwei Zeigern sitzen liesse.
    // `fern_abschalten` setzt `fern_aktiv` VOR `sitzung_beendet`, dieser Blick
    // raeumt das Fenster also bis auf die Anweisungen bis zum Schreiben ab
    // (vorher waren es bis zu zwei Sekunden, so lange kann `lage_aendern` auf
    // ScreenCaptureKit warten). Ganz zu ist es nicht; was bliebe, heilt der
    // erste Wecker der naechsten Sitzung, sobald die Abfrage wieder traegt.
    if !super::fern_aktiv() {
        return;
    }
    // Nur beim Wechsel ins Protokoll — eine Wiederholung je Sekunde waere eine
    // Log-Zeile je Sekunde und sagte nichts Neues.
    if aktiv != vorher.gilt {
        eprintln!(
            "[remote-input] Zeigerform {}",
            if aktiv {
                "nicht abfragbar — Host-Zeiger reitet im Bild mit"
            } else {
                "wieder abfragbar — Host-Zeiger verlaesst das Bild wieder"
            }
        );
    }
    // Auch die Wiederholung fuehrt die Aufnahme mit nach: sie kostet nichts
    // (ohne Wechsel filtert `pulse_fernsteuerung::zeigerschalter` sie weg) und
    // haelt die Zusage, dass die beiden Haelften nie einzeln gehen.
    umschalten(aktiv, |a| lage_aendern(|l| l.rueckfall = a), |a| {
        crate::events::emit(meldung(a))
    });
}

/// Sitzungsende: Buch leeren und die Lage auf ihren Anfang zuruecksetzen.
///
/// **Das Buch**, damit die naechste Sitzung ihre erste Form wieder in jedem
/// Fall meldet (Begruendung bei `Zeigerbuch::zuruecksetzen`).
///
/// **Der Rueckfall**, weil er der Sitzung gehoert und nicht der Maschine: bliebe
/// er stehen, faende die naechste Sitzung ihn schon gesetzt vor, es gaebe
/// keinen Uebergang mehr — und damit auch keine Meldung. Ihr Steuernder saehe
/// seinen eigenen Zeiger UND den des Hosts im Bild. Ist die Abfrage wirklich
/// dauerhaft tot, stellt der erste Wecker der neuen Sitzung ihn binnen 100 ms
/// wieder her, diesmal samt Meldung.
///
/// **Kein Plattform-Aufruf und keine Meldung von hier aus**: `fern_abschalten`
/// ruft unmittelbar davor `host_zeiger_zeigen(true)`; zur Meldung s. Modulkopf.
///
/// Ausdruecklich **nicht** an `host_zeiger_zeigen` gehaengt — dort liefe es
/// zusaetzlich bei jedem Fuehrungswechsel und jedem Vorrang-Uebergang, und der
/// Sidecar hielte danach jede Form fuer unbekannt und schickte sie erneut.
pub(super) fn zuruecksetzen() {
    buch().zuruecksetzen();
    *LAGE.lock().unwrap_or_else(|e| e.into_inner()) = LAGE_ANFANG;
    SEIT_MELDUNG.store(0, Ordering::Relaxed);
}

#[cfg(test)]
#[path = "zeigermeldung_tests.rs"]
mod zeigermeldung_tests;
