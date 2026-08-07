//! Das Fenster auf HDR umstellen — und ehrlich sagen, wenn es nicht geht.
//!
//! **Warum das ueberhaupt noetig ist.** wgpu legt die Swapchain an und waehlt
//! ihr Format, sagt dem Fenstersystem aber nie, WIE die Zahlen darin gemeint
//! sind. Unter Windows heisst die Vorgabe „gewoehnliches SDR" — ein Puffer
//! voller linearem Licht wuerde dann als sRGB gedeutet und saehe grotesk
//! aus. Der eine fehlende Aufruf ist `IDXGISwapChain3::SetColorSpace1`, und an
//! ihn kommt man nur ueber `Surface::as_hal`.
//!
//! **Der vorige Absatz gilt fuer wgpu 29. Seit dem Sprung auf wgpu 30
//! (2026-08-08) stimmt er nicht mehr, und wer hier aufraeumt, muss das wissen:**
//! `wgpu-hal-30.0.0/src/dx12/mod.rs:1656` ruft `SetColorSpace1` inzwischen
//! **selbst** auf, abgeleitet aus dem neuen Feld
//! `SurfaceConfiguration::color_space` (`:1451` bildet es auf die
//! DXGI-Konstanten ab — auf dieselben, die unten stehen). In wgpu 29 kam der
//! Aufruf in der ganzen Datei kein einziges Mal vor.
//!
//! **Trotzdem bleibt unser Aufruf stehen**, aus zwei Gruenden. Erstens laeuft
//! er in `Renderer::konfigurieren` NACH `surface.configure` und ist damit der
//! massgebliche; zweitens sagt er bei `hdr == true` scRGB an, waehrend wgpu aus
//! unserem `SurfaceColorSpace::Auto` nur das ableiten kann, was das Format
//! hergibt. Solange die Migration verhaltensgleich sein soll, wird hier nichts
//! entfernt. **Das ist die Stelle, an der beim Umstieg auf `Bt2100Pq`
//! aufgeraeumt gehoert** — dann macht wgpu die Anmeldung vollstaendig, und
//! zwei Stellen, die denselben Farbraum setzen, waeren eine zu viel.
//! **Ungeprueft auf echter Windows-Hardware** (diese Maschine hat keine): dass
//! sich die beiden Aufrufe nicht ins Gehege kommen, ist am Quelltext
//! erschlossen, nicht gesehen.
//!
//! **Zwei Fragen, nicht eine.** Ob das Fenster HDR ausgeben KANN, entscheidet
//! die Grafik-API; ob es etwas nuetzt, entscheidet der Bildschirm. Laeuft der
//! in SDR, wird ein HDR-Puffer nicht heruntergerechnet, sondern **abgeschnitten**
//! — die Spitzlichter waeren weg, und zwar schlimmer als beim eigenen
//! Tone-Mapping. Deshalb wird beides getrennt gefragt und nur bei zweimal Ja
//! umgeschaltet.
//!
//! **Und wenn es nicht geht, wird es nicht behauptet.** Der Player faellt dann
//! auf den eigenen Weg zurueck (PQ aufloesen, Spitzlichter zusammenschieben,
//! als SDR ausgeben). Das ist sichtbar schlechter als echtes HDR, aber richtig
//! — und es steht im Log, statt still zu passieren.

/// Das Oberflaechenformat des HDR-Betriebs.
///
/// `Rgba16Float` und nichts anderes, weil daran zwei Dinge haengen, die sich
/// nicht trennen lassen: nur Fliesskomma traegt Werte ueber 1,0 (also
/// Spitzlichter) und unter 0,0 (also Farben ausserhalb von BT.709) — und auf
/// dem Vulkan-Weg schaltet wgpu **allein an diesem Format** den weiten Farbraum
/// ein (`wgpu-hal`, `vulkan/swapchain/native.rs`: `EXTENDED_SRGB_LINEAR_EXT`
/// genau dann, wenn das Format `Rgba16Float` ist). Ein anderes Format hier
/// waere auf beiden Wegen falsch, auf jedem aus einem anderen Grund.
pub const HDR_OBERFLAECHE: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;

/// Meldet den Farbraum des Fensters bei Windows an: **scRGB**, also lineares
/// Licht mit BT.709-Primaervalenzen, bei dem 1,0 achtzig cd/m² entspricht.
///
/// Rueckgabe: hat es geklappt? Ein `false` ist kein Fehler, sondern eine
/// Auskunft — der Aufrufer bleibt dann beim Herunterrechnen.
///
/// **Nur der D3D12-Weg.** Auf dem Vulkan-Weg ist der Farbraum eine Eigenschaft
/// der Swapchain und wird beim Anlegen festgelegt; nachtraeglich gibt es dort
/// nichts zu setzen (wgpu tut es selbst, s. [`HDR_OBERFLAECHE`]). Wir koennen
/// von aussen aber nicht pruefen, ob es geklappt hat — und was wir nicht
/// pruefen koennen, behaupten wir nicht: auf Vulkan liefert diese Funktion
/// `false`, der Player rechnet dann herunter. Das ist die vorsichtige Seite des
/// Irrtums.
///
/// **Nach JEDEM `surface.configure` erneut aufzurufen.** Eine neue Swapchain
/// startet wieder im SDR-Farbraum — der Aufruf hier ist keine einmalige
/// Einstellung, sondern eine Eigenschaft des jeweiligen Swapchain-Objekts. Wer
/// das übersieht, bekommt HDR, das beim ersten Fenster-Vergrößern verschwindet;
/// deshalb geht in `render::Renderer` jedes `configure` durch dieselbe Stelle.
#[cfg(windows)]
pub fn farbraum_anmelden(surface: &wgpu::Surface<'static>, hdr: bool) -> bool {
    use windows::Win32::Graphics::Dxgi::Common::{
        DXGI_COLOR_SPACE_RGB_FULL_G10_NONE_P709, DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709,
    };

    let (raum, name) = if hdr {
        (DXGI_COLOR_SPACE_RGB_FULL_G10_NONE_P709, "scRGB (lineares Licht, 1,0 = 80 cd/m²)")
    } else {
        (DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709, "sRGB")
    };

    // SAFETY: `as_hal` gibt nur eine Leihe auf die Swapchain heraus, solange
    // die Oberflaeche lebt; `SetColorSpace1` veraendert weder ihre Groesse noch
    // ihr Format und ist dokumentiert als jederzeit aufrufbar.
    let hal = unsafe { surface.as_hal::<wgpu::hal::api::Dx12>() };
    let Some(hal) = hal else {
        if hdr {
            eprintln!(
                "pulse-player: HDR-Ausgabe nicht angemeldet — das Fenster laeuft nicht ueber \
                 D3D12. Der Strom wird stattdessen auf SDR heruntergerechnet."
            );
        }
        return false;
    };
    let Some(swapchain) = hal.swap_chain() else {
        if hdr {
            eprintln!("pulse-player: HDR-Ausgabe nicht angemeldet — noch keine Swapchain");
        }
        return false;
    };
    match unsafe { swapchain.SetColorSpace1(raum) } {
        Ok(()) => {
            eprintln!("pulse-player: Farbraum des Fensters: {name}");
            hdr
        }
        Err(e) => {
            if hdr {
                eprintln!(
                    "pulse-player: HDR-Ausgabe abgelehnt ({e}) — der Strom wird auf SDR \
                     heruntergerechnet"
                );
            }
            false
        }
    }
}

#[cfg(not(windows))]
pub fn farbraum_anmelden(_surface: &wgpu::Surface<'static>, _hdr: bool) -> bool {
    // Auf Linux/macOS gibt es diesen Weg heute nicht — der Sidecar sendet dort
    // ohnehin kein HDR (`encode/hdr.rs` im Windows-Sidecar ist der einzige
    // belegte Sender). Kommt fremdes HDR-Material an, wird es heruntergerechnet.
    false
}

/// Laeuft der Bildschirm unter diesem Fenster gerade in HDR?
///
/// Dieselbe Frage und derselbe Weg wie im Sidecar (`system/hdr.rs`), nur von
/// der anderen Seite: dort geht es um den Schirm, der AUFGENOMMEN wird, hier um
/// den, auf dem GEZEIGT wird. Bewusst nicht geteilt — die beiden Programme
/// haben keine gemeinsame Bibliothek, und eine dafuer anzulegen waere mehr
/// Kopplung als die dreissig Zeilen wert sind.
///
/// `false` bei jedem Zweifel: kein Ausgang gefunden, Abfrage fehlgeschlagen,
/// nicht Windows. Ein falsches Ja kostet hier abgeschnittene Spitzlichter, ein
/// falsches Nein nur die Genauigkeit des Herunterrechnens.
#[cfg(windows)]
pub fn schirm_ist_hdr(hwnd: isize) -> bool {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dxgi::Common::DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020;
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, DXGI_ERROR_NOT_FOUND, IDXGIAdapter1, IDXGIFactory1, IDXGIOutput6,
    };
    use windows::Win32::Graphics::Gdi::{MONITOR_DEFAULTTONEAREST, MonitorFromWindow};
    use windows::core::Interface;

    let monitor = unsafe { MonitorFromWindow(HWND(hwnd as *mut _), MONITOR_DEFAULTTONEAREST) };
    let Ok(factory) = (unsafe { CreateDXGIFactory1::<IDXGIFactory1>() }) else { return false };
    let mut a = 0u32;
    loop {
        let adapter: IDXGIAdapter1 = match unsafe { factory.EnumAdapters1(a) } {
            Ok(x) => x,
            Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => return false,
            Err(_) => return false,
        };
        a += 1;
        let mut o = 0u32;
        while let Ok(output) = unsafe { adapter.EnumOutputs(o) } {
            o += 1;
            let Ok(output6) = output.cast::<IDXGIOutput6>() else { continue };
            let Ok(desc) = (unsafe { output6.GetDesc1() }) else { continue };
            if desc.Monitor == monitor {
                return desc.ColorSpace == DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020;
            }
        }
    }
}

#[cfg(not(windows))]
pub fn schirm_ist_hdr(_hwnd: isize) -> bool {
    false
}

/// Wie lange eine Antwort von [`schirm_ist_hdr`] wiederverwendet wird.
///
/// **Eine Sekunde, und beide Richtungen der Wahl sind begruendet.**
///
/// *Warum ueberhaupt gespeichert:* [`Renderer::farbraum_fuer_quelle`] wird bei
/// JEDEM Bild gefragt, und bei einem PQ-Strom lief die Abfrage darin bis zum
/// 2026-08-06 auch jedes Mal wirklich durch — `CreateDXGIFactory1` samt
/// Aufzaehlung aller Adapter und Ausgaenge, sechzigmal je Sekunde. Das ist ein
/// AUFBAU-Aufruf im Bildtakt, gegen dieselben Treibersperren, die gleichzeitig
/// das Praesentieren bedienen. Bei einem SDR-Strom brach die `&&`-Kette vorher
/// ab, deshalb ist es nie aufgefallen.
///
/// *Warum nicht einfach einmalig:* die Antwort kann sich waehrend der Sitzung
/// aendern — der Nutzer legt HDR in den Windows-Anzeigeeinstellungen um, oder
/// er zieht das Fenster auf einen anderen Schirm. Ein eingefrorener Wert hiesse
/// dann: HDR-Strom auf SDR-Schirm mit abgeschnittenen Spitzlichtern, oder
/// umgekehrt dauerhaftes Herunterrechnen auf einem Schirm, der HDR koennte.
///
/// *Warum eine Sekunde:* sie deckt beide Ereignisse ab, ohne sie spuerbar
/// nachhinken zu lassen — Windows braucht fuer einen HDR-Wechsel selbst
/// laenger (der Schirm wird dabei schwarz), und ein Fensterwechsel ueber die
/// Bildschirmgrenze dauert die Mausbewegung. Nach oben begrenzt sie der
/// Nutzen: aus 60 Abfragen je Sekunde wird eine, das sind 98 % weg. Eine
/// laengere Frist holt davon nur noch Bruchteile und verlaengert den Nachhall.
/// Kuerzer waere Aufwand ohne Anlass: bei 100 ms blieben sechs Aufzaehlungen je
/// Sekunde stehen, fuer eine Frage, deren Antwort sich im Betrieb praktisch nie
/// aendert.
const SCHIRM_FRIST: std::time::Duration = std::time::Duration::from_secs(1);

/// Die letzte Antwort von [`schirm_ist_hdr`] samt ihrem Alter.
///
/// Kein `Option<bool>` mit Zeitstempel daneben, sondern beides zusammen: die
/// beiden gehoeren zueinander, und getrennt liessen sie einen Zustand zu, in
/// dem ein Wert ohne Alter dasteht.
#[derive(Default)]
pub(super) struct Schirmwissen {
    stand: Option<(bool, std::time::Instant)>,
}

impl Schirmwissen {
    /// Laeuft der Schirm in HDR? Fragt hoechstens einmal je [`SCHIRM_FRIST`]
    /// wirklich nach.
    pub(super) fn ist_hdr(&mut self, hwnd: isize) -> bool {
        // Als Wachbedingung statt als verschachteltes `if let`: die Kiste steht
        // auf Edition 2021, `if let ... &&` gibt es erst ab 2024 — ein `match`
        // mit `if` am Arm tut dasselbe schon heute.
        match self.stand {
            Some((wert, seit)) if seit.elapsed() < SCHIRM_FRIST => wert,
            _ => {
                let wert = schirm_ist_hdr(hwnd);
                self.stand = Some((wert, std::time::Instant::now()));
                wert
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **Was die Bildschirm-Abfrage wirklich kostet** — die Zahl, die der
    /// Durchsicht vom 2026-08-06 gefehlt hat (`[UNBELEGT]`, „begruendeter
    /// Verdacht Nummer eins").
    ///
    /// `#[ignore]`, weil er echte Hardware abfragt: das Ergebnis haengt an
    /// Adapterzahl, Ausgangszahl und Treiber, ist also auf keiner zweiten
    /// Maschine dieselbe Zahl und taugt nicht als Zusicherung. Aufrufen mit
    /// `cargo test --release -- --ignored --nocapture schirm_abfrage`.
    ///
    /// **Was er NICHT misst:** die Kosten unter Last. Hier laeuft weder ein
    /// Zeichendurchgang noch ein Decoder gegen dieselben Treibersperren; im
    /// laufenden Betrieb ist der Aufruf eher teurer als hier, nicht billiger.
    #[test]
    #[ignore = "fragt echte Hardware ab; Ergebnis ist maschinenabhaengig"]
    fn was_kostet_die_schirm_abfrage() {
        // Ein paar Durchlaeufe vorweg: der erste Aufruf zieht die DXGI-DLLs
        // und waere sonst der Ausreisser, den man hinterher erklaeren muss.
        for _ in 0..10 {
            let _ = schirm_ist_hdr(0);
        }
        let mut zeiten: Vec<u128> = (0..200)
            .map(|_| {
                let t = std::time::Instant::now();
                let _ = schirm_ist_hdr(0);
                t.elapsed().as_micros()
            })
            .collect();
        zeiten.sort_unstable();
        let median = zeiten[zeiten.len() / 2];
        let p95 = zeiten[zeiten.len() * 95 / 100];
        eprintln!(
            "schirm_ist_hdr: Median {median} us, p95 {p95} us, Groesstes {} us \
             (200 Aufrufe) — bei 60 Bildern je Sekunde waeren das {:.2} ms/s, \
             also {:.1} % eines Bildbudgets von 16,7 ms je Bild",
            zeiten[zeiten.len() - 1],
            median as f64 * 60.0 / 1000.0,
            median as f64 / 16_700.0 * 100.0,
        );
    }

    /// Die Frist tut, was sie soll: innerhalb ihrer kommt die Antwort aus dem
    /// Speicher. Geprueft ohne echte Abfrage — `hwnd = 0` liefert auf
    /// Nicht-Windows ohnehin `false`, und worauf es hier ankommt, ist, dass
    /// zweimal dasselbe herauskommt und der Stand gesetzt ist.
    #[test]
    fn die_frist_haelt_die_antwort_fest() {
        let mut w = Schirmwissen::default();
        let erst = w.ist_hdr(0);
        let stand = w.stand.expect("nach der ersten Frage muss ein Stand dastehen");
        assert_eq!(w.ist_hdr(0), erst, "innerhalb der Frist dieselbe Antwort");
        assert_eq!(
            w.stand.map(|(v, t)| (v, t)),
            Some(stand),
            "und ohne den Zeitstempel zu erneuern — sonst liefe die Frist nie ab"
        );
    }
}

// ── Der Renderer-Teil, der am Farbraum haengt ───────────────────────────────
//
// Steht hier statt in `render::mod`, weil beides zusammengehoert: was das
// Fenster ausgibt, und wie es das dem System sagt. Und weil `mod.rs` mit diesen
// Methoden ueber die harte Groessen-Grenze von 500 Zeilen gewachsen war
// (`PLAN.md` §12.1).
//
// Ein Kindmodul darf auf die privaten Felder seines Elternteils zugreifen —
// deshalb braucht es dafuer keine Lockerung der Sichtbarkeit.

use crate::decode::{Farbangaben, Uebertragung};
use super::{pick_format, build_graphics, Renderer};

/// Die Win32-Fensterkennung, oder `0`, wo es keine gibt.
///
/// Gebraucht fuer eine einzige Frage — laeuft der Schirm unter diesem Fenster
/// in HDR ([`schirm_ist_hdr`]). Auf anderen Systemen ist die Antwort ohnehin
/// Nein, deshalb genuegt dort die Null.
pub(super) fn fensterkennung(window: &winit::window::Window) -> isize {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    match window.window_handle().map(|h| h.as_raw()) {
        Ok(RawWindowHandle::Win32(h)) => h.hwnd.get(),
        _ => 0,
    }
}

impl Renderer {

    /// Die Oberflaeche neu einrichten — **die einzige Stelle, die das tut.**
    ///
    /// Der Grund ist der Farbraum: `configure` legt unter der Haube eine NEUE
    /// Swapchain an, und die faengt wieder im SDR-Farbraum an. Ein direktes
    /// `surface.configure` irgendwo im Code hiesse also, dass HDR beim ersten
    /// Vergroessern des Fensters wortlos verschwindet — und niemand suchte den
    /// Fehler beim Fensterrahmen.
    pub(super) fn konfigurieren(&mut self) {
        self.surface.configure(&self.device, &self.config);
        if self.hdr_gewuenscht || self.hdr_fenster {
            self.hdr_fenster = farbraum_anmelden(&self.surface, self.hdr_gewuenscht);
        }
    }

    /// Das Fenster auf die Farbwelt des Stroms einstellen.
    ///
    /// Wird bei jedem Bild gefragt, tut aber nur etwas, wenn sich die Antwort
    /// aendert — also beim ersten HDR-Bild eines Stroms und beim Wechsel
    /// zurueck. Rueckgabe: das neue Oberflaechenformat, falls es sich geaendert
    /// hat. Der Aufrufer muss dann die Bedienoberflaeche neu aufsetzen, die in
    /// dieselbe Flaeche zeichnet.
    ///
    /// **Drei Bedingungen, alle notwendig:** der Strom ist HDR, die Oberflaeche
    /// bietet ein Fliesskomma-Format an, und der Schirm laeuft in HDR. Fehlt
    /// eine, bleibt es beim SDR-Fenster — und der Shader rechnet herunter,
    /// statt Spitzlichter abschneiden zu lassen.
    /// **Die dritte Bedingung steht bewusst hinten und wird gespeichert.** Sie
    /// ist die einzige teure — eine DXGI-Aufzaehlung ueber alle Adapter und
    /// Ausgaenge — und die `&&`-Kette kommt bei einem SDR-Strom gar nicht bis
    /// zu ihr. Bei einem PQ-Strom kommt sie bei JEDEM Bild dorthin, und genau
    /// deshalb beantwortet sie [`Schirmwissen`] aus dem Speicher (Frist:
    /// [`SCHIRM_FRIST`]). Die Reihenfolge der Kette umzudrehen waere die
    /// schlechtere Abhilfe gewesen: dann fiele ein Wechsel des Schirms nach HDR
    /// nie auf.
    pub fn farbraum_fuer_quelle(&mut self, farbe: Farbangaben) -> Option<wgpu::TextureFormat> {
        let moeglich = farbe.uebertragung == Uebertragung::Pq
            && self.angebotene_formate.contains(&HDR_OBERFLAECHE)
            && self.schirmwissen.ist_hdr(self.hwnd);
        if moeglich == self.hdr_gewuenscht {
            return None;
        }
        self.hdr_gewuenscht = moeglich;

        let ziel = if moeglich {
            HDR_OBERFLAECHE
        } else {
            // Zurueck auf die gewoehnliche Wahl — nicht einfach das vorherige
            // Format merken: zwischen den beiden Streams kann sich die
            // Angebotsliste geaendert haben (Bildschirm gewechselt).
            pick_format(&self.angebotene_formate).unwrap_or(self.config.format)
        };
        let format_geaendert = ziel != self.config.format;
        if format_geaendert {
            self.config.format = ziel;
            self.surface_format_name = format!("{ziel:?}");
            // Pipeline und Bindungen haengen am Format — der Shader wird fuer
            // das Zielformat uebersetzt. Ohne diesen Neubau zeichnete die alte
            // Pipeline in eine Flaeche, die sie nicht kennt.
            let gfx = build_graphics(&self.device, ziel);
            self.pipeline = gfx.pipeline;
            self.bind_layout = gfx.bind_layout;
            self.sampler = gfx.sampler;
            self.uniform_buf = gfx.uniform_buf;
            // Zeigt auf die alte Bindungsvorlage und den alten Uniform-Puffer.
            self.bind_group = None;
        }
        self.konfigurieren();
        eprintln!(
            "pulse-player: Farbwelt des Stroms {} -> Fenster {} ({ziel:?})",
            if farbe.uebertragung == Uebertragung::Pq { "HDR (PQ)" } else { "SDR" },
            if self.hdr_fenster { "HDR" } else { "SDR, wird heruntergerechnet" },
        );
        format_geaendert.then_some(ziel)
    }

}
