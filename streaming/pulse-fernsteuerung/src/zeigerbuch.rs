//! Die Buchführung der Zeigerform: welche **Form** der Zeiger des Hosts zuletzt
//! hatte, was die Gegenseite davon schon kennt, und was daraus in dieser Runde
//! hinausgeht.
//!
//! **Herkunft.** Bis zum 2026-08-23 lag das alles in
//! `win-hq-sidecar/src/remote_input/zeigerform.rs`, mitten zwischen
//! `GetCursorInfo` und `LoadCursorW` — rund 500 von 634 Zeilen, die kein
//! Betriebssystem kennen. Ein zweiter Sidecar hätte sie ein zweites Mal
//! schreiben müssen, samt der beiden Regeln, an denen hier alles hängt (die
//! Auffrischung trägt das Bild immer ganz; eine Auffrischung leert die Liste
//! der bekannten Bilder nicht). Dort bleibt, was Windows kennt: die
//! Handle-Tabelle, die Abfrage und die Übersetzung Handle → Name.
//!
//! **Warum es das überhaupt braucht.** Das Cursor-Echo nimmt den Host-Zeiger
//! aus der Aufnahme, damit der Steuernde nur seinen eigenen, verzögerungsfreien
//! Zeiger sieht. Was dabei verlorengeht, ist alles, was der Zeiger sonst noch
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
//! die Formen, die das Betriebssystem selbst mitbringt; die Rasierklinge einer
//! Schnittanwendung, der Werkzeugzeiger einer Bildbearbeitung, der Achsenzeiger
//! eines 3D-Programms stehen nicht darauf. Früher fielen die alle wortlos auf
//! [`VORGABE`], und der Steuernde sah einen Standardpfeil, wo das Programm ihm
//! etwas sagen wollte. Erkennt der Sender den Zeiger nicht, holt er deshalb
//! sein Bild und reicht es als [`Stand::Eigen`] herein. Der Name bleibt
//! trotzdem **immer** dabei: kommt das Bild nicht durch oder kann der Steuernde
//! es nicht bauen, hat er wenigstens den Rückfall.
//!
//! ## Was der Sender beisteuert
//!
//! Diese Kiste kennt weder Uhr noch Betriebssystem noch Kanal. Vier Pflichten
//! bleiben deshalb beim Sidecar, und drei davon fängt keine Signatur ein:
//!
//! 1. **Der Takt.** [`Zeigerbuch::nachricht`] wird alle 100 ms gerufen, solange
//!    eine Fernsteuerung läuft — und nur dann. Beide Zähler hier sind in diesen
//!    Weckern gezählt; ein anderer Abstand verschiebt die Auffrischung.
//!    **Warum am Wecker und nicht an den Eingabe-Nachrichten:** die Form ändert
//!    sich, ohne dass jemand etwas sendet (der Zeiger steht über einer Kante,
//!    die Anwendung lädt fertig, der Wartekringel geht). An die Nachrichten des
//!    Steuernden gehängt erführe er von einem Wechsel nie, solange er die Hand
//!    still hält.
//! 2. **Der [`Stand`]** — die eigene Abfrage des Systemzeigers.
//! 3. **Bei Vorrang des Hosts [`Stand::Name`]`(`[`VORGABE`]`)`**, und zwar
//!    ohne vorher zu ermitteln: der Host führt dann seinen eigenen Zeiger, der
//!    wieder im Bild ist — der Steuernde soll nicht mit einem I-Balken
//!    dastehen, der zu einer Bewegung gehört, die nicht seine ist. Aus
//!    demselben Grund geht dann auch kein Bild hinaus. Das Ermitteln zu
//!    überspringen ist kein Feinschliff: es kostet auf jeder Plattform
//!    Systemaufrufe, und der Host arbeitet gerade selbst.
//! 4. **Das Einreihen in den Ereigniskanal außerhalb der eigenen Sperre.**
//!    Diese Kiste liefert nur den fertigen Wert. Einen **fremden** Kanal unter
//!    der eigenen Sperre anzufassen wäre das, was aus zwei harmlosen Sperren
//!    eine Reihenfolge macht, an der sich später jemand verklemmt.
//!
//!    **Was dabei sehr wohl unter der Sperre des Aufrufers liegt**, seit die
//!    Buchführung hier steht: das Packen der Läufe und die Base64-Kodierung in
//!    [`Zeigerbuch::nachricht`]. Im Windows-Sidecar lagen die vor dem
//!    2026-08-23 daneben. Das ist bedacht und nicht übersehen: es ist reine
//!    Rechnung auf eigenen Daten — höchstens `MAX_LAEUFE_BYTE` Byte, keine
//!    zweite Sperre, kein fremder Kanal —, und die Gefahr, gegen die der alte
//!    Kommentar geschrieben war, ist die Verschachtelung, nicht die Dauer. Wer
//!    hier später etwas hineinlegt, das seinerseits sperrt, muss den Schnitt
//!    neu ziehen.
//!
//! ## Was hier bewusst NICHT entschieden wird
//!
//! Ob der Zeiger überhaupt **sichtbar** ist (unter Windows `CURSOR_SHOWING`;
//! die anderen Systeme haben ihre eigene Entsprechung). Windows blendet ihn
//! beim Tippen aus, Videowiedergaben tun es nach ein paar Sekunden Ruhe — dem
//! Steuernden dabei jedes Mal den Zeiger wegzunehmen, nähme ihm die
//! Orientierung, denn im Bild ist ja auch keiner. Den einen Fall, in dem der
//! Zeiger wirklich verschwinden muss (Spiel mit Zeigerfang), erledigt der
//! Player schon selbst über den Fang.

use std::collections::BTreeSet;

use pulse_zeigerbild::Zeigerbild;

use crate::base64;

/// Was gemeldet wird, wenn die Form keinem Standard-Zeiger entspricht — der
/// eigene Zeiger eines Spiels, ein Werkzeug-Zeiger einer Bildbearbeitung, ein
/// Zeiger, den wir schlicht nicht kennen. Der Steuernde bekommt dann den
/// gewöhnlichen Pfeil, und das ist die richtige Richtung des Irrtums: eine
/// falsche Sonderform behauptete etwas über den fremden Rechner, das nicht
/// stimmt.
pub const VORGABE: &str = "default";

/// Wie oft die geltende Form **wiederholt** gemeldet wird, gezählt in Weckern
/// à 100 ms — also einmal je Sekunde.
///
/// Aus demselben Grund wie beim Vorrang des Hosts: die Meldung fährt über den
/// `remote_signal`-Weiterleiter des Gateways, und der verwirft über seinem
/// Sekundendeckel **still**. Ohne Wiederholung bliebe ein verlorener Wechsel
/// für immer verloren — der Steuernde behielte den I-Balken, während der Host
/// längst wieder auf dem Desktop steht. Eine Nachricht je Sekunde fällt gegen
/// den 60/s-Deckel nicht ins Gewicht.
///
/// **Dieselbe Zahl mit derselben Begründung steht noch einmal** in
/// `sitzung/vorrang.rs::WIEDERHOLUNG_TAKTE` — seit dem 2026-08-23 in derselben
/// Kiste, vorher in zweien. Zusammengelegt wird sie trotzdem nicht: die eine
/// taktet die Vorrang-Meldung, die andere die Zeigerform, und wer eine davon
/// verstellt, meint selten beide. Wer dagegen den Sekunden-Deckel des Gateways
/// (`remote_signal`) ändert, muss beide Stellen finden.
const WIEDERHOLUNG_TAKTE: u64 = 10;

/// Wie viele Zeigerbilder als „drüben bekannt" geführt werden.
///
/// Ein Programm hat ein paar Dutzend eigene Zeiger; 64 deckt das mit Rand. Beim
/// Überlaufen wird die Liste **geleert** statt einzeln gealtert: das kostet
/// einmalig, dass jedes Bild erneut vollständig hinausgeht, und spart die
/// Buchführung darüber, welches am längsten nicht gebraucht wurde. Eine Liste,
/// die unbegrenzt wächst, wäre die Alternative — und die wächst in einer langen
/// Sitzung mit wechselnden Programmen eben doch.
///
/// Das Gegenstück beim Empfänger heißt `MAX_VORRAT`
/// (`pulse-player/src/app/zeigerbau.rs`) und trägt dieselbe Zahl: beide Seiten
/// sollen zur selben Zeit vergessen.
const MAX_BEKANNT: usize = 64;

/// Was über den Zeiger herauszufinden war — das, was der Sender beisteuert.
pub enum Stand {
    /// Ein Zeiger, den das Betriebssystem selbst mitbringt — der Name genügt,
    /// und er ist der bessere Weg (s. Modulkopf).
    Name(&'static str),
    /// Ein eigener Zeiger der Anwendung. Der Name wäre hier nur der
    /// Standardpfeil, also gehen die Pixel mit.
    Eigen(Zeigerbild),
}

/// Was von der letzten Meldung übrig ist. Alles in **einem** Wert, weil es nur
/// zusammen einen Sinn ergibt: die Takte zählen den Abstand zu genau dieser
/// Form, und jede Meldung setzt alles zugleich.
///
/// **Ohne eigene Sperre und ohne globalen Zustand** (`lib.rs`-Kopf): der
/// Sidecar hält seine eine Buchführung selbst, unter der Sperre seiner Wahl.
/// So braucht kein Test hier eine prozessweite Reihenfolge.
pub struct Zeigerbuch {
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

impl Zeigerbuch {
    /// Der leere Anfang — Sitzungsbeginn und [`Zeigerbuch::zuruecksetzen`]
    /// gehen von hier aus.
    ///
    /// Als `const` und nicht als `fn`, damit der Sidecar ihn unmittelbar in ein
    /// `static Mutex<Zeigerbuch>` stecken kann.
    pub const LEER: Zeigerbuch =
        Zeigerbuch { form: None, bild: None, takte: 0, bild_takte: 0, bekannt: BTreeSet::new() };

    /// Sitzungsende: das Buch leeren, damit die nächste Sitzung ihre erste Form
    /// wieder in jedem Fall meldet. Ohne das begänne sie mit der Annahme, der
    /// Steuernde wisse noch, was am Ende der vorigen galt — und der hat
    /// inzwischen selbst zurückgesetzt.
    pub fn zuruecksetzen(&mut self) {
        *self = Self::LEER;
    }

    /// Ein Wecker: das Buch fortschreiben und sagen, was hinausgeht. `None`
    /// heißt „diesmal nichts".
    ///
    /// Die fertige Nachricht, so wie sie über `remote_signal` `kind:"zeiger"`
    /// fährt. Der Aufrufer reiht sie in seinen Ereigniskanal ein — außerhalb
    /// seiner Sperre (s. Modulkopf).
    pub fn nachricht(&mut self, stand: &Stand) -> Option<serde_json::Value> {
        // Ein eigener Zeiger trägt als Namen die Vorgabe — sie ist der Rückfall,
        // wenn das Bild nicht ankommt oder drüben nicht gebaut werden kann.
        let (form, bild) = match stand {
            Stand::Name(n) => (*n, None),
            Stand::Eigen(b) => (VORGABE, Some(b)),
        };
        let kennung = bild.map(Zeigerbild::kennung);

        let auftrag = self.buchen(form, kennung.as_deref())?;
        let mut nachricht = serde_json::json!({ "ev": "remote_pointer", "shape": form });
        if let Some((b, k)) = bild.zip(kennung.as_deref()) {
            if let Some(feld) = bildfeld(b, k, auftrag.vollstaendig) {
                nachricht["bild"] = feld;
            }
        }
        Some(nachricht)
    }

    /// Das Buch fortschreiben und sagen, was zu senden ist.
    ///
    /// Getrennt vom Nachrichtenbau, weil dies die einzige Stelle ist, die den
    /// Zustand **ändert** — der Bau daneben liest nur. Ausdrücklich **nicht**,
    /// „damit es für sich prüfbar ist": prüfbar für sich sind die drei Regeln,
    /// die es zusammensetzt ([`meldung_faellig`], [`bild_vollstaendig`],
    /// [`bekannt_aufnehmen`]); `buchen` selbst wird über
    /// [`Zeigerbuch::nachricht`] geprüft, s. den Abschnitt „Über die ganze
    /// Runde" bei den Tests. Genau diese Verwechslung hat es im
    /// Windows-Sidecar jahrelang ungeprüft gelassen.
    fn buchen(&mut self, form: &'static str, kennung: Option<&str>) -> Option<Auftrag> {
        self.takte += 1;
        self.bild_takte += 1;
        if !meldung_faellig(self.form, self.bild.as_deref(), form, kennung, self.takte) {
            return None;
        }
        let vollstaendig =
            kennung.is_some_and(|k| bild_vollstaendig(&self.bekannt, k, self.bild_takte));
        self.form = Some(form);
        self.bild = kennung.map(str::to_string);
        self.takte = 0;
        if let Some(k) = kennung.filter(|_| vollstaendig) {
            self.bild_takte = 0;
            bekannt_aufnehmen(&mut self.bekannt, k);
        }
        Some(Auftrag { vollstaendig })
    }
}

/// Steht eine Meldung an? Reine Rechnung, damit die Regel ohne Betriebssystem
/// und ohne laufende Sitzung prüfbar ist.
///
/// Drei Anlässe: der **Formwechsel**, der **Bildwechsel** (zwei eigene Zeiger
/// desselben Programms tragen beide den Namen [`VORGABE`] — ohne den Vergleich
/// der Kennung bliebe der Wechsel zwischen ihnen unbemerkt) und die
/// **Auffrischung** (s. `WIEDERHOLUNG_TAKTE`).
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

/// Das `bild`-Feld der Meldung. `None`, wenn keines mitgeht — bei einem
/// Standardzeiger, und bei einem Bild, das nicht unter die Nutzlastgrenze passt
/// (dann trägt allein der Name, s. `pulse_zeigerbild::MAX_LAEUFE_BYTE`).
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Kurzform für die Fälle ohne Bild — die Regel für Standardzeiger ist
    /// dieselbe geblieben, nur die Signatur trägt zwei Felder mehr.
    fn faellig(gemeldet: Option<&str>, jetzt: &str, takte: u64) -> bool {
        meldung_faellig(gemeldet, None, jetzt, None, takte)
    }

    /// Ein 2×2-Zeiger aus lauter gleichen Punkten. Verschiedene Füllungen
    /// ergeben verschiedene Kennungen — mehr braucht die Buchführung nicht.
    fn zeiger(fuellung: u8) -> Zeigerbild {
        Zeigerbild { breite: 2, hoehe: 2, halt_x: 1, halt_y: 0, punkte: vec![fuellung; 2 * 2 * 4] }
    }

    /// Ein Zeiger über der Nutzlastgrenze: 128×128 in lauter wechselnden
    /// Farben, damit die Läufe nichts zusammenfassen können und
    /// `pulse_zeigerbild::MAX_LAEUFE_BYTE` sicher überschritten wird.
    fn zu_grosser_zeiger() -> Zeigerbild {
        let bunt: Vec<u8> = (0..128 * 128 * 4).map(|i| (i % 251) as u8).collect();
        Zeigerbild { breite: 128, hoehe: 128, halt_x: 0, halt_y: 0, punkte: bunt }
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
    /// ging überhaupt etwas hinaus" (s. [`Zeigerbuch::bild_takte`]). Lägen beide
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

    /// Das `bild`-Feld in beiden Ausprägungen: ganz und als blosse Kennung.
    /// Hält die Feldnamen fest, auf die der Renderer und der Player hören
    /// (`web/src/lib/remote/zeigerform.ts`, `pulse-player/src/proto.rs`).
    #[test]
    fn das_bildfeld_traegt_die_erwarteten_namen() {
        let bild = zeiger(9);
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
    ///
    /// **Seit dem 2026-08-23 steht der Test hier und nicht mehr im
    /// Windows-Sidecar** — er gilt damit für JEDEN Sender, der diese Kiste
    /// nutzt, statt nur für den einen, bei dem er zufällig entstand.
    #[test]
    fn bildfeld_erzeugt_genau_die_formen_des_pruefsteins() {
        let pruefstein: serde_json::Value =
            serde_json::from_str(include_str!("../../zeigerbild-formen.json"))
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

        let bild = zeiger(9);
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
        assert!(bildfeld(&zu_grosser_zeiger(), "abc", true).is_none());
    }

    // ── Über die ganze Runde, nicht nur über die einzelne Regel ──────────────
    //
    // Die Prüfungen oben treffen je eine Bedingung. Sie ließen bis zum
    // 2026-08-23 eine Lücke: `buchen` selbst — die Stelle, die aus den drei
    // Regeln einen Auftrag macht — war von KEINEM Test berührt. Eine Mutation
    // dort (`vollstaendig = false`) blieb deshalb grün. Die fünf Prüfungen
    // hier gehen den Weg, den auch der Sidecar geht: Wecker für Wecker über
    // `nachricht`.

    /// Der Rückwechsel auf einen Zeiger, der eben schon über die Leitung ging,
    /// kostet nur noch die Kennung — genau die Kurzform des Prüfsteins.
    #[test]
    fn der_rueckwechsel_auf_ein_bekanntes_bild_geht_als_kurzform() {
        let mut buch = Zeigerbuch::LEER;
        let a = Stand::Eigen(zeiger(9));
        let b = Stand::Eigen(zeiger(4));

        let erste = buch.nachricht(&a).expect("die erste Form meldet immer");
        assert_eq!(erste["shape"], VORGABE, "ein eigener Zeiger trägt die Vorgabe als Namen");
        assert!(erste["bild"]["daten"].is_string(), "das erste Bild geht ganz hinaus");

        let zweite = buch.nachricht(&b).expect("ein Bildwechsel meldet");
        assert!(zweite["bild"]["daten"].is_string(), "auch das zweite Bild ist neu");

        let dritte = buch.nachricht(&a).expect("der Rückwechsel meldet");
        assert_eq!(dritte["bild"]["id"], erste["bild"]["id"], "derselbe Zeiger, dieselbe Kennung");
        assert!(
            dritte["bild"].get("daten").is_none(),
            "ein drüben bekanntes Bild geht nur als Kennung"
        );
    }

    /// **Die Auffrischung trägt das Bild ganz — über die ganze Runde geprüft.**
    ///
    /// Der Test daneben hält nur [`bild_vollstaendig`] fest. Hier läuft der
    /// Weg, den der Sidecar geht: neun stille Wecker, dann eine Meldung, und
    /// die MUSS die Daten tragen. Sie ist der einzige Weg, auf dem sich ein am
    /// Gateway verworfenes Bild heilt; wer den Wechselfilter davorschiebt,
    /// bricht die Selbstheilung, und das fällt erst im Betrieb auf.
    #[test]
    fn die_auffrischung_traegt_das_bild_auch_ueber_die_ganze_runde_ganz() {
        let mut buch = Zeigerbuch::LEER;
        let a = Stand::Eigen(zeiger(9));
        buch.nachricht(&a).expect("die erste Form meldet immer");
        for takt in 1..WIEDERHOLUNG_TAKTE {
            assert!(buch.nachricht(&a).is_none(), "Wecker {takt} hätte schweigen müssen");
        }
        let auffrischung = buch.nachricht(&a).expect("nach zehn Weckern frischt es auf");
        assert!(
            auffrischung["bild"]["daten"].is_string(),
            "die Auffrischung trägt das Bild GANZ, auch wenn die Gegenseite es kennt"
        );
    }

    /// Ein Standardzeiger trägt gar kein `bild`-Feld — der Name allein.
    #[test]
    fn ein_benannter_zeiger_traegt_kein_bildfeld() {
        let mut buch = Zeigerbuch::LEER;
        let n = buch.nachricht(&Stand::Name("text")).expect("die erste Form meldet immer");
        assert_eq!(n["ev"], "remote_pointer");
        assert_eq!(n["shape"], "text");
        assert!(n.get("bild").is_none());
    }

    /// Passt das Bild nicht unter die Nutzlastgrenze, geht die Meldung
    /// trotzdem hinaus — nur eben ohne Feld. Der Name ist der Rückfall, und
    /// ohne ihn erführe der Steuernde von dem Wechsel gar nichts.
    #[test]
    fn ein_zu_grosses_bild_meldet_immer_noch_den_namen() {
        let gross = Stand::Eigen(zu_grosser_zeiger());
        let mut buch = Zeigerbuch::LEER;
        let n = buch.nachricht(&gross).expect("gemeldet wird trotzdem");
        assert_eq!(n["shape"], VORGABE);
        assert!(n.get("bild").is_none(), "kein Feld, wenn das Bild nicht unter die Grenze passt");
    }

    /// Nach dem Zurücksetzen beginnt alles von vorn — die erste Form der
    /// nächsten Sitzung geht in jedem Fall hinaus, samt vollem Bild.
    #[test]
    fn nach_dem_zuruecksetzen_geht_das_bild_wieder_ganz_hinaus() {
        let mut buch = Zeigerbuch::LEER;
        let a = Stand::Eigen(zeiger(9));
        buch.nachricht(&a).expect("erste Meldung");
        assert!(buch.nachricht(&a).is_none(), "gleich danach schweigt es");
        buch.zuruecksetzen();
        let neu = buch.nachricht(&a).expect("nach dem Zurücksetzen meldet es wieder");
        assert!(neu["bild"]["daten"].is_string(), "und zwar mit vollem Bild");
    }
}
