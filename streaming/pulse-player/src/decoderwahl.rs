//! `PULSE_PLAYER_DECODER` — die Kandidatenliste des Decoders von aussen
//! einschraenken und umsortieren.
//!
//! **Wozu, wenn die Vorgabe doch die richtige sein soll.** Die Liste in
//! `decode::candidates_mit` entscheidet still, welchen Bildweg der ganze Player
//! nimmt: auf einer NVIDIA-Karte gewinnt `av1_cuvid`, und damit ist die
//! Zero-Copy-Bruecke (`crate::zerocopy`) aus dem Spiel, bevor sie gefragt wird
//! — sie haengt am D3D11VA-Bild. Ohne einen Schalter laesst sich der zweite Weg
//! auf so einer Maschine **gar nicht messen**, und genau daran ist der
//! NVIDIA-Nachweis am 2026-08-11 zuerst haengengeblieben.
//!
//! **Es hat ihn schon einmal gegeben.** Die Messakte
//! `streaming/testbench/profiles/player-2026-08-06-bildweg-kosten.json` nennt
//! ihn im Abschnitt `kosten_je_bild_d3d11va_weg` woertlich („Erzwungen ueber
//! PULSE_PLAYER_DECODER=av1+hw") — im Quelltext war er am 2026-08-11 nirgends
//! mehr zu finden. Die Akte beschreibt damit einen Aufbau, den niemand
//! nachstellen konnte. Diese Datei stellt ihn wieder her, mit derselben
//! Schreibweise.
//!
//! ## Schreibweise
//!
//! Komma-getrennte Liste; **die Reihenfolge ist die Probierreihenfolge**, nicht
//! die der Vorgabe. Je Eintrag:
//!
//! | Eintrag | trifft |
//! |---|---|
//! | `libdav1d` | den Kandidaten OHNE angehaengtes Geraet |
//! | `av1+hw` | den nativen Decoder mit dem plattform-eigenen hwaccel (D3D11VA unter Windows, VAAPI unter Linux) |
//! | `av1_cuvid+cuda` | den cuvid-Decoder mit CUDA-Geraet (Bild bleibt auf der Karte) |
//!
//! `av1_cuvid` allein trifft also den cuvid-Decoder **ohne** Geraet — den, der
//! sein Bild in den Hauptspeicher legt. Das ist kein Sonderfall, sondern
//! dieselbe Regel: ohne Zusatz ist der Kandidat ohne Geraet gemeint.
//!
//! ## Was er ausdruecklich NICHT tut
//!
//! Er faellt bei einem Tippfehler **nicht** auf die volle Liste zurueck. Eine
//! Vorgabe, die nichts trifft, laesst den Decoder mit „kein Decoder fuer av1"
//! scheitern — laut und sofort. Der stille Rueckfall waere hier der schlimmere
//! Fehler: er liefert ein tadelloses Messergebnis vom falschen Weg, und in
//! genau diese Falle ist dieses Projekt mehrfach getreten (der Sender, der eine
//! Option klaglos annimmt und nichts damit tut). Deshalb steht die Warnung
//! auch dann da, wenn nur ein einzelner Eintrag ins Leere geht.

/// Der Umgebungs-Schalter, EINMAL gelesen.
///
/// Wie bei `zerocopy::angefordert` nicht je Aufruf: die Kandidatenliste wird
/// zwar nur beim Anlegen eines Decoders gebaut, aber `VideoDecoder::sonde` und
/// jeder Neuaufbau fragen erneut, und der Wert kann sich zur Laufzeit nicht
/// aendern.
///
/// **Folge fuers Testen:** die Variable ist prozessweit, ein gesetztes
/// `PULSE_PLAYER_DECODER` faerbt also auch `decode::tests` ein (dort pruefen
/// zwei Tests die volle Kandidatenliste ueber `candidates`). Dieselbe Falle
/// besteht seit laengerem fuer `PULSE_PLAYER_CUDA_AUSGABE`, und die Antwort
/// darauf steht in `decode.rs`: was ohne Umgebung pruefbar sein muss, geht
/// ueber `candidates_mit`. Wer hier eine Messung faehrt, setzt die Variable
/// fuer den LAUF, nicht fuer die Sitzung der Testsuite.
fn vorgabe() -> &'static Option<Vec<String>> {
    static WUNSCH: std::sync::OnceLock<Option<Vec<String>>> = std::sync::OnceLock::new();
    WUNSCH.get_or_init(|| {
        let roh = std::env::var("PULSE_PLAYER_DECODER").ok()?;
        let liste: Vec<String> = roh
            .split(',')
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| !s.is_empty())
            .collect();
        if liste.is_empty() {
            return None;
        }
        eprintln!("pulse-player: Decoder-Vorgabe aus der Umgebung: {}", liste.join(", "));
        Some(liste)
    })
}

/// Trifft ein Eintrag der Vorgabe diesen Kandidaten?
///
/// `geraet` ist die Kurzform des angehaengten Geraets (`"hw"` fuer den
/// plattform-eigenen hwaccel, `"cuda"`), `None` fuer „kein Geraet".
fn trifft(eintrag: &str, name: &str, geraet: Option<&str>) -> bool {
    match eintrag.split_once('+') {
        Some((n, g)) => n == name && geraet == Some(g),
        None => eintrag == name && geraet.is_none(),
    }
}

/// Die Liste nach der Vorgabe filtern und in deren Reihenfolge bringen.
///
/// Ohne Vorgabe kommt sie unveraendert zurueck — der Regelbetrieb geht also
/// durch dieselbe Funktion und wird von ihr nicht angefasst.
///
/// `kennung` liefert zu einem Kandidaten sein Paar aus Name und Geraete-Kurzform.
/// **Ueber diesen Umweg statt ueber den `Kandidat`-Typ selbst**, damit dieses
/// Modul nichts aus `decode.rs` importieren muss und die dortige Datei (weit
/// ueber der Groessengrenze) nicht weiter waechst.
pub fn filtern<T: Copy>(
    liste: Vec<T>,
    kennung: impl Fn(&T) -> (&'static str, Option<&'static str>),
) -> Vec<T> {
    let Some(wunsch) = vorgabe() else { return liste };
    let mut aus = Vec::new();
    for eintrag in wunsch {
        let mut getroffen = false;
        for k in &liste {
            let (name, geraet) = kennung(k);
            if trifft(eintrag, name, geraet) {
                aus.push(*k);
                getroffen = true;
            }
        }
        if !getroffen {
            eprintln!(
                "pulse-player: Decoder-Vorgabe {eintrag:?} trifft keinen Kandidaten \
                 — Schreibweise: name, name+hw, name+cuda"
            );
        }
    }
    aus
}

#[cfg(test)]
mod tests {
    use super::trifft;

    /// Ohne Zusatz ist der Kandidat OHNE Geraet gemeint — auch dann, wenn es
    /// denselben Namen mit Geraet gibt. Genau dieses Paar steht in der echten
    /// Liste zweimal (`av1_cuvid` mit und ohne CUDA), und eine Vorgabe, die
    /// beide traefe, machte den Schalter fuer die Messung wertlos.
    #[test]
    fn ohne_zusatz_meint_ohne_geraet() {
        assert!(trifft("av1_cuvid", "av1_cuvid", None));
        assert!(!trifft("av1_cuvid", "av1_cuvid", Some("cuda")));
    }

    #[test]
    fn mit_zusatz_meint_genau_dieses_geraet() {
        assert!(trifft("av1+hw", "av1", Some("hw")));
        assert!(!trifft("av1+hw", "av1", None));
        assert!(!trifft("av1+hw", "av1", Some("cuda")));
        assert!(trifft("av1_cuvid+cuda", "av1_cuvid", Some("cuda")));
    }

    #[test]
    fn ein_fremder_name_trifft_nichts() {
        assert!(!trifft("av1+hw", "h264", Some("hw")));
        assert!(!trifft("libdav1d", "av1", None));
    }
}
