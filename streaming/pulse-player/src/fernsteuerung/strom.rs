//! Der Lebenslauf eines Eingabestroms: ein- und ausschalten, Hello, alles
//! loslassen, Notbremse.
//!
//! Abgetrennt von [`super`], weil dort die UEBERSETZUNG einzelner Ereignisse
//! wohnt (welches winit-Ereignis welchen Frame ergibt) und hier die Frage, zu
//! WELCHEM Strom sie gehoeren. Beides in einer Datei war ueber die
//! Groessen-Grenze gewachsen (`PLAN.md` §12.1).
//!
//! Als Kindmodul kommt das an die privaten Felder von [`Erfassung`], ohne dafuer
//! Zugaenge zu oeffnen, die sonst niemand braucht.

use super::rahmen::{self, Rahmen};
use super::winit_abbild::knopf_aus_nummer;
use super::Erfassung;

impl Erfassung {
    /// Erfassung einschalten — **jedes Einschalten beginnt einen neuen
    /// Eingabestrom** und stellt ihm ein Hello voran, auch wenn die Erfassung
    /// aus Sicht des Players schon an war (s. [`Self::strom_beginnen`]).
    ///
    /// `sitzung` ist die Kennung der Fernsteuerungs-Sitzung, fuer die erfasst
    /// wird. Sie wird hier nicht gedeutet und geht auch nicht ueber die Leitung
    /// — sie beantwortet allein die Frage, ob liegengebliebene Frames des
    /// vorigen Stroms noch **an dasselbe Ziel** gehen (s. unten). `None` heisst
    /// „unbekannt" und wird wie ein Zielwechsel behandelt: wer nicht weiss, wem
    /// er etwas schickt, schickt es nicht.
    pub fn einschalten(&mut self, slot: u32, zeigerfang: bool, sitzung: Option<&str>) {
        // **Dasselbe Ziel heisst: gleiche Sitzung UND gleicher Platz.**
        //
        // Liegengebliebene Hoch-Ereignisse stammen aus dem vorigen Strom. Geht
        // dazwischen die Sitzung zu Ende und binnen einer Sekunde eine neue am
        // selben Fenster auf, gingen sie mit der Kennung der NEUEN hinaus — der
        // Host der neuen Sitzung bekaeme ein Hoch-Ereignis fuer eine Taste, die
        // er nie gedrueckt sah. Der Platz zaehlt aus demselben Grund mit: jeder
        // Stream-Platz hat drueben seinen eigenen Sidecar mit eigener Menge des
        // Gedrueckten, ein Hoch-Ereignis fuer Platz 1 hat auf Platz 2 nichts zu
        // suchen.
        //
        // Verwerfen ist dabei die sichere Seite: der Host gibt beim Hello
        // ohnehin alles frei, die Frames waeren also hoechstens ueberfluessig —
        // am falschen Ziel sind sie dagegen echte Fremdeingabe.
        //
        // **Warum hier nichts nachgereicht wird.** Nahe liegt, beim Zielwechsel
        // erst regulaer `ausschalten()` zu durchlaufen und die Hoch-Ereignisse
        // noch mit dem ALTEN Platz hinauszuschicken — sonst bleibt drueben eine
        // Taste gedrueckt. Genau das wurde am 2026-08-19 gebaut und wieder
        // zurueckgenommen; die Stelle sieht nur wie ein Versehen aus:
        //
        // 1. Die Weiche im Hauptprozess (`desktop/electron/remoteInput.ts`,
        //    `erfassungSchalten`) meldet das NEUE Ziel an, bevor sie
        //    `input_capture` ruft. Frames, die waehrend dieses Rufs mit dem
        //    alten Platz hinausgehen, wirft `verteilen()` still weg
        //    (`ev.slot !== zuordnung.slot`) — die Taste bliebe trotzdem
        //    gedrueckt, der Aufwand waere umsonst.
        // 2. Beim reinen SITZUNGSwechsel (gleicher Platz) kaemen sie an, aber
        //    mit der neuen Kennung und VOR dem Hello. Dort ist der Host
        //    fail-closed („Eingabe vor dem Hello-Handschlag") — die frische
        //    Sitzung stuende still. Ein Nachreichen macht den Fall also nicht
        //    besser, sondern schlimmer.
        // 3. Erreichbar ist der Fall mit dem ausgelieferten Renderer gar nicht:
        //    `RemoteControllerInput.svelte` schaltet bei jeder Ziel-Aenderung
        //    erst ab und dann ein, `aktiv` ist beim Einschalten also immer
        //    `false`. Er traete nur ein, wenn ein Ausschalten scheitert (Fenster
        //    weg, Ruf geworfen) — und dann ist ein Frame-Schwall mit fremder
        //    Kennung die schlechtere Antwort.
        //
        // Wer die klemmende Taste beim Zielwechsel doch schliessen will, setzt
        // beim ABSCHALTEN an (dort geht der alte Platz sauber mit) und nicht
        // hier.
        let selbes_ziel =
            sitzung.is_some() && sitzung == self.sitzung.as_deref() && slot == self.slot;
        self.strom_beginnen(selbes_ziel);
        self.aktiv = true;
        self.slot = slot;
        // Ein neuer Strom beginnt immer beim eigenen Bildschirm. Ein Ziel aus
        // dem vorigen Lauf zeigte auf ein Fenster, das es vielleicht nicht mehr
        // gibt.
        self.ziel_slot = slot;
        self.zeigerfang = zeigerfang;
        self.sitzung = sitzung.map(str::to_owned);
    }

    /// Erfassung ausschalten. Fuer alles Gedrueckte wird das Hoch-Ereignis
    /// nachgereicht: der Host laesst zwar bei Sitzungsende ebenfalls alles los,
    /// aber „Erfassung aus" ist kein Sitzungsende — wer den Mauszeiger aus dem
    /// Fenster nimmt, waehrend W gedrueckt ist, liefe sonst im Spiel weiter.
    ///
    /// **Nimmt bewusst KEINEN Platz entgegen.** Die Hoch-Ereignisse gehoeren zu
    /// dem Stream, der gerade gesteuert wurde, und nur diese Seite weiss,
    /// welcher das war. Bis zum 2026-08-12 trug das Ausschalten einen Platz in
    /// der Signatur, den die IPC-Strecke nicht mitfuehrte: aus `stop()` wurde
    /// oben eine 0, und die Hoch-Ereignisse einer Steuerung von Platz 2 gingen
    /// an Platz 0 — dessen Sidecar nie ein Hello gesehen hatte und deshalb
    /// fail-closed einen FREMDEN, laufenden Stream stilllegte. Ein Wert, den
    /// niemand setzen kann, kann auch niemand verbiegen.
    pub fn ausschalten(&mut self) {
        if self.aktiv {
            self.alles_loslassen();
        }
        self.aktiv = false;
        self.zeigerfang = false;
        // Wie in `strom_beginnen`: kein Merker darf die Erfassung ueberleben,
        // sonst schluckt der naechste Lauf ein Loslassen, das ihm nicht gehoert.
        self.menue_geschluckt = false;
    }

    /// Einen neuen Eingabestrom beginnen: Hello nach VORN, Zustand auf null.
    ///
    /// **Am Strom, nicht an der Flanke** (2026-08-12). Vorher entstand das
    /// Hello nur beim Uebergang aus→an. Der Host haelt seinen Zustand aber ueber
    /// die ganze stdio-Sitzung und die ueberlebt Sitzungswechsel: war die
    /// Erfassung im Player schon „an", als drueben ein neuer Eingabestrom
    /// begann, kam als erstes eine Bewegung an — und der Host ist fail-closed
    /// (`Eingabe vor dem Hello-Handschlag`, im Zwei-Geraete-Test am 2026-08-12
    /// belegt, danach stand die Sitzung still). Ein weiteres Hello ist laut
    /// Wire-Spec ausdruecklich erlaubt und heisst „neuer Strom"; es zu wenig zu
    /// senden legt die Fernsteuerung lahm, es zu oft zu senden kostet nichts.
    ///
    /// **Das Hello geht nach VORN, Uebernommenes dahinter.** Beides hat je
    /// einen Grund:
    /// * Die Hoch-Ereignisse des vorigen Stroms (aus [`Self::alles_loslassen`])
    ///   bleiben stehen — **hier stand bis zum 2026-08-12 ein `clear()`**, das
    ///   sie wegwarf, wenn zwischen Aus und Ein kein Abholen lag; die Taste
    ///   blieb dann beim Host gedrueckt. Das gilt aber nur bei gleichem Ziel
    ///   (`uebernehmen`, s. [`Self::einschalten`]).
    /// * Vor dem Hello duerfen sie trotzdem nicht liegen: hat der Host in
    ///   diesem Strom noch kein Hello gesehen, beendet ihn schon das erste
    ///   Frame davor. Dahinter sind sie hoechstens ueberfluessig — **aber nur
    ///   fuer den Platz, an den DIESES Hello geht.** Das Hello traegt
    ///   `ziel_slot` in der Huelle und erreicht damit genau EINEN
    ///   Sidecar-Prozess, nicht "den Host" als Ganzes — seit dem Ziehen ueber
    ///   die Fenstergrenze ist `ziel_slot` nicht mehr zwingend derselbe wie
    ///   der eigene `slot`. Deshalb setzt diese Funktion `ziel_slot` weiter
    ///   unten auf den EIGENEN Platz zurueck, bevor der Rest laeuft — sonst
    ///   ginge das Hello an ein Fenster, ueber das der vorige Strom zufaellig
    ///   zuletzt gezogen hatte. Und genau deshalb vergisst der Player hier
    ///   auch seine eigene Menge des Gedrueckten: sie gilt fuer den Platz, an
    ///   den das neue Hello tatsaechlich geht. **Was das nicht heilt:** ein
    ///   Zug, der bei einem NACHBARN endete (dessen Sidecar also das zuletzt
    ///   Gedrueckte haelt), bekommt durch diese Notbremse keine Freigabe —
    ///   die Taste kann dort bis zum Sitzungsende gedrueckt bleiben. Das zu
    ///   beheben braucht Gehaltenes je ZIEL nachzuziehen, nicht nur den
    ///   eigenen Platz zu befreien, und ist eigene Entwurfsarbeit.
    ///
    /// Ueberholte Bewegungen fallen: die Wire-Spec erlaubt genau das. Eine
    /// Bewegung, an der ein Knopf oder das Rad haengt, faellt **nicht**
    /// (`Schlange::behaltmaske`) — sonst klickte der Host dort, wo sein Zeiger
    /// zufaellig steht.
    pub(super) fn strom_beginnen(&mut self, uebernehmen: bool) {
        self.warteschlange.neuer_strom(rahmen::hello(), uebernehmen);
        // Das neue Hello geht an den EIGENEN Platz — ein Ziel aus dem vorigen
        // Lauf (ein Zug ueber die Fenstergrenze kurz vor dieser Stelle) darf
        // nicht ueberleben. `einschalten` setzt `ziel_slot` gleich danach
        // ohnehin nochmal auf den neuen Platz (macht das hier redundant); die
        // NOTBREMSE (`notbremse_pruefen`) ruft `strom_beginnen` aber OHNE
        // `einschalten` und bliebe sonst auf einem fremden Ziel stehen.
        self.ziel_slot = self.slot;
        if !uebernehmen {
            // Buendel aus einem fremden Ziel oder einer fremden Sitzung
            // draengeln sich sonst vor das neue Hello: `abholen()` gibt
            // `ausstehend` vor allem anderen heraus, und beim Host waeren
            // diese Frames Fremdeingabe VOR dem Handschlag — derselbe
            // fail-closed-Fall, gegen den die Warteschlange oben schon
            // geschuetzt wird. Ein Grenzuebertritt kurz vor einem Ziel- oder
            // Sitzungswechsel fuellt genau dieses Feld.
            self.ausstehend.clear();
        }
        self.tasten_unten.clear();
        self.knoepfe_unten.clear();
        // Der Zeiger kann inzwischen woanders stehen, und Reste einer alten
        // Geste gehoeren nicht in die neue.
        self.letzte_zeigerlage = None;
        self.rasten.zuruecksetzen();
        self.rest_dx = 0.0;
        self.rest_dy = 0.0;
        // Auch der Merker fuer die geschluckte Menue-Taste (s.
        // `Erfassung::menue_kombination`). Ohne das hier ueberlebt er einen
        // Fokusverlust zwischen Druck und Loslassen der Kombination — und das
        // NAECHSTE Loslassen eines ganz gewoehnlichen P wuerde geschluckt,
        // waehrend sein Druck hinausging. Beim Gesteuerten liefe die
        // Tastenwiederholung dann bis zum Ende der Erfassung weiter.
        self.menue_geschluckt = false;
    }

    /// Den Zeigerfang nachfuehren, ohne den Strom anzufassen.
    ///
    /// **Windows loest `ClipCursor` beim Fokusverlust auf, und winit stellt es
    /// nicht wieder her.** Ohne diese Stelle glaubte die Erfassung nach
    /// Alt+Tab und zurueck weiter an einen gefangenen Zeiger: `CursorMoved`
    /// wuerde weiter ignoriert, relative Bewegungen kaemen von einem freien
    /// Zeiger, und die Bedienleiste waere nicht mehr zu treffen. Wer den Griff
    /// erneuert (oder ihn verliert), sagt es hier.
    pub fn zeigerfang_nachfuehren(&mut self, gefangen: bool) {
        let neu = self.aktiv && gefangen;
        if neu == self.zeigerfang {
            return;
        }
        self.zeigerfang = neu;
        // Betriebsartwechsel: die Reste gehoeren zur alten Art, und wo der
        // Zeiger jetzt steht, weiss vor dem naechsten `CursorMoved` niemand.
        self.rest_dx = 0.0;
        self.rest_dy = 0.0;
        self.letzte_zeigerlage = None;
    }

    /// Hoch-Ereignisse fuer alles Gedrueckte, in fester Reihenfolge.
    pub(super) fn alles_loslassen(&mut self) {
        for scan in std::mem::take(&mut self.tasten_unten) {
            self.einreihen(rahmen::taste(scan, false));
        }
        for nummer in std::mem::take(&mut self.knoepfe_unten) {
            if let Some(knopf) = knopf_aus_nummer(nummer) {
                self.einreihen(rahmen::maus_knopf(knopf, false));
            }
        }
    }

    /// Ein Wayland-Zug ist beendet (`Drop`/`Leave`, s.
    /// `wayland::zug`-Modulkopf „Die Nummer gilt nicht ueber einen Zug
    /// hinweg") — die Maustaste ist damit physisch los, auch wenn dafuer NIE
    /// ein `MouseInput`-Ereignis bei diesem Fenster ankommt: waehrend eines
    /// Zugs ist das Datengeraet die EINZIGE Quelle, winit liefert keins mehr
    /// (s. `app::wayland_zug` Modulkopf, „Stolperstein 2"). Jeder noch
    /// gehaltene Mausknopf geht deshalb hier als Hoch-Ereignis hinaus, an den
    /// zuletzt gueltigen `ziel_slot` — dieselbe Kodierung wie
    /// [`Self::alles_loslassen`], nur ohne dessen zweite Haelfte.
    ///
    /// **Tasten bleiben unberuehrt.** Anders als bei [`Self::alles_loslassen`]
    /// (Tastaturfokus-Verlust) wechselte hier nur der ZEIGERFOKUS — die
    /// Tastatur blieb beim Steuernden, und sie faelschlich mit loszulassen
    /// liesse eine wirklich noch gehaltene Taste am fernen Rechner haengen.
    ///
    /// **Nur auf Linux ausserhalb von Tests aufgerufen** (`app::wayland_zug`,
    /// dort hinter `#[cfg(target_os = "linux")]`) — derselbe Grund wie beim
    /// `cfg_attr` an [`Erfassung::wayland_ziel_setzen`].
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub fn zug_beendet(&mut self) {
        if !self.aktiv {
            return;
        }
        for nummer in std::mem::take(&mut self.knoepfe_unten) {
            if let Some(knopf) = knopf_aus_nummer(nummer) {
                self.einreihen(rahmen::maus_knopf(knopf, false));
            }
        }
    }

    /// Einen unverwerfbaren Frame einreihen — der einzige Weg dorthin.
    ///
    /// **Hier haengt die Notbremse** (s. `schlange::MAX_GESAMT`): eine reine
    /// Tasten- oder Knopfflut enthaelt nichts, was die Flutkontrolle kappen
    /// duerfte, und liesse die Warteschlange sonst unbegrenzt wachsen. Statt
    /// blind Frames zu opfern — es koennte das Hoch-Ereignis sein, dessen
    /// Verlust eine Taste am fremden Rechner klemmen laesst — wird der Strom
    /// neu begonnen: das Hello gibt beim Host alles frei, und der Player
    /// vergisst dabei seine eigene Menge des Gedrueckten.
    pub(super) fn einreihen(&mut self, rahmen: Rahmen) {
        self.notbremse_pruefen();
        self.warteschlange.einreihen(rahmen);
    }

    /// Eine Bewegung einreihen. Getrennt von [`Self::einreihen`], weil
    /// Bewegungen zusammengefasst und unter Last verworfen werden duerfen — die
    /// Notbremse greift trotzdem, denn geschuetzte Positionierungen (s.
    /// `Schlange::behaltmaske`) sind auch fuer die Flutkontrolle unantastbar.
    pub(super) fn bewegung_einreihen(&mut self, rahmen: Rahmen) {
        self.notbremse_pruefen();
        self.warteschlange.bewegung(rahmen);
    }

    /// Wie oft die Notbremse gezogen wurde (s. [`Self::einreihen`]).
    pub fn notbremsen(&self) -> u64 {
        self.notbremsen
    }

    /// Wie viele unverwerfbare Frames dabei gefallen sind.
    pub fn verworfene_frames(&self) -> u64 {
        self.warteschlange.verworfene_frames()
    }

    fn notbremse_pruefen(&mut self) {
        if !self.warteschlange.uebervoll() {
            return;
        }
        self.notbremsen += 1;
        eprintln!(
            "pulse-player: Eingabe-Warteschlange uebervoll — Strom neu begonnen \
             (die Abgabe steht; alles Gedrueckte gibt der Host beim Hello frei)"
        );
        self.strom_beginnen(false);
    }
}
