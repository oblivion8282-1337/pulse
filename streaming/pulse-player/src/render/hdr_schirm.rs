//! Die zweite HDR-Frage unter Wayland: **laeuft der Schirm gerade in HDR?**
//!
//! Sie ist von der ersten getrennt zu stellen, und das ist nicht Theorie,
//! sondern gemessen (2026-08-07, KWin 6.7.3, RTX 5080): die Vulkan-Formatliste
//! der Oberflaeche ist bei ein- und bei ausgeschaltetem HDR **dieselbe** — sie
//! sagt ueber den Bildschirmzustand nichts. Messakte
//! `streaming/testbench/profiles/player-2026-08-07-wayland-hdr.json`.
//!
//! **Woran HDR zu erkennen ist — und woran NICHT.** Die naheliegende Pruefung
//! waere die Uebertragungskurve des Ausgangs (`tf_named == st2084_pq`). Sie ist
//! falsch: KWin meldet in BEIDEN Zustaenden `gamma22`. Das Kennzeichen ist die
//! Leuchtdichte — der Ausgang nennt eine Hoechsthelligkeit und ein Bezugsweiss,
//! und HDR heisst, dass die Hoechsthelligkeit darueber liegt:
//!
//! | DP-2 | Primaervalenzen | min | max | Bezugsweiss | Verhaeltnis |
//! |---|---|---|---|---|---|
//! | HDR an | BT.2020 | 0 | 530 | 295 | **1,80** |
//! | HDR aus | sRGB | 0,01 | 200 | 200 | **1,00** |
//!
//! **Herstellerneutral, nicht KDE-spezifisch.** Gefragt wird ueber
//! `wp_color_manager_v1` (Wayland-Staging-Protokoll), nicht ueber
//! `kscreen-doctor`. Jeder Compositor mit Farbverwaltung beantwortet das;
//! einer ohne wird nicht gefragt, und dann bleibt es beim Herunterrechnen.
//!
//! **Auf einem eigenen Faden.** Die Antwort wird bei jedem Bild gebraucht, ihre
//! Beschaffung kostet aber einen Wayland-Umlauf. Deshalb haelt ein
//! Hintergrundfaden eine eigene Verbindung und schreibt nur mit, wenn der
//! Compositor eine Aenderung meldet (`image_description_changed`); der
//! Zeichenfaden liest einen Wert aus einer Tabelle.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use wayland_client::protocol::{wl_output, wl_registry};
use wayland_client::{Connection, Dispatch, QueueHandle};
use wayland_protocols::wp::color_management::v1::client::{
    wp_color_management_output_v1 as cmo, wp_color_manager_v1 as cm,
    wp_image_description_info_v1 as info, wp_image_description_v1 as beschr,
};

/// Ab welchem Verhaeltnis `max_lum / reference_lum` der Schirm als HDR gilt.
///
/// **Eine Schwelle mit genau zwei Messpunkten dahinter**, und sie steht deshalb
/// hier oben mit Namen: 1,00 (DP-2 mit HDR aus) und 1,80 (derselbe Schirm mit
/// HDR an). Alles dazwischen ist ungemessen — ein HDR-Geraet mit knappem
/// Spielraum koennte darunter fallen und wuerde dann heruntergerechnet.
///
/// **Die Schwelle ist bewusst hoeher als noetig gewaehlt.** Der SDR-Fall liegt
/// bei exakt 1,00; jede Zahl darueber wuerde ihn ausschliessen. 1,2 laesst
/// zusaetzlich Luft fuer Ausgaenge, die eine belanglose Restspanne melden. Die
/// beiden Irrtuemer sind naemlich nicht gleich teuer: ein falsches Nein kostet
/// die Genauigkeit des Herunterrechnens, ein falsches Ja kann Spitzlichter
/// kosten. Im Zweifel also gegen HDR.
const MINDEST_SPIELRAUM: f32 = 1.2;

/// Was ein Ausgang ueber seine Leuchtdichte sagt (cd/m²).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Leuchtdichte {
    pub max: f32,
    pub bezugsweiss: f32,
}

impl Leuchtdichte {
    /// Bietet dieser Ausgang nennenswerten Spielraum ueber Weiss?
    pub fn ist_hdr(&self) -> bool {
        self.bezugsweiss > 0.0 && self.max / self.bezugsweiss >= MINDEST_SPIELRAUM
    }
}

/// Die Tabelle, die Zeichen- und Wayland-Faden teilen: Ausgangsname -> Angabe.
type Tafel = Arc<Mutex<HashMap<String, Leuchtdichte>>>;

/// Der laufende Beobachter — die Lese-Seite der geteilten Tafel.
///
/// **Sein Faden haengt an der Wayland-Verbindung, nicht an dieser Struktur.**
/// Hier stand bis zum 2026-08-07 „solange er lebt, laeuft sein Faden"; das ist
/// zu wenig gesagt: die Verbindung ist mit in den Faden gewandert, ein
/// Loslassen der `Schirmwacht` beendet ihn also NICHT, er laeuft bis zum
/// Programmende. Folgenlos, weil er die ganze Zeit in `blocking_dispatch`
/// schlaeft und nur die Tafel festhaelt — aber wer ihn abschalten will, muss
/// mehr tun als hier loszulassen.
pub struct Schirmwacht {
    tafel: Tafel,
}

impl Schirmwacht {
    /// Startet den Beobachter — oder `None`, wenn es hier nichts zu beobachten
    /// gibt (kein Wayland, oder ein Compositor ohne `wp_color_manager_v1`).
    ///
    /// **`None` ist ein Ergebnis, kein Fehler.** Auf X11 gibt es kein HDR, und
    /// ein Compositor ohne Farbverwaltung kann die Frage nicht beantworten. In
    /// beiden Faellen bleibt der Player beim Herunterrechnen.
    pub fn starten() -> Option<Self> {
        let conn = Connection::connect_to_env().ok()?;
        let tafel: Tafel = Default::default();
        // Erst einmal pruefen, ob es den Farbverwalter ueberhaupt gibt —
        // sonst laeuft ein Faden, der nie etwas zu tun bekommt.
        let mut queue = conn.new_event_queue();
        let qh = queue.handle();
        conn.display().get_registry(&qh, ());
        let mut zustand = Zustand { tafel: tafel.clone(), manager: None, ausgaenge: HashMap::new() };
        queue.roundtrip(&mut zustand).ok()?;
        let mgr = zustand.manager.clone()?;

        // **Die Beschreibungen erst JETZT anfordern, nicht schon im
        // Registrierungs-Ereignis.** Die Reihenfolge, in der ein Compositor
        // seine Angebote nennt, ist beliebig: kommen die `wl_output` VOR dem
        // Farbverwalter, gaebe es beim Binden noch niemanden, den man fragen
        // koennte, und die Ausgaenge blieben stumm. Auf dieser Maschine kommt
        // der Verwalter zufaellig zuerst — darauf darf sich nichts stuetzen.
        for (id, ausgang) in zustand.bekannte_ausgaenge() {
            mgr.get_output(&ausgang, &qh, id).get_image_description(&qh, id);
        }
        // Zwei Umlaeufe: einer traegt die Anfragen hin, der zweite bringt
        // `ready` und die Auskunft zurueck.
        let _ = queue.roundtrip(&mut zustand);
        let _ = queue.roundtrip(&mut zustand);

        std::thread::Builder::new()
            .name("pulse-hdr-schirm".into())
            .spawn(move || {
                // `conn` wandert mit in den Faden. Die Ereigniswarteschlange
                // haelt die Verbindung zwar selbst am Leben; sie hier
                // fallenzulassen waere trotzdem eine Verabredung mit fremdem
                // Innenleben, auf die niemand angewiesen sein muss.
                let _verbindung = conn;
                // `blocking_dispatch` wartet bis zum naechsten Ereignis — der
                // Faden kostet nichts, solange sich am Bildschirm nichts
                // aendert.
                while queue.blocking_dispatch(&mut zustand).is_ok() {}
            })
            .ok()?;
        Some(Self { tafel })
    }

    /// Die Angabe zu einem Ausgang (`"DP-2"`), oder `None`, wenn er unbekannt
    /// ist.
    pub fn angabe(&self, ausgang: &str) -> Option<Leuchtdichte> {
        self.tafel.lock().ok()?.get(ausgang).copied()
    }

    /// Alles, was gerade bekannt ist — fuer die Auskunft und die Messakte.
    pub fn alles(&self) -> Vec<(String, Leuchtdichte)> {
        let Ok(t) = self.tafel.lock() else { return Vec::new() };
        let mut v: Vec<_> = t.iter().map(|(k, l)| (k.clone(), *l)).collect();
        v.sort_by(|a, b| a.0.cmp(&b.0));
        v
    }
}

/// Was ueber einen Ausgang bekannt ist, solange er noch nicht vollstaendig ist.
struct Ausgangsstand {
    proxy: wl_output::WlOutput,
    /// Kommt erst mit dem `name`-Ereignis („DP-2"). Ohne ihn laesst sich der
    /// Ausgang nicht mit dem Fenster verbinden, also auch nicht eintragen.
    name: Option<String>,
    wert: Leuchtdichte,
}

/// Was der Wayland-Faden mitfuehrt.
struct Zustand {
    tafel: Tafel,
    manager: Option<cm::WpColorManagerV1>,
    /// Registrierungsnummer -> Stand.
    ausgaenge: HashMap<u32, Ausgangsstand>,
}

impl Zustand {
    /// Die schon gebundenen Ausgaenge — fuer die Nachhol-Anfrage in
    /// [`Schirmwacht::starten`].
    fn bekannte_ausgaenge(&self) -> Vec<(u32, wl_output::WlOutput)> {
        self.ausgaenge.iter().map(|(id, a)| (*id, a.proxy.clone())).collect()
    }

    /// Den fertig gelesenen Stand eines Ausgangs in die geteilte Tafel legen.
    fn eintragen(&mut self, id: u32) {
        let Some(stand) = self.ausgaenge.get(&id) else { return };
        // Ohne Namen laesst sich der Ausgang mit nichts verbinden — dann steht
        // der Wert eben noch nicht in der Tafel; das `name`-Ereignis holt ihn
        // gleich darauf nach.
        let Some(name) = stand.name.clone() else { return };
        let wert = stand.wert;
        if let Ok(mut t) = self.tafel.lock() {
            t.insert(name, wert);
        }
    }
}

impl Dispatch<wl_registry::WlRegistry, ()> for Zustand {
    fn event(
        st: &mut Self,
        registry: &wl_registry::WlRegistry,
        ev: wl_registry::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        match ev {
            wl_registry::Event::Global { name, interface, version } if interface == "wl_output" => {
                // Fassung 4 bringt das `name`-Ereignis („DP-2") — ohne das
                // laesst sich der Ausgang nicht mit dem Fenster verbinden.
                let o = registry.bind::<wl_output::WlOutput, _, _>(name, version.min(4), qh, name);
                // Kommt der Verwalter erst spaeter, holt [`Schirmwacht::starten`]
                // die Anfrage nach; erscheint ein Ausgang im Betrieb neu, wird
                // sie hier gestellt.
                if let Some(mgr) = st.manager.clone() {
                    mgr.get_output(&o, qh, name).get_image_description(qh, name);
                }
                let stand =
                    Ausgangsstand { proxy: o, name: None, wert: Leuchtdichte::default() };
                st.ausgaenge.insert(name, stand);
            }
            wl_registry::Event::Global { name, interface, .. }
                if interface == "wp_color_manager_v1" =>
            {
                // **Fassung 1 und nicht mehr.** Gebraucht werden nur
                // `get_output` und `get_image_description`, beide seit der
                // ersten Fassung da. Eine hoehere anzufordern hiesse, einen
                // Compositor auszuschliessen, der weniger kann, ohne dass wir
                // von dem Mehr etwas haetten.
                st.manager = Some(registry.bind(name, 1, qh, ()));
            }
            wl_registry::Event::GlobalRemove { name } => {
                if let Some(Ausgangsstand { name: Some(alt), .. }) = st.ausgaenge.remove(&name)
                {
                    if let Ok(mut t) = st.tafel.lock() {
                        t.remove(&alt);
                    }
                }
            }
            _ => {}
        }
    }
}

impl Dispatch<wl_output::WlOutput, u32> for Zustand {
    fn event(
        st: &mut Self,
        _: &wl_output::WlOutput,
        ev: wl_output::Event,
        id: &u32,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_output::Event::Name { name } = ev {
            if let Some(stand) = st.ausgaenge.get_mut(id) {
                stand.name = Some(name);
            }
            st.eintragen(*id);
        }
    }
}

impl Dispatch<cm::WpColorManagerV1, ()> for Zustand {
    fn event(_: &mut Self, _: &cm::WpColorManagerV1, _: cm::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {}
}

impl Dispatch<cmo::WpColorManagementOutputV1, u32> for Zustand {
    fn event(
        _: &mut Self,
        ausgang: &cmo::WpColorManagementOutputV1,
        ev: cmo::Event,
        id: &u32,
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        // Der Bildschirm hat auf HDR umgeschaltet (oder zurueck) — neu lesen.
        // **Das ist der Grund fuer den ganzen Faden**: ohne dieses Ereignis
        // muesste der Zeichenfaden regelmaessig nachfragen.
        if let cmo::Event::ImageDescriptionChanged = ev {
            ausgang.get_image_description(qh, *id);
        }
    }
}

impl Dispatch<beschr::WpImageDescriptionV1, u32> for Zustand {
    fn event(
        _: &mut Self,
        b: &beschr::WpImageDescriptionV1,
        ev: beschr::Event,
        id: &u32,
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        // `Ready` in Fassung 1, `Ready2` ab Fassung 2 — beide bedeuten
        // dasselbe. Wir binden Fassung 1, aber ein Compositor darf das
        // Nachfolgeereignis schicken, wenn er das Objekt hoeher fuehrt.
        if matches!(ev, beschr::Event::Ready { .. } | beschr::Event::Ready2 { .. }) {
            b.get_information(qh, *id);
        }
    }
}

impl Dispatch<info::WpImageDescriptionInfoV1, u32> for Zustand {
    fn event(
        st: &mut Self,
        _: &info::WpImageDescriptionInfoV1,
        ev: info::Event,
        id: &u32,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match ev {
            info::Event::Luminances { max_lum, reference_lum, .. } => {
                if let Some(stand) = st.ausgaenge.get_mut(id) {
                    stand.wert =
                        Leuchtdichte { max: max_lum as f32, bezugsweiss: reference_lum as f32 };
                }
            }
            // Erst wenn der Compositor fertig ist, steht der Satz zusammen.
            info::Event::Done => st.eintragen(*id),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **Die beiden gemessenen Faelle, als Zahlen festgehalten.** Sie sind der
    /// einzige Beleg dafuer, dass die Unterscheidung ueberhaupt traegt; ohne
    /// sie waere [`MINDEST_SPIELRAUM`] eine geratene Zahl ohne Gegenprobe.
    #[test]
    fn die_gemessenen_zustaende_werden_richtig_getrennt() {
        // DP-2 mit HDR an (2026-08-07): 530 gegen 295 cd/m².
        assert!(Leuchtdichte { max: 530.0, bezugsweiss: 295.0 }.ist_hdr());
        // Derselbe Schirm mit HDR aus: 200 gegen 200.
        assert!(!Leuchtdichte { max: 200.0, bezugsweiss: 200.0 }.ist_hdr());
    }

    /// Ein Ausgang, der gar nichts gesagt hat, darf nicht als HDR gelten —
    /// sonst entschiede eine fehlende Antwort fuer den teureren Irrtum.
    #[test]
    fn ohne_angabe_kein_hdr() {
        assert!(!Leuchtdichte::default().ist_hdr());
        assert!(!Leuchtdichte { max: 530.0, bezugsweiss: 0.0 }.ist_hdr());
    }

    /// Knapper Spielraum faellt bewusst auf die SDR-Seite.
    #[test]
    fn knapper_spielraum_zaehlt_nicht_als_hdr() {
        assert!(!Leuchtdichte { max: 210.0, bezugsweiss: 200.0 }.ist_hdr());
    }
}
