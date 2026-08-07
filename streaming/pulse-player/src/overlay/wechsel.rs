//! Das Overlay auf ein anderes Oberflaechenformat umstellen.
//!
//! **Warum das eine eigene Datei ist: der erste Versuch war falsch, und der
//! Fehler hat den Player umgebracht.** Es gab hier `zeichner_neu`, das NUR den
//! `egui_wgpu::Renderer` austauschte, mit der Begruendung: „Was dabei
//! verlorengeht, sind die hochgeladenen Texturen (Symbole, Schrift). egui laedt
//! sie beim naechsten Durchgang von selbst neu — es haelt seinen eigenen
//! Bestand und schickt ihn als `textures_delta` mit."
//!
//! **Der zweite Satz ist falsch, und genau daran ist es gescheitert.** egui
//! haelt seinen Bestand im `egui::Context`, nicht im Zeichner, und es schickt
//! ihn nur EINMAL vollstaendig. Danach kommen nur noch **Teilstuecke**: ein
//! `ImageDelta` mit gesetztem `pos`, das eine Ecke des bestehenden
//! Schrift-Atlas nachtraegt. Ein frisch angelegter Zeichner kennt diese Textur
//! aber nicht mehr — seine Tabelle ist leer —, und
//! `egui-wgpu-0.35.0/src/renderer.rs:669` bricht dann ab:
//!
//! ```text
//! self.textures.remove(&id)
//!     .expect("Tried to update a texture that has not been allocated yet.")
//! ```
//!
//! Gemessen am 2026-08-07 gegen einen echten PQ-Strom: die Erkennung griff
//! (`Farbwelt des Stroms HDR (PQ) -> Fenster HDR (Rgba16Float)`), und im selben
//! Durchgang starb der Player.
//!
//! **Es waren drei Paniken, aber nur EIN Fehler** — und das ist nachgemessen,
//! nicht geschlossen: mit der alten Bauart kommen alle drei (`renderer.rs:669`,
//! dann `wgpu-hal .../swapchain/native.rs:359` „Trying to destroy a
//! SwapchainAcquireSemaphore that is still in use by a SurfaceTexture", dann
//! „panic in a destructor during cleanup"), mit der neuen keine einzige. Die
//! beiden hinteren sind Folgen der ersten: sie faellt mitten im
//! Zeichendurchgang an, waehrend das Swapchain-Bild abgeholt in der Hand liegt,
//! und was danach abgeraeumt wird, ist in falscher Reihenfolge dran. Wer nur
//! die zweite liest, sucht den Fehler in der Swapchain — dort ist keiner.
//!
//! **Die Abhilfe: Zeichner UND Kontext zusammen erneuern.** Ein frischer
//! Kontext hat nichts geschickt, schickt also beim ersten Durchgang wieder
//! alles vollstaendig (`pos == None`), und ein frischer Zeichner kann das
//! annehmen. Die beiden gehoeren zusammen; eines davon allein zu tauschen war
//! der Fehler. Belegt mit Gegenlauf, Messakte
//! `streaming/testbench/profiles/player-2026-08-07-wayland-hdr.json`:
//! 40 s, 2315 ausgegebene Bilder, 0 Paniken — gegen 0 Bilder und 3 Paniken in
//! derselben Kette mit der alten Bauart.
//!
//! **Was das kostet, und warum es hinnehmbar ist:** egui vergisst dabei seinen
//! eigenen Zustand (Bildlaufstellen, Animationen, welches Feld den Fokus hat).
//! Die Dinge, an denen der Nutzer haengt — Titel, Lautstaerke, Sichtbarkeit der
//! Leiste — liegen im [`Overlay`] selbst und ueberleben. Und der Wechsel
//! passiert beim ERSTEN Bild eines Stroms, also bevor jemand etwas bedient hat.
//!
//! **Warum nicht das Format gleich beim Anlegen der Sitzung festnageln?** Das
//! war der naheliegende Ausweg, nachdem der Wechsel zum ersten Mal umgefallen
//! ist, und er ist bewusst NICHT genommen worden — aus drei Gruenden, in
//! aufsteigender Schwere:
//!
//! 1. Die Farbwelt des Stroms steht erst mit dem ersten dekodierten Bild fest.
//!    Das Fenster gibt es da laengst; „beim Anlegen" gaebe es also nichts zu
//!    entscheiden, man muesste auf das erste Bild warten und das Fenster
//!    solange schwarz lassen.
//! 2. Der Wechsel ist auch spaeter noch noetig, und zwar in BEIDE Richtungen:
//!    zieht der Nutzer das Fenster von einem HDR- auf einen SDR-Schirm, muss
//!    das Format zurueck, sonst schneidet der Compositor die Spitzlichter ab.
//!    Ein festgenageltes Format haette diesen Fall dauerhaft falsch.
//! 3. **Der Wechsel war nicht heikel, er war falsch gebaut.** Nachgemessen: 40
//!    Sekunden Dauerbetrieb ueber den Wechsel hinweg, 2315 ausgegebene Bilder,
//!    keine Panik. Eine Faehigkeit wegen eines behobenen Fehlers aufzugeben
//!    waere die teurere Entscheidung gewesen.

use winit::window::Window;

use super::Overlay;
use crate::theme;

/// Ein frischer egui-Kontext mit dem Aussehen der App.
///
/// **An genau einer Stelle**, weil er an zwei gebraucht wird — beim Anlegen des
/// Overlays und beim Formatwechsel. Liefe das auseinander, saehe die
/// Bedienleiste nach einem Wechsel auf HDR anders aus als vorher, und niemand
/// suchte die Ursache beim Farbraum.
pub(super) fn kontext_aufsetzen() -> egui::Context {
    let ctx = egui::Context::default();
    // Ohne den SVG-Lader bleiben die Symbole der Leiste leer.
    theme::install_fonts(&ctx);
    theme::apply_style(&ctx);
    egui_extras::install_image_loaders(&ctx);
    ctx
}

/// Den egui-Zeichner fuer ein Oberflaechenformat anlegen.
///
/// **An genau einer Stelle**, weil `dithering: false` eine Entscheidung ist,
/// keine Vorgabe: das Bild bringt sein eigenes Dither mit
/// (`render/shader.wgsl`), und die Oberflaeche traegt mindestens 10 bit — egui
/// hat hier nichts zu glaetten. Stuende das zweimal da, koennte der Wechsel auf
/// HDR es stillschweigend einschalten.
fn zeichner_anlegen(
    device: &wgpu::Device,
    surface_format: wgpu::TextureFormat,
) -> egui_wgpu::Renderer {
    egui_wgpu::Renderer::new(
        device,
        surface_format,
        egui_wgpu::RendererOptions { dithering: false, ..Default::default() },
    )
}

/// Die drei egui-Stuecke, die **nur gemeinsam** etwas taugen.
///
/// **Das ist der eigentliche Schutz gegen den Absturz — nicht der Test.** Sie
/// als ein Feld zu fuehren macht es unmoeglich, den Zeichner allein zu
/// tauschen; genau das war der Fehler. Ein Test kann so etwas nur bemerken,
/// wenn er das echte Overlay durchfaehrt, und dafuer braeuchte er ein Fenster
/// samt Ereignisschleife — in `cargo test` nicht zu haben (die Schleife will
/// den Hauptfaden, die Tests laufen auf Arbeitsfaeden). Also wird der Fehler
/// nicht geprueft, sondern verunmoeglicht.
///
/// Warum alle drei und nicht nur Kontext und Zeichner: `egui_winit::State`
/// haelt eine eigene Kopie des Kontexts und schickt Eingaben und
/// Neuzeichen-Wuensche dorthin. Bliebe sie am alten haengen, waere das Fenster
/// still ohne Bedienung — kein Absturz, aber schlechter zu finden.
pub(super) struct Eguiseite {
    pub(super) ctx: egui::Context,
    pub(super) state: egui_winit::State,
    pub(super) renderer: egui_wgpu::Renderer,
}

impl Eguiseite {
    pub(super) fn neu(
        device: &wgpu::Device,
        surface_format: wgpu::TextureFormat,
        window: &Window,
    ) -> Self {
        let ctx = kontext_aufsetzen();
        let state = egui_winit::State::new(
            ctx.clone(),
            egui::ViewportId::ROOT,
            window,
            Some(window.scale_factor() as f32),
            None,
            None,
        );
        let renderer = zeichner_anlegen(device, surface_format);
        Self { ctx, state, renderer }
    }
}

impl Overlay {
    /// Die egui-Seite fuer ein anderes Oberflaechenformat neu aufsetzen.
    ///
    /// Aufzurufen, wenn `render::Renderer::farbraum_fuer_quelle` ein neues
    /// Format meldet: ein Zeichner fuer `Rgb10a2Unorm` darf nicht in eine
    /// `Rgba16Float`-Flaeche zeichnen, seine Pipeline ist beim Anlegen fuer das
    /// Ziel uebersetzt worden.
    ///
    /// **Eine einzige Zuweisung**, und das ist Absicht — der Grund steht bei
    /// [`Eguiseite`] und im Kopf dieser Datei. Alles, woran der Nutzer haengt
    /// (Titel, Lautstaerke, Sichtbarkeit der Leiste), liegt ausserhalb dieses
    /// Feldes und ueberlebt damit von selbst; es muss nicht aufgezaehlt und
    /// kann nicht vergessen werden.
    pub fn egui_neu(
        &mut self,
        device: &wgpu::Device,
        surface_format: wgpu::TextureFormat,
        window: &Window,
    ) {
        self.egui = Eguiseite::neu(device, surface_format, window);
        // Alles neu zeichnen lassen — sonst bliebe die Leiste bis zur naechsten
        // Eingabe leer.
        self.egui.ctx.request_repaint();
        self.input_pending = true;
        self.stats_dirty = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Einen Durchgang fahren und die Textur-Aenderungen zurueckgeben.
    ///
    /// Ohne Fenster: `egui_winit::State` braucht eines, `egui::Context` nicht.
    /// Der Teil, um den es hier geht — welchen Bestand der Kontext fuehrt und
    /// was er dem Zeichner schickt — haengt am Kontext allein.
    fn durchgang(ctx: &egui::Context, text: &str) -> Vec<(egui::TextureId, egui::epaint::ImageDelta)> {
        let input = egui::RawInput {
            screen_rect: Some(egui::Rect::from_min_size(
                egui::pos2(0.0, 0.0),
                egui::vec2(800.0, 600.0),
            )),
            ..Default::default()
        };
        let full = ctx.run_ui(input, |ui| {
            ui.label(text);
        });
        full.textures_delta.set
    }

    /// **Der Fehler, an dem der Player gestorben ist — als Tatsache
    /// festgehalten.**
    ///
    /// Nach dem ersten Durchgang schickt derselbe Kontext nur noch
    /// TEILSTUECKE (`pos` gesetzt). Genau die kann ein frisch angelegter
    /// Zeichner nicht annehmen; `egui_wgpu` bricht daran ab. Der Test ruft
    /// `update_texture` bewusst NICHT auf — er wuerde dann selbst abstuerzen
    /// statt eine Aussage zu treffen.
    ///
    /// Faellt dieser Test eines Tages um, weil egui seinen Bestand anders
    /// fuehrt, ist das kein Grund, ihn zu streichen: dann ist zu pruefen, ob
    /// der Grund fuer [`Overlay::egui_neu`] noch besteht.
    #[test]
    fn ein_gebrauchter_kontext_schickt_nur_noch_teilstuecke() {
        let ctx = kontext_aufsetzen();
        let erst = durchgang(&ctx, "Pulse");
        assert!(!erst.is_empty(), "der erste Durchgang muss den Schrift-Atlas schicken");
        assert!(
            erst.iter().all(|(_, d)| d.pos.is_none()),
            "und zwar VOLLSTAENDIG — ein frischer Zeichner kann nichts anderes annehmen"
        );

        // Neue Zeichen zwingen egui, den bestehenden Atlas zu ergaenzen.
        let mut teilstueck = false;
        for text in ["Wiedergabe 1234", "@#%&/()=?", "Lautstaerke 200 %"] {
            teilstueck |= durchgang(&ctx, text).iter().any(|(_, d)| d.pos.is_some());
        }
        assert!(
            teilstueck,
            "ein gebrauchter Kontext muss irgendwann ein Teilstueck schicken — sonst gaebe \
             es den Absturz nicht, und dann ist die Begruendung von egui_neu ueberholt"
        );
    }

    /// **Und die Abhilfe: ein frischer Kontext faengt wieder vollstaendig an.**
    ///
    /// Das ist die Eigenschaft, auf der [`Overlay::egui_neu`] beruht. Sie hier
    /// festzuhalten ist der Unterschied zwischen „wir haben etwas geaendert"
    /// und „wir wissen, warum es jetzt haelt".
    #[test]
    fn ein_frischer_kontext_faengt_wieder_von_vorn_an() {
        let alt = kontext_aufsetzen();
        for text in ["Pulse", "Wiedergabe 1234", "@#%&/()=?"] {
            let _ = durchgang(&alt, text);
        }
        let neu = kontext_aufsetzen();
        let erst = durchgang(&neu, "Wiedergabe 1234");
        assert!(!erst.is_empty(), "auch der frische Kontext muss den Atlas schicken");
        assert!(
            erst.iter().all(|(_, d)| d.pos.is_none()),
            "vollstaendig, nicht als Teilstueck — sonst braechte der Tausch nichts"
        );
    }

    /// **Der Fall zu Ende gefahren, auf echter GPU:** ein frischer Kontext und
    /// ein frischer Zeichner fuer das HDR-Format nehmen einander an.
    ///
    /// Der Test ruft `update_texture` wirklich auf — bei der alten Bauart waere
    /// genau hier der Abbruch aus `renderer.rs:669` gekommen. Ohne GPU wird
    /// uebersprungen statt fehlgeschlagen; auf einem Bauserver ohne
    /// Grafikkarte soll er nichts behaupten.
    ///
    /// **Was er NICHT leistet, und das gehoert dazugesagt:** er faehrt zwei von
    /// drei Stuecken der [`Eguiseite`] durch die echten Funktionen
    /// ([`kontext_aufsetzen`], [`zeichner_anlegen`]), aber nicht
    /// [`Overlay::egui_neu`] selbst — dafuer braeuchte er ein Fenster samt
    /// Ereignisschleife, und die will den Hauptfaden. Gegen einen Rueckfall auf
    /// „nur den Zeichner tauschen" schuetzt deshalb nicht dieser Test, sondern
    /// die Bauart: die drei stehen in EINEM Feld.
    #[test]
    fn der_formatwechsel_laeuft_auf_echter_gpu_durch() {
        let instance =
            wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
        let Ok(adapter) = pollster::block_on(instance.request_adapter(&Default::default())) else {
            eprintln!("keine GPU — Formatwechsel nicht geprueft");
            return;
        };
        let Ok((device, queue, _)) =
            pollster::block_on(crate::render::geraet_oeffnen(&adapter, "pulse-player-wechsel"))
        else {
            eprintln!("Geraet liess sich nicht oeffnen — Formatwechsel nicht geprueft");
            return;
        };

        // Vorher: SDR-Format, ein paar Durchgaenge, damit der Kontext Bestand
        // hat und auf Teilstuecke umschaltet.
        let alt_format = wgpu::TextureFormat::Rgb10a2Unorm;
        let ctx = kontext_aufsetzen();
        let mut zeichner = zeichner_anlegen(&device, alt_format);
        for text in ["Pulse", "Wiedergabe 1234", "@#%&/()=?"] {
            for (id, delta) in durchgang(&ctx, text) {
                zeichner.update_texture(&device, &queue, id, &delta);
            }
        }

        // Der Wechsel, so wie `egui_neu` ihn macht: BEIDE neu.
        let ctx = kontext_aufsetzen();
        let mut zeichner = zeichner_anlegen(&device, crate::render::HDR_OBERFLAECHE);
        for (id, delta) in durchgang(&ctx, "Wiedergabe 1234") {
            // Vor der Behebung brach genau dieser Aufruf ab.
            zeichner.update_texture(&device, &queue, id, &delta);
        }
        device
            .poll(wgpu::PollType::wait_indefinitely())
            .expect("Geraet nach dem Formatwechsel krank");
    }
}
