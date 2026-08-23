//! Die Tastenkuerzel des Fenstermanagers abschalten, solange ferngesteuert
//! wird — und sie danach wieder freigeben.
//!
//! **Wozu.** Auf einem Mac ist die Befehlstaste das, was unter Windows Strg
//! ist; der Player schickt sie deshalb als Windows-Taste (Scancode `0xE05B`,
//! s. `crate::fernsteuerung::tasten`). Genau diese Taste belegt ein
//! Wayland-Compositor aber gern als seinen eigenen Modifikator (`niri`, Sway,
//! GNOME) und faengt sie ab, bevor irgendein Fenster sie sieht. Von einem
//! Linux-Rechner aus war damit auf dem gesteuerten Mac **kein einziges
//! Tastenkuerzel erreichbar** — kein Kopieren, kein Einfuegen, kein Speichern.
//! `zwp_keyboard_shortcuts_inhibit_v1` ist der dafuer vorgesehene Weg: der
//! Compositor laesst seine eigenen Kuerzel ruhen, solange unsere Flaeche den
//! Tastaturfokus hat.
//!
//! **Fail-soft, nicht fail-closed — und das ist Absicht.** Kuendigt der
//! Compositor das Protokoll nicht an (X11, aeltere Umgebungen, ein Compositor
//! ohne diese Erweiterung), laeuft die Sitzung **trotzdem**: einmal ins Log,
//! weiter im Text. Das ist der Gegensatz zur Vorrang-Wache im Windows-Sidecar
//! und zu HDR, wo „unerfuellbar" Startverweigerung heisst — dort haengt eine
//! Sicherheitszusage bzw. eine Bildzusage daran, hier nur Bequemlichkeit. Eine
//! verweigerte Fernsteuerung waere ein viel groesserer Schaden als ein
//! fehlendes Tastenkuerzel. **Wer das spaeter auf „einheitlich fail-closed"
//! geradezieht, macht es kaputt.**
//!
//! **Warum die Buchfuehrung nicht schmueckendes Beiwerk ist.** Das Protokoll
//! erlaubt je (Flaeche, Sitzplatz) genau EINEN Inhibitor; ein zweiter ist der
//! Protokollfehler `already_inhibited`. Ein Protokollfehler toetet nicht nur
//! unser Objekt, sondern die **ganze Wayland-Verbindung** — und das ist
//! dieselbe Verbindung, an der winit haengt. Eine doppelte Anforderung kostet
//! also das Fenster. [`Sperrbuch`] ist deshalb keine Aufraeumhilfe, sondern die
//! Stelle, die das verhindert; sie ist absichtlich frei von Wayland, damit sie
//! auf jeder Maschine pruefbar bleibt.
//!
//! **Der Ausweg haengt an keiner gesperrten Taste.** Solange die Sperre gilt,
//! erreicht der Nutzer die Kuerzel seines Compositors nicht mehr. Der Weg aus
//! der Fernsteuerung ist deshalb derselbe wie der aus dem Zeigerfang, und er
//! liegt vollstaendig im Player: Strg+Alt+Umschalt+P oeffnet das Menue am Griff
//! (`overlay::FERN_MENUE_TASTE`, von `Erfassung::menue_kombination`
//! geschluckt), darin sitzt „Fernsteuerung beenden". Diese Kombination geht
//! durch, WEIL die Sperre gilt — ein Inhibitor laesst mehr Tasten ins Fenster,
//! nie weniger. Das Ende der Sitzung ruft `input_capture(enabled: false)`, und
//! dort wird auch hier freigegeben.
//!
//! Aufbau: die plattformneutrale Fassade steht hier, der Wayland-Teil in
//! [`wayland`] und **nur unter Linux**. Auf X11 ist der Linux-Teil ein
//! Nichtstun ohne Kosten (der Aufbau erkennt am Anzeige-Handle, dass es kein
//! Wayland ist); Windows und macOS uebersetzen ihn gar nicht erst.

#[cfg(target_os = "linux")]
mod wayland;

/// Was aus einem Wunsch im aktuellen Zustand folgt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Schritt {
    /// Es steht keine Sperre und es soll eine stehen.
    Anfordern,
    /// Es steht eine Sperre und sie soll weg.
    Freigeben,
    /// Wunsch und Zustand decken sich — **nichts tun**. Das ist der Zweig, an
    /// dem die doppelte Anforderung haengt (s. Modulkopf).
    Nichts,
}

/// Der Ist-Zustand der Sperre eines Fensters, ohne Wayland.
///
/// Getrennt in „was waere zu tun" ([`Self::schritt`]) und „was ist wirklich
/// passiert" ([`Self::vollzogen`]). Die Trennung ist es, die fail-soft
/// richtig macht: scheitert das Anfordern, wird `vollzogen(false)` gemeldet,
/// und ein spaeteres Freigeben versucht dann nicht, etwas abzuraeumen, das nie
/// entstanden ist.
#[derive(Debug, Default)]
pub(crate) struct Sperrbuch {
    haelt: bool,
}

impl Sperrbuch {
    /// Steht gerade eine Sperre?
    pub(crate) fn haelt(&self) -> bool {
        self.haelt
    }

    /// Was der Wunsch bedeutet — reine Auskunft, der Zustand wandert nicht.
    pub(crate) fn schritt(&self, gewuenscht: bool) -> Schritt {
        match (self.haelt, gewuenscht) {
            (false, true) => Schritt::Anfordern,
            (true, false) => Schritt::Freigeben,
            _ => Schritt::Nichts,
        }
    }

    /// Meldet, was der Wayland-Teil WIRKLICH erreicht hat.
    pub(crate) fn vollzogen(&mut self, haelt: bool) {
        self.haelt = haelt;
    }
}

/// Die Sperre EINES Fensters. Haengt an der Sitzung.
#[derive(Default)]
pub(crate) struct Tastensperre {
    buch: Sperrbuch,
    #[cfg(target_os = "linux")]
    halter: wayland::Halter,
}

impl Tastensperre {
    /// Nur fuer die Diagnose: steht die Sperre gerade?
    #[allow(dead_code)]
    pub(crate) fn haelt(&self) -> bool {
        self.buch.haelt()
    }
}

/// Einen Wunsch vollziehen: entscheiden, wirken lassen, buchen.
///
/// **Warum das eine eigene Funktion mit einem Rueckruf ist.** Der Ablauf ist
/// die Haelfte der Richtigkeit — was nuetzt ein fehlerfreies [`Sperrbuch`],
/// wenn der Aufrufer bei [`Schritt::Nichts`] trotzdem anfordert oder nach dem
/// Anfordern zu buchen vergisst? Der wirkende Teil braucht Wayland und ist auf
/// einer fremden Maschine nicht pruefbar, dieser Ablauf hier ist es sehr wohl
/// — mit einem Rueckruf, den ein Test durch einen Zaehler ersetzt. Die
/// Trennung ist genau dort gezogen, wo die Pruefbarkeit endet.
///
/// `wirken` bekommt den Schritt und meldet fuer [`Schritt::Anfordern`], ob die
/// Sperre WIRKLICH steht. Bei [`Schritt::Freigeben`] wird die Antwort bewusst
/// verworfen: danach steht nichts mehr, auch wenn das Abraeumen scheiterte.
fn vollziehen<W>(sperre: &mut Tastensperre, gewuenscht: bool, wirken: W)
where
    W: FnOnce(Schritt, &mut Tastensperre) -> bool,
{
    match sperre.buch.schritt(gewuenscht) {
        Schritt::Nichts => {}
        Schritt::Anfordern => {
            let erreicht = wirken(Schritt::Anfordern, sperre);
            sperre.buch.vollzogen(erreicht);
        }
        Schritt::Freigeben => {
            wirken(Schritt::Freigeben, sperre);
            sperre.buch.vollzogen(false);
        }
    }
}

/// Was sich alle Fenster teilen: die Verbindung zum Compositor samt Manager und
/// Sitzplaetzen.
///
/// Liegt an der App und nicht an der Sitzung, weil eine zweite Verbindung nichts
/// nuetzte — Objekte zweier Verbindungen lassen sich nicht mischen, und der
/// Aufbau kostet einen Umlauf, den man nicht je Fenster zahlen will.
#[derive(Default)]
pub(crate) struct Gemeinsam {
    #[cfg(target_os = "linux")]
    inner: wayland::Gemeinsam,
}

impl Gemeinsam {
    /// Die Sperre eines Fensters auf `gewuenscht` bringen.
    ///
    /// Idempotent — und zwar nicht aus Ordnungsliebe, sondern weil eine zweite
    /// Anforderung auf dieselbe Flaeche die Wayland-Verbindung toetet
    /// (s. Modulkopf).
    pub(crate) fn setzen(
        &mut self,
        sperre: &mut Tastensperre,
        window: &winit::window::Window,
        gewuenscht: bool,
    ) {
        vollziehen(sperre, gewuenscht, |schritt, sperre| match schritt {
            Schritt::Anfordern => self.anfordern(sperre, window),
            _ => {
                self.abraeumen(sperre);
                false
            }
        });
    }

    /// Freigeben ohne Fenster — fuer den Abbau einer Sitzung und fuers Ende der
    /// Ereignisschleife. Ohne Sperre ein Nichtstun.
    pub(crate) fn freigeben(&mut self, sperre: &mut Tastensperre) {
        vollziehen(sperre, false, |_, sperre| {
            self.abraeumen(sperre);
            false
        });
    }

    /// Die Verbindung abbauen, **solange die Anzeige noch lebt**.
    ///
    /// Gehoert ans Ende der Ereignisschleife (`ApplicationHandler::exiting`).
    /// Danach faellt jede noch offene Sperre still in sich zusammen: die
    /// Inhibitor-Objekte halten nur eine schwache Referenz auf die Verbindung,
    /// und ohne sie ist ihr `destroy` ein Nichtstun statt eines Zugriffs auf
    /// eine abgebaute Verbindung.
    pub(crate) fn schliessen(&mut self) {
        #[cfg(target_os = "linux")]
        self.inner.schliessen();
    }

    #[cfg(target_os = "linux")]
    fn anfordern(&mut self, sperre: &mut Tastensperre, window: &winit::window::Window) -> bool {
        self.inner.anfordern(&mut sperre.halter, window)
    }

    #[cfg(not(target_os = "linux"))]
    fn anfordern(&mut self, _sperre: &mut Tastensperre, _window: &winit::window::Window) -> bool {
        false
    }

    #[cfg(target_os = "linux")]
    fn abraeumen(&mut self, sperre: &mut Tastensperre) {
        self.inner.abraeumen(&mut sperre.halter);
    }

    #[cfg(not(target_os = "linux"))]
    fn abraeumen(&mut self, _sperre: &mut Tastensperre) {}
}

#[cfg(test)]
mod tests {
    use super::{Schritt, Sperrbuch, Tastensperre};

    #[test]
    fn frisches_buch_haelt_nichts() {
        assert!(!Sperrbuch::default().haelt());
    }

    #[test]
    fn ohne_sperre_wird_der_wunsch_zur_anforderung() {
        assert_eq!(Sperrbuch::default().schritt(true), Schritt::Anfordern);
    }

    #[test]
    fn ohne_sperre_ist_das_freigeben_ein_nichtstun() {
        // Der Fall „Freigabe ohne Anforderung": kommt bei jedem Sitzungsabbau
        // vor, bei dem nie ferngesteuert wurde.
        assert_eq!(Sperrbuch::default().schritt(false), Schritt::Nichts);
    }

    #[test]
    fn stehende_sperre_gibt_auf_wunsch_frei() {
        let mut buch = Sperrbuch::default();
        buch.vollzogen(true);
        assert_eq!(buch.schritt(false), Schritt::Freigeben);
    }

    #[test]
    fn doppelte_anforderung_tut_nichts() {
        // Der teuerste Fehler des ganzen Moduls: ein zweiter Inhibitor auf
        // dieselbe Flaeche ist `already_inhibited` und reisst die
        // Wayland-Verbindung mit, an der auch winit haengt.
        let mut buch = Sperrbuch::default();
        buch.vollzogen(true);
        assert_eq!(buch.schritt(true), Schritt::Nichts);
    }

    #[test]
    fn gescheiterte_anforderung_hinterlaesst_keine_sperre() {
        // fail-soft: der Compositor kann das Protokoll nicht, `anfordern`
        // meldet `false`. Danach darf das Freigeben nichts abzuraeumen suchen
        // — und ein erneuter Wunsch muss wieder als Anforderung ankommen.
        let mut buch = Sperrbuch::default();
        assert_eq!(buch.schritt(true), Schritt::Anfordern);
        buch.vollzogen(false);
        assert!(!buch.haelt());
        assert_eq!(buch.schritt(false), Schritt::Nichts);
        assert_eq!(buch.schritt(true), Schritt::Anfordern);
    }

    /// Steht anstelle des Wayland-Teils: zaehlt, was `vollziehen` auslaest.
    #[derive(Default)]
    struct Spion {
        angefordert: u32,
        abgeraeumt: u32,
        /// Was das Anfordern melden soll — `false` ist der fail-soft-Fall.
        erfolg: bool,
    }

    /// `vollziehen` mit dem Spion als Wirkung.
    fn lauf(sperre: &mut Tastensperre, gewuenscht: bool, spion: &mut Spion) {
        let erfolg = spion.erfolg;
        super::vollziehen(sperre, gewuenscht, |schritt, _| match schritt {
            Schritt::Anfordern => {
                spion.angefordert += 1;
                erfolg
            }
            _ => {
                spion.abgeraeumt += 1;
                false
            }
        });
    }

    #[test]
    fn vollziehen_fordert_einmal_an_und_bucht_den_erfolg() {
        let mut sperre = Tastensperre::default();
        let mut spion = Spion { erfolg: true, ..Spion::default() };
        lauf(&mut sperre, true, &mut spion);
        assert_eq!((spion.angefordert, spion.abgeraeumt), (1, 0));
        assert!(sperre.haelt());
    }

    #[test]
    fn vollziehen_bucht_nichts_wenn_das_anfordern_scheitert() {
        // fail-soft: der Compositor kann das Protokoll nicht. Wuerde hier
        // trotzdem `true` gebucht, waere der naechste Wunsch ein `Nichts` —
        // und das spaetere Freigeben ein `destroy` auf ein Objekt, das es nie
        // gab.
        let mut sperre = Tastensperre::default();
        let mut spion = Spion { erfolg: false, ..Spion::default() };
        lauf(&mut sperre, true, &mut spion);
        assert_eq!(spion.angefordert, 1);
        assert!(!sperre.haelt());
    }

    #[test]
    fn vollziehen_ruehrt_bei_deckungsgleichem_wunsch_nichts_an() {
        // Der Fall, der die Wayland-Verbindung kostet: ein zweites
        // `input_capture(true)` darf den Wayland-Teil NICHT erreichen.
        let mut sperre = Tastensperre::default();
        let mut spion = Spion { erfolg: true, ..Spion::default() };
        lauf(&mut sperre, true, &mut spion);
        lauf(&mut sperre, true, &mut spion);
        assert_eq!(spion.angefordert, 1);

        // Und dasselbe fuer die Freigabe ohne Sperre.
        let mut leer = Tastensperre::default();
        let mut spion = Spion::default();
        lauf(&mut leer, false, &mut spion);
        assert_eq!((spion.angefordert, spion.abgeraeumt), (0, 0));
    }

    #[test]
    fn vollziehen_raeumt_ab_und_bucht_immer_false() {
        let mut sperre = Tastensperre::default();
        let mut spion = Spion { erfolg: true, ..Spion::default() };
        lauf(&mut sperre, true, &mut spion);
        // Der Spion meldet weiter `true` — nach dem Freigeben muss trotzdem
        // `false` gebucht sein, sonst bliebe die Sperre auf ewig „gehalten"
        // und koennte nie wieder angefordert werden.
        lauf(&mut sperre, false, &mut spion);
        assert_eq!(spion.abgeraeumt, 1);
        assert!(!sperre.haelt());

        // Danach ist ein erneutes Anfordern wieder moeglich.
        lauf(&mut sperre, true, &mut spion);
        assert_eq!(spion.angefordert, 2);
    }

    #[test]
    fn ein_ganzer_sitzungslauf() {
        let mut buch = Sperrbuch::default();

        // Fernsteuerung an.
        assert_eq!(buch.schritt(true), Schritt::Anfordern);
        buch.vollzogen(true);
        assert!(buch.haelt());

        // Ein zweites `input_capture(true)` (Platzwechsel, Fokusrueckkehr)
        // darf NICHTS tun.
        assert_eq!(buch.schritt(true), Schritt::Nichts);

        // Fernsteuerung aus.
        assert_eq!(buch.schritt(false), Schritt::Freigeben);
        buch.vollzogen(false);
        assert!(!buch.haelt());

        // Und der Abbau der Sitzung danach ebenso wenig — sonst ginge ein
        // `destroy` auf ein Objekt, das es nicht mehr gibt.
        assert_eq!(buch.schritt(false), Schritt::Nichts);
    }
}
