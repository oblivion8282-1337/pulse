//! stdio-JSON-RPC — identisches Rahmenformat wie die HQ-Capture-Sidecars.
//!
//! Eine JSON-Zeile pro Nachricht:
//!   Request   `{"op": "...", "id": 1, ...}`      (`id` optional)
//!   Response  `{"id": 1, "ok": true, ...}`       (`error` statt Nutzdaten bei `ok=false`)
//!   Event     `{"ev": "...", ...}`               (kein `id`, kein `ok`)
//!
//! WICHTIG: stdout gehoert ausschliesslich dem Protokoll. Jede Diagnose geht
//! nach stderr, sonst zerlegt sie den Frame-Strom auf der Electron-Seite.

use serde::{Deserialize, Serialize};

/// Eingehender Request. `op` entscheidet, welche Felder gelesen werden.
#[derive(Debug, Deserialize)]
pub struct Request {
    pub op: String,
    #[serde(default)]
    pub id: Option<i64>,

    // --- open ---
    /// WHEP-URL inklusive `?token=` (wird unveraendert durchgereicht).
    #[serde(default)]
    pub url: Option<String>,
    /// Auffangnetz: ein zweiter, sehr kleiner Strom, in dem JEDES Bild ein
    /// Vollbild ist. Er wird im selben Fenster gezeigt, solange der Hauptstrom
    /// kein Bild liefert — beim Beitritt und nach Paketverlust.
    ///
    /// Warum das gebraucht wird: Im Intra-Refresh-Betrieb hat der Hauptstrom
    /// keine Vollbilder mehr. Wer einsteigt oder den Faden verliert, muss
    /// einen vollen Auffrisch-Durchlauf (~2 s) abwarten, bis sein Bild wieder
    /// stimmt — und saehe in dieser Zeit Schwarz oder Muell. Ein
    /// angefordertes Vollbild wuerde das abkuerzen, ginge aber an ALLE
    /// Zuschauer und stoert jeden, der gerade zuschaut. Das Netz laesst die
    /// Kosten beim Verursacher.
    #[serde(default)]
    pub fallback_url: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    /// Kann die App das Bild ueberhaupt selbst zeigen? Bei AV1 10 bit nicht —
    /// Chromium legt seinen Puffer immer als 8 bit an (gemessen 2026-07-26).
    /// Steht hier `false`, bietet die Leiste kein „wieder in der App zeigen"
    /// an; das waere eine Zusage, die niemand halten kann.
    #[serde(default)]
    pub can_reattach: Option<bool>,
    /// Index aus `list_monitors`; ohne Angabe entscheidet der Compositor.
    /// Noch nicht ausgewertet — Fensterplatzierung folgt.
    #[allow(dead_code)]
    #[serde(default)]
    pub monitor: Option<usize>,
    #[serde(default)]
    pub fullscreen: Option<bool>,

    // --- close / set_option / stats / screenshot / clip ---
    #[serde(default)]
    pub session: Option<u64>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub value: Option<serde_json::Value>,
    /// Zielpfad fuer `record`/`clip`/`screenshot`. Hier stand bis 2026-08-08
    /// "beide Ops sind noch nicht gebaut, die Felder stehen aber schon im
    /// Protokoll" — das ist falsch: `record` und `clip` sind laengst verdrahtet
    /// (`app/requests.rs`) und schreiben mit diesem Pfad in das Dateisystem
    /// (geprueft in `recorder::pruefe_ziel`). Nur `screenshot` fehlt noch.
    #[allow(dead_code)]
    #[serde(default)]
    pub path: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    pub seconds: Option<f64>,

    // --- input_capture (Fernsteuerung, s. `crate::fernsteuerung`) ---
    /// Erfassung an oder aus. **Ohne Angabe gilt `false`** — der Schalter fuer
    /// fremde Eingabe darf sich nicht aus einem fehlenden Feld ergeben.
    #[serde(default)]
    pub enabled: Option<bool>,
    /// Welcher der gleichzeitig laufenden Streams des Hosts gemeint ist. Steht
    /// in der Huelle der Leitung, nicht im Frame (s. Wire-Spec v2).
    #[serde(default)]
    pub slot: Option<u32>,
    /// Zeiger fangen (Spiele): dann gehen relative statt absoluter Bewegungen
    /// ueber die Leitung, und das Fenster versteckt den Zeiger.
    #[serde(default)]
    pub pointer_lock: Option<bool>,
    /// Kennung der Fernsteuerungs-Sitzung, fuer die erfasst wird.
    ///
    /// Sie geht **nicht** ueber die Leitung — der Player deutet sie nicht und
    /// vergleicht sie nur mit der vorigen. Sie beantwortet genau eine Frage:
    /// gehen liegengebliebene Hoch-Ereignisse des vorigen Stroms noch an
    /// dasselbe Ziel, oder haengt inzwischen eine andere Sitzung am Fenster?
    /// Ohne sie gingen die Tastenfreigaben einer beendeten Sitzung mit der
    /// Kennung der naechsten hinaus (s. `fernsteuerung::Erfassung::einschalten`).
    #[serde(default)]
    pub remote_session: Option<String>,

    // --- remote_transport ---
    /// Anzeigetext fuer den Eingabeweg der Fernsteuerung („Direktverbindung",
    /// „Serverweg — …"). Der Player DEUTET ihn nicht, er zeigt ihn im
    /// Statistik-Feld — der Zustand lebt im Renderer (`p2p.ts`), und eine
    /// zweite Zustandsmaschine hier koennte nur auseinanderlaufen.
    #[serde(default)]
    pub transport: Option<String>,

    // --- remote_pointer ---
    /// Form des Host-Zeigers als Name aus der CSS-Zeigerliste („text",
    /// „ns-resize", …). Ersetzt beim Steuernden, was das Cursor-Echo aus dem
    /// Bild nimmt (`web/src/lib/remote/zeigerform.ts`). Ein **Name** und kein
    /// Bild: gezeichnet wird der lokale Zeiger, also ohne Verzoegerung und in
    /// der Zeigergroesse des Steuernden — und winit uebersetzt denselben Namen
    /// auf jeder Plattform in deren eigene Form.
    #[serde(default)]
    pub shape: Option<String>,

    // --- remote_anfragbar ---
    /// Darf dieser Zuschauer eine Fernsteuerung anfragen? Der Player zeigt
    /// daraufhin einen Knopf in der Bedienleiste und meldet den Klick als
    /// `player:remoteRequest` — er fragt NICHT selbst an: Rechte, Host und
    /// Serververbindung kennt allein die App.
    #[serde(default)]
    pub anfragbar: Option<bool>,

    // --- remote_screens ---
    /// Die Bildschirme des ferngesteuerten Rechners fuers Menue am Griff.
    /// Reine Anzeige — was ein Klick ausloest, entscheidet die App
    /// (`web/src/lib/devices/`).
    #[serde(default)]
    pub screens: Option<Vec<crate::overlay::Schirm>>,

    /// Startwerte fuer `open` — dieselben Schluessel wie bei `set_option`.
    #[serde(default)]
    pub options: Option<PlayerOptions>,
}

/// Alles, was zur Laufzeit umgeschaltet werden kann.
///
/// `None` heisst durchgehend "unveraendert lassen", nicht "Standardwert" —
/// deshalb ist jedes Feld optional und wird einzeln angewendet.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct PlayerOptions {
    /// Geduld des Jitter-Puffers BEI EINER LUECKE, in Millisekunden — **kein
    /// Fuellstand und kein Vorhalt**: ohne Luecke gibt `jitter.rs::poll` sofort
    /// frei. Der Wert entscheidet allein, wie lange auf ein fehlendes Paket
    /// gewartet wird, bevor die Luecke gemeldet wird; er muss deshalb ueber der
    /// Umlaufzeit liegen, sonst kommt jede NACK-Nachlieferung zu spaet.
    /// Vorgabe und Begruendung: [`JITTER_MS_VORGABE`].
    ///
    /// Chromiums WebRTC-Puffer laesst sich nicht so einstellen — das ist einer
    /// der Gruende fuer diesen Player.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jitter_ms: Option<u32>,

    /// Debanding-Staerke 0.0 (aus) bis 1.0. Glaettet Kompressions-Banding in
    /// dunklen Verlaeufen. Wirkt auch bei 8-bit-Quellen und ist damit der
    /// wirksamste Bildhebel, ohne die Encode-Kette anzufassen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deband: Option<f32>,

    /// Dithering beim Quantisieren auf das Ausgabeformat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dither: Option<bool>,

    /// Zoomfaktor (1.0 = ganzes Bild). Skaliert aus dem dekodierten Vollbild,
    /// nicht aus einem bereits herunterskalierten Fensterinhalt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zoom: Option<f32>,
    /// Bildmittelpunkt beim Zoomen, jeweils 0.0-1.0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pan_x: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pan_y: Option<f32>,

    /// 0.0-1.0 regulaer, darueber Verstaerkung (entspricht `volumeBoost.ts`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume: Option<f32>,
    /// Positiv = Ton spaeter (entspricht `AvOffsetSlider.svelte`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub av_offset_ms: Option<i32>,

    /// Standbild ohne Verbindungsabbruch: die Sitzung laeuft weiter, nur die
    /// Darstellung friert ein. Beim Fortsetzen ist man sofort wieder live.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused: Option<bool>,

    /// Hardware-Decode erzwingen/verbieten. `None` = automatisch (Hardware
    /// zuerst, Software als Rueckfall).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hwdec: Option<bool>,

    /// Vorhalt des Ausgabe-Takts in Millisekunden. `0` = aus.
    ///
    /// **Was das tut und was `jitter_ms` NICHT tut.** Ist der Wert gesetzt,
    /// zeigt der Player ein Bild zu dem Zeitpunkt, den sein RTP-Zeitstempel
    /// nennt, statt sofort bei der Ankunft — die Uhr des Senders gibt dann den
    /// Takt vor. `jitter_ms` daneben ist ausschliesslich die Wartezeit bei
    /// einem FEHLENDEN Paket; ohne Luecke gibt `jitter.rs::poll` sofort frei.
    /// Vor dieser Option gab es also im ganzen Programm keine Stelle, an der
    /// ein Bild auf seinen Zeitpunkt gewartet haette.
    ///
    /// **Vorgabe 30 ms — seit 2026-08-07.** Beim Einbau stand hier "aus", weil
    /// der Vorhalt echte Verzoegerung kostet; am 2026-08-05 wurde daraus 60 ms,
    /// weil eine Messung gegen die Produktion zeigte, dass der Takt die
    /// Ungleichmaessigkeit halbiert (Messakte
    /// `ausgabetakt-2026-08-05-windows-produktion.json`: zu spaete Bilder
    /// 24/30/22 gegen 3/15/0, Netz bis Schirm 4,5 gegen 59,5 ms).
    ///
    /// **Diese Messung deckte nur 0 und 60 ab, und dazwischen lag die
    /// Antwort.** Nachgeholt am 2026-08-07, 1080p bei 144 fps, sonst alles
    /// gleich (Akte `player-2026-08-07-ausgabetakt-warteschlange.json`):
    ///
    /// | Vorhalt | Netz bis Schirm | zu spaet je Sekunde |
    /// |---|---|---|
    /// | 60 ms | 61 ms | 2-5 |
    /// | **30 ms** | **33 ms** | **2-4** |
    /// | 20 ms | 21-27 ms | 3-13 |
    ///
    /// Dreissig halbiert die Verzoegerung, ohne dass die Gleichmaessigkeit
    /// leidet — die 60 waren schlicht mehr, als der Zweck braucht. Bei 20 faengt
    /// es an zu broeckeln, das ist die Untergrenze und nicht mehr die Vorgabe.
    ///
    /// Nebenwirkung, die den Wert zusaetzlich stuetzt: der Vorhalt braucht
    /// `Bildrate × Vorhalt` Plaetze in der Warteschlange (s. `app::takt`). Mit
    /// 30 ms reichen die vorhandenen zwoelf bis rund 360 Bilder je Sekunde,
    /// mit 60 ms nur bis 180.
    ///
    /// **Fuer die Fernsteuerung ist er falsch** — dort zaehlt jede
    /// Millisekunde, und dieser Weg wird sie auf `0` setzen, wenn er kommt.
    /// Ueber die Umgebung: `PULSE_PLAYER_AUSGABETAKT_MS`.
    ///
    /// Lokal ueber die Schleife ist der Unterschied NICHT messbar (dort steht
    /// die Ausgabe schon ohne Takt bei null zu spaeten Bildern). Wer den Wert
    /// aendert, misst ueber eine echte Leitung — sonst misst er nichts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ausgabetakt_ms: Option<u32>,
}

/// Erzeugt [`PlayerOptions::apply`] und [`PlayerOptions::any_set`] aus **einer**
/// Feldliste. Beide muessen dieselben Felder kennen; standen sie getrennt da,
/// hiess eine neue Option, zwei Stellen zu pflegen — und wer `any_set`
/// vergisst, bekommt fuer die neue Option ein stilles `ok: true` ohne Wirkung.
macro_rules! umschaltbare_felder {
    ($($f:ident),+ $(,)?) => {
        impl PlayerOptions {
            /// Uebernimmt nur die gesetzten Felder aus `patch`.
            pub fn apply(&mut self, patch: &PlayerOptions) {
                $( if patch.$f.is_some() { self.$f = patch.$f; } )+
            }

            /// Ob ueberhaupt ein Feld gesetzt ist. Dient dazu, einen Patch zu
            /// erkennen, der aus einem unbekannten Schluessel entstanden ist.
            pub fn any_set(&self) -> bool {
                [$(self.$f.is_some()),+].into_iter().any(|gesetzt| gesetzt)
            }
        }
    };
}

umschaltbare_felder!(
    jitter_ms,
    deband,
    dither,
    zoom,
    pan_x,
    pan_y,
    volume,
    av_offset_ms,
    paused,
    hwdec,
    ausgabetakt_ms,
);

/// Geduld des Jitter-Puffers bei einer Luecke, in Millisekunden.
///
/// An EINER Stelle, weil `session.rs` denselben Wert als Rueckfall braucht,
/// wenn der Aufrufer das Feld nicht setzt. Zwei getrennte Zahlen hiessen: die
/// Puffergeduld haengt davon ab, ueber welchen Weg die Sitzung geoeffnet wurde.
pub const JITTER_MS_VORGABE: u32 = 100;

/// Vorhalt des Ausgabe-Takts, Vorgabe. Herleitung und Messwerte stehen an
/// [`PlayerOptions::ausgabetakt_ms`].
pub const AUSGABETAKT_MS_VORGABE: u32 = 30;

impl PlayerOptions {
    /// Startwerte. Bewusst konservativ: Debanding an (der sichtbare Gewinn).
    ///
    /// **`jitter_ms` ist KEIN Vorhalt.** `jitter.rs::poll` gibt ohne Luecke
    /// sofort frei; der Wert ist allein die Wartezeit BEI einer Luecke. Er
    /// stand bis 2026-07-29 auf 20 ms, waehrend eine NACK-Nachlieferung ueber
    /// die echte Leitung rund 61 ms braucht — jede Nachlieferung traf also ein
    /// und wurde als zu spaet verworfen. Gemessen ueber Hetzner, mit
    /// Zeitmuster und je zwei Laeufen:
    ///
    /// * ungestoert kostet die groessere Geduld NICHTS (104,8 gegen 104,7 ms),
    /// * unter Buendelverlust +16 ms Ende zu Ende (103,8 -> 119,8), dafuer
    ///   volle Bildrate (56 -> 60) und weniger endgueltiger Verlust (150 -> 136),
    /// * ein Rueckstand baut sich NICHT auf (erste gegen letzte fuenf Sekunden
    ///   -2,6 ms) — die Fehlerklasse „Rueckstand wird nie aufgeholt" liegt hier
    ///   nicht vor.
    ///
    /// Messakten `profiles/nack-2026-07-29-{puffergeduld,was-die-geduld-kostet}.json`.
    /// Ungeprueft: ob 100 der beste Wert ist (70/80 nie gemessen) und ob er bei
    /// deutlich laengeren Strecken an die gemessene Umlaufzeit gehoerte.
    pub fn defaults() -> Self {
        Self {
            jitter_ms: Some(JITTER_MS_VORGABE),
            deband: Some(0.6),
            dither: Some(true),
            zoom: Some(1.0),
            pan_x: Some(0.5),
            pan_y: Some(0.5),
            volume: Some(1.0),
            av_offset_ms: Some(0),
            paused: Some(false),
            hwdec: None,
            // An, mit 60 ms. Begruendung samt Messwerten an der Feld-Doku:
            // gegen die Produktion gemessen laeuft die Ausgabe damit in 96
            // statt 54 Prozent der Sekunden sauber, fuer rund 55 ms Vorhalt.
            // Die Fernsteuerung setzt ihn auf 0, wenn sie kommt.
            ausgabetakt_ms: Some(AUSGABETAKT_MS_VORGABE),
        }
    }

    /// Grenzen hart ziehen, damit ein fehlerhafter Aufruf nicht die
    /// Darstellung zerlegt (z. B. Zoom 0 => Division durch null im Shader).
    pub fn clamp(&mut self) {
        if let Some(v) = self.jitter_ms.as_mut() {
            *v = (*v).clamp(0, 2000);
        }
        if let Some(v) = self.ausgabetakt_ms.as_mut() {
            *v = (*v).min(crate::app::VORHALT_MAX_MS);
        }
        if let Some(v) = self.deband.as_mut() {
            *v = v.clamp(0.0, 1.0);
        }
        if let Some(v) = self.zoom.as_mut() {
            *v = v.clamp(1.0, 16.0);
        }
        for v in [self.pan_x.as_mut(), self.pan_y.as_mut()].into_iter().flatten() {
            *v = v.clamp(0.0, 1.0);
        }
        if let Some(v) = self.volume.as_mut() {
            *v = v.clamp(0.0, 4.0);
        }
        if let Some(v) = self.av_offset_ms.as_mut() {
            *v = (*v).clamp(-2000, 2000);
        }
    }
}

/// Antwortrahmen. `data` wird flach in das Objekt gemischt, damit die
/// Nutzdaten wie bei den Capture-Sidecars direkt neben `ok` liegen.
#[derive(Debug, Serialize)]
pub struct Response {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl Response {
    pub fn ok(id: Option<i64>, data: serde_json::Value) -> Self {
        Self { id, ok: true, error: None, data: Some(data) }
    }

    pub fn bare(id: Option<i64>) -> Self {
        Self { id, ok: true, error: None, data: None }
    }

    pub fn err(id: Option<i64>, msg: impl Into<String>) -> Self {
        Self { id, ok: false, error: Some(msg.into()), data: None }
    }
}

/// Ereignisrahmen (`ev`), ohne `id`/`ok`.
#[derive(Debug, Serialize)]
pub struct Event {
    pub ev: &'static str,
    #[serde(flatten)]
    pub data: serde_json::Value,
}

impl Event {
    pub fn new(ev: &'static str, data: serde_json::Value) -> Self {
        Self { ev, data }
    }
}

/// Zustand einer Wiedergabe-Sitzung, wie er nach vorne gemeldet wird.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    /// WHEP-Aushandlung laeuft.
    Connecting,
    /// Frames kommen an und werden dargestellt.
    Playing,
    /// Verbindung steht, aber es kommen keine Frames mehr.
    /// Wird noch nicht gemeldet — die Stillstandserkennung fehlt.
    #[allow(dead_code)]
    Stalled,
    /// Regulaer beendet (auch: Nutzer hat das Fenster geschlossen).
    Closed,
    /// Abgebrochen; Ursache steht im `error`-Feld des Events.
    Failed,
}

impl SessionState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Connecting => "connecting",
            Self::Playing => "playing",
            Self::Stalled => "stalled",
            Self::Closed => "closed",
            Self::Failed => "failed",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_uebernimmt_nur_gesetzte_felder() {
        let mut base = PlayerOptions::defaults();
        let patch = PlayerOptions { deband: Some(0.0), ..Default::default() };
        base.apply(&patch);
        assert_eq!(base.deband, Some(0.0));
        // unveraendert geblieben, obwohl im Patch nicht enthalten
        assert_eq!(base.jitter_ms, Some(JITTER_MS_VORGABE));
        assert_eq!(base.volume, Some(1.0));
    }

    #[test]
    fn clamp_zieht_grenzen() {
        let mut o = PlayerOptions {
            zoom: Some(0.0),
            deband: Some(5.0),
            volume: Some(-1.0),
            av_offset_ms: Some(999_999),
            ..Default::default()
        };
        o.clamp();
        assert_eq!(o.zoom, Some(1.0));
        assert_eq!(o.deband, Some(1.0));
        assert_eq!(o.volume, Some(0.0));
        assert_eq!(o.av_offset_ms, Some(2000));
    }

    #[test]
    fn response_serialisiert_flach() {
        let r = Response::ok(Some(7), serde_json::json!({"session": 1}));
        let s = serde_json::to_string(&r).unwrap();
        assert!(s.contains("\"id\":7"), "{s}");
        assert!(s.contains("\"ok\":true"), "{s}");
        assert!(s.contains("\"session\":1"), "{s}");
        assert!(!s.contains("error"), "{s}");
    }

    #[test]
    fn event_hat_kein_id_und_kein_ok() {
        let e = Event::new("player:state", serde_json::json!({"state": "playing"}));
        let s = serde_json::to_string(&e).unwrap();
        assert!(s.contains("\"ev\":\"player:state\""), "{s}");
        assert!(!s.contains("\"ok\""), "{s}");
        assert!(!s.contains("\"id\""), "{s}");
    }
}
