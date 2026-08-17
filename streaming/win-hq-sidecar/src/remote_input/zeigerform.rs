//! Welche **Form** der Zeiger des Hosts gerade hat — die Gegenrichtung zum
//! Cursor-Echo.
//!
//! **Warum es das braucht.** Das Cursor-Echo
//! ([`crate::capture::cursorsteuerung`]) nimmt den Host-Zeiger aus der
//! Aufnahme, damit der Steuernde nur seinen eigenen, verzögerungsfreien Zeiger
//! sieht. Was dabei verlorengeht, ist alles, was der Zeiger sonst noch
//! erzählt: der I-Balken über einem Textfeld, der Doppelpfeil an einer
//! Fensterkante, die Hand über einem Verweis, der Wartekringel. Ohne diese
//! Rückmeldung zieht der Steuernde an Kanten ins Leere und rät, ob ein Klick
//! trifft. Der Zeiger fühlt sich zwar an wie der eigene — er weiß nur nichts
//! mehr über den fremden Rechner.
//!
//! **Bevorzugt geht ein NAME hinaus und kein Bild** (`text`, `ns-resize`,
//! `pointer` …). Der Steuernde setzt damit die Form seines eigenen, lokal vom
//! Betriebssystem gezeichneten Zeigers. Das kostet ein paar Byte je
//! Formwechsel statt eines Bildes je Wechsel, bleibt verzögerungsfrei, trägt
//! über Plattformgrenzen (winit benennt seine Formen nach derselben
//! CSS-Liste, macOS und Linux übersetzen sie in ihre eigenen) und kommt beim
//! Steuernden in dessen Zeigergröße und -thema an.
//!
//! **Wo der Name nicht trägt, gehen die Pixel mit.** Die Namensliste kennt nur
//! die dreizehn Formen, die Windows selbst mitbringt; die Rasierklinge einer
//! Schnittanwendung, der Werkzeugzeiger einer Bildbearbeitung, der Achsenzeiger
//! eines 3D-Programms stehen nicht darauf. Früher fielen die alle wortlos auf
//! [`VORGABE`], und der Steuernde sah einen Standardpfeil, wo das Programm ihm
//! etwas sagen wollte. Erkennt [`zu_name`] den Zeiger nicht, holt
//! [`super::zeigerpixel`] deshalb sein Bild und es geht neben dem Namen her.
//! Der Name bleibt trotzdem **immer** dabei: kommt das Bild nicht durch oder
//! kann der Steuernde es nicht bauen, hat er wenigstens den Rückfall.
//!
//! **Warum am Wecker der Wache und nicht an den Eingabe-Nachrichten.** Die Form
//! ändert sich, ohne dass jemand etwas sendet: der Zeiger steht über einer
//! Kante, die Anwendung lädt fertig, der Wartekringel geht. An die Nachrichten
//! des Steuernden gehängt erführe er von einem Wechsel nie, solange er die
//! Hand still hält. Der Wecker der Wache ([`super::wache`]) läuft ohnehin genau
//! dann, wenn eine Fernsteuerung läuft, und auf einem eigenen Faden — ein
//! zweiter Faden für eine Abfrage, die vier Mikrosekunden kostet, wäre
//! Aufwand ohne Ertrag.
//!
//! **Was hier bewusst NICHT ausgewertet wird:** ob der Zeiger überhaupt
//! sichtbar ist (`CURSOR_SHOWING`). Windows blendet ihn beim Tippen aus,
//! Videowiedergaben tun es nach ein paar Sekunden Ruhe — dem Steuernden dabei
//! jedes Mal den Zeiger wegzunehmen, nähme ihm die Orientierung, denn im Bild
//! ist ja auch keiner. Den einen Fall, in dem der Zeiger wirklich verschwinden
//! muss (Spiel mit Zeigerfang), erledigt der Player schon selbst über den Fang.

use std::collections::BTreeSet;
use std::sync::Mutex;

use windows::Win32::UI::WindowsAndMessaging::{
    CURSORINFO, GetCursorInfo, HCURSOR, IDC_APPSTARTING, IDC_ARROW, IDC_CROSS, IDC_HAND, IDC_HELP,
    IDC_IBEAM, IDC_NO, IDC_SIZEALL, IDC_SIZENESW, IDC_SIZENS, IDC_SIZENWSE, IDC_SIZEWE, IDC_WAIT,
    LoadCursorW,
};
use windows::core::PCWSTR;

use super::{base64, wache, zeigerpixel};
use crate::zeigerbild::Zeigerbild;

/// Was gemeldet wird, wenn die Form keinem Standard-Zeiger entspricht — der
/// eigene Zeiger eines Spiels, ein Werkzeug-Zeiger einer Bildbearbeitung, ein
/// Zeiger, den wir schlicht nicht kennen. Der Steuernde bekommt dann den
/// gewöhnlichen Pfeil, und das ist die richtige Richtung des Irrtums: eine
/// falsche Sonderform behauptete etwas über den fremden Rechner, das nicht
/// stimmt.
const VORGABE: &str = "default";

/// Wie oft die geltende Form **wiederholt** gemeldet wird, gezählt in Weckern
/// à 100 ms ([`wache`]) — also einmal je Sekunde.
///
/// Aus demselben Grund wie beim Vorrang ([`super::vorrang`]): die Meldung fährt
/// über den `remote_signal`-Weiterleiter des Gateways, und der verwirft über
/// seinem Sekundendeckel **still**. Ohne Wiederholung bliebe ein verlorener
/// Wechsel für immer verloren — der Steuernde behielte den I-Balken, während
/// der Host längst wieder auf dem Desktop steht. Eine Nachricht je Sekunde
/// fällt gegen den 60/s-Deckel nicht ins Gewicht.
const WIEDERHOLUNG_TAKTE: u64 = 10;

/// Wie viele Zeigerbilder als „drüben bekannt" geführt werden.
///
/// Ein Programm hat ein paar Dutzend eigene Zeiger; 64 deckt das mit Rand. Beim
/// Überlaufen wird die Liste **geleert** statt einzeln gealtert: das kostet
/// einmalig, dass jedes Bild erneut vollständig hinausgeht, und spart die
/// Buchführung darüber, welches am längsten nicht gebraucht wurde. Eine Liste,
/// die unbegrenzt wächst, wäre die Alternative — und die wächst in einer langen
/// Sitzung mit wechselnden Programmen eben doch.
const MAX_BEKANNT: usize = 64;

/// Was von der letzten Meldung übrig ist. Alles unter **einer** Sperre, weil es
/// nur zusammen einen Sinn ergibt: die Takte zählen den Abstand zu genau dieser
/// Form, und jede Meldung setzt alles zugleich.
struct Merker {
    /// Zuletzt gemeldete Form; `None` = in dieser Sitzung noch nichts gemeldet.
    form: Option<&'static str>,
    /// Kennung des zuletzt gemeldeten Bildes; `None` = Standardzeiger, für den
    /// gar keines gebraucht wird.
    bild: Option<String>,
    /// Wecker seit der letzten Meldung — entscheidet, ob überhaupt etwas
    /// hinausgeht.
    takte: u64,
    /// Wecker seit dem letzten **vollständigen** Bild.
    ///
    /// **Getrennt von [`Self::takte`], und das ist der Punkt.** Beide Zähler
    /// zusammenzulegen sieht sparsam aus und nimmt der Auffrischung genau dann
    /// die Wirkung, wenn sie gebraucht wird: fällt der Zähler bei jeder
    /// Meldung, dann frischt bei einem Zeiger, der öfter als einmal je Sekunde
    /// wechselt, überhaupt nichts mehr auf — und Zeiger wechseln beim Fahren
    /// über eine Timeline mehrmals je Sekunde. Ein verlorenes Bild bliebe dann
    /// für den Rest der Sitzung verloren, obwohl die Heilung genau dafür da
    /// ist. Gemessen an einer Nachbildung: mit einem Zähler 60 von 120 Takten
    /// falscher Zeiger und keine Heilung bis zum Ende, mit zweien 8 von 120
    /// und geheilt nach 800 ms.
    bild_takte: u64,
    /// Kennungen, die in dieser Sitzung schon **vollständig** hinausgegangen
    /// sind. Für die genügt beim nächsten Mal die Kennung allein — ein Wechsel
    /// zwischen zwei Werkzeugen kostet damit ein paar Byte statt zweier Bilder.
    ///
    /// Das ist eine **Annahme** über die Gegenseite, keine Zusage von ihr: geht
    /// eine Nachricht verloren oder wirft der Steuernde seinen Vorrat weg,
    /// stimmt sie nicht mehr. Deshalb trägt die Auffrischung das Bild immer
    /// vollständig — spätestens nach einer Sekunde ist der Irrtum geheilt, und
    /// bis dahin steht drüben der Standardpfeil, nicht der falsche Zeiger.
    bekannt: BTreeSet<String>,
}

/// Der leere Anfang — Sitzungsbeginn und [`zuruecksetzen`] gehen von hier aus.
const LEER: Merker =
    Merker { form: None, bild: None, takte: 0, bild_takte: 0, bekannt: BTreeSet::new() };

static MERKER: Mutex<Merker> = Mutex::new(LEER);

/// Die Sperre nehmen — auch eine vergiftete, aus demselben Grund wie in
/// [`super::Sitzung::sperre`]: [`zuruecksetzen`] liegt auf jedem Ausstiegsweg
/// der Sitzung und darf an keiner fremden Panik scheitern.
fn sperre() -> std::sync::MutexGuard<'static, Merker> {
    MERKER.lock().unwrap_or_else(|e| e.into_inner())
}

/// Die Abbildung Windows-Zeiger → Name. Als Funktion statt als `static`, weil
/// [`PCWSTR`] ein roher Zeiger ist; die Werte selbst sind Konstanten des
/// Betriebssystems, das Aufbauen kostet nichts.
///
/// **Nicht zwischengespeichert:** `LoadCursorW` auf einen Standard-Zeiger ist
/// ein Nachschlagen ohne Ladevorgang, und die Handles wechseln, wenn der Nutzer
/// sein Zeigerschema umstellt (`SetSystemCursor`). Ein gemerktes Handle wäre
/// danach falsch, und die Fernsteuerung meldete für den Rest der Sitzung nur
/// noch [`VORGABE`].
///
/// Ohne Entsprechung bleiben `IDC_UPARROW` und die Personen-/Nadel-Zeiger:
/// dafür gibt es in der CSS-Liste nichts, und etwas Ähnliches zu nehmen wäre
/// geraten. Sie fallen auf [`VORGABE`].
fn abbildung() -> [(PCWSTR, &'static str); 13] {
    [
        (IDC_ARROW, VORGABE),
        (IDC_IBEAM, "text"),
        (IDC_HAND, "pointer"),
        (IDC_WAIT, "wait"),
        (IDC_APPSTARTING, "progress"),
        (IDC_CROSS, "crosshair"),
        (IDC_HELP, "help"),
        (IDC_NO, "not-allowed"),
        (IDC_SIZEWE, "ew-resize"),
        (IDC_SIZENS, "ns-resize"),
        (IDC_SIZENWSE, "nwse-resize"),
        (IDC_SIZENESW, "nesw-resize"),
        (IDC_SIZEALL, "move"),
    ]
}

/// Was über den Zeiger herauszufinden war.
enum Stand {
    /// Ein Zeiger, den Windows selbst mitbringt — der Name genügt, und er ist
    /// der bessere Weg (s. Modulkopf).
    Name(&'static str),
    /// Ein eigener Zeiger der Anwendung. Der Name wäre hier nur der
    /// Standardpfeil, also gehen die Pixel mit.
    Eigen(Zeigerbild),
}

/// Der gerade gezeichnete System-Zeiger.
fn ermitteln() -> Stand {
    let mut info =
        CURSORINFO { cbSize: std::mem::size_of::<CURSORINFO>() as u32, ..Default::default() };
    if unsafe { GetCursorInfo(&mut info) }.is_err() {
        // Kein Grund für mehr als die Vorgabe: die Abfrage ist Beiwerk, und
        // eine Störung darf weder die Sitzung noch das Protokoll fluten (der
        // Wecker käme 100 ms später mit derselben Zeile wieder) — deshalb wird
        // der Fehler auch nicht ausgegeben.
        return Stand::Name(VORGABE);
    }
    match zu_name(info.hCursor) {
        Some(name) => Stand::Name(name),
        // **Der Zeiger wird bei JEDEM Wecker frisch ausgelesen**, nicht am
        // Handle festgemacht. Windows gibt die Zahl eines freigegebenen Zeigers
        // an den nächsten weiter; wer sie als Ausweis nähme, zeigte irgendwann
        // ein Bild, das zu einem längst verworfenen Zeiger gehört. Das Auslesen
        // ist eine Kopie von wenigen Kilobyte und fällt zehnmal je Sekunde
        // neben der laufenden Bildschirmaufnahme nicht ins Gewicht.
        None => zeigerpixel::bild_holen(info.hCursor).map_or(Stand::Name(VORGABE), Stand::Eigen),
    }
}

/// Ein Zeiger-Handle in einen Namen übersetzen. Getrennt von [`ermitteln`],
/// damit der Vergleich für sich steht — er ist die einzige Stelle, an der
/// dieses Modul etwas behauptet.
///
/// `None` heisst **nicht** „Fehler", sondern „kein Zeiger, den Windows selbst
/// mitbringt" — und damit: hol die Pixel.
fn zu_name(aktuell: HCURSOR) -> Option<&'static str> {
    if aktuell.0.is_null() {
        // Kein Zeiger gesetzt (ausgeblendet). Absichtlich nicht als eigene
        // Form gemeldet — Begründung im Modulkopf. Auch kein Bild: es gibt
        // keines.
        return Some(VORGABE);
    }
    for (kennung, name) in abbildung() {
        if unsafe { LoadCursorW(None, kennung) }.is_ok_and(|h| h == aktuell) {
            return Some(name);
        }
    }
    None
}

/// Steht eine Meldung an? Reine Rechnung, damit die Regel ohne Windows und
/// ohne laufende Sitzung prüfbar ist.
///
/// Drei Anlässe: der **Formwechsel**, der **Bildwechsel** (zwei eigene Zeiger
/// desselben Programms tragen beide den Namen [`VORGABE`] — ohne den Vergleich
/// der Kennung bliebe der Wechsel zwischen ihnen unbemerkt) und die
/// **Auffrischung** (s. [`WIEDERHOLUNG_TAKTE`]).
fn meldung_faellig(
    gemeldete_form: Option<&str>,
    gemeldetes_bild: Option<&str>,
    form: &str,
    bild: Option<&str>,
    takte: u64,
) -> bool {
    gemeldete_form != Some(form) || gemeldetes_bild != bild || takte >= WIEDERHOLUNG_TAKTE
}

/// Muss das Bild **vollständig** mit, oder genügt seine Kennung?
///
/// Vollständig bei der Auffrischung — sie ist es, die einen Verlust heilt — und
/// bei jedem Bild, das die Gegenseite noch nicht gesehen hat.
fn bild_vollstaendig(bekannt: &BTreeSet<String>, kennung: &str, takte: u64) -> bool {
    takte >= WIEDERHOLUNG_TAKTE || !bekannt.contains(kennung)
}

/// Eine Kennung in die Liste der bekannten aufnehmen.
///
/// **Der erste Zweig ist der Fund**, nicht bloss eine Abkürzung: ohne ihn leert
/// eine blosse Auffrischung die ganze Liste, sobald sie voll ist. Sie gilt
/// nämlich als „vollständig" (s. [`bild_vollstaendig`]), obwohl die Kennung
/// längst drinsteht — und die Gegenseite macht das Leeren nicht mit, weil sie
/// ihren Vorrat nur beim EINFÜGEN deckelt und beim Auffrischen bloss
/// nachschlägt. Danach halten die beiden Seiten verschiedene Mengen für
/// bekannt, ohne dass je eine Nachricht verlorengegangen wäre, und der Sidecar
/// schickt Kennungen für Bilder, die drüben nicht mehr liegen.
///
/// Reine Rechnung, damit die Regel ohne laufende Sitzung prüfbar ist.
fn bekannt_aufnehmen(bekannt: &mut BTreeSet<String>, kennung: &str) {
    if bekannt.contains(kennung) {
        return;
    }
    if bekannt.len() >= MAX_BEKANNT {
        bekannt.clear();
    }
    bekannt.insert(kennung.to_string());
}

/// Was in dieser Runde hinausgeht.
struct Auftrag {
    /// Bild mitschicken, nicht nur seine Kennung (s. [`bild_vollstaendig`]).
    vollstaendig: bool,
}

/// Den Merker fortschreiben und sagen, was zu senden ist. Getrennt vom Senden,
/// damit die Sperre nicht über einen fremden Kanal gehalten wird.
fn buchen(form: &'static str, kennung: Option<&str>) -> Option<Auftrag> {
    let mut merker = sperre();
    merker.takte += 1;
    merker.bild_takte += 1;
    if !meldung_faellig(merker.form, merker.bild.as_deref(), form, kennung, merker.takte) {
        return None;
    }
    let vollstaendig =
        kennung.is_some_and(|k| bild_vollstaendig(&merker.bekannt, k, merker.bild_takte));
    merker.form = Some(form);
    merker.bild = kennung.map(str::to_string);
    merker.takte = 0;
    if let Some(k) = kennung.filter(|_| vollstaendig) {
        merker.bild_takte = 0;
        bekannt_aufnehmen(&mut merker.bekannt, k);
    }
    Some(Auftrag { vollstaendig })
}

/// Das `bild`-Feld der Meldung. `None`, wenn keines mitgeht — bei einem
/// Standardzeiger, und bei einem Bild, das nicht unter die Nutzlastgrenze passt
/// (dann trägt allein der Name, s. `crate::zeigerbild::MAX_LAEUFE_BYTE`).
fn bildfeld(bild: &Zeigerbild, kennung: &str, vollstaendig: bool) -> Option<serde_json::Value> {
    if !vollstaendig {
        return Some(serde_json::json!({ "id": kennung }));
    }
    let laeufe = bild.packen()?;
    Some(serde_json::json!({
        "id": kennung,
        "w": bild.breite,
        "h": bild.hoehe,
        "hx": bild.halt_x,
        "hy": bild.halt_y,
        "daten": base64::kodiere(&laeufe),
    }))
}

/// Der Wecker der Wache (alle 100 ms, aus ihrem eigenen Faden).
pub(super) fn tick() {
    // Nur während einer Fernsteuerung: der Wecker überlebt das Sitzungsende um
    // bis zu einen Takt, und ohne Steuernden gibt es niemanden, den die Form
    // angeht.
    if !super::fern_aktiv() {
        return;
    }
    // **Bei Vorrang des Hosts die Vorgabe**, nicht die echte Form: der Host
    // führt dann seinen eigenen Zeiger, der wieder im Bild ist
    // ([`super::vorrang`]) — der Steuernde soll nicht mit einem I-Balken
    // dastehen, der zu einer Bewegung gehört, die nicht seine ist. Aus
    // demselben Grund geht dann auch kein Bild hinaus.
    let stand = if wache::host_regt_sich() { Stand::Name(VORGABE) } else { ermitteln() };
    // Ein eigener Zeiger trägt als Namen die Vorgabe — sie ist der Rückfall,
    // wenn das Bild nicht ankommt oder drüben nicht gebaut werden kann.
    let (form, bild) = match &stand {
        Stand::Name(n) => (*n, None),
        Stand::Eigen(b) => (VORGABE, Some(b)),
    };
    let kennung = bild.map(Zeigerbild::kennung);

    let Some(auftrag) = buchen(form, kennung.as_deref()) else {
        return;
    };
    // Außerhalb der Sperre — `emit` reiht zwar nur ein, aber es gibt keinen
    // Grund, einen fremden Kanal unter einer eigenen Sperre anzufassen.
    let mut nachricht = serde_json::json!({ "ev": "remote_pointer", "shape": form });
    if let Some((b, k)) = bild.zip(kennung.as_deref()) {
        if let Some(feld) = bildfeld(b, k, auftrag.vollstaendig) {
            nachricht["bild"] = feld;
        }
    }
    crate::events::emit(nachricht);
}

/// Sitzungsende: den Merker leeren, damit die nächste Sitzung ihre erste Form
/// wieder in jedem Fall meldet. Ohne das begänne sie mit der Annahme, der
/// Steuernde wisse noch, was am Ende der vorigen galt — und der hat inzwischen
/// selbst zurückgesetzt.
pub(super) fn zuruecksetzen() {
    *sperre() = LEER;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Kurzform für die Fälle ohne Bild — die Regel für Standardzeiger ist
    /// dieselbe geblieben, nur die Signatur trägt jetzt zwei Felder mehr.
    fn faellig(gemeldet: Option<&str>, jetzt: &str, takte: u64) -> bool {
        meldung_faellig(gemeldet, None, jetzt, None, takte)
    }

    /// Ein Wechsel geht sofort hinaus — er ist der Regelfall und der einzige,
    /// den der Steuernde bemerkt.
    #[test]
    fn ein_wechsel_meldet_sofort() {
        assert!(faellig(Some("default"), "text", 1));
    }

    /// Ohne Wechsel bleibt es still, bis die Auffrischung fällig ist.
    #[test]
    fn gleiche_form_schweigt_bis_zur_auffrischung() {
        assert!(!faellig(Some("text"), "text", 1));
        assert!(!faellig(Some("text"), "text", WIEDERHOLUNG_TAKTE - 1));
        assert!(faellig(Some("text"), "text", WIEDERHOLUNG_TAKTE));
    }

    /// **Der Grund für die Auffrischung:** der Gateway verwirft über seinem
    /// Sekundendeckel still. Ginge ein Wechsel verloren und käme danach nichts
    /// mehr, behielte der Steuernde die falsche Form für den Rest der Sitzung.
    #[test]
    fn die_auffrischung_wiederholt_auch_ohne_wechsel() {
        assert!(faellig(Some("ew-resize"), "ew-resize", WIEDERHOLUNG_TAKTE + 5));
    }

    /// **Zwei eigene Zeiger desselben Programms tragen beide den Namen
    /// `default`** — zwischen ihnen unterscheidet allein die Kennung des Bildes.
    /// Ohne diesen Vergleich bliebe der Wechsel von der Rasierklinge zum
    /// Trimm-Zeiger unbemerkt, und der Steuernde behielte das falsche Bild.
    #[test]
    fn ein_bildwechsel_meldet_auch_bei_gleichem_namen() {
        assert!(meldung_faellig(Some(VORGABE), Some("aaa"), VORGABE, Some("bbb"), 1));
        assert!(!meldung_faellig(Some(VORGABE), Some("aaa"), VORGABE, Some("aaa"), 1));
    }

    /// Der Weg vom eigenen Zeiger zurück zum Standardpfeil: der Name bleibt
    /// gleich, das Bild fällt weg. Würde nur der Name verglichen, bliebe drüben
    /// der Werkzeugzeiger stehen, nachdem der Nutzer das Programm verlassen hat.
    #[test]
    fn das_wegfallen_des_bildes_meldet() {
        assert!(meldung_faellig(Some(VORGABE), Some("aaa"), VORGABE, None, 1));
    }

    /// Ein Bild, das die Gegenseite schon hat, geht als blosse Kennung hinaus —
    /// sonst kostete jeder Wechsel zwischen zwei Werkzeugen zwei volle Bilder.
    #[test]
    fn bekanntes_bild_geht_nur_als_kennung() {
        let mut bekannt = BTreeSet::new();
        bekannt.insert("aaa".to_string());
        assert!(!bild_vollstaendig(&bekannt, "aaa", 1));
        assert!(bild_vollstaendig(&bekannt, "bbb", 1), "ein neues Bild muss ganz hinaus");
    }

    /// **Die Auffrischung trägt das Bild immer ganz.** Sie ist der einzige Weg,
    /// auf dem sich ein am Gateway verworfenes Bild heilt — ginge sie als blosse
    /// Kennung hinaus, bliebe der Steuernde für den Rest der Sitzung beim
    /// Standardpfeil, und niemand käme auf die Ursache.
    #[test]
    fn die_auffrischung_traegt_das_bild_ganz() {
        let mut bekannt = BTreeSet::new();
        bekannt.insert("aaa".to_string());
        assert!(bild_vollstaendig(&bekannt, "aaa", WIEDERHOLUNG_TAKTE));
    }

    /// **Ein schnell wechselnder Zeiger darf die Auffrischung nicht aushebeln.**
    ///
    /// Der Zähler für das vollständige Bild ist getrennt vom Zähler für „es
    /// ging überhaupt etwas hinaus" (s. [`Merker::bild_takte`]). Lägen beide
    /// zusammen, käme bei einem Zeiger, der öfter als einmal je Sekunde
    /// wechselt, nie eine Auffrischung zustande — und genau so verhält sich ein
    /// Zeiger beim Fahren über eine Timeline. Der Test hält die Bedingung fest,
    /// die das trägt: die Fälligkeit des Bildes misst sich an SEINEM Zähler.
    #[test]
    fn haeufige_wechsel_heben_die_auffrischung_nicht_auf() {
        let mut bekannt = BTreeSet::new();
        bekannt.insert("aaa".to_string());
        // Zwischendurch ging etwas hinaus (Formwechsel), das Bild aber schon
        // lange nicht mehr: die Auffrischung ist trotzdem fällig.
        assert!(bild_vollstaendig(&bekannt, "aaa", WIEDERHOLUNG_TAKTE + 3));
        // Und umgekehrt: kurz nach einem vollständigen Bild genügt die Kennung.
        assert!(!bild_vollstaendig(&bekannt, "aaa", 1));
    }

    /// **Eine blosse Auffrischung darf die Liste der bekannten Bilder nicht
    /// leeren.**
    ///
    /// Sie gilt als „vollständig", obwohl die Kennung längst drinsteht — ohne
    /// die Neuheitsprüfung liefe damit der Überlauf-Zweig mit und würfe die
    /// ganze Liste weg. Die Gegenseite tut das nicht mit (sie leert nur beim
    /// EINFÜGEN, und beim Auffrischen schlägt sie bloss nach), also laufen die
    /// beiden Vorräte auseinander, ohne dass eine Nachricht verlorengeht.
    #[test]
    fn eine_auffrischung_leert_die_bekannten_nicht() {
        let mut bekannt: BTreeSet<String> =
            (0..MAX_BEKANNT).map(|i| format!("{i:04}")).collect();
        let vorher = bekannt.clone();
        // Eine Kennung, die schon drinsteht — genau der Fall der Auffrischung.
        bekannt_aufnehmen(&mut bekannt, "0007");
        assert_eq!(bekannt, vorher, "eine bekannte Kennung lässt die Liste unberührt");
    }

    /// Eine **neue** Kennung leert die volle Liste sehr wohl — das ist der
    /// gewollte Überlauf. Ohne diesen Test sähe die Prüfung darüber aus, als
    /// hätte sie den Deckel ganz abgeschafft.
    #[test]
    fn eine_neue_kennung_laesst_die_volle_liste_ueberlaufen() {
        let mut bekannt: BTreeSet<String> =
            (0..MAX_BEKANNT).map(|i| format!("{i:04}")).collect();
        bekannt_aufnehmen(&mut bekannt, "neu");
        assert_eq!(bekannt.len(), 1, "geleert und die neue aufgenommen");
        assert!(bekannt.contains("neu"));
    }

    /// Unterhalb des Deckels wird schlicht ergänzt.
    #[test]
    fn unter_dem_deckel_wird_ergaenzt() {
        let mut bekannt = BTreeSet::new();
        bekannt_aufnehmen(&mut bekannt, "a");
        bekannt_aufnehmen(&mut bekannt, "b");
        bekannt_aufnehmen(&mut bekannt, "a");
        assert_eq!(bekannt.len(), 2);
    }

    /// Die erste Form einer Sitzung geht in jedem Fall hinaus — auch wenn es
    /// die Vorgabe ist. Der Steuernde weiß sonst nicht, ob überhaupt jemand
    /// meldet.
    #[test]
    fn die_erste_form_meldet_immer() {
        assert!(faellig(None, VORGABE, 1));
    }

    /// Ein Nullzeiger ist kein Handle: kein Absturz, sondern die Vorgabe — und
    /// ausdrücklich **kein** Anlass, Pixel zu suchen, denn es gibt keine.
    #[test]
    fn ohne_zeiger_gilt_die_vorgabe() {
        assert_eq!(zu_name(HCURSOR(std::ptr::null_mut())), Some(VORGABE));
    }

    /// Das `bild`-Feld in beiden Ausprägungen: ganz und als blosse Kennung.
    /// Hält die Feldnamen fest, auf die der Renderer und der Player hören
    /// (`web/src/lib/remote/zeigerform.ts`, `pulse-player/src/proto.rs`).
    #[test]
    fn das_bildfeld_traegt_die_erwarteten_namen() {
        let bild = Zeigerbild {
            breite: 2,
            hoehe: 2,
            halt_x: 1,
            halt_y: 0,
            punkte: vec![9u8; 2 * 2 * 4],
        };
        let kurz = bildfeld(&bild, "abc", false).expect("Kennung allein");
        assert_eq!(kurz["id"], "abc");
        assert!(kurz.get("daten").is_none(), "ohne Daten, wenn drueben bekannt");

        let ganz = bildfeld(&bild, "abc", true).expect("ganzes Bild");
        assert_eq!(ganz["w"], 2);
        assert_eq!(ganz["h"], 2);
        assert_eq!(ganz["hx"], 1);
        assert_eq!(ganz["hy"], 0);
        assert!(ganz["daten"].as_str().is_some_and(|s| !s.is_empty()));
    }

    /// **`bildfeld` erzeugt genau die Formen des Prüfsteins** — nicht mehr und
    /// nicht weniger.
    ///
    /// Der Prüfstein (`streaming/zeigerbild-formen.json`) ist die eine Stelle,
    /// an der steht, was über die Leitung geht; die Gegenseiten prüfen gegen
    /// dieselbe Datei (`web/test/zeigerbild-formen.test.ts` und der Test in
    /// `pulse-player/src/app/zeigerbau.rs`). Wer hier ein Feld ergänzt oder
    /// wegnimmt, muss die Datei anfassen und bricht damit die Tests der anderen
    /// Seiten, bis er sie mitzieht.
    ///
    /// **Warum das nötig war:** am 2026-08-17 verlangte die Prüfung im Renderer
    /// vier Zahlenfelder, die die Kurzform gar nicht hat — sie verwarf damit
    /// jede Kurzform, und der Zeiger des Steuernden sprang bei jedem
    /// Rückwechsel auf den Standardpfeil. Beide Seiten hatten grüne Tests.
    #[test]
    fn bildfeld_erzeugt_genau_die_formen_des_pruefsteins() {
        let pruefstein: serde_json::Value =
            serde_json::from_str(include_str!("../../../zeigerbild-formen.json"))
                .expect("Prüfstein ist gültiges JSON");
        let formen = pruefstein["formen"].as_array().expect("Liste 'formen'");
        // Die Feldnamen je Ausprägung, wie sie der Prüfstein festhält.
        let felder = |wert: &serde_json::Value| -> Vec<String> {
            let mut k: Vec<String> =
                wert.as_object().expect("Objekt").keys().cloned().collect();
            k.sort();
            k
        };
        let kurz: Vec<Vec<String>> = formen
            .iter()
            .map(|f| felder(&f["bild"]))
            .filter(|k| !k.contains(&"daten".to_string()))
            .collect();
        let voll: Vec<Vec<String>> = formen
            .iter()
            .map(|f| felder(&f["bild"]))
            .filter(|k| k.contains(&"daten".to_string()))
            .collect();
        assert!(!kurz.is_empty(), "der Prüfstein muss eine Kurzform enthalten");
        assert!(!voll.is_empty(), "der Prüfstein muss eine Vollform enthalten");

        let bild = Zeigerbild {
            breite: 2,
            hoehe: 2,
            halt_x: 1,
            halt_y: 0,
            punkte: vec![9u8; 2 * 2 * 4],
        };
        assert_eq!(
            felder(&bildfeld(&bild, "abc", false).expect("Kurzform")),
            kurz[0],
            "die Kurzform weicht vom Prüfstein ab"
        );
        assert_eq!(
            felder(&bildfeld(&bild, "abc", true).expect("Vollform")),
            voll[0],
            "die Vollform weicht vom Prüfstein ab"
        );
    }

    /// Ein Bild über der Nutzlastgrenze geht **gar nicht** hinaus — der Name
    /// trägt dann allein. Eine Nachricht, die der Gateway still verwirft, wäre
    /// die schlechtere Wahl: sie sähe von hier aus wie ein Erfolg aus.
    #[test]
    fn ein_zu_grosses_bild_liefert_kein_feld() {
        let bunt: Vec<u8> = (0..128 * 128 * 4).map(|i| (i % 251) as u8).collect();
        let bild =
            Zeigerbild { breite: 128, hoehe: 128, halt_x: 0, halt_y: 0, punkte: bunt };
        assert!(bildfeld(&bild, "abc", true).is_none());
    }

    /// Jede Form der Tabelle ist ein Name aus der CSS-Liste, den winit auf der
    /// Gegenseite kennt (`streaming/pulse-player/src/app/zeigerform.rs`). Der Test
    /// hält die beiden Enden zusammen: ein hier erfundener Name käme drüben
    /// wortlos als Standardpfeil an.
    #[test]
    fn alle_formen_sind_bekannte_namen() {
        const BEKANNT: &[&str] = &[
            "default",
            "text",
            "pointer",
            "wait",
            "progress",
            "crosshair",
            "help",
            "not-allowed",
            "ew-resize",
            "ns-resize",
            "nwse-resize",
            "nesw-resize",
            "move",
        ];
        for (_, name) in abbildung() {
            assert!(BEKANNT.contains(&name), "{name} steht nicht auf der Liste des Players");
        }
    }
}
