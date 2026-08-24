//! Ob der EIGENE Zug ueber die Fenstergrenze zuende ist — und ob das schon
//! sicher ist.
//!
//! **Getrennt von [`super::zug::ZugLage`], weil deren Momentaufnahme
//! (`aktuell() == None`) das Ende NICHT zuverlaessig anzeigt** — Review-Befunde
//! C2/I3 vom 2026-08-24: ein ganzer Zug kann VOLLSTAENDIG zwischen zwei
//! Abtastungen ablaufen (`Enter -> Motion -> Drop -> Leave` in einem einzigen
//! `dispatch_pending`, wenn Druck und Loslassen schnell aufeinander folgen).
//! Und ein Flaechenwechsel innerhalb DESSELBEN Zugs raeumt `ZugLage` per
//! `Leave` vor dem naechsten `Enter` derselben Zugsitzung — eine Abtastung
//! genau in dieser Luecke saehe ebenfalls wie ein Ende aus, waere aber keins.
//!
//! [`Zugende`] ist deshalb EREIGNISGETRIEBEN statt abgetastet: nur `Drop`/
//! `Enter`/`Leave` bewegen ihn voran, [`super::Gastverbindung::zug_zuende`]
//! konsumiert das Ergebnis genau einmal.
//!
//! **Wer ihn speist, entscheidet der Merker „eigener Zug" in [`super`]** — das
//! Datengeraet bekommt `Enter`/`Drop`/`Leave` auch fuer FREMDE Zuege (jemand
//! zieht eine Datei aus dem Dateimanager ueber ein Player-Fenster). Bis zum
//! Review-Befund C-1 vom 2026-08-24 speiste ein fremder Zug dieselben Zaehler
//! wie der eigene; Begruendung und Folgen stehen am Merker in [`super`].
//!
//! ## Was ein `Leave` ohne `Drop` WIRKLICH heisst (Messung 2026-08-24)
//!
//! Gemessen auf dieser Maschine (`niri`, zwei echte `xdg_toplevel` eines
//! Klienten, EIN `wl_data_device`, durchgehender Zug per `ydotool`, Protokoll
//! im Bericht zu Task 3):
//!
//! ```text
//! [3990523 us] lese#22  DND motion x=780.0     <- letzte Bewegung IN Flaeche A
//! [4011631 us] lese#23  DND leave
//! [4032725 us] lese#24  DND enter Flaeche B x=8.0   (+21091 us nach dem Leave)
//! ```
//!
//! **`Leave` und `Enter(B)` liegen NICHT im selben Umlauf** — weder im selben
//! `dispatch_pending` noch im selben Socket-Lesevorgang. Zwischen den beiden
//! Kacheln klafft eine Luecke (16 px bei `niri`), und solange der Zeiger darin
//! steht, gehoert er KEINER eigenen Flaeche: es kommt nichts.
//!
//! **Die 21 ms sind dabei die Abtastrate der Messung, keine gemessene
//! Verweildauer** (Review M-1): der synthetische Zug lief in 22-px-Schritten
//! alle 21 ms, genau ein Schritt fiel in die Luecke. Wie lange ein Mensch
//! dort verbringt, ist damit NICHT gemessen — es folgt aber aus dem Aufbau,
//! dass es beliebig lang sein kann: die Zeit haengt an der Breite der Luecke,
//! an der Handgeschwindigkeit, an fremden Fenstern dazwischen und schlicht am
//! Innehalten. (Was hier bis zum 2026-08-25 stand — „ueber die Luecke
//! zwischen zwei Monitoren sind es Sekunden" — war schief: im Zeigerraum
//! grenzen zwei Monitore ohne Luecke aneinander. Lang wird das Intervall
//! durch das, was ZWISCHEN den Player-FENSTERN liegt, nicht durch die
//! Monitorgrenze.)
//!
//! Daraus folgt zweierlei:
//! * Die **Ein-Umlauf-Kulanz der ersten Fassung war nachweislich zu kurz** —
//!   sie haette diesen Zug genau an der Fenstergrenze abgebrochen.
//! * Ein `Leave` ohne `Drop` ist **nicht ueberwiegend ein Abbruch**, sondern
//!   ueberwiegend „der Zeiger steht gerade zwischen den Fenstern". Eine kurze
//!   FRIST als Hauptkriterium waere deshalb auch mit 200 ms noch eine Wette
//!   auf Handgeschwindigkeit und Fensterabstand. Das eigentliche Kriterium ist
//!   der Beweis von der anderen Seite: **liefert winit wieder
//!   `CursorMoved`/`MouseInput`, ist der Griff des Compositors nachweislich
//!   vorbei** (waehrend des ganzen gemessenen Zugs kam kein einziges
//!   `wl_pointer`-Ereignis; erst mit dem `Drop` kam `wl_pointer.enter` zurueck,
//!   und zwar im SELBEN Umlauf). Diesen Beweis fuehrt `app::wayland_zug`; hier
//!   bleibt nur die [`NOTFRIST`] als letztes Netz.
//!
//! **Eigene Datei, weil `mod.rs` sonst ueber die Groessen-Grenze waechst**
//! (`PLAN.md` §12.1) — und weil hier, anders als daneben, keine
//! Wayland-Abhaengigkeit steckt: die ganze Entscheidung ist reine
//! Zustandsfuehrung und laeuft im Test ohne Compositor.

use std::time::{Duration, Instant};

/// Letztes Netz: so lange darf ein `Leave` ohne `Drop` unaufgeloest bleiben,
/// bevor der Zug als beendet gilt und alles Gedrueckte freigegeben wird.
///
/// **Ein Netz, kein Hauptkriterium.** Aufgeloest wird ein `Leave` normalerweise
/// von einem der beiden echten Signale: ein `Enter` (der Zeiger hat die
/// naechste eigene Flaeche erreicht, s. Modulkopf) oder ein winit-Zeigerereignis
/// (der Griff des Compositors ist vorbei, `app::wayland_zug`). Diese Frist
/// greift nur, wenn BEIDE ausbleiben — der Zug wurde abgebrochen (Esc), und der
/// Zeiger steht dabei ueber einem FREMDEN Fenster, von dem uns winit nichts
/// meldet. Ohne sie bliebe die Maustaste am fernen Rechner unten, bis der
/// Nutzer das naechste Mal ein Player-Fenster beruehrt.
///
/// **Warum sie GROSSZUEGIG bemessen ist, entgegen der ersten Schaetzung.** Das
/// Review vom 2026-08-24 gab 200 ms vor, unter der Annahme, ein `Leave` ohne
/// `Drop` sei „der seltene Fall Abbruch". Die Messung desselben Tages (s.
/// Modulkopf) zeigt das Gegenteil: der Normalfall eines `Leave` ist „der
/// Zeiger ist gerade zwischen zwei Fenstern". Wie lange das dauert, ist NICHT
/// gemessen (die 21 ms des Messlaufs sind dessen Schrittweite, s. Modulkopf) —
/// es haengt an der Breite der Luecke zwischen den Player-Fenstern, an der
/// Handgeschwindigkeit und daran, ob der Nutzer innehaelt, und ist damit nach
/// oben offen. Eine kurze Frist zerrisse dann GENAU die Geste, fuer die dieser
/// ganze Weg gebaut ist, und zwar still.
///
/// Die Abwaegung ist einseitig, nur anders herum als angenommen:
/// * Zu kurz: `zug_beendet()` mitten in der Geste, Sitzung danach tot, ein
///   spaeter doch kommendes `Enter(B)` erreicht niemanden mehr.
/// * Zu lang: die Maustaste bleibt beim Host laenger unten — und auch das nur,
///   solange der Zeiger KEIN Player-Fenster beruehrt; die erste Beruehrung
///   beendet den Zug ueber den Beweisweg sofort.
///
/// 5 s ist die Haelfte von `REMOTE_DISCONNECT_GRACE_S` (10 s), mit dem dieses
/// Haus dieselbe Abwaegung schon einmal getroffen hat: lieber eine womoeglich
/// gehaltene Taste in Kauf nehmen als eine laufende Sitzung toeten
/// (`CLAUDE.md`, Fernsteuerung).
///
/// **Der „zu kurz"-Schaden ist mit 5 s nicht weg, nur selten** (Review I-1),
/// und was dann bleibt, gehoert benannt: `Unklar` entsteht bei JEDEM `Leave` —
/// auch wenn der Nutzer nur innehaelt oder ueber ein fremdes Fenster zieht.
/// Laeuft die Frist waehrend eines gesunden Zugs ab, steht danach eine halbe
/// Sitzung: der Player hat losgelassen und seine Sitzung vergessen, der Zug
/// im Compositor laeuft weiter. Das folgende `Enter`, alle `Motion` und das
/// `Drop` fallen dann heraus — der Nutzer sieht seinen Zeiger drueben
/// ankommen, die Taste ist weg, das Fenster faellt nicht. Deshalb meldet
/// [`Zugende::frist_pruefen`] ihr Ausloesen ins Log; von den drei Ende-Wegen
/// ist dieser der einzige echte Ausnahmefall.
pub(super) const NOTFRIST: Duration = Duration::from_secs(5);

/// Ob der laufende eigene Zug (aus Sicht des Datengeraets) zuende ist — und ob
/// das schon SICHER ist.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(super) enum Zugende {
    #[default]
    Keins,
    /// Ein `Leave` kam, OHNE dass zuvor in dieser Zugsitzung ein `Drop` fiel.
    /// Ueberwiegend heisst das „der Zeiger steht zwischen zwei Fenstern" (s.
    /// Modulkopf, Messung) — dann kommt gleich ein `Enter` und hebt es wieder
    /// auf. Seltener heisst es „abgebrochen". Der Zeitpunkt ist der des
    /// `Leave`; bleibt es [`NOTFRIST`] lang unaufgeloest, gilt es als
    /// [`Zugende::Beendet`].
    Unklar(Instant),
    /// Definitiv vorbei: `Drop` kam (sofort, ohne auf das abschliessende
    /// `Leave` zu warten — ein `Drop` ohne vorheriges Loesen der Maustaste gibt
    /// es im Protokoll nicht), oder ein [`Zugende::Unklar`] hat die
    /// [`NOTFRIST`] ueberlebt.
    Beendet,
}

impl Zugende {
    /// `wl_data_device::Event::Enter` — loest ein vorheriges `Unklar` auf (der
    /// Zeiger hat die naechste eigene Flaeche erreicht: die Zugsitzung geht
    /// weiter).
    ///
    /// **Ein bereits definitives `Beendet` bleibt unangetastet** — Guertel und
    /// Hosentraeger. Erreichbar ist der Fall seit dem C-1-Fix nicht mehr: ein
    /// `Enter` speist diesen Zustand nur noch, solange der Merker „eigener Zug"
    /// steht, und der naechste eigene Zug setzt hier ohnehin auf `Keins`
    /// zurueck — nachdem der Aufrufer ein noch offenes Ende abgearbeitet hat
    /// (`app::App::wayland_zug_beginnen`). Bis zum 2026-08-24 stand hier als
    /// Begruendung, das verhindere eine klemmende Taste; das war doppelt falsch
    /// (Review M-c) und ist der Kommentar, unter dem C-1 ueberhaupt entstand:
    /// das aufbewahrte Ende wurde nicht der ALTEN Sitzung zugestellt, sondern
    /// der naechsten — es klemmte nichts, es ging zu FRUEH auf.
    pub(super) fn betreten(&mut self) {
        if matches!(self, Self::Unklar(_)) {
            *self = Self::Keins;
        }
    }

    /// `Drop` — sofort und unbedingt definitiv (s. Typ-Doku).
    pub(super) fn fallengelassen(&mut self) {
        *self = Self::Beendet;
    }

    /// `Leave` — nur „unklar", und nur wenn noch gar kein Ende steht.
    ///
    /// Nicht aus [`Self::Beendet`] heraus: sonst setzte das abschliessende
    /// `Leave` NACH einem `Drop` das definitive Ende faelschlich wieder auf
    /// „unklar" (gemessene Abfolge `Drop -> Leave` im selben Umlauf, s.
    /// Modulkopf). Und nicht aus einem laufenden [`Self::Unklar`] heraus: ein
    /// zweites `Leave` ohne `Enter` dazwischen wuerde die Frist sonst neu
    /// starten, statt sie ablaufen zu lassen.
    pub(super) fn verlassen(&mut self, jetzt: Instant) {
        if matches!(self, Self::Keins) {
            *self = Self::Unklar(jetzt);
        }
    }

    /// Ist die [`NOTFRIST`] eines `Unklar` abgelaufen? Dann gilt es jetzt als
    /// beendet — und der Rueckgabewert sagt, dass das GERADE passiert ist.
    ///
    /// Aufgerufen aus [`super::Gastverbindung::nachfassen`], nicht aus dem
    /// Dispatch selbst: dort gibt es keinen Anlass, die Uhr anzusehen — ein
    /// abgelaufenes `Unklar` soll gerade auch dann beendet werden, wenn gar
    /// kein Ereignis mehr kommt.
    ///
    /// **Der Rueckgabewert traegt ein Log** (Review I-1). Von den drei Wegen,
    /// auf denen ein Zug endet, ist dieser der einzige, der wirklich ein
    /// Ausnahmefall ist — und der einzige, der einen GESUNDEN Zug zerreissen
    /// kann (s. [`NOTFRIST`]). Was danach steht, sieht von aussen wie ein
    /// Defekt aus: der Zeiger kommt drueben noch an, die Taste ist weg, das
    /// Fenster faellt nicht. Ohne die Zeile im Log gaebe es dafuer keine Spur.
    pub(super) fn frist_pruefen(&mut self, jetzt: Instant) -> bool {
        if let Self::Unklar(seit) = *self {
            if jetzt.saturating_duration_since(seit) >= NOTFRIST {
                *self = Self::Beendet;
                return true;
            }
        }
        false
    }

    /// Der Beweis von der anderen Seite: winit liefert wieder Zeigerereignisse,
    /// der Griff des Compositors ist also vorbei (s. Modulkopf). Damit ist ein
    /// offenes `Unklar` aufgeloest, ohne auf die [`NOTFRIST`] zu warten — der
    /// Weg, auf dem ein abgebrochener Zug (Esc) im Normalfall endet.
    ///
    /// **Nur aus [`Self::Unklar`] heraus, mit Absicht.** Aus [`Self::Keins`]
    /// heraus hiesse: „ein winit-Zeigerereignis beendet einen Zug, der gerade
    /// voellig gesund ueber einer eigenen Flaeche laeuft". Dass es solche
    /// Ereignisse waehrend eines Zugs nicht gibt, ist gemessen (s. Modulkopf) —
    /// aber es ist eine Messung auf EINEM Compositor, und die Kosten einer
    /// Fehlannahme waeren die schlimmstmoeglichen: eine Maustaste, die am
    /// fernen Rechner mitten in der Geste hochgeht. Aus `Keins` heraus nichts
    /// zu tun kostet dagegen gar nichts: jeder Zug endet laut Protokoll mit
    /// einem `Leave`, und danach greift dieser Weg. Ein `Drop` wiederum hat
    /// das Ende schon definitiv gesetzt.
    pub(super) fn griff_vorbei(&mut self) {
        if matches!(self, Self::Unklar(_)) {
            *self = Self::Beendet;
        }
    }

    /// Konsumierend: `true` GENAU EINMAL, wenn [`Self::Beendet`] gilt — danach
    /// wieder [`Self::Keins`]. Ohne das Konsumieren wuerde derselbe Ende-Frame
    /// bei jedem Tick erneut gemeldet.
    pub(super) fn konsumiere_beendet(&mut self) -> bool {
        if *self == Self::Beendet {
            *self = Self::Keins;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Zugende, NOTFRIST};
    use std::time::{Duration, Instant};

    /// Ein fester Zeitpunkt — die Frist wird im Test GERECHNET, nicht
    /// abgewartet. Ein Test, der schlaeft, misst die Maschinenlast mit.
    fn t0() -> Instant {
        Instant::now()
    }

    #[test]
    fn frisch_ist_keins() {
        assert_eq!(Zugende::default(), Zugende::Keins);
    }

    #[test]
    fn drop_ist_sofort_definitiv() {
        let mut ende = Zugende::default();
        ende.fallengelassen();
        assert_eq!(ende, Zugende::Beendet);
    }

    #[test]
    fn leave_ohne_vorheriges_drop_ist_nur_unklar() {
        let jetzt = t0();
        let mut ende = Zugende::default();
        ende.verlassen(jetzt);
        assert_eq!(
            ende,
            Zugende::Unklar(jetzt),
            "noch nicht definitiv — der Zeiger steht vermutlich zwischen zwei Fenstern"
        );
    }

    /// **Der Flaechenwechsel-Fall (I3):** `Leave(A)` gefolgt von `Enter(B)` IM
    /// SELBEN Zug loest das `Unklar` wieder auf — kein Ende.
    #[test]
    fn enter_loest_ein_unklares_leave_auf() {
        let mut ende = Zugende::default();
        ende.verlassen(t0());
        ende.betreten();
        assert_eq!(ende, Zugende::Keins, "der Flaechenwechsel ist bestaetigt, kein Ende");
    }

    #[test]
    fn enter_laesst_ein_bereits_definitives_ende_unangetastet() {
        let mut ende = Zugende::default();
        ende.fallengelassen();
        ende.betreten();
        assert_eq!(ende, Zugende::Beendet);
    }

    /// Das abschliessende `Leave` NACH einem `Drop` — gemessen im SELBEN
    /// Umlauf wie das `Drop` (2026-08-24, s. Modulkopf) — darf das definitive
    /// Ende nicht wieder auf „unklar" zuruecksetzen.
    #[test]
    fn leave_nach_drop_bleibt_beendet() {
        let mut ende = Zugende::default();
        ende.fallengelassen();
        ende.verlassen(t0());
        assert_eq!(ende, Zugende::Beendet);
    }

    /// **Der C2-Kernfall:** ein ganzer Zug (`Enter -> Motion -> Drop -> Leave`)
    /// lief vollstaendig ab, ohne dass je eine Abtastung dazwischen kam —
    /// `Zugende` ist trotzdem korrekt `Beendet`, weil `Drop` sofort definitiv
    /// ist, unabhaengig von jeder Momentaufnahme.
    #[test]
    fn ein_ganzer_schneller_zug_ergibt_beendet_ohne_zwischenabtastung() {
        let mut ende = Zugende::default();
        ende.betreten(); // Enter
        // Motion beruehrt `Zugende` nicht.
        ende.fallengelassen(); // Drop
        ende.verlassen(t0()); // Leave
        assert_eq!(ende, Zugende::Beendet);
    }

    #[test]
    fn konsumiere_beendet_liefert_einmal_true_und_dann_wieder_false() {
        let mut ende = Zugende::default();
        ende.fallengelassen();
        assert!(ende.konsumiere_beendet());
        assert!(!ende.konsumiere_beendet(), "ein zweiter Aufruf ohne neues Ende liefert false");
        assert_eq!(ende, Zugende::Keins);
    }

    #[test]
    fn konsumiere_beendet_ohne_ende_liefert_false() {
        assert!(!Zugende::default().konsumiere_beendet());
        let mut unklar = Zugende::default();
        unklar.verlassen(t0());
        assert!(!unklar.konsumiere_beendet(), "unklar ist noch nicht beendet");
    }

    /// **Der gemessene Flaechenwechsel gegen die Frist:** zwischen `Leave` und
    /// `Enter(B)` lagen 21,1 ms (Messung 2026-08-24, s. Modulkopf). Die
    /// [`NOTFRIST`] darf davon weit entfernt bleiben — und tut es.
    #[test]
    fn der_gemessene_flaechenwechsel_liegt_weit_innerhalb_der_frist() {
        let jetzt = t0();
        let mut ende = Zugende::default();
        ende.verlassen(jetzt);
        assert!(!ende.frist_pruefen(jetzt + Duration::from_micros(21_091)));
        assert_eq!(ende, Zugende::Unklar(jetzt), "21 ms zwischen den Fenstern sind kein Ende");
        ende.betreten();
        assert_eq!(ende, Zugende::Keins);
    }

    #[test]
    fn unklar_wird_erst_nach_der_notfrist_beendet() {
        let jetzt = t0();
        let mut ende = Zugende::default();
        ende.verlassen(jetzt);
        assert!(!ende.frist_pruefen(jetzt + NOTFRIST - Duration::from_millis(1)));
        assert_eq!(ende, Zugende::Unklar(jetzt), "kurz vor Ablauf noch nicht");
        assert!(ende.frist_pruefen(jetzt + NOTFRIST), "das Ausloesen wird gemeldet (Log)");
        assert_eq!(ende, Zugende::Beendet);
        assert!(
            !ende.frist_pruefen(jetzt + NOTFRIST * 2),
            "und nur EINMAL — sonst schriebe der Takt das Log voll"
        );
    }

    /// Ein zweites `Leave` ohne `Enter` dazwischen darf die Frist nicht neu
    /// starten — sonst schoebe eine Folge von `Leave`s das Ende beliebig weit
    /// hinaus.
    #[test]
    fn ein_zweites_leave_startet_die_frist_nicht_neu() {
        let jetzt = t0();
        let mut ende = Zugende::default();
        ende.verlassen(jetzt);
        ende.verlassen(jetzt + NOTFRIST - Duration::from_millis(1));
        assert!(ende.frist_pruefen(jetzt + NOTFRIST));
        assert_eq!(ende, Zugende::Beendet);
    }

    /// **Der Beweisweg:** winit meldet sich wieder — das loest ein offenes
    /// `Unklar` sofort auf, ohne die Frist abzuwarten. Das ist der Weg, ueber
    /// den ein abgebrochener Zug im Normalfall endet.
    #[test]
    fn ein_winit_zeigerereignis_loest_ein_unklares_leave_sofort_auf() {
        let jetzt = t0();
        let mut ende = Zugende::default();
        ende.verlassen(jetzt);
        ende.griff_vorbei();
        assert_eq!(ende, Zugende::Beendet);
        assert!(ende.konsumiere_beendet());
    }

    /// **Und der Beweisweg beendet KEINEN gesunden Zug.** Solange kein `Leave`
    /// offen ist, laeuft der Zug ueber einer eigenen Flaeche — ein
    /// winit-Zeigerereignis waere dann eine Ueberraschung, und die teuerste
    /// Antwort darauf waere, die Maustaste am fernen Rechner mitten in der
    /// Geste loszulassen (s. Doku an `griff_vorbei`).
    #[test]
    fn ein_winit_zeigerereignis_beendet_keinen_gesunden_zug() {
        let mut ende = Zugende::default();
        ende.betreten();
        ende.griff_vorbei();
        assert_eq!(ende, Zugende::Keins);
        assert!(!ende.konsumiere_beendet());
    }
}
