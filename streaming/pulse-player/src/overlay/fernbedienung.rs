//! Die Bedienung im **Fernsteuerungs-Modus**: ein verschiebbarer Griff statt
//! der Leiste am unteren Rand.
//!
//! **Warum die Leiste hier falsch ist.** Sie taucht bei jeder Mausbewegung auf
//! (`HIDE_AFTER` in `super`) — beim Zusehen genau richtig, beim Steuern eine
//! Dauererscheinung, denn dort bewegt man die Maus ununterbrochen. Schwerer
//! wiegt aber, was sie dabei anrichtet: solange sie sichtbar ist, meldet egui
//! den Zeiger als „verbraucht" (`Ereignisantwort::verbraucht`), und die
//! Erfassung schickt in diesem Bereich weder Bewegung noch Klick an den fernen
//! Rechner. Dieser Bereich ist damit tot — mittig am unteren Rand, in der
//! Breite ihres Inhalts (keine volle Fensterbreite, das stand hier bis zum
//! 2026-08-13 falsch), also genau dort, wo bei Windows die Mitte der
//! Taskleiste liegt.
//!
//! Der Griff hier ist dieselbe Idee auf der kleinsten moeglichen Flaeche: ein
//! Symbol, das man **wegziehen** kann, wenn es doch einmal im Weg ist. Das
//! Verschieben ist deshalb kein Komfort, sondern der Ersatz fuer das
//! Ausblenden, das es hier nicht geben darf — ohne sichtbaren Griff gaebe es
//! keinen Weg zurueck in die Bedienung.
//!
//! **Erreichbar bleibt er auch ohne Zeiger.** Mit Zeigerfang
//! (`input_capture` mit `pointer_lock`) gibt es keinen lokalen Mauszeiger mehr,
//! mit dem sich irgendetwas anklicken liesse. Deshalb oeffnet
//! [`super::FERN_MENUE_TASTE`] das Menue auch per Tastatur, und die Erfassung
//! schluckt genau diese Kombination, statt sie weiterzureichen
//! (`crate::fernsteuerung::Erfassung::menue_kombination`).

use winit::window::Window;

use super::{Overlay, OverlayAction, schirmkarte};
use crate::app::anordnen;
use crate::theme;

/// Kantenlaenge des Griffs. Bewusst groesser als ein Leisten-Symbol: er ist ein
/// Ziehpunkt, und was man ziehen soll, muss man treffen koennen.
pub(super) const GRIFF: f32 = 34.0;

/// Abstand des Griffs von der Fensterecke in seiner Ausgangslage.
///
/// Oben links, weil dort am wenigsten im Weg steht: unten sitzt bei Windows die
/// Taskleiste, oben rechts die Fensterknoepfe. Das Statistikfeld liegt zwar
/// ebenfalls oben links — es weicht deshalb nach unten aus, solange der Griff da
/// ist (`super::paint`).
pub(super) const RAND: f32 = 12.0;

impl Overlay {
    /// Griff plus (wenn offen) Klappmenue. Wird im Fernsteuerungs-Modus
    /// ANSTELLE der Leiste gezeichnet, und anders als sie **immer** — nicht nur
    /// nach einer Mausbewegung.
    pub(super) fn build_fernbedienung(
        &mut self,
        ctx: &egui::Context,
        is_fullscreen: bool,
        window: &Window,
        actions: &mut Vec<OverlayAction>,
    ) {
        let griff = egui::Area::new(egui::Id::new("pulse-fern-griff"))
            .default_pos(egui::pos2(RAND, RAND))
            // Ausdruecklich, obwohl es die Vorgabe von `Area::new` ist: hier
            // haengt Bedienbarkeit daran, und ein spaeteres `fixed_pos` oder
            // `anchor` schaltete es stillschweigend ab (`egui::Area`). Das Menue
            // unten bekommt genau deshalb `fixed_pos` — es soll am Griff
            // haengen und nicht selbst ziehbar sein.
            .movable(true)
            .constrain(true)
            .show(ctx, |ui| {
                // **Von Hand gezeichnet statt `Button::image`.** Der Knopf
                // deckelt sein Bild auf Schriftzeilenhoehe (`limit_image_size`,
                // rund 15 px bei unserer Schrift) — die Marke sass verloren in
                // einem 34er-Feld. `fill` schaltet ausserdem die Hover-Wirkung
                // ab, der Griff sah damit aus wie ein Wasserzeichen und nicht
                // wie etwas, das man druecken kann.
                let (flaeche, antwort) =
                    ui.allocate_exact_size(egui::vec2(GRIFF, GRIFF), egui::Sense::click());
                let hell = antwort.hovered() || self.fern_menue_offen;
                ui.painter().rect_filled(
                    flaeche,
                    theme::RADIUS_MD,
                    if hell { theme::GRIFF_BG_AKTIV } else { theme::LEISTE_BG },
                );
                // **Nicht einfaerben.** `tint` multipliziert, und die Marke
                // bringt ihre eigenen Farben mit: aus Smaragd mal Blau wurde ein
                // schmutziges Petrol, in dem der Zustand „Menue offen" kaum vom
                // Ruhezustand zu unterscheiden war. Der Zustand haengt deshalb
                // an der Flaeche dahinter, nicht am Symbol.
                egui::Image::new(theme::icon::pulse_mark())
                    .corner_radius(theme::RADIUS_MD)
                    .paint_at(ui, flaeche.shrink(5.0));
                if antwort.clicked() {
                    self.fern_menue_offen = !self.fern_menue_offen;
                }
                antwort.on_hover_text(super::FERN_MENUE_HINWEIS)
            });

        if !self.fern_menue_offen {
            return;
        }
        // Das Menue haengt UNTER dem Griff und wandert mit ihm. Eigene Area und
        // nicht `popup`: ein egui-Popup schliesst beim Klick daneben, und
        // „daneben" ist hier das ferne Bild — der Klick soll dorthin gehen, das
        // Menue aber offen bleiben, bis man es selbst zumacht.
        let unter_griff = griff.response.rect.left_bottom() + egui::vec2(0.0, 6.0);
        egui::Area::new(egui::Id::new("pulse-fern-menue"))
            .fixed_pos(unter_griff)
            .constrain(true)
            .show(ctx, |ui| {
                egui::Frame::NONE
                    .fill(theme::LEISTE_BG)
                    .corner_radius(theme::RADIUS_MD)
                    .inner_margin(egui::Margin::symmetric(theme::PAD_X as i8, theme::PAD_Y as i8))
                    .show(ui, |ui| {
                        ui.spacing_mut().item_spacing.y = 6.0;
                        if !self.title.is_empty() {
                            ui.label(
                                egui::RichText::new(&self.title)
                                    .font(theme::font_xs())
                                    .color(theme::TEXT),
                            );
                        }
                        // **Jede waagerechte Zeile bekommt eine AUSDRUECKLICHE
                        // Hoehe.** Ohne sie wuchs das Menue endlos, und zwar so:
                        // `Layout::left_to_right(Align::Center)` fuellt die
                        // gesamte verfuegbare Hoehe (egui `layout.rs`, „fill full
                        // height"), das Ergebnis wird ueber `Area::end` zur
                        // verfuegbaren Hoehe des NAECHSTEN Durchgangs — und weil
                        // unter der zentrierten Zeile noch Geschwister stehen
                        // (Symbolzeile, Beenden-Knopf), kam deren Hoehe jedes Mal
                        // obendrauf. Rund 60 px je Durchgang, bei 60 Bildern je
                        // Sekunde also mehrere tausend Pixel Zuwachs pro Sekunde.
                        // Sichtbar wurde daraus eine bildschirmhohe, fast leere
                        // Flaeche (am 2026-08-13 am Bild beobachtet).
                        //
                        // Die Leiste unten (`controls.rs`) hat das Problem nicht:
                        // dort ist die zentrierte Zeile das EINZIGE Kind des
                        // Rahmens, damit ist die Hoehe ein Fixpunkt statt einer
                        // Treppe. Genau deshalb bleibt sie hier unangetastet.
                        //
                        // Nicht 0 als Hoehe (auch das traegt): dann faende
                        // `Align::Center` gar keine Hoehe mehr zum Zentrieren,
                        // und kurze Texte saessen an der Oberkante statt auf der
                        // Mittellinie der Knoepfe.
                        let breite = ui.available_width();
                        // 32 = Knopfhoehe 24 + 2x 4 Innenrand des Gruppenrahmens.
                        ui.allocate_ui_with_layout(
                            egui::vec2(breite, 32.0),
                            egui::Layout::left_to_right(egui::Align::Center),
                            |ui| self.volume_group(ui, actions),
                        );
                        // 24 = Symbol 16 + 2x 4 Knopfpolsterung.
                        ui.allocate_ui_with_layout(
                            egui::vec2(breite, 24.0),
                            egui::Layout::left_to_right(egui::Align::Center),
                            |ui| {
                                Self::action_button(
                                    ui,
                                    actions,
                                    theme::icon::stats(),
                                    "Diagnose-Stats (Codec/FPS/Bitrate)",
                                    self.stats_visible,
                                    OverlayAction::ToggleStats,
                                );
                                Self::action_button(
                                    ui,
                                    actions,
                                    theme::icon::chat(),
                                    "Live-Chat",
                                    false,
                                    OverlayAction::Chat,
                                );
                                // Vollbild bleibt erreichbar: der Doppelklick
                                // ins Bild geht im Fernsteuerungs-Modus an den
                                // fernen Rechner, nicht mehr an das Fenster.
                                Self::action_button(
                                    ui,
                                    actions,
                                    if is_fullscreen {
                                        theme::icon::fullscreen_exit()
                                    } else {
                                        theme::icon::fullscreen_enter()
                                    },
                                    if is_fullscreen { "Vollbild verlassen" } else { "Vollbild" },
                                    false,
                                    OverlayAction::Fullscreen(!is_fullscreen),
                                );
                            },
                        );
                        // **Die massstaebliche Karte der Bildschirme des fernen
                        // Rechners.** Ersetzt seit 2026-08-24 die fruehere Liste
                        // von „+ Name"-Knoepfen fuer die noch nicht offenen
                        // Schirme: eine Karte zeigt ALLE — auch die schon
                        // offenen, samt Markierung, welcher davon dieses
                        // Fenster ist. Die Filterung wandert damit von „welche
                        // Liste" zu „welche Kaestchen sind antippbar"
                        // (`schirmkarte::zeichnen`).
                        //
                        // Bewusst weiter nur bei MEHR als einem Schirm: eine
                        // Karte mit einem einzigen Kaestchen zeigt nichts, was
                        // der Nutzer nicht schon vor sich hat.
                        //
                        // **Die Ueberschrift steht unbedingt; DARUNTER
                        // entscheidet `darstellbar`** (C1 aus der Review vom
                        // 2026-08-24) zwischen Karte und Knopfliste — nicht
                        // erst, wenn `zeichnen` schon leer zurueckkommt. Das
                        // war schon im alten Code so (die Ueberschrift stand
                        // unbedingt ueber der Liste); neu ist nur, dass jetzt
                        // ZWEI Zweige moeglich sind statt einem. Meldet der
                        // ferne Rechner keine Lage (aeltere Gegenstelle — Host
                        // und Steuernder sind zwei Rechner mit eigenem
                        // Update-Takt, das ist der NORMALFALL direkt nach der
                        // Auslieferung, nicht ein Randfall) oder liegen zwei
                        // Schirme deckungsgleich uebereinander (gescheiterte
                        // Lage-Abfrage am Host, `list_monitors.rs`), zeigt
                        // dieser Zweig die ALTE Knopfliste. Entscheidend ist,
                        // dass BEIDE Zweige etwas zeigen: nie eine
                        // Ueberschrift ohne Inhalt darunter — genau die leere,
                        // verwirrende Gruppe, die der Satz „Alle Bildschirme
                        // sind bereits offen" seit 2026-08-17 verhindern soll.
                        if self.fern_schirme.len() > 1 {
                            ui.add_space(6.0);
                            ui.label(
                                egui::RichText::new("Bildschirme")
                                    .font(theme::font_xs())
                                    .color(theme::TEXT_DIM),
                            );
                            if schirmkarte::darstellbar(&self.fern_schirme) {
                                let breite = ui.available_width();
                                if schirmkarte::zeichnen(ui, breite, &self.fern_schirme, actions) {
                                    self.fern_menue_offen = false;
                                }
                            } else {
                                self.bildschirm_knopfliste(ui, actions);
                            }
                            // **Nur, wenn der Knopf auch etwas bewirkt** — ein
                            // Knopf, der wortlos nichts tut, ist schlimmer als
                            // keiner. Zwei Bedingungen, und beide stammen aus
                            // genau den Daten, an denen auch die Wirkung
                            // haengt:
                            //
                            // * `fern_anordenbar` rechnet die App aus den
                            //   Schirmen ALLER Fenster dieser Sitzung — mit
                            //   derselben Sammlung und demselben Tor, die
                            //   `App::fenster_anordnen` danach benutzt
                            //   (`app::anordnen`). Hier stand bis zum
                            //   2026-08-25 „mehr als ein offener Schirm", und
                            //   das war eine unabhaengig formulierte zweite
                            //   Bedingung: bei einer aelteren Gegenstelle ohne
                            //   Lagen, bei mehrdeutiger Zuordnung
                            //   Strom-zu-Bildschirm und bei nur EINEM Fenster
                            //   mit vollstaendiger Lage stand der Knopf da und
                            //   tat nichts.
                            // * Unter Wayland ist `set_outer_position` ein
                            //   stiller Leerlauf (`anordnen::
                            //   fenster_setzen_moeglich`). Das haengt an der
                            //   Oberflaeche und nicht an den Schirmen, deshalb
                            //   fragt es dieses Fenster selbst.
                            if self.fern_anordenbar && anordnen::fenster_setzen_moeglich(window) {
                                ui.add_space(6.0);
                                if ui
                                    .add(
                                        egui::Button::new(
                                            egui::RichText::new("Fenster wie drueben anordnen")
                                                .font(theme::font_xs())
                                                .color(theme::TEXT),
                                        )
                                        .fill(theme::GRUPPE_BG)
                                        .corner_radius(theme::RADIUS_MD),
                                    )
                                    .clicked()
                                {
                                    self.fern_menue_offen = false;
                                    actions.push(OverlayAction::FensterAnordnen);
                                }
                            }
                            ui.add_space(6.0);
                        }
                        // Der Schalter „Zwischenablage teilen" (s.
                        // `super::ablageschalter`). Er steht ueber dem
                        // Trennen-Knopf, weil er die laufende Sitzung
                        // veraendert statt sie zu beenden — und er zeichnet
                        // sich samt Abstand selbst, weil er auf Plattformen
                        // ohne Umsetzung ganz entfaellt.
                        self.ablage_schalter(ui, actions);
                        // Trennen steht unten und allein — es beendet die
                        // Fernsteuerung, nicht den Stream. Wer danach nur
                        // zusieht, hat wieder die gewohnte Leiste.
                        if ui
                            .add(
                                egui::Button::new(
                                    egui::RichText::new("Fernsteuerung beenden")
                                        .font(theme::font_xs())
                                        .color(theme::TEXT),
                                )
                                .fill(theme::GRUPPE_BG)
                                .corner_radius(theme::RADIUS_MD),
                            )
                            .clicked()
                        {
                            self.fern_menue_offen = false;
                            actions.push(OverlayAction::RemoteDisconnect);
                        }
                    });
            });
    }

    /// Rueckfall, wenn [`schirmkarte::darstellbar`] nein sagt: die Liste, die
    /// es vor der Karte gab. Zeigt nur die noch NICHT laufenden Schirme —
    /// ohne Lage laesst sich ohnehin keine Karte zeichnen, aber „dazuschalten"
    /// bleibt moeglich, denn dafuer braucht es nur `index`/`name`/`open`.
    ///
    /// Ein Schirm, der schon sein Fenster hat, gehoert nicht in eine Liste von
    /// Dingen, die man holen kann — er stand hier bis 2026-08-16 und sah aus
    /// wie ein zweiter, den es nicht gibt. Wer sein Fenster sucht, findet es
    /// ueber die Fensterverwaltung des Systems; wer es schliesst, bekommt den
    /// Eintrag hier von selbst zurueck.
    fn bildschirm_knopfliste(&mut self, ui: &mut egui::Ui, actions: &mut Vec<OverlayAction>) {
        let zuschaltbar: Vec<_> = self.fern_schirme.iter().filter(|s| !s.open).cloned().collect();
        // **Ist keiner mehr zu holen, steht es da** (2026-08-17). Vorher
        // verschwand die ganze Gruppe: wer wusste, dass der Rechner drei
        // Schirme hat, suchte dann nach einem Menuepunkt, den es aus gutem
        // Grund nicht mehr gab — und hielt das Fehlen fuer einen Fehler. Ein
        // Satz ist billiger als diese Suche.
        if zuschaltbar.is_empty() {
            ui.label(
                egui::RichText::new("Alle Bildschirme sind bereits offen")
                    .font(theme::font_xs())
                    .color(theme::TEXT_DIM),
            );
            return;
        }
        for schirm in &zuschaltbar {
            let beschriftung = format!("+ {}", schirm.name);
            if ui
                .add(
                    egui::Button::new(
                        egui::RichText::new(beschriftung).font(theme::font_xs()).color(theme::TEXT),
                    )
                    .fill(theme::GRUPPE_BG)
                    .corner_radius(theme::RADIUS_MD),
                )
                .clicked()
            {
                self.fern_menue_offen = false;
                actions.push(OverlayAction::RemoteScreen(schirm.index));
            }
        }
    }
}
