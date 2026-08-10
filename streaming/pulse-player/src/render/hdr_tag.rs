//! Die eigene Oberflaeche beim Compositor als **BT.2020 mit PQ** anmelden
//! (`wp_color_management_v1`).
//!
//! **Warum ueberhaupt, wenn der Treiber es doch selbst tut.** Er tut es nur fuer
//! `Rgba16Float`, und dann in der falschen Waehrung. Mitgeschnitten am
//! 2026-08-10 (`WAYLAND_DEBUG=1`, NVIDIA 610.57.04, KWin 6.7.3):
//!
//! ```text
//! -> wp_color_manager_v1#72.get_surface(...)
//! -> wp_color_manager_v1#72.create_parametric_creator(...)
//! ->   set_primaries_named(1)         # srgb / BT.709
//! ->   set_tf_named(5)                # ext_linear
//! ->   set_luminances(0, 80, 203)     # min 0, max 80, Bezugsweiss 203 cd/m²
//! -> wp_color_management_surface_v1#82.set_image_description(..., 0)
//! ```
//!
//! Das ist regelkonformes scRGB. Der Haken ist nicht der Treiber, sondern der
//! Farbraum: **scRGB ist relativ.** Er legt fest, dass 1,0 achtzig cd/m² sind,
//! sagt aber nicht, wo im Signal das Diffusweiss des Inhalts liegt — der
//! Compositor muss es annehmen (203 cd/m² nach BT.2408) und verankert daran
//! seine gesamte Helligkeit ("anchoring", so verlangt es die Protokoll-Doku zu
//! `set_luminances`). Unser Inhalt ist aber ein Bildschirm-Scanout: sein Weiss
//! liegt dort, wo der aufgenommene Schirm es hat — auf dieser Maschine
//! 295 cd/m² (`wayland-info`: DP-2 `reference 295`). Der Compositor hebt also
//! ein Bild, das schon richtig war, um 295/203 = 1,45 an. Sichtbar wird das als
//! ausgeblasener Kontrast, und es ist genau das, was den Anlass zu dieser Datei
//! gegeben hat.
//!
//! **PQ kennt das Problem nicht.** Jeder Codewert IST eine absolute
//! Leuchtdichte (SMPTE ST 2084), es gibt nichts zu verankern und nichts zu
//! raten. Der Strom liegt ohnehin schon so vor — er wird damit unveraendert
//! durchgereicht statt zweimal umgerechnet (`shader.wgsl::pq_ausgeben`).
//!
//! **Und es ist der herstellerneutrale Weg.** `wp_color_management_v1` ist seit
//! Februar 2025 Teil von `wayland-protocols`; KWin, Mutter (GNOME 48+),
//! wlroots (Sway/Wayfire/Labwc) und Hyprland setzen denselben Vertrag um.
//! Ungetaggte Oberflaechen behandelt die Spezifikation ausdruecklich als sRGB —
//! wer sich darauf verlaesst, dass ein Compositor ein fp16-Fenster schon
//! richtig erraten wird, bekommt auf dem naechsten Compositor ein anderes Bild.
//!
//! **Warum die Oberflaeche dafuer NICHT `Rgba16Float` sein darf.** Bei diesem
//! Format meldet der Treiber selbst an (s. Mitschnitt oben), und ein zweites
//! `get_surface` auf derselben `wl_surface` ist ein Protokollfehler
//! (`surface_exists`), der nicht nur diesen Weg, sondern die **ganze
//! Wayland-Verbindung** beendet — der Player stirbt dann wortlos. Der PQ-Weg
//! nutzt deshalb `Rgb10a2Unorm` (s. [`super::hdr_fenster::HDR_OBERFLAECHE`]);
//! dort haelt sich der Treiber heraus, und das Feld gehoert uns.
//!
//! **Eine zweite Warteschlange, keine zweite Verbindung.**
//! `Backend::from_foreign_display` haengt sich an dasselbe `wl_display`, das
//! winit haelt — eine echte zweite Verbindung saehe eine andere `wl_surface`
//! und koennte unsere eigene nicht anmelden. libwayland-client ist fuer dieses
//! Muster gebaut (Sperren je Warteschlange); derselbe Kunstgriff wie in
//! [`super::hdr_schirm`], nur auf der Fenster- statt der Bildschirmseite.

use std::sync::Arc;

use raw_window_handle::{HasDisplayHandle, HasWindowHandle, RawDisplayHandle, RawWindowHandle};
use wayland_client::backend::{Backend, ObjectId};
use wayland_client::protocol::{wl_registry, wl_surface::WlSurface};
use wayland_client::{Connection, Dispatch, Proxy, QueueHandle, WEnum};
use wayland_protocols::wp::color_management::v1::client::{
    wp_color_management_surface_v1 as cms, wp_color_manager_v1 as cm,
    wp_image_description_creator_params_v1 as params, wp_image_description_v1 as beschr,
};

/// Die Anmeldung — lebt, solange der Renderer lebt.
pub struct OberflaechenTaeger {
    conn: Connection,
    oberflaeche: cms::WpColorManagementSurfaceV1,
    /// Die fertige BT.2020/PQ-Beschreibung. **Einmal gebaut und aufgehoben**:
    /// sie ist unveraenderlich, und `set_image_description` hat Kopiersemantik
    /// — sie bei jedem Wechsel neu zu bauen waere ein Wayland-Umlauf fuer
    /// dasselbe Ergebnis.
    beschreibung: beschr::WpImageDescriptionV1,
    wl_surface: WlSurface,
}

/// Was der Aufbau mitfuehrt.
#[derive(Default)]
struct Zustand {
    manager: Option<cm::WpColorManagerV1>,
    intents: Vec<cm::RenderIntent>,
    features: Vec<cm::Feature>,
    tf: Vec<cm::TransferFunction>,
    primaries: Vec<cm::Primaries>,
    /// Hat der Compositor die Beschreibung fertiggestellt? Vorher darf sie
    /// nicht gesetzt werden (sonst Protokollfehler `image_description`).
    bereit: bool,
    /// Der Compositor hat die Beschreibung abgelehnt — dann bleibt es beim
    /// Herunterrechnen, statt eine unfertige zu setzen.
    gescheitert: bool,
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
        if let wl_registry::Event::Global { name, interface, version } = ev {
            if interface == "wp_color_manager_v1" {
                // Fassung 1 reicht: `get_surface`, `create_parametric_creator`
                // und die drei Setzer darauf gibt es seit der ersten Fassung.
                // Mehr zu verlangen hiesse, einen Compositor auszuschliessen,
                // der weniger kann, ohne dass wir vom Mehr etwas haetten.
                st.manager = Some(registry.bind(name, version.min(1), qh, ()));
            }
        }
    }
}

impl Dispatch<cm::WpColorManagerV1, ()> for Zustand {
    fn event(
        st: &mut Self,
        _: &cm::WpColorManagerV1,
        ev: cm::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match ev {
            cm::Event::SupportedIntent { render_intent: WEnum::Value(v) } => st.intents.push(v),
            cm::Event::SupportedFeature { feature: WEnum::Value(v) } => st.features.push(v),
            cm::Event::SupportedTfNamed { tf: WEnum::Value(v) } => st.tf.push(v),
            cm::Event::SupportedPrimariesNamed { primaries: WEnum::Value(v) } => {
                st.primaries.push(v)
            }
            _ => {}
        }
    }
}

impl Dispatch<cms::WpColorManagementSurfaceV1, ()> for Zustand {
    fn event(
        _: &mut Self,
        _: &cms::WpColorManagementSurfaceV1,
        _: cms::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        // Kennt ausser Protokollfehlern keine Ereignisse; die kaemen als
        // `Err` aus `roundtrip`/`flush`, nicht hier durch.
    }
}

impl Dispatch<params::WpImageDescriptionCreatorParamsV1, ()> for Zustand {
    fn event(
        _: &mut Self,
        _: &params::WpImageDescriptionCreatorParamsV1,
        _: params::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<beschr::WpImageDescriptionV1, ()> for Zustand {
    fn event(
        st: &mut Self,
        _: &beschr::WpImageDescriptionV1,
        ev: beschr::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match ev {
            // `Ready` in Fassung 1, `Ready2` ab Fassung 2 — dieselbe Bedeutung
            // (wie in `hdr_schirm`).
            beschr::Event::Ready { .. } | beschr::Event::Ready2 { .. } => st.bereit = true,
            // Der Compositor kann eine Beschreibung ablehnen (`cause`:
            // low_version, unsupported, operating_system, no_output). Das ist
            // kein Fehler, sondern eine Absage — sie muss nur ankommen, damit
            // niemand auf `ready` wartet, das nie kommt.
            beschr::Event::Failed { cause, msg } => {
                st.gescheitert = true;
                eprintln!("pulse-player: Compositor lehnt BT.2020/PQ ab ({cause:?}): {msg}");
            }
            _ => {}
        }
    }
}

impl OberflaechenTaeger {
    /// Versucht, die Anmeldung vorzubereiten. **`None` ist ein Ergebnis, kein
    /// Fehler** — kein Wayland, keine Farbverwaltung, oder der Compositor fuehrt
    /// BT.2020/PQ nicht. Der Aufrufer bleibt dann beim Herunterrechnen auf SDR,
    /// was schlechter aussieht, aber richtig ist.
    ///
    /// Die Beschreibung wird hier schon gebaut, nicht erst beim ersten
    /// HDR-Bild: das kostet zwei Wayland-Umlaeufe, und die gehoeren in den
    /// Fensteraufbau statt mitten in den Bildtakt.
    pub fn einrichten(window: &Arc<winit::window::Window>) -> Option<Self> {
        // Diagnose-Notausgang: ohne Anmeldung laeuft die Oberflaeche in dem
        // Zustand, den die Spezifikation fuer ungetaggte Flaechen vorsieht
        // (der Compositor behandelt sie als sRGB). Das ist der A/B-Gegenversuch
        // zu jeder Messung an dieser Datei — wirkt die Anmeldung ueberhaupt?
        if std::env::var_os("PULSE_PLAYER_KEIN_FARBTAG").is_some() {
            eprintln!("pulse-player: Farb-Anmeldung per PULSE_PLAYER_KEIN_FARBTAG abgeschaltet");
            return None;
        }
        let RawDisplayHandle::Wayland(disp) = window.display_handle().ok()?.as_raw() else {
            return None; // X11, Windows, macOS
        };
        let RawWindowHandle::Wayland(surf) = window.window_handle().ok()?.as_raw() else {
            return None;
        };

        // SAFETY: Beide Zeiger stammen ueber `raw-window-handle` von winit und
        // sind fuer die Lebensdauer des Fensters gueltig. Wir haengen uns nur
        // mit einer eigenen Warteschlange an dieselbe Verbindung; das Fenster
        // bleibt winits Eigentum, wir erzeugen und zerstoeren es nicht.
        let backend = unsafe { Backend::from_foreign_display(disp.display.as_ptr().cast()) };
        let conn = Connection::from_backend(backend);
        let mut queue = conn.new_event_queue::<Zustand>();
        let qh = queue.handle();

        conn.display().get_registry(&qh, ());
        let mut zustand = Zustand::default();
        // **Zwei Umlaeufe, nicht einer.** Der erste bringt die Registrierung
        // heim und stoesst den Bind an; dessen `supported_*`-Ereignisse kommen
        // erst danach. Mit nur einem Umlauf stand hier eine leere
        // Faehigkeitsliste, und ein Compositor, der alles Noetige bietet, wurde
        // als unfaehig abgewiesen (am 2026-08-10 genau so passiert, gegen
        // `wayland-info` gegengeprueft).
        queue.roundtrip(&mut zustand).ok()?;
        queue.roundtrip(&mut zustand).ok()?;
        let manager = zustand.manager.clone()?;

        // **Vorher fragen, nicht hinterher scheitern.** Jeder dieser Aufrufe
        // waere ein Protokollfehler, wenn der Compositor das Stueck nicht
        // fuehrt — und ein Protokollfehler beendet die ganze Verbindung, also
        // das Fenster. Die Liste ist genau das, was unten benutzt wird.
        let fehlt = |was: &str| {
            eprintln!(
                "pulse-player: Compositor fuehrt {was} nicht — die Oberflaeche bleibt \
                 ungetaggt, HDR wird auf SDR heruntergerechnet."
            );
            None::<Self>
        };
        if !zustand.features.contains(&cm::Feature::Parametric) {
            return fehlt("parametrische Farbbeschreibungen");
        }
        if !zustand.tf.contains(&cm::TransferFunction::St2084Pq) {
            return fehlt("die Uebertragungskurve ST 2084 (PQ)");
        }
        if !zustand.primaries.contains(&cm::Primaries::Bt2020) {
            return fehlt("die Primaervalenzen BT.2020");
        }
        if !zustand.intents.contains(&cm::RenderIntent::Perceptual) {
            return fehlt("die Wiedergabe-Absicht 'perceptual'");
        }

        // Bis wohin der Inhalt an Leuchtdichte reicht (cd/m²).
        //
        // **Noch eine Vorgabe, kein gelesener Wert — und das ist eine bekannte
        // Luecke.** Richtig waere die Spitze des laufenden Stroms
        // (`decode::Farbangaben::spitze_nits`, aus den Mastering-Metadaten des
        // AV1-Kopfes); die steht hier aber noch nicht zur Verfuegung, weil die
        // Anmeldung beim Fensteraufbau geschieht und der Strom da noch nicht
        // laeuft. `PULSE_PLAYER_HDR_SPITZE` haelt den Wert bis dahin messbar.
        let spitze: u32 = std::env::var("PULSE_PLAYER_HDR_SPITZE")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(1000);

        // Die `wl_surface` aus winit uebernehmen — nicht neu erzeugen: es ist
        // genau die, in die wgpu zeichnet.
        let object_id =
            unsafe { ObjectId::from_ptr(WlSurface::interface(), surf.surface.as_ptr().cast()) }
                .ok()?;
        let wl_surface = WlSurface::from_id(&conn, object_id).ok()?;

        let oberflaeche = manager.get_surface(&wl_surface, &qh, ());
        let creator = manager.create_parametric_creator(&qh, ());
        creator.set_primaries_named(cm::Primaries::Bt2020);
        creator.set_tf_named(cm::TransferFunction::St2084Pq);
        // **Was der Inhalt an Leuchtdichte wirklich fuehrt — gemessen, warum
        // das noetig ist (2026-08-10).** Ohne diese Angaben nimmt der
        // Compositor die Vorgabe der PQ-Kurve an, also Inhalt bis
        // 10 000 cd/m², und passt ihn an einen Schirm an, der 530 kann. Am
        // Prueffbild (acht Balken bekannter Leuchtdichte, durch die ganze Kette
        // an den Scanout gemessen) sah das so aus:
        //
        // ```text
        //   Soll     Ist   Faktor
        //      1     0,1    0,13x
        //     20     5,7    0,28x
        //    100    65,2    0,65x
        //    400   368,7    0,92x
        // ```
        //
        // Also: Helles bleibt stehen, Dunkles wird heruntergedrueckt — ein
        // ueberzeichneter Kontrast, bei dem die Mitten absaufen. Genau das ist
        // der Fehler, um dessentwillen diese Datei entstanden ist.
        // Das Bezugsweiss des Inhalts (cd/m²). **Der empfindlichste Wert von
        // allen**: der Compositor verankert daran seine ganze Helligkeit — er
        // bringt das Bezugsweiss des Inhalts auf das des Schirms. Steht hier
        // 203 (BT.2408) und der Schirm auf 295, hebt er alles um 1,45 an.
        // Fuer einen Bildschirm-Mitschnitt ist 203 die falsche Auskunft: der
        // Inhalt KOMMT von einem Schirm und traegt dessen Bezugsweiss bereits.
        let bezugsweiss: u32 = std::env::var("PULSE_PLAYER_HDR_BEZUGSWEISS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(203);
        let mit_meister = std::env::var_os("PULSE_PLAYER_HDR_OHNE_MEISTER").is_none();
        if zustand.features.contains(&cm::Feature::SetLuminances) {
            // Bei `st2084_pq` ist `max_lum` laut Protokoll-Doku ohnehin
            // festgelegt (min + 10 000) und wird ignoriert; entscheidend ist
            // das Bezugsweiss. 203 cd/m² ist der Wert aus ITU-R BT.2408,
            // derselbe, den der Shader beim Herunterrechnen als Diffusweiss
            // nimmt (`shader.wgsl::DIFFUSWEISS`) — beide Wege sagen damit
            // dasselbe ueber denselben Inhalt.
            creator.set_luminances(0, 10_000, bezugsweiss);
        }
        if mit_meister {
            if zustand.features.contains(&cm::Feature::SetMasteringDisplayPrimaries) {
                // Das Zielvolumen: bis wohin der Inhalt ueberhaupt reicht. Ohne
                // das rechnet der Compositor gegen 10 000 cd/m².
                creator.set_mastering_luminance(0, spitze);
            }
            creator.set_max_cll(spitze);
            creator.set_max_fall(spitze);
        }
        let beschreibung = creator.create(&qh, ());
        // Der zweite Umlauf bringt `ready` bzw. `failed`.
        queue.roundtrip(&mut zustand).ok()?;
        if zustand.gescheitert || !zustand.bereit {
            return None;
        }

        Some(Self { conn, oberflaeche, beschreibung, wl_surface })
    }

    /// Die Anmeldung wirksam machen. Rueckgabe: hat es geklappt?
    ///
    /// Mehrfach aufzurufen ist harmlos — es ist dieselbe Beschreibung, der
    /// Compositor sieht ein wiederholtes `set_image_description`. Das passt zu
    /// [`super::hdr_fenster::Renderer::konfigurieren`], das nach **jedem**
    /// `configure` durch diese Stelle geht.
    pub fn anwenden(&self) -> bool {
        self.oberflaeche
            .set_image_description(&self.beschreibung, cm::RenderIntent::Perceptual);
        // Bildbeschreibung und Absicht sind doppelt gepufferter
        // `wl_surface`-Zustand — ohne `commit` wuerden sie erst beim naechsten
        // Bild von winit wirksam, und wann das ist, soll hier niemand raten.
        self.wl_surface.commit();
        self.conn.flush().is_ok()
    }

    /// Die Anmeldung zuruecknehmen — beim Wechsel zurueck auf einen SDR-Strom.
    ///
    /// Ohne das truege die Oberflaeche weiter das PQ-Etikett, waehrend der
    /// Shader gewoehnliche sRGB-Bildpunkte hineinschreibt: dasselbe Bild wie
    /// vorher, nur in die andere Richtung falsch.
    pub fn zuruecknehmen(&self) {
        self.oberflaeche.unset_image_description();
        self.wl_surface.commit();
        let _ = self.conn.flush();
    }
}
