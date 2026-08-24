//! Fenster- und Sitzungsverwaltung: nimmt Requests von stdin entgegen, haelt
//! je Sitzung ein Fenster samt Renderer und meldet Zustand und Statistik
//! ueber stdout zurueck.
//!
//! Alles hier laeuft auf dem Hauptthread — winit verlangt das. Netzwerk und
//! Decode leben im Tokio-Kontext und reichen ihre Ergebnisse ueber
//! [`UserEvent`] herein.
//!
//! Was die einzelnen RPC-Operationen bedeuten, steht in [`requests`].

// **`pub(crate)`, nicht `pub`:** `overlay::fernbedienung` muss die Wayland-
// Auskunft (`anordnen::fenster_setzen_moeglich`) erreichen, um den Knopf zu
// gaten — das ist die einzige Stelle ausserhalb von `app`, die etwas von hier
// braucht. Weiter als bis zum eigenen Crate muss niemand.
pub(crate) mod anordnen;
pub mod diagnose;
mod eingabe;
mod requests;
mod takt;
mod wayland_zug;
mod zeigerbau;
mod zeigerform;
mod zeigersicht;

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Result;
use tokio::sync::mpsc;
use winit::application::ApplicationHandler;
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, EventLoopProxy};
use winit::window::{Window, WindowId};

use crate::decode::{self};
use crate::overlay::{Overlay, OverlayAction, Schirm, StatsView};
use crate::proto::{Event, PlayerOptions, Request, SessionState};
use crate::render;
use crate::rpc::StdoutWriter;
use crate::session::{self, SessionCommand, SessionEvent, SessionStats};
use takt::Ausgabetakt;

pub use takt::VORHALT_MAX_MS;

/// Wie frisch das letzte Bild sein muss, damit Eingaben KEINEN eigenen
/// Durchgang anfordern.
///
/// Fliessen Bilder, wird das Overlay mit dem naechsten ohnehin neu gezeichnet —
/// bei 144 fps also spaetestens nach 7 ms, beim Schieben eines Reglers
/// unmerklich. Ohne diese Bremse fordert jede Mausbewegung ihren eigenen
/// Durchgang an: gemessen bis zu 900 je Sekunde (Abtastrate der Maus), also ein
/// Vielfaches der Bildwiederholrate fuer nichts.
///
/// 50 ms heisst: ab etwa 20 Bildern je Sekunde uebernimmt der Bildfluss. Kommen
/// weniger (Standbild, Verbindungsabbruch), muessen Eingaben weiter selbst
/// zeichnen — sonst reagierte die Bedienung im Standbild nicht mehr.
const FRAME_FLOW_WINDOW: std::time::Duration = std::time::Duration::from_millis(50);

/// Wie lange die beiden Abschnitte eines Durchgangs brauchen, gemittelt ueber
/// jeweils eine Sekunde. Mikrosekunden, weil bei 144 fps das ganze Budget nur
/// 6900 davon betraegt.
#[derive(Default)]
struct PhaseTimes {
    upload_sum: u64,
    render_sum: u64,
    count: u64,
    since: Option<std::time::Instant>,
    /// Letztes vollstaendiges Fenster — das wird angezeigt.
    upload_avg_us: u64,
    render_avg_us: u64,
    /// Wann zuletzt ausgegeben wurde — Grundlage der ABSTAENDE.
    last_present: Option<std::time::Instant>,
    gap_min_us: u64,
    gap_max_us: u64,
    /// Abstaende von mehr als dem Doppelten des Sollwerts. Genau das sieht man
    /// als Ruckeln: die Summe je Sekunde kann stimmen, waehrend einzelne Bilder
    /// doppelt so lange stehen und andere sich draengeln.
    gap_late: u64,
    /// Fertige Werte des letzten Fensters.
    gap_min_us_last: u64,
    gap_max_us_last: u64,
    gap_late_last: u64,
    /// Alter des Bildes beim Ausgeben, gerechnet ab Ankunft des Pakets, das
    /// seine Zugriffseinheit abschloss. Das ist der Teil der Ende-zu-Ende-Kette,
    /// der in diesem Programm liegt: Jitter-Wartezeit + Zusammensetzen +
    /// Dekodieren + Hochladen + Ausgeben.
    age_sum_us: u64,
    age_count: u64,
    age_max_us: u64,
    age_avg_us: u64,
    age_max_us_last: u64,
}

impl PhaseTimes {
    /// Alter eines gerade ausgegebenen Bildes vermerken. Bilder ohne
    /// Ankunftszeit (Tests) zaehlen nicht mit, statt die Messung mit Nullen zu
    /// verwaessern.
    fn note_age(&mut self, arrived: Option<std::time::Instant>) {
        let Some(a) = arrived else { return };
        let us = a.elapsed().as_micros() as u64;
        self.age_sum_us += us;
        self.age_count += 1;
        self.age_max_us = self.age_max_us.max(us);
    }

    /// `expected_gap` = Soll-Abstand aus der gemessenen Bildrate der Quelle.
    fn note(
        &mut self,
        upload: std::time::Duration,
        render: std::time::Duration,
        expected_gap: Option<std::time::Duration>,
    ) {
        let now = std::time::Instant::now();
        if let Some(prev) = self.last_present {
            let gap = now.duration_since(prev).as_micros() as u64;
            self.gap_min_us = if self.gap_min_us == 0 { gap } else { self.gap_min_us.min(gap) };
            self.gap_max_us = self.gap_max_us.max(gap);
            if expected_gap.is_some_and(|e| gap > (e.as_micros() as u64).saturating_mul(2)) {
                self.gap_late += 1;
            }
        }
        self.last_present = Some(now);
        let since = self.since.get_or_insert(now);
        self.upload_sum += upload.as_micros() as u64;
        self.render_sum += render.as_micros() as u64;
        self.count += 1;
        if since.elapsed() >= std::time::Duration::from_secs(1) && self.count > 0 {
            self.upload_avg_us = self.upload_sum / self.count;
            self.render_avg_us = self.render_sum / self.count;
            self.gap_min_us_last = self.gap_min_us;
            self.gap_max_us_last = self.gap_max_us;
            self.gap_late_last = self.gap_late;
            if self.age_count > 0 {
                self.age_avg_us = self.age_sum_us / self.age_count;
                self.age_max_us_last = self.age_max_us;
            }
            self.age_sum_us = 0;
            self.age_count = 0;
            self.age_max_us = 0;
            self.upload_sum = 0;
            self.render_sum = 0;
            self.count = 0;
            self.gap_min_us = 0;
            self.gap_max_us = 0;
            self.gap_late = 0;
            self.since = Some(now);
        }
    }
}

/// Fassungsvermoegen des Kanals vom Decoder- zum Fenster-Faden.
///
/// Als Funktion und nicht als Ausdruck an der Anlagestelle, weil die
/// Sitzungs-Zusammenfassung denselben Wert nennen muss — ein zweiter Ausdruck
/// koennte auseinanderlaufen, und dann meldete das Log etwas anderes, als
/// laeuft. Begruendung fuer die Groesse steht an der Anlagestelle.
fn ev_kanal_groesse() -> usize {
    std::env::var("PULSE_PLAYER_EV_KANAL")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|n| (2..=256).contains(n))
        .unwrap_or(32)
}

/// Taugt die Skalierung dieses Fensters fuer die Rechnung mit dem eigenen?
///
/// **Nur auf macOS eine echte Frage.** Dort gibt winit Fensterlage und
/// Zeigerlage je in der Skalierung DES JEWEILIGEN Fensters heraus
/// (`macos/window_delegate.rs::inner_position`, `macos/view.rs`s
/// `CursorMoved`) — die Differenz zweier Fenster kuerzt sich deshalb nur, wenn
/// beide gleich skaliert sind. Ein MacBook mit externem Monitor ist genau der
/// Fall, in dem sie es nicht sind.
///
/// **Auf Windows und X11 waere derselbe Riegel ein Eigentor.** Dort sind beide
/// Angaben physische Bildpunkte EINES globalen Raums (winit macht den Prozess
/// per `become_dpi_aware()` DPI-bewusst, `windows/event_loop.rs:199`), und
/// `scale_factor()` darf je Monitor verschieden sein, ohne dass die Rechnung
/// daran etwas merkt — Laptop auf 150 % neben einem externen Schirm auf 100 %
/// ist dort ueblich. Ein Riegel darauf schaltete das Ziehen ueber die
/// Fenstergrenze auf genau diesen Rechnern lautlos ab.
#[cfg(target_os = "macos")]
fn skalierung_taugt(fenster: &Window, eigene: Option<f64>) -> bool {
    // Mit Toleranz, es sind f64.
    eigene.is_some_and(|e| (fenster.scale_factor() - e).abs() < 1e-6)
}

#[cfg(not(target_os = "macos"))]
fn skalierung_taugt(_fenster: &Window, _eigene: Option<f64>) -> bool {
    true
}

/// Ereignisse, die von aussen in die Fenster-Schleife getragen werden.
pub enum UserEvent {
    Request(Box<Request>),
    Session { id: u64, event: SessionEvent, gesendet: std::time::Instant },
    StdinClosed,
}

struct Session {
    window: Arc<Window>,
    renderer: Option<render::Renderer>,
    /// Bedienoberflaeche IM Fenster. `None`, wenn sie sich nicht aufbauen liess
    /// — dann laeuft das Bild ohne Bedienung weiter, statt die Sitzung zu
    /// verlieren (Fernsteuerung per RPC funktioniert ohnehin).
    overlay: Option<Overlay>,
    commands: mpsc::Sender<SessionCommand>,
    options: PlayerOptions,
    stats: SessionStats,
    decoder: String,
    hardware: bool,
    full_range: bool,
    /// Was der laufende Strom ueber seine Farben sagt — YUV-Matrix,
    /// Transferkurve, Farbraum und Spitzenhelligkeit.
    ///
    /// **Zusammen statt einzeln**, weil der Renderer sie nur zusammen auswerten
    /// kann: eine PQ-Kurve mit der BT.709-Matrix gelesen ergibt ein Bild, das
    /// plausibel aussieht und falsch ist. Frueher stand hier nur die Matrix,
    /// und jede weitere Angabe waere ein zweites Feld gewesen, das an einer der
    /// Zuweisungsstellen vergessen werden kann.
    farbe: decode::Farbangaben,
    /// Zuletzt dekodiertes Bild — wird bei Pause weiter gezeigt.
    pending: Option<Box<decode::DecodedFrame>>,
    /// Ausgabe-Takt (s. [`takt`]). **Laeuft in der Vorgabe MIT Vorhalt**
    /// (`proto::AUSGABETAKT_MS_VORGABE`, seit 2026-08-07 30 ms, davor 60);
    /// hier stand bis zum 2026-08-06 „bei ausgeschaltetem Vorhalt — der
    /// Vorgabe —", und das war schon damals falsch. Nur ausdruecklich
    /// abgeschaltet reicht er jedes Bild unveraendert durch.
    takt: Ausgabetakt,
    /// Ende-zu-Ende-Sonde, nur mit `PULSE_PLAYER_LATENCY_PROBE=1` vorhanden
    /// (s. `crate::probe`). Ohne die Umgebungsvariable ist das `None` und
    /// kostet nichts.
    probe: Option<crate::probe::LatencyProbe>,
    /// Wie viele Bilder hier ueberschrieben wurden, bevor sie gezeichnet
    /// werden konnten. Das ist der EINZIGE Ort, an dem ein Bild lautlos
    /// verschwinden kann, und er war bis 2026-07-26 ungezaehlt — bei 144 fps
    /// genau die Zahl, die fehlt, wenn Decode und Anzeige auseinanderlaufen.
    frames_never_drawn: u64,
    /// Zeitmessung der beiden Abschnitte auf dem Fenster-Thread (s.
    /// [`PhaseTimes`]). Ohne sie waere bei zu wenigen gezeichneten Bildern nicht
    /// entscheidbar, ob das Hochladen oder das Warten auf die Ausgabe bremst —
    /// und die beiden verlangen voellig verschiedene Gegenmassnahmen.
    phases: PhaseTimes,
    /// Wann das letzte Bild eintraf. Entscheidet, ob Eingaben einen eigenen
    /// Durchgang brauchen (s. [`FRAME_FLOW_WINDOW`]).
    last_frame_at: Option<std::time::Instant>,
    /// Bezugspunkt der Statistik-Zeile (s. `App::stats_log`).
    last_log: Option<std::time::Instant>,
    presented_at_last_log: u64,
    /// Stand der Verlust-Zaehler beim letzten Melden — s. [`App::bilanz_pruefen`].
    /// Wurde die Bilanz-Warnung schon abgesetzt? (s. [`App::bilanz_pruefen`])
    bilanz_gemeldet: bool,
    state: SessionState,
    /// Zweiter Abnehmer der Fensterereignisse: kodiert Maus und Tastatur fuer
    /// die Fernsteuerung (s. [`crate::fernsteuerung`]). **Standard aus** — ohne
    /// `input_capture` kostet sie nur ein `if` je Ereignis.
    eingabe: crate::fernsteuerung::Erfassung,
    /// Ob die Sitzung den Zeigerfang WILL — getrennt davon, ob er gerade
    /// besteht. Windows gibt den Griff beim Fokusverlust zurueck; ohne den
    /// gemerkten Wunsch waere beim Zurueckkommen nicht zu wissen, ob er
    /// erneuert werden muss (s. `App::fokus_gewechselt`).
    fang_gewuenscht: bool,
    /// Ob der lokale Zeiger im Fenster zu sehen ist — und aus welchen Gruenden
    /// nicht (Zeigerfang, Rueckfall „Zeiger im Bild"). Beide rechnen zusammen,
    /// weil sie gleichzeitig gelten koennen (s. [`zeigersicht`]).
    zeigersicht: zeigersicht::Zeigersicht,
    /// Anzeigetext des Eingabewegs waehrend einer Fernsteuerung
    /// („Direktverbindung", „Serverweg — …"); leer = nichts gemeldet. Kommt
    /// per `remote_transport`-RPC aus dem Renderer (s. `eingabe.rs`).
    fern_transport: String,
    /// Wieviele Eingabe-Frames diese Sitzung nach vorne gemeldet hat — das
    /// Statistik-Feld rechnet daraus die Rate (sichtbar, OB etwas fliesst).
    eingabe_frames: u64,
    /// Kopie von `req.can_reattach` (s. `proto.rs`) — steht bisher nur im
    /// Overlay (fuer den Reattach-Knopf), aber der Fenster-Schliessen-Handler
    /// braucht sie ebenso und hat kein `overlay` (kann `None` sein, wenn die
    /// Bedienoberflaeche nicht aufgebaut werden konnte). Deshalb hier zusaetzlich
    /// direkt an der Sitzung, statt sie ueber das Overlay umzuleiten.
    can_reattach: bool,
    /// Kopie von `remote_screens` (s. `overlay::Overlay::set_fern_schirme`) —
    /// aus demselben Grund zusaetzlich hier wie `can_reattach`, NICHT weil ein
    /// Getter auf `Overlay` unmoeglich waere (privaten Feldern eines Typs
    /// koennen Kindmodule lesen, ein `impl Overlay` liesse sich also auch in
    /// `overlay::schirmkarte` schreiben, ohne `overlay/mod.rs` anzufassen).
    /// Der Grund ist `overlay: Option<Overlay>`: schlaegt der Aufbau der
    /// Bedienoberflaeche fehl, laeuft das Fenster ohne sie weiter (Bild und
    /// Fernsteuerung funktionieren trotzdem), ein Getter auf `Overlay` haette
    /// dann aber nichts, worauf er zeigen koennte. Die Fokus-Suche
    /// (`OverlayAction::RemoteScreenFocus`) muss ueber ALLE Sitzungen gehen,
    /// auch die ohne Overlay — deshalb die eigene Kopie, aktualisiert IMMER,
    /// nicht nur wenn `session.overlay.is_some()`.
    fern_schirme: Vec<Schirm>,
    /// Die zuletzt losgeschickte Options-Task (s. `requests::apply_options`).
    /// Haelt die REIHENFOLGE der Patches auf dem Weg in die Sitzung: jede neue
    /// wartet auf diese hier, bevor sie sendet.
    optionskette: Option<tokio::task::JoinHandle<()>>,
    /// Ob die Tastenkuerzel des Fenstermanagers fuer DIESES Fenster gerade
    /// stillstehen (s. [`crate::tastensperre`]). Ausserhalb von Linux/Wayland
    /// ein leerer Wert ohne Kosten.
    tastensperre: crate::tastensperre::Tastensperre,
}

pub struct App {
    /// Schreibt einmal je Sekunde eine Statistik-Zeile auf stderr, wenn
    /// `PULSE_PLAYER_STATS_LOG` gesetzt ist.
    ///
    /// Hinter einem Schalter, nicht dauerhaft an: eine Zeile je Sekunde und
    /// Sitzung sind in einem ausgelieferten Build 3600 Zeilen je Stunde in
    /// Pulses Log. Fuer die Fehlersuche ist genau das aber das Werkzeug — die
    /// Zahlen liegen sonst nur im Overlay, und wer beim Zuschauen die Maus
    /// bewegt, veraendert die Messung (das Zeichnen des Overlays kostet selbst).
    stats_log: bool,
    sessions: HashMap<u64, Session>,
    by_window: HashMap<WindowId, u64>,
    next_id: u64,
    proxy: EventLoopProxy<UserEvent>,
    runtime: tokio::runtime::Handle,
    stdout: StdoutWriter,
    /// Die Zeigerbilder der Fernsteuerung, einmal gebaut und behalten
    /// (s. [`zeigerbau`]). Bei der App und nicht bei der Sitzung, weil ein
    /// gebauter Zeiger am Ereignisschleifen-Zeiger haengt und derselbe ferne
    /// Rechner ueber mehrere Fenster gesteuert werden kann.
    zeigervorrat: zeigerbau::Vorrat,
    /// Die Verbindung, ueber die waehrend einer Fernsteuerung die Tastenkuerzel
    /// des Fenstermanagers stillgelegt werden (s. [`crate::tastensperre`]).
    ///
    /// **Steht NACH `sessions`**, und das ist keine Kosmetik: die Sperren der
    /// Fenster haengen an dieser Verbindung, und Felder fallen in der
    /// Reihenfolge ihrer Deklaration. Andersherum faenden die Sperren beim
    /// Abbau eine Verbindung vor, die es nicht mehr gibt.
    tastensperre: crate::tastensperre::Gemeinsam,
    /// Welches Fenster zuletzt den Tastaturfokus bekam.
    ///
    /// Stellvertreter fuer „liegt oben": winit gibt die Stapelreihenfolge nicht
    /// heraus, aber ein Fenster wird durch Anklicken zugleich fokussiert und
    /// nach vorne geholt. Entscheidet bei ueberlappenden Player-Fenstern, wer
    /// einen Punkt bekommt (s. `fernsteuerung::nachbarn::vorrang`).
    zuletzt_fokussiert: Option<u64>,
    /// Wayland: der Zug ueber die Fenstergrenze ueber das Datengeraet (s.
    /// [`wayland_zug`]). Liegt an der App wie `tastensperre`, aus demselben
    /// Grund: dieselbe Verbindung bedient alle Fenster.
    ///
    /// Auf Nicht-Linux ist [`wayland_zug::WaylandZug`] ein leerer Typ und
    /// wird auch nirgends gelesen (die dortigen Methoden sind dort reine
    /// No-ops, s. Modulkopf) — ohne den `cfg_attr` meldete ein Windows-/
    /// macOS-Bau dieses Feld faelschlich als toten Code.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    wayland_zug: wayland_zug::WaylandZug,
}

/// Wie lange nach dem letzten Bild des Hauptstroms das Auffangnetz noch
/// unterdrückt bleibt.
///
/// Grosszuegiger als ein Bildabstand: Bei 60 fps kaeme sonst schon eine
/// einzelne verspaetete Ankunft als Umschaltung durch, und das Bild spraenge
/// zwischen scharf und grob hin und her. 400 ms sind kurz genug, dass ein
/// echter Aussetzer sofort aufgefangen wird, und lang genug, dass normales
/// Zappeln nichts ausloest.
const FALLBACK_GRACE: std::time::Duration = std::time::Duration::from_millis(400);

impl App {
    pub fn new(proxy: EventLoopProxy<UserEvent>, runtime: tokio::runtime::Handle) -> Self {
        Self {
            stats_log: std::env::var_os("PULSE_PLAYER_STATS_LOG").is_some(),
            sessions: HashMap::new(),
            by_window: HashMap::new(),
            next_id: 1,
            proxy,
            runtime,
            stdout: StdoutWriter::new(),
            zeigervorrat: zeigerbau::Vorrat::default(),
            tastensperre: crate::tastensperre::Gemeinsam::default(),
            zuletzt_fokussiert: None,
            wayland_zug: wayland_zug::WaylandZug::default(),
        }
    }

    /// Hauptstrom und Auffangnetz nebeneinander laufen lassen, in EIN Fenster.
    ///
    /// Beide Sitzungen melden unter derselben Kennung, also zeigt der Renderer
    /// unverändert, was ihn erreicht. Die Auswahl passiert davor:
    ///
    /// * Der Hauptstrom geht durch, und jedes seiner Bilder stempelt die Uhr
    ///   `zuletzt_haupt`.
    /// * Vom Netz gehen NUR Bilder durch, und nur wenn diese Uhr älter ist als
    ///   [`FALLBACK_GRACE`]. Seine Zustandsmeldungen werden verworfen: Ein
    ///   `failed` des Netzes darf die Sitzung nicht beenden, und ein `playing`
    ///   des Netzes darf nicht als "der Stream läuft" durchgehen.
    ///
    /// Endet der Hauptstrom, wird auch das Netz gestoppt — sonst liefe es
    /// weiter und hielte ein Fenster am Leben, das niemand mehr füttert.
    fn spawn_with_fallback(
        &self,
        url: String,
        fallback_url: String,
        options: PlayerOptions,
        ev_tx: mpsc::Sender<SessionEvent>,
        cmd_rx: mpsc::Receiver<SessionCommand>,
        geraet: Option<wgpu::Device>,
    ) {
        let zuletzt_haupt = Arc::new(std::sync::Mutex::new(None::<std::time::Instant>));

        let (haupt_tx, mut haupt_rx) = mpsc::channel::<SessionEvent>(8);
        let (netz_tx, mut netz_rx) = mpsc::channel::<SessionEvent>(8);
        let (netz_cmd_tx, netz_cmd_rx) = mpsc::channel::<SessionCommand>(4);

        // Steuerbefehle erreichen BEIDE Sitzungen (Bughunt 2026-08-13): vorher
        // sah das Auffangnetz nur `Stop` — eine Fernsteuerung (oder ein
        // Options-Patch) senkte die Geduld nur im Hauptstrom, und gezeigt wird
        // das Netz genau dann, wenn der Hauptstrom ausfällt. Weitergereicht
        // werden nur die klonbaren Befehle; `Record`/`Clip` tragen einen
        // Antwortkanal und gehören ohnehin dem Hauptstrom.
        let (haupt_cmd_tx, haupt_cmd_rx) = mpsc::channel::<SessionCommand>(16);
        let netz_cmd_fuer_befehle = netz_cmd_tx.clone();
        self.runtime.spawn(async move {
            let mut cmd_rx = cmd_rx;
            // Nachzuegler-Task fuer den Fall, dass der Netz-Kanal gerade voll
            // ist (s. unten). Als Kette, damit auch der Nachschub in der
            // richtigen Reihenfolge ankommt — ein „aus", das ein „ein"
            // ueberholt, waere schlimmer als der verlorene Patch.
            let mut nachzuegler: Option<tokio::task::JoinHandle<()>> = None;
            while let Some(cmd) = cmd_rx.recv().await {
                let kopie = match &cmd {
                    SessionCommand::Fernsteuerung(aktiv) => {
                        Some(SessionCommand::Fernsteuerung(*aktiv))
                    }
                    SessionCommand::Options(patch) => Some(SessionCommand::Options(patch.clone())),
                    _ => None,
                };
                if let Some(kopie) = kopie {
                    // Hier wird NIE blockierend gesendet (Bughunt R2): der
                    // Netz-Kanal hat Tiefe 4, und das Auffangnetz pollt seine
                    // Befehle erst nach dem WHEP-Aufbau (bis 15 s + 2 s ICE).
                    // Ein blockierendes Send hielte den WEITERLEITER an — und
                    // damit erreichte den HAUPTSTROM gar nichts mehr, auch kein
                    // Stop.
                    //
                    // **Verworfen werden darf es trotzdem nicht.** Hier stand
                    // ein blosses `try_send` mit der Begruendung, der naechste
                    // Statistik-Takt bzw. Options-Patch ziehe es nach — das
                    // gilt aber nur fuers EINSCHALTEN: `fern_geduld` in
                    // `session.rs` wird nur bei laufender Fernsteuerung neu
                    // gerechnet. Blieb ein `Fernsteuerung(false)` liegen, hing
                    // das Auffangnetz bis zum Sitzungsende auf der abgesenkten
                    // Geduld — und gezeigt wird es genau dann, wenn der
                    // Hauptstrom ausfaellt. Der Nachschub laeuft deshalb ueber
                    // eine eigene Task, die warten darf, waehrend der
                    // Weiterleiter weiterlaeuft.
                    let voll = nachzuegler.as_ref().is_some_and(|h| !h.is_finished());
                    let rest = if voll {
                        Some(kopie)
                    } else {
                        netz_cmd_fuer_befehle.try_send(kopie).err().map(|e| e.into_inner())
                    };
                    if let Some(kopie) = rest {
                        let tx = netz_cmd_fuer_befehle.clone();
                        let vorherige = nachzuegler.take();
                        nachzuegler = Some(tokio::spawn(async move {
                            if let Some(vorherige) = vorherige {
                                let _ = vorherige.await;
                            }
                            let _ = tx.send(kopie).await;
                        }));
                    }
                }
                if haupt_cmd_tx.send(cmd).await.is_err() {
                    break;
                }
            }
        });

        // Hauptstrom: unverändert durchreichen, Bilder stempeln.
        let uhr = zuletzt_haupt.clone();
        let weiter = ev_tx.clone();
        self.runtime.spawn(async move {
            while let Some(event) = haupt_rx.recv().await {
                if matches!(event, SessionEvent::Frame(_)) {
                    *uhr.lock().unwrap() = Some(std::time::Instant::now());
                } else if matches!(event, SessionEvent::Ended { .. }) {
                    let _ = netz_cmd_tx.send(SessionCommand::Stop).await;
                }
                if weiter.send(event).await.is_err() {
                    break;
                }
            }
            // Fenster zu oder Sitzung vorbei: das Netz mit beenden.
            let _ = netz_cmd_tx.send(SessionCommand::Stop).await;
        });

        // Netz: nur Bilder, nur wenn der Hauptstrom gerade nichts liefert.
        let uhr = zuletzt_haupt.clone();
        self.runtime.spawn(async move {
            while let Some(event) = netz_rx.recv().await {
                let SessionEvent::Frame(_) = event else { continue };
                let frisch = uhr
                    .lock()
                    .unwrap()
                    .is_some_and(|t| t.elapsed() < FALLBACK_GRACE);
                if frisch {
                    continue;
                }
                if ev_tx.send(event).await.is_err() {
                    break;
                }
            }
        });

        let netz_opts = options.clone();
        // Beide Sitzungen zeichnen ins selbe Fenster, also auch auf dasselbe
        // Geraet.
        let netz_geraet = geraet.clone();
        self.runtime.spawn(async move {
            session::run(url, vec![], options, haupt_tx, haupt_cmd_rx, geraet).await
        });
        self.runtime.spawn(async move {
            session::run(fallback_url, vec![], netz_opts, netz_tx, netz_cmd_rx, netz_geraet).await
        });
    }

    fn open(&mut self, req: Request, event_loop: &ActiveEventLoop) -> Result<u64> {
        let url = req.url.clone().ok_or_else(|| anyhow::anyhow!("url fehlt"))?;
        let mut options = PlayerOptions::defaults();
        // Die Umgebung VOR dem Aufrufer: sie ist das Werkzeug des Pruefstands,
        // der den Player ohne Oberflaeche faehrt. Ein `open` mit gesetztem
        // `ausgabetakt_ms` sticht sie danach wieder — die App soll bestimmen
        // duerfen, wenn sie etwas sagt.
        if let Some(ms) = takt::vorhalt_aus_umgebung() {
            options.ausgabetakt_ms = Some(ms);
        }
        if let Some(o) = req.options.as_ref() {
            options.apply(o);
        }
        options.clamp();
        let vorhalt_ms = options.ausgabetakt_ms.unwrap_or(0);

        let title = req.title.clone().unwrap_or_else(|| "Pulse — HQ-Stream".into());
        let attrs = Window::default_attributes()
            .with_title(title.clone())
            .with_inner_size(winit::dpi::LogicalSize::new(1280.0, 720.0))
            // NICHT aktivieren: das Fenster soll den Tastatur-Fokus nicht
            // wegnehmen. Pulses Tastenkuerzel hoeren am Fenster der Web-App zu
            // und wirken nicht mehr, sobald ein anderes Fenster aktiv ist —
            // beim Zuschauen will man weiter in Pulse tippen koennen.
            .with_active(false);
        let window = Arc::new(event_loop.create_window(attrs)?);
        if req.fullscreen.unwrap_or(false) {
            window.set_fullscreen(Some(winit::window::Fullscreen::Borderless(None)));
        }

        let size = window.inner_size();
        let renderer =
            pollster::block_on(render::Renderer::new(window.clone(), size.width, size.height))?;
        // Overlay in DASSELBE Oberflaechenformat zeichnen wie das Bild.
        let overlay = match Overlay::new(
            renderer.device(),
            renderer.surface_texture_format(),
            &window,
            options.volume.unwrap_or(1.0),
        ) {
            Ok(mut o) => {
                // Die Leiste im Fenster ist die einzige Bedienung dieses
                // Streams, solange er hier laeuft — sie braucht denselben
                // Namen und dieselben Knoepfe wie die Kachel in der App.
                o.set_title(title);
                o.set_can_reattach(req.can_reattach.unwrap_or(true));
                Some(o)
            }
            Err(e) => {
                eprintln!("pulse-player: Bedienoberflaeche nicht verfuegbar: {e:#}");
                None
            }
        };

        let id = self.next_id;
        self.next_id += 1;

        let (cmd_tx, cmd_rx) = mpsc::channel(16);
        // Kanal vom Decoder-Faden zum Fenster-Faden.
        //
        // **HIER STAND BIS ZUM 2026-08-07 „Klein gehalten … Ein grosser Puffer
        // wuerde bei langsamer Darstellung Latenz aufbauen statt Bilder zu
        // ueberspringen — bei 60 fps waeren 256 Eintraege ueber vier Sekunden
        // Rueckstand." Die Begruendung ist seit dem Ausgabe-Takt hinfaellig:**
        // seit dem 2026-08-05 bestimmt nicht mehr die Position in einer
        // Warteschlange, WANN ein Bild erscheint, sondern sein RTP-Zeitstempel
        // (`app::takt`). Ein Bild, das laenger im Kanal lag, wird deshalb nicht
        // spaeter gezeigt — es wird zu seinem Zeitpunkt gezeigt oder als zu
        // spaet gezaehlt und verworfen. Rueckstand kann so gar nicht entstehen.
        //
        // Was der kleine Kanal stattdessen tat: er warf fertig dekodierte
        // Bilder weg, BEVOR der Takt sie ueberhaupt zu sehen bekam — und zwar
        // ohne Rueckgriff auf ihren Zeitpunkt, nur weil gerade acht andere
        // unterwegs waren. Gemessen am 2026-08-07 bei 1440p und 144 fps, zwei
        // Paare abwechselnd (Akte `player-2026-08-07-...`):
        //
        // | Fassungsvermoegen | gezeichnet | hier verworfen |
        // |---|---|---|
        // | 8 (alt) | 67 / 91 je Sekunde | 859 / 876 je Lauf |
        // | 32 (neu) | 112 / 108 | 193 / 223 |
        //
        // **Das ist eine Linderung, keine Behebung.** Richtig waere, hier gar
        // nichts zu verwerfen und das Aussortieren dem Takt zu ueberlassen, der
        // die Zeitpunkte kennt. Das setzt voraus, dass die Dekodierung nicht
        // mehr in derselben Schleife laeuft wie das Abholen der RTP-Pakete —
        // sonst blockiert ein blockierendes Einstellen den Empfang. Dieser
        // Umbau steht aus und ist in der Messakte beschrieben.
        //
        // **Kopplung an den Ring:** auf dem Zero-Copy-Weg haelt jedes Bild im
        // Kanal einen Platz im Ring der Bruecke. Kanal + Warteschlange des
        // Takts + laufende Bilder koennen den Ring damit rechnerisch
        // uebersteigen. Das ist hingenommen und nicht gefaehrlich: geht dem
        // Ring der Platz aus, liefert `Freigabe::nehmen` nichts und das Bild
        // nimmt den Weg ueber den Hauptspeicher — langsamer, aber vollstaendig.
        // Im Messbetrieb wurde der Ring dabei nie ausgeschoepft.
        let (ev_tx, mut ev_rx) = mpsc::channel(ev_kanal_groesse());
        let proxy = self.proxy.clone();
        self.runtime.spawn(async move {
            let mut announced_end = false;
            let mut zuletzt = std::time::Instant::now();
            while let Some(event) = ev_rx.recv().await {
                // Wie lange dieser Task NICHT lief. Ist die Zahl gross, ist ein
                // voller Kanal keine Aussage ueber den Fenster-Faden, sondern
                // ueber die Tokio-Zuteilung.
                let jetzt = std::time::Instant::now();
                diagnose::hoechstens(
                    &diagnose::FW_LUECKE_MAX_US,
                    jetzt.duration_since(zuletzt).as_micros() as u64,
                );
                zuletzt = jetzt;
                diagnose::FW_LAUF_US
                    .store(diagnose::jetzt_us(), std::sync::atomic::Ordering::Relaxed);
                announced_end |= matches!(&event, SessionEvent::Ended { .. });
                diagnose::hoch(&diagnose::ABGESCHICKT, 1);
                diagnose::hoch(&diagnose::GES_GESENDET, 1);
                if proxy
                    .send_event(UserEvent::Session { id, event, gesendet: jetzt })
                    .is_err()
                {
                    return;
                }
            }
            // Der Kanal ist zu, ohne dass `session::run` sein Ende gemeldet
            // hat — der Task ist also gestorben, statt zurueckzukehren (Panik).
            // Ohne diese Ersatzmeldung bliebe die Sitzung ewig in `connecting`:
            // der Renderer wartet auf `state`, der Rueckfall auf das
            // <video>-Element haengt an `failed` und griffe nie. Genau so
            // verhielt sich der fehlende rustls-Krypto-Provider (s. `main.rs`).
            if !announced_end {
                let _ = proxy.send_event(UserEvent::Session {
                    id,
                    event: SessionEvent::Ended {
                        reason: "Sitzung unerwartet beendet".to_string(),
                        failed: true,
                    },
                    gesendet: std::time::Instant::now(),
                });
            }
        });
        let opts = options.clone();
        // Das Geraet des gerade gebauten Renderers — die Sitzung reicht es bis
        // zum Decoder durch (s. `session::run`).
        let geraet = Some(renderer.device().clone());
        match req.fallback_url.clone() {
            None => {
                self.runtime.spawn(async move {
                    session::run(url, vec![], opts, ev_tx, cmd_rx, geraet).await
                });
            }
            Some(fallback) => {
                // Zwei Sitzungen, EIN Fenster: beide melden unter derselben
                // Kennung, deshalb landet ihr Bild in derselben Anzeige. Was
                // gezeigt wird, entscheidet der Filter unten — nicht der
                // Renderer, der davon nichts wissen muss.
                self.spawn_with_fallback(url, fallback, opts, ev_tx, cmd_rx, geraet);
            }
        }

        self.by_window.insert(window.id(), id);
        self.sessions.insert(
            id,
            Session {
                window,
                renderer: Some(renderer),
                overlay,
                commands: cmd_tx,
                options,
                stats: SessionStats::default(),
                decoder: String::new(),
                hardware: false,
                full_range: false,
                farbe: decode::Farbangaben::default(),
                pending: None,
                takt: Ausgabetakt::neu(vorhalt_ms),
                probe: crate::probe::LatencyProbe::from_env(),
                frames_never_drawn: 0,
                phases: PhaseTimes::default(),
                last_frame_at: None,
                last_log: None,
                presented_at_last_log: 0,
                bilanz_gemeldet: false,
                state: SessionState::Connecting,
                eingabe: crate::fernsteuerung::Erfassung::neu(),
                fang_gewuenscht: false,
                zeigersicht: zeigersicht::Zeigersicht::default(),
                fern_transport: String::new(),
                eingabe_frames: 0,
                can_reattach: req.can_reattach.unwrap_or(true),
                fern_schirme: Vec::new(),
                optionskette: None,
                tastensperre: crate::tastensperre::Tastensperre::default(),
            },
        );
        // Einmal zeichnen, bevor das erste Bild da ist: sonst zeigt das Fenster
        // undefinierten Inhalt, bis der Strom laeuft — und die Bedienoberflaeche
        // waere nicht auffindbar, weil sie ohne Durchgang nie erscheint.
        if let Some(session) = self.sessions.get(&id) {
            session.window.request_redraw();
        }
        // **Das `connecting` wird NICHT hier gemeldet, sondern erst nach der
        // Antwort** (s. `requests.rs`, Zweig `"open"`). Bis zum 2026-08-07 stand
        // es an dieser Stelle und ging damit VOR der Antwort ueber die Leitung —
        // die Gegenseite kannte ihre Sitzungsnummer zu diesem Zeitpunkt noch
        // nicht und verwarf die Meldung als "gehoert zu einer anderen Sitzung".
        // Beim `connecting` war das folgenlos; die Reihenfolge als solche ist es
        // nicht, denn stirbt eine Sitzung sofort (der fehlende
        // rustls-Krypto-Anbieter ist der reale Fall, s. `main.rs`), traefe es
        // dasselbe `failed` — und dann bliebe die Kachel ewig auf "verbinde"
        // stehen, statt auf das <video>-Element zurueckzufallen.
        Ok(id)
    }

    /// Ein Durchgang: Bild hochladen, zeichnen, Overlay darueber. Gibt zurueck,
    /// was der Nutzer im Fenster ausgeloest hat — angewandt wird es erst danach
    /// (`apply_overlay_action`), weil dafuer die Sitzung erneut geliehen wird.
    fn draw(&mut self, id: u64) -> Vec<OverlayAction> {
        let draw_uhr = std::time::Instant::now();
        let ergebnis = self.draw_inner(id);
        let us = draw_uhr.elapsed().as_micros() as u64;
        diagnose::hoch(&diagnose::DRAW_SUM_US, us);
        diagnose::hoechstens(&diagnose::DRAW_MAX_US, us);
        diagnose::hoch(&diagnose::DRAW_N, 1);
        ergebnis
    }

    fn draw_inner(&mut self, id: u64) -> Vec<OverlayAction> {
        let Some(session) = self.sessions.get_mut(&id) else { return Vec::new() };
        // Feldweise leihen: Renderer und Overlay brauchen beide `&mut`, sind
        // aber getrennte Felder — ueber Methoden waere das dem Borrow-Checker
        // nicht vermittelbar.
        let Session {
            window,
            renderer,
            overlay,
            options,
            stats,
            decoder,
            hardware,
            full_range,
            farbe,
            pending,
            frames_never_drawn,
            phases,
            probe,
            eingabe,
            fern_transport,
            eingabe_frames,
            ..
        } = session;
        let Some(renderer) = renderer.as_mut() else { return Vec::new() };
        // Nur zeichnen, wenn es etwas Neues gibt.
        //
        // Vorher gab die Schleife auch ohne neues Bild aus — gemessen 2500-mal
        // je Sekunde bei 144 ankommenden Bildern, also 17-mal dasselbe Bild.
        // Das kostete dauerhaft einen halben Kern und erklaerte die Kernlast,
        // die zunaechst nach teuren Bildern aussah. `ControlFlow::Wait` hilft
        // dagegen nichts: die Anforderungen kamen aus dem Zeichnen selbst.
        let has_frame = pending.is_some();
        // Zwei verschiedene Fragen, die vorher eine waren:
        //   * `wants_redraw` = gibt es einen GRUND, ohne neues Bild zu zeichnen
        //   * `visible`      = soll das Overlay in DIESEM Durchgang mitgezeichnet
        //                      werden (sonst verschwaende es beim Bildwechsel)
        let overlay_wants = overlay.as_ref().is_some_and(|o| o.wants_redraw());
        if !has_frame && !overlay_wants {
            return Vec::new();
        }
        let upload_started = std::time::Instant::now();
        let mut frame_arrived = None;
        if let Some(frame) = pending.take() {
            frame_arrived = frame.arrived;
            // Vor dem Hochladen: die Sonde braucht die Ebenen im Hauptspeicher.
            if let Some(p) = probe.as_mut() {
                p.note(&frame);
            }
            renderer.upload(&frame);
        }
        let upload_took = upload_started.elapsed();

        // Das Fenster auf die Farbwelt des Stroms stellen. Tut nur beim Wechsel
        // etwas (erstes HDR-Bild, oder zurueck auf SDR).
        //
        // **Aendert sich dabei das Oberflaechenformat, muss die
        // Bedienoberflaeche mitziehen** — sie zeichnet in dieselbe Flaeche, und
        // ihre GPU-Pipeline ist auf das alte Format uebersetzt. Nur der
        // Zeichner wird ersetzt, nicht das ganze Overlay: Titel, Lautstaerke
        // und der Zustand der Leiste sollen den Wechsel ueberleben.
        if let Some(neues_format) = renderer.farbraum_fuer_quelle(*farbe) {
            if let Some(o) = overlay.as_mut() {
                o.zeichner_neu(renderer.device(), neues_format);
            }
        }

        // Nur wenn das Overlay diesen Durchgang wirklich zeichnet, lohnt sich
        // ueberhaupt Arbeit fuer die Anzeige — sonst faellt hier alles weg.
        // Die Bedingung liegt im Overlay (`soll_mitzeichnen`) und nicht hier:
        // sie war als `visible() || wants_redraw()` ausgeschrieben und uebersah
        // damit den Fernsteuerungs-Modus, in dem der Griff dauerhaft steht.
        let want_overlay = overlay.as_ref().is_some_and(Overlay::soll_mitzeichnen);
        let surface_format =
            if want_overlay { renderer.surface_format().to_string() } else { String::new() };
        let frames_presented = renderer.frames_presented();
        let acquire_misses = renderer.acquire_misses();
        let view = StatsView {
            width: stats.width,
            height: stats.height,
            decoder,
            hardware: *hardware,
            surface_format: &surface_format,
            fps: stats.fps,
            kbps: stats.kbps,
            frames_presented,
            never_drawn: *frames_never_drawn,
            upload_us: phases.upload_avg_us,
            render_us: phases.render_avg_us,
            acquire_misses,
            frames_dropped: stats.frames_dropped,
            frames_skipped: stats.frames_skipped,
            packets_lost: stats.packets_lost,
            buffered_packets: stats.buffered_packets,
            jitter_target_ms: stats.jitter_target_ms,
            ten_bit_source: stats.ten_bit_source,
            audio_active: stats.media.audio_active,
            audio_underruns: stats.media.audio_underruns,
            audio_geraetefehler: stats.media.audio_geraetefehler,
            recording: stats.media.recording,
            fern_aktiv: eingabe.aktiv(),
            fern_transport,
            input_frames: *eingabe_frames,
            input_verworfen: eingabe.verworfene_bewegungen(),
            input_ohne_abbildung: eingabe.unbekannte_tasten(),
        };
        let mut pass = overlay
            .as_mut()
            .filter(|_| want_overlay)
            .map(|o| render::OverlayPass::new(o, window, window.fullscreen().is_some(), &view));
        let render_started = std::time::Instant::now();
        // Der Abschnitt, den bisher KEINE Uhr sah: Farbraumpruefung,
        // Statistik-Zusammenbau, Overlay-Vorbereitung.
        let zwischen = render_started.duration_since(upload_started) - upload_took;
        diagnose::hoch(&diagnose::ZWISCHEN_SUM_US, zwischen.as_micros() as u64);
        diagnose::hoechstens(&diagnose::ZWISCHEN_MAX_US, zwischen.as_micros() as u64);
        if let Err(e) = renderer.render(options, *full_range, *farbe, pass.as_mut()) {
            eprintln!("pulse-player: Darstellung: {e:#}");
        }
        // Musterzeilen aus dem Grafikspeicher nachreichen — der Weg der
        // Latenz-Sonde, wenn das Bild den Hauptspeicher nie gesehen hat
        // (`render::musterprobe`). Sie hinken ein bis zwei Bilder hinterher und
        // fuehren deshalb ihren eigenen Zeitstempel mit; hier wird nichts mehr
        // gemessen, nur weitergegeben.
        if let Some(p) = probe.as_mut() {
            while let Some(zeilen) = renderer.musterzeilen_nehmen() {
                p.note_gpu(&zeilen);
            }
        }
        // Soll-Abstand aus der gemessenen Bildrate der Quelle — nicht aus einer
        // angenommenen: die Rate bestimmt der Sender.
        let expected_gap = stats
            .fps
            .filter(|f| *f > 0)
            .map(|f| std::time::Duration::from_micros(1_000_000 / f));
        phases.note_age(frame_arrived);
        phases.note(upload_took, render_started.elapsed(), expected_gap);
        pass.map(|p| p.actions).unwrap_or_default()
    }

    /// Eine Zeile mit allen Zahlen, hoechstens einmal je Sekunde und Sitzung.
    ///
    /// Getrieben von den Statistik-Ereignissen der Sitzung (alle 250 ms), NICHT
    /// vom Zeichnen: bliebe die Anzeige stehen, waere genau dann keine Zeile
    /// mehr da, wenn man sie am dringendsten braucht.
    fn log_stats_if_due(&mut self, id: u64) {
        if !self.stats_log {
            return;
        }
        let now = std::time::Instant::now();
        let Some(session) = self.sessions.get_mut(&id) else { return };
        let elapsed = session.last_log.map(|t| now.duration_since(t));
        if elapsed.is_some_and(|d| d < std::time::Duration::from_secs(1)) {
            return;
        }
        let presented = session.renderer.as_ref().map_or(0, render::Renderer::frames_presented);
        let misses = session.renderer.as_ref().map_or(0, render::Renderer::acquire_misses);
        // Beim ersten Aufruf gibt es keinen Bezugspunkt — dann nur die
        // Zaehlerstaende, keine erfundene Rate.
        let drawn = elapsed.map(|d| {
            let secs = d.as_secs_f64().max(0.001);
            ((presented.saturating_sub(session.presented_at_last_log)) as f64 / secs).round() as u64
        });
        // Fenster der Sonde im GLEICHEN Rhythmus abschliessen wie das Log —
        // sonst gehoerten Mittelwert und Zeitpunkt nicht zusammen.
        if let Some(p) = session.probe.as_mut() {
            p.roll();
        }
        let probe_line = session.probe.as_ref().map(|p| {
            format!(
                ", Ende-zu-Ende {:.1}/{:.1} ms ({} ohne Muster)",
                p.avg_us() as f64 / 1000.0,
                p.max_us() as f64 / 1000.0,
                p.misses()
            )
        });
        // Der Ausgabe-Takt bekommt eine eigene Zeile, und nur wenn er laeuft.
        //
        // **`verdraengt` ist die erste Zahl, auf die zu sehen ist, und sie muss
        // 0 sein.** Alles andere heisst: der Vorhalt braucht mehr Plaetze in
        // der Warteschlange, als es gibt, und Bilder fliegen VOR ihrem
        // Zeitpunkt heraus — sie erreichen die Anzeige also nie. Genau das lief
        // bis zum 2026-08-07 bei 144 fps, ungezaehlt und unbemerkt (rund 90
        // Bilder je Sekunde). Begruendung und Messung: `app/takt.rs`.
        //
        // **`verspaetet` ist die Kontrollzahl fuer den Vorhalt selbst, nicht
        // `gap_late`**: steigt
        // sie, ist der Vorhalt kleiner als die Schwankung der Strecke, und dann
        // taktet nichts mehr — die Ausgabe-Abstaende in der Zeile darueber
        // saehen aus wie ohne Takt, ohne dass etwas darauf hinweist.
        //
        // Die Zeile hier fertigstellen, nicht unten: `st` unten leiht die
        // Sitzung bis zum Ende der Funktion aus. (Wie `probe_line` darueber.)
        let takt_zeile = session.takt.aktiv().then(|| {
            format!(
                ": Ausgabe-Takt {} ms Vorhalt, verspaetet {}, neu verankert {}, \
                 nachgezogen {}, verdraengt {}",
                session.takt.vorhalt_ms(),
                session.takt.verspaetet(),
                session.takt.neu_verankert(),
                session.takt.nachgezogen(),
                session.takt.verdraengt(),
            )
        });
        let st = &session.stats;
        // `concat!` statt Zeilenfortsetzungen: mit `\` am Zeilenende ist beim
        // Schreiben dieser Datei schon einmal eine einzige lange Zeile mit
        // Leerraum-Ketten entstanden, die im Log als klaffende Luecken auftauchte.
        eprintln!(
            concat!(
                "pulse-player: Sitzung {}: dekodiert {}/s, gezeichnet {}/s, ",
                "nie gezeichnet {}, ohne Oberflaeche {}, ",
                "hochladen {:.1} ms, ausgeben {:.1} ms, ",
                "Abstand {:.1}-{:.1} ms ({} zu spaet), ",
                "Ankunft max {:.1} ms ({} ueber 5 ms), ",
                "dekodieren {:.1}/{:.1} ms, Netz-bis-Schirm {:.1}/{:.1} ms, ",
                "{} kbit/s, Paketverlust {}, Puffer {} Pakete, uebersprungen {}, ",
                // **Der Eimer, der bis zum 2026-08-07 fehlte.** Die Zeile nannte
                // dekodierte und gezeichnete Bilder und zwei Verlustzaehler —
                // aber nicht den groessten: nach einer Luecke gilt das Bild
                // `refresh_dauer()` lang als unsauber (Deckel 2 s), und JEDES
                // Bild in dieser Zeit wird weggeworfen. Bei 144 fps sind das bis
                // zu 288 Stueck je Luecke. Ohne diese Zahl gingen bei 1440p rund
                // 60 Bilder je Sekunde verloren, ohne dass eine Zeile sagte wohin.
                "davon nach Luecke verworfen {}"
            ),
            id,
            st.fps.map_or_else(|| "?".to_string(), |v| v.to_string()),
            drawn.map_or_else(|| "?".to_string(), |v| v.to_string()),
            session.frames_never_drawn,
            misses,
            session.phases.upload_avg_us as f64 / 1000.0,
            session.phases.render_avg_us as f64 / 1000.0,
            session.phases.gap_min_us_last as f64 / 1000.0,
            session.phases.gap_max_us_last as f64 / 1000.0,
            session.phases.gap_late_last,
            st.arrival_gap_max_us as f64 / 1000.0,
            st.arrival_gaps_over_5ms,
            // Mittel und Ausschlag je Fenster, beide in ms.
            st.decode_avg_us() as f64 / 1000.0,
            st.decode_max_us as f64 / 1000.0,
            session.phases.age_avg_us as f64 / 1000.0,
            session.phases.age_max_us_last as f64 / 1000.0,
            st.kbps.map_or_else(|| "?".to_string(), |v| v.to_string()),
            st.packets_lost,
            st.buffered_packets,
            st.frames_skipped,
            st.frames_dropped,
        );
        // Getrennte Zeile statt eines weiteren Platzhalters in der grossen:
        // die Sonde laeuft nur im Pruefstand, und die Zeile oben soll im
        // Normalbetrieb unveraendert bleiben (der Pruefstand liest sie).
        if let Some(line) = probe_line {
            eprintln!("pulse-player: Sitzung {id}{line}");
        }
        if let Some(line) = takt_zeile {
            eprintln!("pulse-player: Sitzung {id}{line}");
        }
        // **Was der Sender wirklich schickt**, am Strom gemessen statt aus einer
        // Einstellung gelesen. Eigene Zeile aus demselben Grund wie die
        // Takt-Zeile: die grosse oben soll unveraendert bleiben, der Pruefstand
        // liest sie.
        //
        // Warum das ueberhaupt gebraucht wird: am 2026-08-07 kostete es einen
        // halben Messtag, dass der Testsender einen anderen Vollbild-Takt fuhr
        // als der Betrieb. Ein 1440p-Vollbild ueber eine schmale Leitung
        // braucht hunderte Millisekunden und reisst genau die Ankunftsloecher,
        // die danach dem Player angelastet wurden. Diese Zeile beantwortet das
        // beim Hinsehen — auf jedem Betriebssystem, weil nur der Bitstrom
        // gelesen wird.
        //
        // Sie DEUTET seit dem 2026-08-21 nichts mehr (s.
        // `decode::Sendeart::beschreibung`): mit dem Entfernen von
        // Intra-Refresh gibt es nur noch eine Betriebsart, und die alte Deutung
        // war zuletzt dauerhaft falsch.
        if st.sendeart.her_ms.is_some() {
            eprintln!("pulse-player: Sitzung {id}: Sender — {}", st.sendeart.beschreibung());
        }
        // Diagnose: WO zwischen Decoder und Schirm die Bilder liegenbleiben.
        let d = diagnose::abholen();
        eprintln!(
            concat!(
                "pulse-player: Sitzung {}: Weg — abgeschickt {}, angekommen {}, ",
                "Weckverzug {:.1}/{:.1} ms, Weiterleitung-Luecke max {:.1} ms, ",
                "Fenster belegt {:.1} %, draw {} x {:.2}/{:.1} ms, ",
                "davon unbeobachtet {:.2}/{:.1} ms; ",
                "holen {:.2}/{:.1} ms, aufzeichnen {:.2} ms, ausgeben {:.2}/{:.1} ms; ",
                "Kanal max {}, Sendeluecke max {:.1} ms; ",
                "beim Verwerfen: Weiterleitung seit {:.1} ms nicht gelaufen, ",
                "Schlange {} Ereignisse; ",
                "Schleife: max {} Bilder je Durchlauf, Durchlauf max {:.1} ms, ",
                "Pause max {:.1} ms; ",
                "Luecken im gleichen Fenster: Paket {:.1} ms → Einheit {:.1} ms ",
                "→ Bild {:.1} ms"
            ),
            id,
            d.abgeschickt,
            d.angekommen,
            d.weck_avg_us as f64 / 1000.0,
            d.weck_max_us as f64 / 1000.0,
            d.fw_luecke_max_us as f64 / 1000.0,
            d.haupt_belegt_us as f64 / 10_000.0,
            d.draw_n,
            d.draw_avg_us as f64 / 1000.0,
            d.draw_max_us as f64 / 1000.0,
            d.zwischen_avg_us as f64 / 1000.0,
            d.zwischen_max_us as f64 / 1000.0,
            d.acq_avg_us as f64 / 1000.0,
            d.acq_max_us as f64 / 1000.0,
            d.enc_avg_us as f64 / 1000.0,
            d.pres_avg_us as f64 / 1000.0,
            d.pres_max_us as f64 / 1000.0,
            d.kanal_max,
            d.sende_luecke_max_us as f64 / 1000.0,
            d.verworfen_fw_alter_max_us as f64 / 1000.0,
            d.verworfen_schlange_max,
            d.bilder_je_durchlauf_max,
            d.durchlauf_max_us as f64 / 1000.0,
            d.durchlauf_luecke_max_us as f64 / 1000.0,
            d.ank_luecke_max_us as f64 / 1000.0,
            d.einheit_luecke_max_us as f64 / 1000.0,
            d.sende_luecke_max_us as f64 / 1000.0,
        );
        // Der Ton ebenfalls in einer eigenen Zeile, aus demselben Grund.
        //
        // **Warum ueberhaupt:** Die Zahlen liegen seit jeher an (`counters()`
        // → `MediaStats`), gingen aber nur ins Overlay — und wer beim Zuschauen
        // die Maus bewegt, um sie zu lesen, veraendert die Messung. Beim
        // Knacksen wurde deshalb bisher geraten. Ein Unterlauf ist genau das,
        // was man hoert: der Geraete-Rueckruf fand zu wenig im Ring und hat mit
        // Stille aufgefuellt. Steigen stattdessen die verworfenen Samples,
        // liegt es am anderen Ende — es kommt mehr an, als ausgegeben wird.
        let media = &st.media;
        if media.audio_active || media.audio_underruns > 0 {
            // `concat!` wie oben, nicht `\` am Zeilenende — aus demselben Grund.
            eprintln!(
                concat!(
                    "pulse-player: Sitzung {}: Ton — Unterlaeufe {}, verworfen {}, ",
                    "Puffer {} Samples, Uhrenabgleich {:+} ppm{}"
                ),
                id,
                media.audio_underruns,
                media.audio_dropped,
                media.audio_buffered,
                media.audio_abgleich_ppm,
                // Ein Geraetefehler heisst: es kommt nichts mehr heraus. Das
                // gehoert in dieselbe Zeile und nicht in eine einmalige
                // Meldung, die im Protokoll nach oben wegscrollt.
                if media.audio_geraetefehler { " — AUSGABEGERAET GESTOERT" } else { "" },
            );
        }
        session.last_log = Some(now);
        session.presented_at_last_log = presented;
        // Zuletzt, weil sie die Sitzung erneut ausleiht.
        self.bilanz_pruefen(id, presented);
    }

    /// **Geht die Rechnung auf?** Jedes dekodierte Bild muss genau einen Ausgang
    /// nehmen: gezeichnet, oder einen der Verlust-Zaehler.
    ///
    /// **Warum es das gibt.** Am 2026-08-07 standen 144 dekodierte gegen 85
    /// gezeichnete Bilder, und die vorhandenen Zaehler erklaerten davon nur
    /// zwanzig. Den fehlenden Ausgang habe ich von Hand gesucht — es war die
    /// Warteschlange des Ausgabe-Takts, die ungezaehlt verwarf. Diese Pruefung
    /// haette ihn in der ersten Minute genannt.
    ///
    /// **Sie meldet nur, wenn etwas fehlt.** Im gesunden Betrieb ist sie stumm
    /// und kostet eine Subtraktion je Sekunde. Das ist Absicht: eine Zeile, die
    /// immer dasteht, wird nicht gelesen — und jede Zeile kostet den
    /// Diagnose-Upload Reichweite (er traegt nur die letzten 512 KB).
    ///
    /// **Sie rechnet KUMULIERT, nicht je Fenster** — das ist der Kern und war
    /// im ersten Anlauf falsch. Zwischen „dekodiert" und „gezeichnet" liegen
    /// Puffer (Kanal zum Fenster-Faden bis 32 Bilder, Warteschlange des Takts
    /// bis 12). Ein Sekundenfenster sieht die als verschwunden und im naechsten
    /// als zu viel: der erste Lauf meldete prompt „34 Bilder ohne Ausgang",
    /// obwohl nichts fehlte. Kumuliert bleibt dieser Anteil beschraenkt, ein
    /// echtes Leck waechst dagegen unbegrenzt weiter.
    fn bilanz_pruefen(&mut self, id: u64, presented: u64) {
        /// Wie viele Bilder hoechstens gleichzeitig unterwegs sein koennen,
        /// ohne dass etwas fehlt: Kanal + Warteschlange + angezeigtes Bild +
        /// was im Decoder steckt, grosszuegig aufgerundet. Alles darueber ist
        /// kein Puffer mehr, sondern ein fehlender Zaehler.
        const UNTERWEGS_MAX: i64 = 150;
        let Some(session) = self.sessions.get_mut(&id) else { return };
        let st = &session.stats;
        let rest = st.frames_decoded as i64
            - presented as i64
            - st.frames_skipped as i64
            - st.frames_dropped as i64
            - session.frames_never_drawn as i64
            - session.takt.verdraengt() as i64;
        // Nur EINMAL melden, sonst steht die Zeile ab da jede Sekunde da und
        // frisst die Reichweite des Diagnose-Uploads.
        if rest.abs() > UNTERWEGS_MAX && !session.bilanz_gemeldet {
            session.bilanz_gemeldet = true;
            eprintln!(
                "pulse-player: Sitzung {id}: BILANZ — {rest} Bilder ohne Ausgang \
                 (dekodiert {}, gezeichnet {presented}, uebersprungen {}, nach Luecke {}, \
                 nie gezeichnet {}, verdraengt {}). Ein Verlustzaehler fehlt.",
                st.frames_decoded,
                st.frames_skipped,
                st.frames_dropped,
                session.frames_never_drawn,
                session.takt.verdraengt(),
            );
        }
    }

    /// Setzt um, was im Fenster bedient wurde.
    fn apply_overlay_action(&mut self, id: u64, action: OverlayAction) {
        match action {
            OverlayAction::Volume(volume) => {
                // Denselben Weg wie die RPC-Operation nehmen, damit es nur EINE
                // Stelle gibt, die Optionen anwendet.
                self.apply_options(id, PlayerOptions { volume: Some(volume), ..Default::default() });
                // Nach vorne melden: die App haelt die Lautstaerke je Streamer
                // dauerhaft, und ohne diese Meldung waere ein Regeln im Fenster
                // beim naechsten Oeffnen wieder weg.
                self.stdout.send(&Event::new(
                    "player:option",
                    serde_json::json!({ "session": id, "volume": volume }),
                ));
            }
            OverlayAction::Fullscreen(on) => {
                let Some(session) = self.sessions.get(&id) else { return };
                session.window.set_fullscreen(
                    on.then(|| winit::window::Fullscreen::Borderless(None)),
                );
                session.window.request_redraw();
            }
            // Zurueck in die Kachel — dasselbe wie das Fensterkreuz (der
            // Reattach-Knopf existiert nur, wenn `can_reattach` ohnehin gilt,
            // s. `overlay/controls.rs`): gemeinsame Entscheidung in
            // `on_window_closed`, damit beide Wege nicht auseinanderlaufen
            // koennen.
            OverlayAction::Reattach => self.on_window_closed(id),
            // „Diesen Stream nicht mehr ansehen." Der Unterschied zu `Reattach`
            // liegt allein in der Meldung nach vorne: die App schliesst darauf
            // die Kachel, statt das Bild zurueckzuholen. Ohne diese
            // Unterscheidung war ein erzwungenes Fenster nicht loszuwerden — es
            // ging sofort wieder auf.
            OverlayAction::Close => {
                self.stdout.send(&Event::new(
                    "player:closeRequest",
                    serde_json::json!({ "session": id }),
                ));
                self.emit_state(id, SessionState::Closed, None);
                self.close_session(id);
            }
            // Der Chat lebt in der App. Hier nur die Bitte, ihn zu zeigen —
            // ihn im Fenster nachzubauen hiesse Nachrichtenliste, Eingabe und
            // eine eigene Serververbindung zu doppeln.
            OverlayAction::Chat => {
                self.stdout.send(&Event::new(
                    "player:chatRequest",
                    serde_json::json!({ "session": id }),
                ));
            }
            OverlayAction::ToggleStats => {
                let Some(session) = self.sessions.get_mut(&id) else { return };
                if let Some(overlay) = session.overlay.as_mut() {
                    overlay.toggle_stats();
                }
                session.window.request_redraw();
            }
            // Die Fernsteuerung beendet die APP, nicht das Fenster: dort liegt
            // die Sitzung mit dem Gegenueber, und nur sie kann sie sauber
            // aufloesen. Hier wird deshalb nur gemeldet — das anschliessende
            // `input_capture` mit `enabled: false` kommt von aussen zurueck und
            // schaltet Erfassung, Zeigerfang und Griff zusammen ab. Selbst
            // abzuschalten und die Meldung nur mitzuschicken waere schneller
            // und falsch: dann liefe die Sitzung beim Gegenueber weiter,
            // waehrend hier schon nichts mehr erfasst wird.
            // Der Wunsch nach einer Fernsteuerung — mehr nicht. Das Fenster
            // kennt weder den Host noch die Rechte im Kanal noch den Weg zum
            // Server; es meldet den Klick, und die App fragt an
            // (`$lib/player/client.ts` -> `remoteSession.request`).
            OverlayAction::RemoteRequest => {
                self.stdout.send(&Event::new(
                    "player:remoteRequest",
                    serde_json::json!({ "session": id }),
                ));
            }
            OverlayAction::RemoteDisconnect => {
                self.stdout.send(&Event::new(
                    "player:remoteDisconnect",
                    serde_json::json!({ "session": id }),
                ));
            }
            // Bildschirm-Wunsch aus dem Menue am Griff. Auch hier schaltet das
            // Fenster NICHTS selbst: es kennt weder das Geraet noch die Sitzung
            // beim Server. Die App weckt den Bildschirm und oeffnet sein
            // Fenster; kommt es, meldet sie die Liste hier neu.
            OverlayAction::RemoteScreen(monitor) => {
                self.stdout.send(&Event::new(
                    "player:remoteScreen",
                    serde_json::json!({ "session": id, "monitor": monitor }),
                ));
            }
            // Klick auf ein FREMDES, schon offenes Kaestchen der Bildschirm-
            // Karte: das Fenster dafuer existiert im selben Prozess bereits,
            // es muss nur nach vorne. Anders als bei `RemoteScreen` wird hier
            // nichts an die App gemeldet — sie kennt die Sitzungsnummern der
            // Fenster ohnehin nicht, nur dieser Prozess tut das.
            //
            // Gesucht wird ueber ALLE Sitzungen: dieses Fenster (das den
            // Klick ausgeloest hat) kennt nur seine EIGENE Kopie von
            // `remote_screens` und weiss nicht, welche Sitzungsnummer der
            // andere Bildschirm traegt. Gefunden ist die Sitzung, deren
            // eigene Liste den Bildschirm als `dieses_fenster` fuehrt.
            OverlayAction::RemoteScreenFocus(monitor) => {
                let ziel = self.sessions.values().find(|s| {
                    s.fern_schirme.iter().any(|schirm| schirm.index == monitor && schirm.dieses_fenster)
                });
                if let Some(session) = ziel {
                    session.window.focus_window();
                }
            }
            // Knopf „Fenster wie drueben anordnen". Die Rechnung UND das
            // Anwenden (Fenster-Objekte, Wayland-Riegel) liegen in
            // `anordnen::fenster_anordnen` — hier wird nur aufgefangen.
            OverlayAction::FensterAnordnen => self.fenster_anordnen(id),
        }
    }

    fn emit_state(&self, id: u64, state: SessionState, error: Option<&str>) {
        let mut data = serde_json::json!({ "session": id, "state": state.as_str() });
        if let (Some(err), Some(obj)) = (error, data.as_object_mut()) {
            obj.insert("error".into(), err.into());
        }
        self.stdout.send(&Event::new("player:state", data));
    }

    /// Fenster wurde OHNE den expliziten „Schliessen"-Knopf beendet — Titelleisten-
    /// Kreuz, Alt+F4, Fenstermanager, oder der Reattach-Knopf. Anders als bei
    /// `OverlayAction::Close` gibt es hier keine ausdrueckliche „nicht mehr
    /// ansehen"-Absicht, also muss aus `can_reattach` folgen, was gemeint ist:
    /// Steht ein Zurueck zur Verfuegung, heisst das Ende nur „Bild zurueck in
    /// die Kachel" (die App holt es beim `closed`-Zustand automatisch ab, kein
    /// `closeRequest` noetig). Bei einem erzwungenen Fenster (10 bit, kein
    /// Zurueck moeglich) gibt es dieses Zurueck nicht — bliebe die Meldung hier
    /// gleich, wuerde die App weiter `active` halten und das Fenster ueber
    /// `ensure()` prompt neu oeffnen (der eigentliche Fehler). EINE Stelle fuer
    /// die Entscheidung, damit OS-Schliessweg und Reattach-Knopf nicht
    /// auseinanderlaufen koennen.
    fn on_window_closed(&mut self, id: u64) {
        let can_reattach = self.sessions.get(&id).is_some_and(|s| s.can_reattach);
        if !can_reattach {
            self.stdout.send(&Event::new(
                "player:closeRequest",
                serde_json::json!({ "session": id }),
            ));
        }
        self.emit_state(id, SessionState::Closed, None);
        self.close_session(id);
    }

    fn close_session(&mut self, id: u64) {
        // VOR dem Entfernen: danach gibt es die Warteschlange nicht mehr.
        self.eingabe_raeumen(id);
        // Dasselbe fuer die Tastenkuerzel des Fenstermanagers. `Halter::drop`
        // faenge es zwar auch auf — aber nur ohne das `flush` danach, und der
        // Nutzer soll seine Kuerzel jetzt zurueckbekommen und nicht beim
        // naechsten Durchgang von winit.
        if let Some(session) = self.sessions.get_mut(&id) {
            self.tastensperre.freigeben(&mut session.tastensperre);
        }
        if let Some(session) = self.sessions.remove(&id) {
            self.by_window.remove(&session.window.id());
            let tx = session.commands;
            self.runtime.spawn(async move {
                let _ = tx.send(SessionCommand::Stop).await;
            });
        }
    }

    fn on_session_event(&mut self, id: u64, event: SessionEvent) {
        let Some(session) = self.sessions.get_mut(&id) else { return };
        match event {
            SessionEvent::Frame(frame) => {
                // Bei Pause bleibt das zuletzt gezeigte Bild stehen, die
                // Verbindung laeuft aber weiter — beim Fortsetzen ist man
                // sofort wieder live.
                if session.options.paused.unwrap_or(false) {
                    return;
                }
                // Ueber den Ausgabe-Takt einreihen statt direkt uebernehmen.
                // In der Vorgabe (30 ms Vorhalt) liegt das Bild danach
                // wirklich eine Weile, und der zweite Weg (`about_to_wait`)
                // holt es ab. Nur bei ausdruecklich abgeschaltetem Vorhalt ist
                // es im selben Zug wieder faellig — hier stand bis zum
                // 2026-08-06 „bei ausgeschaltetem Vorhalt — der Vorgabe —",
                // und das trifft seit dem 2026-08-05 nicht mehr zu.
                let jetzt = std::time::Instant::now();
                session.takt.einreihen(frame, jetzt);
                self.abliefern(id, jetzt);
            }
            SessionEvent::Stats(stats) => {
                session.stats = stats;
                self.log_stats_if_due(id);
                let Some(session) = self.sessions.get_mut(&id) else { return };
                if let Some(overlay) = session.overlay.as_mut() {
                    overlay.mark_stats_dirty();
                }
                // Nur dann: bei ausgeblendetem Overlay traegt ein Neuzeichnen
                // nichts bei, und das Bild treibt seine Durchgaenge selbst.
                if session.overlay.as_ref().is_some_and(Overlay::wants_redraw) {
                    session.window.request_redraw();
                }
            }
            SessionEvent::Playing { decoder, hardware } => {
                session.decoder = decoder;
                session.hardware = hardware;
                session.state = SessionState::Playing;
                // **Was WIRKLICH gilt, nicht was eingestellt wurde.** Mehrere
                // Werte hier sind „die Vorgabe, ausser …": der Vorhalt kuerzt
                // sich bei hoher Bildrate selbst (`takt::wirksamer_vorhalt`),
                // die Ringgroesse schneidet die Speichergrenze zu
                // (`zerocopy::bruecke`), und das Fassungsvermoegen des Kanals
                // haengt an einer Umgebungsvariablen. Am 2026-08-07 musste ich
                // fuer jeden dieser Werte den Quelltext lesen, um zu wissen, was
                // der laufende Player gerade tut.
                //
                // EINMAL je Sitzung, nicht je Sekunde: es aendert sich nicht,
                // und jede wiederkehrende Zeile kostet den Diagnose-Upload
                // Reichweite (er traegt nur die letzten 512 KB).
                eprintln!(
                    "pulse-player: Sitzung {id}: wirksam — Vorhalt {} ms{}, Jitter {} ms, \
                     Kanal {} Bilder, Decoder {} ({})",
                    session.takt.wirksamer_vorhalt().as_millis(),
                    if session.takt.aktiv() { "" } else { " (Takt aus)" },
                    session.options.jitter_ms.unwrap_or(crate::proto::JITTER_MS_VORGABE),
                    ev_kanal_groesse(),
                    session.decoder,
                    if session.hardware { "Hardware" } else { "Software" },
                );
                self.emit_state(id, SessionState::Playing, None);
            }
            SessionEvent::Ended { reason, failed } => {
                let state = if failed { SessionState::Failed } else { SessionState::Closed };
                self.emit_state(id, state, failed.then_some(reason.as_str()));
                self.close_session(id);
            }
        }
    }

    /// Alles vom Ausgabe-Takt uebernehmen, was faellig ist.
    fn abliefern(&mut self, id: u64, jetzt: std::time::Instant) {
        let Some(session) = self.sessions.get_mut(&id) else { return };
        let (faellig, uebersprungen) = session.takt.faellig(jetzt);
        session.frames_never_drawn += uebersprungen;
        if let Some(frame) = faellig {
            self.uebernehmen(id, frame);
        }
    }

    /// Ein faelliges Bild zur Anzeige stellen.
    fn uebernehmen(&mut self, id: u64, frame: Box<decode::DecodedFrame>) {
        // Wartet noch ein ungezeichnetes Bild, dann zeichne es JETZT, statt es
        // zu verwerfen: winit fasst mehrere `request_redraw` eines Durchlaufs
        // zu EINEM Zeichnen zusammen, treffen also zwei Bilder im selben
        // Durchlauf ein, ueberlebte vorher nur das zweite. Gemessen gingen so
        // bei 144 ankommenden Bildern rund 95 je Sekunde verloren, obwohl ein
        // Durchgang nur 0,4 ms braucht.
        //
        // Das passiert VOR der Uebernahme der Farbwerte des neuen Bildes —
        // sonst wuerde das alte Bild mit fremdem Wertebereich oder fremder
        // Matrix gezeichnet (sichtbar falsche Farben, s. die
        // Pause-Begruendung oben).
        if self.sessions.get(&id).is_some_and(|s| s.pending.is_some()) {
            let actions = self.draw(id);
            for action in actions {
                self.apply_overlay_action(id, action);
            }
            // Kommt der Player trotzdem nicht mit (sehr hohe Bildrate,
            // langsame GPU), bleibt das Verwerfen der Ausweg — dann aber
            // gezaehlt.
            if let Some(session) = self.sessions.get_mut(&id) {
                if session.pending.is_some() {
                    session.frames_never_drawn += 1;
                }
            }
        }
        let Some(session) = self.sessions.get_mut(&id) else { return };
        session.last_frame_at = Some(std::time::Instant::now());
        session.full_range = frame.full_range;
        session.farbe = frame.farbe;
        session.pending = Some(frame);
        session.window.request_redraw();
    }
}

impl ApplicationHandler<UserEvent> for App {
    fn resumed(&mut self, _event_loop: &ActiveEventLoop) {}

    /// Die Ereignisschleife endet.
    ///
    /// **Die einzige Stelle, an der die Tastenkuerzel-Sperre noch geordnet
    /// abgebaut werden kann.** Danach gibt winit seine Wayland-Anzeige frei —
    /// und zwar bevor `App` selbst faellt, weil `run_app` die Schleife
    /// verschlingt (`main.rs`). Wer den Abbau dem `Drop` von `App`
    /// ueberliesse, griffe auf eine Anzeige zu, die es nicht mehr gibt.
    ///
    /// Erst jede offene Sperre einzeln aufheben — die Kuerzel des Nutzers
    /// muessen zurueck, auch wenn der Player aus einer laufenden Fernsteuerung
    /// heraus beendet wird —, dann die Verbindung.
    fn exiting(&mut self, _event_loop: &ActiveEventLoop) {
        for session in self.sessions.values_mut() {
            self.tastensperre.freigeben(&mut session.tastensperre);
        }
        self.tastensperre.schliessen();
        // Review C3: derselbe geordnete Abbau wie bei `tastensperre` — ohne
        // dieses Rufziel wuerden die Wayland-Objekte des Zugs (Verbindung,
        // Warteschlange, Proxys) beim Fallen von `self` ihre Zerstoerung auf
        // einer Anzeige versuchen, die winits `run_app` bereits freigegeben
        // hat (s. `wayland_zug`-Modulkopf).
        self.wayland_zug.schliessen();
    }

    /// Weckruf fuer den Ausgabe-Takt.
    ///
    /// Die Schleife steht sonst auf `ControlFlow::Wait` (`main.rs`) und schlaeft,
    /// bis ein Ereignis kommt — ein wartendes Bild ist aber kein Ereignis. Ohne
    /// diese Stelle laege es bis zum naechsten RTP-Paket herum, und der Takt
    /// waere wieder der der Ankunft.
    ///
    /// **Der Schnellweg zuerst.** Diese Methode laeuft bei JEDEM
    /// Schleifendurchlauf, und das sind ueber tausend je Sekunde (jedes
    /// Statistik-Ereignis weckt den Faden). Solange nichts wartet, kostet sie
    /// einen Blick auf eine leere Warteschlange je Sitzung und sonst nichts.
    ///
    /// **Hier stand bis zum 2026-08-06 „und das ist der Vorgabefall mit
    /// ausgeschaltetem Vorhalt". Das ist falsch, und es dreht die Aussage um:**
    /// die Vorgabe ist ein Vorhalt (seit 2026-08-07 30 ms), damit ist die
    /// Warteschlange im laufenden Betrieb praktisch NIE leer — der Schnellweg
    /// ist zum Ausnahmefall geworden und die `Vec` weiter unten faellt bei
    /// jedem Durchlauf an. Wirkung minimal, aber die Begruendung stimmt so
    /// nicht mehr.
    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        let _belegt = diagnose::Belegt::neu();
        let jetzt = std::time::Instant::now();
        // Eingabe-Frames zuerst und VOR dem Schnellweg unten: sie fallen auch
        // an, wenn kein einziges Bild wartet (Standbild, abgerissener Strom),
        // und ein zurueckgehaltener Termin muss in den Kontrollfluss eingehen —
        // sonst bliebe die letzte Bewegung einer Geste liegen, bis zufaellig
        // das naechste Ereignis eintrifft.
        let eingabe_termin = self.eingaben_abgeben(jetzt);
        if self.sessions.values().all(|s| s.takt.leer()) {
            event_loop.set_control_flow(match eingabe_termin {
                Some(t) => winit::event_loop::ControlFlow::WaitUntil(t),
                None => winit::event_loop::ControlFlow::Wait,
            });
            return;
        }
        // Kennungen erst einsammeln: `abliefern` leiht die Sitzung erneut aus
        // (es zeichnet), eine laufende Iteration ueber `self.sessions` waere
        // damit nicht vertraeglich. Die Sammlung kostet nur, wenn ueberhaupt
        // etwas wartet — der Schnellweg oben ist vorher schon zurueckgekehrt.
        let ids: Vec<u64> = self.sessions.keys().copied().collect();
        for id in ids {
            self.abliefern(id, jetzt);
        }
        let naechster = self
            .sessions
            .values()
            .filter_map(|s| s.takt.naechster_termin())
            .chain(eingabe_termin)
            .min();
        event_loop.set_control_flow(match naechster {
            Some(t) => winit::event_loop::ControlFlow::WaitUntil(t),
            None => winit::event_loop::ControlFlow::Wait,
        });
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: UserEvent) {
        let _belegt = diagnose::Belegt::neu();
        match event {
            UserEvent::Request(req) => self.handle_request(*req, event_loop),
            UserEvent::StdinClosed => {
                // Gleicher Abbau wie bei der `shutdown`-Operation: stdin kann
                // auch ohne sie wegfallen (Electron stuerzt ab, Prozess wird
                // beendet), und dann muessen die Sitzungen genauso sauber
                // schliessen.
                self.stop_all_sessions();
                event_loop.exit();
            }
            UserEvent::Session { id, event, gesendet } => {
                let verzug = gesendet.elapsed().as_micros() as u64;
                diagnose::hoch(&diagnose::ANGEKOMMEN, 1);
                diagnose::hoch(&diagnose::GES_EMPFANGEN, 1);
                diagnose::hoch(&diagnose::WECK_SUM_US, verzug);
                diagnose::hoechstens(&diagnose::WECK_MAX_US, verzug);
                diagnose::hoch(&diagnose::WECK_N, 1);
                self.on_session_event(id, event)
            }
        }
    }

    /// Rohe Zeigerbewegung — die einzige Quelle fuer relative Eingaben.
    ///
    /// **Kommt NICHT als Fensterereignis**: bei gefangenem Zeiger steht der
    /// Zeiger still, `CursorMoved` schweigt, und nur `DeviceEvent::MouseMotion`
    /// traegt die Differenz. Geraeteereignisse gehoeren zu keinem Fenster,
    /// deshalb bekommen sie alle Sitzungen mit gefangenem Zeiger — praktisch
    /// eine, weil das Fangen den Tastaturfokus voraussetzt.
    fn device_event(
        &mut self,
        _event_loop: &ActiveEventLoop,
        _device_id: winit::event::DeviceId,
        event: winit::event::DeviceEvent,
    ) {
        let winit::event::DeviceEvent::MouseMotion { delta } = event else { return };
        for session in self.sessions.values_mut() {
            if session.eingabe.zeigerfang() {
                session.eingabe.zeigerbewegung(delta.0, delta.1);
            }
        }
    }

    fn window_event(
        &mut self,
        _event_loop: &ActiveEventLoop,
        window_id: WindowId,
        event: WindowEvent,
    ) {
        let _belegt = diagnose::Belegt::neu();
        let Some(&id) = self.by_window.get(&window_id) else { return };
        // **VOR der veraenderlichen Ausleihe.** Die Nachbarschaft braucht alle
        // Sitzungen zugleich, `get_mut` gleich darunter genau eine — beides
        // zusammen lehnt der Borrow-Checker ab. Kopiert werden nur Zahlen.
        //
        // Nur erfassende Fenster kommen hinein: ein Fenster ohne Erfassung hat
        // beim Host keinen Handschlag, und Frames dorthin wuerden dort
        // verworfen. Das waere schlimmer als nichts zu tun — jede verworfene
        // Nachricht gibt beim Host ALLES Gedrueckte frei und risse die
        // Zieh-Geste ab.
        // **Nur wenn dieses Fenster ueberhaupt erfasst.** `window_event` laeuft
        // bei jeder Mausbewegung — bis zu 144-mal je Sekunde. Eine Liste zu
        // bauen und zu sortieren, waehrend die Fernsteuerung aus ist (die
        // Vorgabe), waere genau die Art Kosten, die der Kommentar weiter unten
        // ausdruecklich vermeidet („kostet das nur dieses `if`").
        //
        // **Und nur dieselbe Fernsteuerungs-Sitzung.** Fensternummern und
        // Plaetze wiederholen sich zwischen Sitzungen (Plaetze zaehlen je Host
        // wieder bei 0), die Sitzungskennung nicht — ohne diesen Filter koennte
        // ein Fenster einer FREMDEN Steuerung eine Platznummer beisteuern, die
        // drueben einen ganz anderen Bildschirm meint.
        // **Ganz vorne, vor jeder Auswertung des Ereignisses:** liefert winit
        // wieder ein Zeigerereignis, ist ein laufender Wayland-Zug vorbei (s.
        // `wayland_zug`-Modulkopf, „Stolperstein 2"). Muss VOR
        // `Erfassung::on_window_event` laufen — sonst stuende ein Druck, der
        // gleich einen neuen Zug beginnt, schon in `knoepfe_unten`, wenn das
        // Ende des ALTEN Zugs alles Gedrueckte freigibt, und ginge am fernen
        // Rechner sofort wieder hoch. Auf Nicht-Linux und auf X11 ein
        // Nichtstun.
        self.wayland_zug_griff_pruefen(&event);
        // Ob DIESER Druck bei der Erfassung ankam — das Tor fuer den Zug
        // ueber die Fenstergrenze weiter unten (Review M-a).
        let mut druck_angenommen = false;
        let eigene = self.sessions.get(&id).filter(|s| s.eingabe.aktiv());
        let erfasst = eigene.is_some();
        // **Besitzen, nicht ausleihen:** eine geliehene Kennung hielte die
        // Ausleihe auf `self.sessions` bis hinter das `get_mut` weiter unten.
        let eigene_sitzung = eigene.and_then(|s| s.eingabe.sitzung()).map(str::to_owned);
        let eigene_skalierung = eigene.map(|s| s.window.scale_factor());
        let mut kandidaten: Vec<crate::fernsteuerung::Nachbar> = if !erfasst {
            Vec::new()
        } else {
            self
            .sessions
            .iter()
            .filter(|(_, s)| {
                s.eingabe.aktiv()
                    && s.eingabe.sitzung() == eigene_sitzung.as_deref()
                    // **Nur auf macOS ein Skalierungs-Riegel.** Dort kuerzt sich die
                    // Differenz zweier Fensterlagen nur bei gleicher Skalierung, sonst
                    // nicht (Begruendung an `skalierung_taugt`). Auf Windows und X11 ist
                    // der Riegel eine no-op — ein gemeinsamer Pixelraum bedeutet dort
                    // NICHT gleichen `scale_factor()` je Fenster (unterschiedliche
                    // Monitor-DPI ist dort ueblich), und ein Riegel darauf schaltete das
                    // Ziehen ueber die Fenstergrenze genau dort ab.
                    //
                    // Lieber gar nicht zielen als falsch: auf macOS faellt ein ungleich
                    // skaliertes Fenster aus der Nachbarschaft, und es bleibt beim
                    // Verhalten von vor diesem Zweig.
                    && skalierung_taugt(&s.window, eigene_skalierung)
            })
            .filter_map(|(sid, s)| {
                // Wayland gibt Fensterlagen grundsaetzlich nicht heraus. Dann
                // gibt es keine Nachbarschaft, und alles bleibt beim eigenen
                // Bild — bewusst still, es ist kein Fehler, sondern eine
                // Eigenschaft der Oberflaeche.
                let pos = s.window.inner_position().ok()?;
                let fenster = s.window.inner_size();
                let lage = crate::fernsteuerung::Bildlage::neu(
                    (fenster.width, fenster.height),
                    (s.stats.width, s.stats.height),
                    render::zoom_ausschnitt(&s.options),
                )?;
                Some(crate::fernsteuerung::Nachbar {
                    id: *sid,
                    slot: s.eingabe.slot(),
                    ursprung: (f64::from(pos.x), f64::from(pos.y)),
                    lage,
                })
            })
            .collect()
        };
        crate::fernsteuerung::vorrang(&mut kandidaten, id, self.zuletzt_fokussiert);
        // Die eigene Lage getrennt: sie macht aus fensterlokalen Zeigerpunkten
        // Desktop-Punkte. Fehlt sie, bleibt die Nachbarschaft ungenutzt.
        let eigener_ursprung = kandidaten
            .iter()
            .find(|n| n.id == id)
            .map(|n| n.ursprung);
        if let Some(session) = self.sessions.get_mut(&id) {
            // egui zuerst sehen lassen: es braucht auch Groessen- und
            // Skalierungswechsel. Fuer die vier Faelle unten (Fokus,
            // Schliessen, Groesse, Zeichnen) bleibt sein `consumed` bewusst
            // unbeachtet — die gehoeren uns, egui reklamiert nur Zeiger- und
            // Tastenereignisse. Die Eingabe-Erfassung dagegen fragt danach
            // (s. unten).
            let antwort = session.overlay.as_mut().map_or(
                crate::overlay::Ereignisantwort::NICHTS,
                |o| o.on_window_event(&session.window, &event),
            );
            // Nur wenn gerade KEINE Bilder fliessen — sonst zeichnet das
            // naechste Bild das Overlay ohnehin mit (s. `FRAME_FLOW_WINDOW`).
            let frames_flowing =
                session.last_frame_at.is_some_and(|t| t.elapsed() < FRAME_FLOW_WINDOW);
            if antwort.durchgang && !frames_flowing {
                session.window.request_redraw();
            }
            // **Der zweite Abnehmer, neben egui.** Fuer Tasten ohne Ruecksicht
            // auf dessen `consumed` — es geht nicht um die Bedienleiste,
            // sondern darum, was der Steuernde am fernen Rechner tut. Nur der
            // ZEIGER wird geteilt: die Leiste liegt ueber dem Bild, und wer an
            // ihrem Lautstaerkeregler zieht, will nicht zugleich am fernen
            // Rechner klicken (`antwort.verbraucht`, s. Wire-Spec „auch Knopf
            // und Rad gehoeren ins Bild"). Ist die Erfassung aus (die Vorgabe),
            // kostet das nur dieses `if`.
            if session.eingabe.aktiv() {
                // **Zweite Berechnung derselben Bildlage.** Die erste steckt
                // oben in `kandidaten` (als `Nachbar::lage` fuer dieses
                // Fenster) und wird hier absichtlich nicht wiederverwendet —
                // beide lesen dieselben Felder (`window.inner_size()`,
                // `stats.width/height`, `zoom_ausschnitt(&options)`) aus
                // DERSELBEN `session` im selben synchronen Durchlauf von
                // `window_event`, dazwischen laeuft nur egui. Sie koennen
                // deshalb heute nicht auseinanderlaufen. Das ist eine
                // Zusage, kein Beweis von hier aus: schoebe jemand zwischen
                // dem Einsammeln oben und dieser Stelle einen `.await`, einen
                // Resize-Handler oder sonst eine Mutation an `session.stats`/
                // `session.options`/der Fenstergroesse ein, faellt die
                // Zusage — und die eigene Position in `kandidaten` (fuer die
                // Nachbarn) wich dann von der hier verwendeten `lage` ab.
                let fenster = session.window.inner_size();
                let lage = crate::fernsteuerung::Bildlage::neu(
                    (fenster.width, fenster.height),
                    (session.stats.width, session.stats.height),
                    render::zoom_ausschnitt(&session.options),
                );
                session.eingabe.nachbarschaft_setzen(eigener_ursprung, kandidaten);
                druck_angenommen =
                    session.eingabe.on_window_event(&event, lage, antwort.verbraucht);
            }
        }
        // Wayland: der Zug ueber die Fenstergrenze beginnt im selben Zug, in
        // dem eben `Erfassung::knopf(..., true)` lief (s. `on_window_event`
        // oben, MouseInput-Zweig) — NACH der Ausleihe von `session` oben
        // (die braucht `wayland_zug_beginnen` selbst wieder, ueber `&mut
        // self`).
        //
        // **Das Tor ist DIESER Druck, nicht das Umfeld** (Review I2/M-a):
        // `on_window_event` meldet zurueck, ob es ihn angenommen hat. `aktiv()`
        // sagte nur, dass die Erfassung eingeschaltet ist;
        // `irgendein_knopf_unten()` nur, dass irgendetwas unten ist — bei
        // einem schon gehaltenen anderen Knopf oeffnete auch ein VERWORFENER
        // Druck (auf dem Griff, auf dem Lautstaerkeregler, ausserhalb des
        // Bildes) das Tor. `start_drag` haette dem GANZEN Fenster den
        // Zeigerfokus fuer die Zug-Dauer entzogen, und egui haette danach
        // weder Bewegung noch Loslassen gesehen: der Griff waere nicht mehr
        // verschiebbar, der Regler nicht mehr ziehbar gewesen, genau waehrend
        // einer laufenden Fernsteuerung. Auf Nicht-Linux und auf X11 ein
        // Nichtstun (s. `wayland_zug`-Modulkopf).
        if druck_angenommen {
            self.wayland_zug_beginnen(id);
        }
        match event {
            // Der Zeigerfang ueberlebt den Fokuswechsel NICHT (s.
            // `App::fokus_gewechselt`).
            WindowEvent::Focused(fokus) => self.fokus_gewechselt(id, fokus),
            WindowEvent::CloseRequested => {
                // Der Nutzer hat das Fenster ueber das OS geschlossen (Kreuz,
                // Alt+F4, Fenstermanager) — dieselbe Entscheidung wie beim
                // Reattach-Knopf, s. `on_window_closed`.
                self.on_window_closed(id);
            }
            WindowEvent::Resized(size) => {
                if let Some(session) = self.sessions.get_mut(&id) {
                    if let Some(r) = session.renderer.as_mut() {
                        r.resize(size.width, size.height);
                    }
                    session.window.request_redraw();
                }
            }
            WindowEvent::RedrawRequested => {
                let actions = self.draw(id);
                for action in actions {
                    self.apply_overlay_action(id, action);
                }
            }
            _ => {}
        }
    }
}

