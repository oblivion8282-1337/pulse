//! Der Schleifendurchlauf und das Freigeben — die beiden Stellen, an denen die
//! Zustandsmaschine die Plattform anfasst.
//!
//! **Abgetrennt von [`super`] nur der Groesse wegen** (`PLAN.md` §12.1); der
//! Schnitt liegt trotzdem an einer Naht: hier stehen die zwei Methoden, die
//! [`Prozessablage`] schreiben, dort alles, was allein die Sitzung angeht.
//! Untermodule sehen die privaten Felder ihres Elternmoduls — die Trennung
//! kostet deshalb keine zusaetzliche Sichtbarkeit.

use pulse_ablage::beobachter::Beobachter;
use pulse_ablage::format::Rahmen;
use pulse_ablage::sitzung::Fortschritt;

use super::{Ablagelage, Prozessablage};
use crate::app::ablage::Ablageplattform;

/// Sichtbar gemachter [`Beobachter`] auf einer Plattform hinter `dyn`.
///
/// `Ankuendiger::beantworte` verlangt `&mut impl Beobachter`, also einen Typ
/// mit bekannter Groesse; `&mut dyn Ablageplattform` ist keiner. Diese Huelle
/// ist der ganze Unterschied — sie leitet beide Methoden unveraendert weiter.
struct Sicht<'a>(&'a mut dyn Ablageplattform);

impl Beobachter for Sicht<'_> {
    fn geaendert(&mut self) -> bool {
        self.0.geaendert()
    }
    fn lesen(&self) -> Option<String> {
        self.0.lesen()
    }
}

/// Wie lange die Antwort auf ein `hol` hoechstens auf den Lesevorgang wartet.
///
/// Deutlich unter `pulse_ablage::sitzung::ABRUF_FRIST_MS` (2 s), damit die
/// Antwort noch innerhalb der Frist des Abrufenden ankommt — und ueber der
/// Lesefrist der Plattform (Wayland: 500 ms), damit ein gesunder Lesevorgang
/// nicht kurz vor dem Ziel abgeschnitten wird.
const HOL_FRIST_MS: u64 = 1_000;

impl Ablagelage {
    /// Eigentum abgeben und den Vorbestand zurueckschreiben.
    ///
    /// **Die Buchfuehrung danach fragt die Plattform, statt zu raten.**
    /// Zurueckschreiben heisst auf jeder Plattform „neue eigene Quelle mit dem
    /// gemerkten Text" (Wayland `set_selection`, Windows `SetClipboardData`,
    /// macOS `declareTypes`) — fremdes Eigentum laesst sich nirgends
    /// zurueckgeben. **Wir bleiben danach Eigentuemer**, und was in der Ablage
    /// liegt, IST der Merkposten.
    ///
    /// Ihn hier trotzdem zu loeschen, war der Fehler: `lesen()` liefert als
    /// Eigentuemer (richtigerweise) `None`, der naechste Anspruch merkte sich
    /// also nichts, und das uebernaechste Freigeben raeumte die Ablage des
    /// Nutzers — zwei Klicks im Schalter genuegten. Test:
    /// `zweimal_umschalten_verliert_den_vorbestand_nicht`.
    pub(super) fn freigeben(&mut self, prozess: &mut Prozessablage, p: &mut dyn Ablageplattform) {
        self.anspruch.aufgeben();
        // **Ein geparktes `hol` gehoert dem Zustand, der gerade endet.** Es
        // wurde angenommen, als das Teilen noch an war, und traegt beim
        // Beantworten den INHALT — bliebe es liegen, antwortete es bis zu
        // `HOL_FRIST_MS` spaeter mit genau dem, was der Nutzer gerade nicht
        // mehr teilen wollte. Nach `ende` waere es ausserdem ein Nachzuegler,
        // den ein spaeteres `beginnen` doch noch hinausliesse.
        self.offener_hol = None;
        // **Ab hier wird der PROZESS-Stand angefasst — und das darf nur die
        // Sitzung, die die Plattform auch haelt.**
        //
        // Eine Sitzung ohne Plattform kommt hier trotzdem vorbei:
        // `App::ablage_abbau` ist der eine Trichter fuers Ende und ruft `ende`
        // fuer JEDE Sitzung, nicht nur fuer den Traeger — die uebrigen bekommen
        // [`super::super::KeineAblage`], wo `eigentuemer()` immer `false`
        // meldet. Ohne diesen Ausstieg buchte ein reiner Zuschauer-Fenster den
        // Stand des Traegers ab: `p.freigeben` liefe als No-Op, `p.eigentuemer()`
        // meldete `false`, der Merkposten waere weg — und wenn danach der echte
        // Traeger endet, ist `prozess.eigentuemer` schon `false`, der Block
        // unten wird uebersprungen und `Eigentum::freigeben` NIE gerufen. Der
        // Vorbestand des Nutzers kaeme nicht zurueck und die `wl_data_source`
        // bliebe bis zum Prozessende stehen — genau der Schaden, gegen den
        // `ablage_abbau` als Trichter gebaut ist.
        //
        // Alltaeglich erreichbar: ein zweites Player-Fenster als Zuschauer wird
        // geschlossen; und `stop_all_sessions`/`exiting` laufen ueber
        // `self.sessions.keys()`, also in HashMap-Reihenfolge. Solange
        // `eigentuemer` an der SITZUNG hing, uebersprang der Block so eine
        // Sitzung von selbst — mit dem Umzug auf die Prozessebene tut er das
        // nicht mehr. **Keine Vorsichtsmassnahme, sondern die Bedingung dafuer,
        // dass der Umzug ueberhaupt traegt.**
        //
        // Was DIESER Sitzung gehoert (Anspruch, geparktes Abrufen), ist oben
        // schon geraeumt — das gilt fuer sie auch ohne Plattform.
        if !p.wirksam() {
            return;
        }
        // **`prozess.eigentuemer` ist der Riegel, und er muss hier stehen.**
        // `Eigentum::freigeben` prueft, ob die Auswahl noch bei uns liegt;
        // diese Frage beantwortet die Plattform. Ob wir sie ueberhaupt je
        // verdraengt haben — und damit, ob es etwas zurueckzuschreiben gibt —
        // weiss nur die Buchfuehrung hier.
        //
        // **Sie haengt am PROZESS, nicht an der Sitzung.** Die Auswahl liegt am
        // Prozess (eine je Maschine), die Zustandsmaschine an der Sitzung; der
        // Merkposten gehoert deshalb dorthin, wo auch die Auswahl liegt. Stand
        // er an der Sitzung, verlor ihn jeder Traegerwechsel: die
        // Nachfolge-Sitzung beanspruchte mit `eigentuemer == false`, las als
        // Eigentuemer (richtigerweise) `None` und raeumte beim eigenen Ende die
        // Ablage des Nutzers. Test:
        // `ein_traegerwechsel_verliert_den_vorbestand_nicht`.
        if prozess.eigentuemer {
            // **Haelt die Plattform die Auswahl JETZT noch?** Nur dann raeumt
            // der Aufruf darunter sie selbst — und nur dann ist die Aenderung,
            // die dabei entsteht, unsere eigene. Hat inzwischen jemand anders
            // uebernommen, kehrt `Eigentum::freigeben` sofort zurueck, und die
            // gemeldete Aenderung gehoert dem Fremden. Zwischen dieser Frage
            // und dem Aufruf wird nichts zugestellt (beides synchron, kein
            // `nachfassen` dazwischen) — es kann sich also nichts dazwischen
            // schieben.
            let unser = p.eigentuemer();
            let geraeumt = prozess.vorbestand.is_none();
            p.freigeben(prozess.vorbestand.as_deref());
            // **Die selbst ausgeloeste Aenderung quittieren.**
            //
            // Raeumen wir die Auswahl (kein Merkposten da), zieht die Plattform
            // ihren Aenderungszaehler hoch — `AblageZustand::abgeloest` tut das
            // seit C1 fail-closed, ohne zu unterscheiden, WER die Auswahl
            // genommen hat. Bliebe die Meldung stehen, holte sie der naechste
            // Traeger ab und **kuendigte ein leeres Fach an**: die Gegenseite
            // beansprucht daraufhin ihre Ablage, verdraengt damit den Inhalt
            // IHRES Nutzers und gibt ihn erst beim Sitzungsende zurueck. Das
            // ist derselbe stille Verlust, gegen den dieser ganze Mechanismus
            // gebaut ist, nur auf der Gegenseite.
            //
            // **Das weicht C1 nicht auf.** Quittiert wird eine Aenderung, die
            // wir selbst ausgeloest haben und deshalb kennen — keine Aussage
            // darueber, in welcher Reihenfolge der Compositor `selection` und
            // `cancelled` zustellt; die bleibt gleichgueltig. Und es bleibt
            // fail-closed: faellt die Zeile beim naechsten Aufraeumen wieder
            // (wie schon einmal der `eigentuemer`-Riegel), entsteht eine
            // ueberfluessige Ankuendigung, kein hinausgehender Inhalt. Test:
            // `das_selbst_geraeumte_fach_wird_nicht_angekuendigt`.
            //
            // **Nur der Raeum-Weg.** Zurueckschreiben laeuft auf Wayland ueber
            // eine neue eigene Quelle (`auswahl_setzen`, `eigene = true`) und
            // bewegt den Zaehler nicht.
            if unser && geraeumt {
                p.geaendert();
            }
            // **Die Buchfuehrung sitzt NACH dem Aufruf** und fragt die
            // Plattform, statt zu raten.
            prozess.eigentuemer = p.eigentuemer();
        }
        if !prozess.eigentuemer {
            // Entweder haben wir geraeumt (kein Merkposten da), oder die
            // Ablage gehoert laengst wieder dem Nutzer. In beiden Faellen gibt
            // es nichts mehr aufzuheben.
            prozess.vorbestand = None;
        }
    }

    /// Ein Durchlauf der Ereignisschleife. Liefert, was hinausgeht.
    ///
    /// Vier Schritte in dieser Reihenfolge: eingereihten Anspruch einloesen,
    /// wartendes Einfuegen abrufen, eigene Aenderung ankuendigen, Frist
    /// pruefen.
    pub(crate) fn takt(
        &mut self,
        prozess: &mut Prozessablage,
        p: &mut dyn Ablageplattform,
    ) -> Vec<Rahmen> {
        if !self.wach {
            return Vec::new();
        }
        let jetzt = self.jetzt_ms();
        let mut hinaus = Vec::new();

        // 0. Ein `hol`, dessen Lesevorgang inzwischen fertig ist (s.
        //    `Ablagelage::offener_hol`). Die Frist darunter ist das Netz fuer
        //    eine Plattform, die nie fertig meldet — ohne sie haenge der
        //    Einfuegevorgang drueben bis in seine eigene Frist.
        //
        //    **Auch hier der `teilen`-Riegel**, und hier wiegt er am
        //    schwersten: dieser Schritt antwortet mit dem INHALT, nicht bloss
        //    mit einem `hol`. `freigeben` raeumt ein geparktes Abrufen zwar
        //    schon mit ab; der Riegel haelt die Zusicherung auch dann, wenn
        //    ein spaeterer Umbau einen zweiten Weg zum Ausschalten schafft.
        if !self.teilen {
            self.offener_hol = None;
        } else if let Some((offen, seit)) = self.offener_hol.take() {
            if p.lesen_bereit() || jetzt.saturating_sub(seit) >= HOL_FRIST_MS {
                // Der Inhalt wird in `beantworte` gelesen, nicht hier — die
                // Reihenfolge „erst die Aenderung abholen, dann die Generation
                // vergleichen, dann lesen" ist der Sinn jener Signatur, und
                // sie gilt unveraendert: die Aenderungsmeldung wird JETZT
                // abgeholt, nicht beim Eintreffen des `hol`.
                hinaus.extend(self.ankuendiger.beantworte(&offen, &mut Sicht(p)));
            } else {
                self.offener_hol = Some((offen, seit));
            }
        }

        // 1. Der eingereihte Anspruch. `set_selection` verlangt eine
        //    Seriennummer aus einem frischen Eingabeereignis, und ein Klient
        //    OHNE FOKUS kann die Auswahl nicht setzen — der Compositor
        //    verwirft es STILL. Genau der Fall tritt ein, wenn der Nutzer zu
        //    einem lokalen Programm wechselt und drueben kopiert wird.
        //
        //    **Er wird erst eingeloest, wenn der Vorbestand gelesen ist.** Ein
        //    Anspruch loescht ihn; wer vorher beansprucht, hat nichts mehr zu
        //    merken. `Anspruch::seriennummer` verbraucht den Anspruch, darf
        //    also nicht gefragt werden, solange noch gelesen wird.
        let braucht_vorbestand = !(prozess.eigentuemer && p.eigentuemer());
        if self.anspruch.offen() && braucht_vorbestand && !p.lesen_bereit() {
            p.lesen_anstossen();
        } else if self.anspruch.seriennummer(p.seriennummer()) {
            // **Den Vorbestand VOR dem Anspruch lesen** — aber nur, wenn er
            // nicht ohnehin schon uns gehoert. Beide Bedingungen zaehlen:
            // `prozess.eigentuemer` heisst „dieser Prozess hat etwas
            // verdraengt", `p.eigentuemer()` heisst „und es liegt immer noch
            // bei uns". Hat der Nutzer zwischendurch selbst kopiert, faellt die
            // zweite weg, und sein frischer Inhalt wird gemerkt — sonst waere
            // er nach dem naechsten Anspruch still verloren.
            //
            // **Ein `None` ueberschreibt nichts.** Halten wir die Auswahl,
            // liefert `lesen()` bewusst `None` (es waere unser eigener Stand);
            // eine unbedingte Zuweisung loeschte dann genau den Merkposten,
            // den sie retten soll — dieselbe Falle wie das `take()` in
            // `pulse_ablage::pruefstand::TestAblage::beanspruchen`.
            if braucht_vorbestand {
                if let Some(text) = p.lesen() {
                    prozess.vorbestand = Some(text);
                }
            }
            match p.beanspruchen() {
                Ok(()) => prozess.eigentuemer = true,
                Err(grund) => eprintln!(
                    "pulse-player: Zwischenablage nicht beansprucht ({grund}) — \
                     ein Einfuegen auf dieser Maschine bleibt leer."
                ),
            }
        }

        // 2. Wartet ein Einfuegevorgang? Erst jetzt geht `hol` hinaus — das
        //    IST das verzoegerte Rendern.
        //
        //    **Auch hier der `teilen`-Riegel** (Review C6). Er war der einzige
        //    der vier Schritte ohne, und das Fenster ist schmal (ein
        //    Schleifendurchlauf zwischen Ausschalten und Freigeben) — die
        //    fehlende Symmetrie zu den anderen dreien ist trotzdem genau die
        //    Stelle, an der ein spaeterer Umbau still etwas hinauslaesst.
        if self.teilen && p.einfuegen_wartet() {
            if let Some(hol) = self.empfaenger.abrufen(jetzt) {
                hinaus.push(hol);
            }
        }

        // 3. Hat sich die eigene Ablage geaendert? Dann nur die Ankuendigung,
        //    ohne Inhalt.
        if self.teilen && p.geaendert() {
            hinaus.push(self.ankuendiger.geaendert());
        }

        // 4. Die Frist eines laufenden Abrufs.
        if let Fortschritt::Leer(_) = self.empfaenger.takt(jetzt) {
            p.liefern("");
        }
        hinaus
    }
}
