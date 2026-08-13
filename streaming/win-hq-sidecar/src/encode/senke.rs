//! Wohin die encodierten Pakete gehen — und wie sich ein anderer Sendeweg
//! dazwischenschalten kann, ohne dass diese Bibliothek ihn kennt.
//!
//! **Das Problem.** Es gibt zwei grundverschiedene Ziele. Der Muxer schreibt in
//! einen Container (FLV über RTMPS) und braucht dafür Streams, Zeitbasen und
//! einen Kopf. Ein WebRTC-Sendeweg kennt nichts davon: dort ist ein Bild ein
//! Sample, die Paketierung macht die WebRTC-Schicht, und die Zeitstempel kommen
//! aus der RTP-Uhr. Ein umgerechneter Zeitstempel wäre dort nicht nur nutzlos,
//! sondern irreführend.
//!
//! **Warum ein Trait und keine zweite Encoder-Fassung.** Das Linux-Labor hat
//! die Gabelung durch eine Kopie des Encoders gelöst. Unter Windows wäre das
//! dreimal so teuer, weil es drei Encoder-Wege gibt (`encoder_hw`,
//! `encoder_d3d12`, `encoder`) — und dazu käme die Pipeline, die den ganzen
//! Ablauf von Aufnahme über Skalierung bis zur Taktung trägt. Drei Kopien einer
//! Datei, die je Bild läuft, laufen auseinander; welche Fassung dann welchen
//! Fehler hat, findet niemand mehr. Also sitzt die Gabelung **hinter** dem
//! Encoder: alles bis zum fertigen Paket bleibt eine einzige Implementierung,
//! und nur das letzte Stück unterscheidet sich.
//!
//! **Warum eine Anmeldung statt eines Parameters.** Der Sendeweg müsste sonst
//! durch vier Schichten durchgereicht werden (`StartParams` →
//! `stream_controller` → `pipeline_hw` → `create`), nur damit ganz unten eine
//! Entscheidung fällt, die ganz oben feststeht. Stattdessen meldet der Aufrufer
//! seinen Bauer einmal beim Start an — dieselbe Form, die [`crate::keyframe`]
//! aus demselben Grund hat.
//!
//! **Ohne Anmeldung ändert sich nichts.** Der ausgelieferte Sidecar meldet
//! keinen Bauer an; [`zustaendig`] liefert dann immer `false` und jeder Stream
//! geht über den Muxer, Byte für Byte wie vorher.

use std::time::Duration;

use anyhow::Result;

/// Ein Ziel für fertige Encoder-Pakete, das kein Container ist.
///
/// `Send` ist tragend, nicht Zierde: die Senke wandert in den Abgabe-Faden
/// (`senke_writer.rs`), damit der Taktfaden nicht am Netz hängt. Ohne diese
/// Schranke lässt sich die Box dort nicht hinbewegen.
pub trait PaketSenke: Send {
    /// Ein fertiges Videopaket, roh.
    ///
    /// `pts` ist der Zeitstempel des Encoder-Pakets in der **Encoder**-Zeitbasis
    /// (1/fps, ein Takt also ein Bildabstand) — nicht in RTP-Takten, und nicht
    /// umgerechnet. Ob er gebraucht wird, entscheidet der Sendeweg: der
    /// H.264-Weg stempelt aus der Bilddauer und ignoriert ihn, der eigene
    /// AV1-Paketierer rechnet ihn um.
    ///
    /// **Hier stand bis 2026-08-04 „kein Zeitstempel, die Zeit setzt der
    /// Sendeweg selbst".** Das war die Bauart, bevor der Linux-Zweig den
    /// RTP-Zeitstempel vom Bildzähler auf den echten `pts` umgestellt hat: ein
    /// Zähler unterstellt, dass jedes eingeschobene Bild auch eines wird, und
    /// läuft auseinander, sobald der Encoder eines verwirft oder die Taktung
    /// dupliziert.
    fn video(&mut self, daten: &[u8], pts: Option<i64>) -> Result<()>;

    /// Ein fertiges Tonpaket samt seiner Länge. Die Länge ist nicht optional —
    /// aus ihr leitet der Sendeweg den Zeitstempel ab, und ein falscher Wert
    /// verschiebt den Ton gegen das Bild, ohne dass irgendwo ein Fehler
    /// auftaucht.
    fn audio(&mut self, daten: &[u8], dauer: Duration) -> Result<()>;

    /// Sitzung abbauen. Läuft **genau einmal**, vom Abgabe-Faden, wenn er
    /// endet — Idempotenz ist also nicht nötig.
    fn schliesse(&mut self);
}

/// Was der Sendeweg zum Aufbau braucht. Mehr als die URL, weil eine
/// WebRTC-Sitzung ihre Spuren im Angebot festlegt und nichts davon
/// nachverhandeln kann.
pub struct SenkenAuftrag<'a> {
    pub url: &'a str,
    /// Codec-Kurzname wie im `start`-Request (`"h264"` / `"av1"`).
    pub codec: &'a str,
    pub fps: u32,
    /// Die Maße, mit denen wirklich encodiert wird (nach Skalierung).
    ///
    /// Nicht Zierde: das Angebot nennt bei AV1 eine Stufe (`seq_level_idx`) und
    /// bei H.264 eine Fassung, und beide hängen an Bildgröße mal Bildrate. Eine
    /// zu klein angesetzte Stufe lässt den Hardware-Decoder des Zuschauers
    /// aussteigen — er fällt dann auf Software zurück, das Bild läuft weiter,
    /// und niemand sieht es an einer Bildzahl. Genau so am 2026-08-02 passiert
    /// (Level 3.0 bei 720p), Herleitung in `whip::sdp`.
    pub breite: u32,
    pub hoehe: u32,
    /// Ziel-Bitrate des Encoders. Kein Aufbau-Parameter, sondern der Maßstab
    /// für den REMB-Rückkanal (`whip::bandbreite`): erst mit dem Ziel wird aus
    /// der Bandbreitenschätzung der Gegenseite eine Aussage („die Leitung
    /// trägt das Ziel nicht"). `0` = unbekannt, die Wacht bleibt dann stumm.
    pub bitrate_kbps: u32,
}

/// Baut die Sitzung auf. **Läuft erst, wenn die Encoder offen sind** — würde
/// hier früher verbunden und ein Encoder scheiterte danach, bliebe beim Server
/// eine Karteileiche, die erst ein Zeitablauf aufräumt. Deshalb wird vorher
/// über [`zustaendig`] nur *gefragt*, ohne etwas aufzubauen.
///
/// Ein Fehler bricht den Start ab, statt stillschweigend auf den Muxer
/// zurückzufallen. Der stille Rückfall wäre die schlimmere Antwort: der Stream
/// liefe, aber ohne Rückkanal, und niemand wüsste, warum die Fehlerkorrektur
/// nichts tut.
pub type SenkenBauer = fn(&SenkenAuftrag) -> Result<Box<dyn PaketSenke>>;

static BAUER: super::einmal::EinmalBauer<SenkenBauer> = super::einmal::EinmalBauer::new();

/// Den Bauer anmelden. Einmal beim Programmstart, vor dem ersten `start`.
///
/// Ein zweiter Aufruf wird ignoriert und meldet das auch: zwei Sendewege im
/// selben Prozess wären ein Aufbaufehler, und ein stilles Gewinnen des ersten
/// würde beim Suchen Stunden kosten.
pub fn registriere_senken_bauer(bauer: SenkenBauer) {
    BAUER.registriere(
        bauer,
        "[senke] WARNUNG: zweiter Senken-Bauer ignoriert — der erste bleibt",
    );
}

/// Übernimmt ein angemeldeter Sendeweg diese URL?
///
/// **Welche URLs das sind, entscheidet diese Bibliothek, nicht der Anmelder** —
/// nämlich genau die, die sonst zu FFmpegs WHIP-Muxer gingen. Das ist der
/// einzige Ausgang, den ein fremder Sendeweg sinnvoll ersetzen kann; für RTMPS
/// gibt es einen funktionierenden Muxer. Die Schema-Tabelle steht damit
/// weiterhin an genau einer Stelle ([`super::output::url_format_hint`]) — eine
/// zweite Liste beim Anmelder würde früher oder später abweichen, und dann
/// liefe entweder ein RTMPS-Stream in einen WebRTC-Sender oder ein WHIP-Stream
/// still über den Muxer.
pub(crate) fn zustaendig(url: &str) -> bool {
    BAUER.get().is_some() && super::output::is_whip_url(url)
}

/// Die Sitzung aufbauen. Nur rufen, wenn [`zustaendig`] `true` gesagt hat.
pub(crate) fn baue(auftrag: &SenkenAuftrag) -> Result<Box<dyn PaketSenke>> {
    let bauer = BAUER.get().ok_or_else(|| anyhow::anyhow!("kein Senken-Bauer angemeldet"))?;
    bauer(auftrag)
}

#[cfg(test)]
mod tests {
    /// Der ausgelieferte Sidecar meldet keinen Bauer an — dann muss **jede**
    /// URL über den Muxer gehen, auch die, die ein Labor übernehmen würde.
    ///
    /// Der Test schützt genau eine Fehlerart: dass hier eines Tages ein
    /// Vorgabe-Bauer entsteht und der ausgelieferte Sidecar unbemerkt einen
    /// anderen Sendeweg nimmt. Das wäre nicht als Fehler sichtbar — der Stream
    /// liefe — sondern nur an Zahlen, die niemand mehr erklären kann.
    ///
    /// Er kommt ohne Anmeldung aus und kann deshalb neben allen anderen Tests
    /// im selben Prozess laufen; ein Test, der anmeldet, ginge nicht, weil die
    /// Anmeldung prozessweit und einmalig ist.
    #[test]
    fn ohne_anmeldung_geht_alles_ueber_den_muxer() {
        for url in [
            "rtmps://host:1936/live/x",
            "https://host/whip/x",
            "http://host/whip/x",
            "out.mp4",
        ] {
            assert!(!super::zustaendig(url), "{url} darf ohne Anmeldung nicht uebernommen werden");
        }
    }
}
