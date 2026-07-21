//! Maskierung von Stream-Keys in Strings, die den Prozess verlassen.
//!
//! Push-URLs tragen den Key als `pass=…`, `token=…` oder `streamid=publish:…`.
//! Über anyhow-Fehlerketten landet die volle URL sonst in Antworten und Events
//! (`encode::encoder::open_output` hängt sie als Kontext an), und
//! `desktop/electron/sidecar.ts` schreibt JEDE stdout-Zeile in eine persistente
//! Log-Datei — der Key läge im Klartext auf der Platte. Projektregel: niemals
//! Stream-Keys loggen.
//!
//! Bewusst NICHT in `events::emit` verdrahtet, obwohl das der eine Trichter für
//! allen stdout-Verkehr wäre: dort läuft auch Signaling-Nutzlast durch (SDP/ICE
//! der Fernsteuerung), die eine blinde Textersetzung zerstören würde. Redigiert
//! wird an den Quellen — Fehler-Strings und die argv-Antwort.

/// Endet der Key-Wert an diesem Zeichen?
///
/// Die Liste ist bewusst kurz gehalten. Ein zu früher Schnitt ließe einen Rest
/// des Keys stehen (schlecht), ein zu später frisst nur Interpunktion drumherum
/// (kosmetisch) — im Zweifel also lieber zu viel maskieren. Deshalb gelten
/// URL-taugliche Zeichen (`/`, `+`, `=`, `%`, `:`, `-`, `_`, `.`) NICHT als
/// Ende: Base64-Keys enthalten sie. Klammern und Anführungszeichen dagegen
/// schon — in Fehlerketten steht die URL fast immer eingefasst
/// (`format::output(rtmps://…?pass=x)`), und ohne sie fräße die Maskierung die
/// schließende Klammer mit.
fn ends_value(c: char) -> bool {
    c.is_whitespace()
        || matches!(
            c,
            '&' | '"' | '\'' | '(' | ')' | '[' | ']' | '{' | '}' | ',' | ';' | '<' | '>' | '|' | '`'
        )
}

/// Ersetzt die Werte aller bekannten Key-Parameter durch `***`.
///
/// Bewusst textuell statt via URL-Parser: die Eingabe ist meist eine ganze
/// Fehlermeldung mit eingebetteter URL, kein sauberer URL-String.
///
/// NICHT idempotent: ein zweiter Lauf über bereits maskierten Text sucht
/// hinter dem eingesetzten `***` weiter und kann dabei zu viel wegfressen.
/// Jede Ausgabestelle redigiert deshalb genau einmal — beim Verketten von
/// Pfaden darauf achten.
pub(crate) fn secrets(s: &str) -> String {
    let mut out = s.to_string();
    for pat in ["pass=", "token=", "streamid=publish:"] {
        let mut from = 0;
        // Alle Vorkommen, nicht nur das erste: eine Fehlermeldung kann die URL
        // mehrfach enthalten (verschachtelte anyhow-Kontexte).
        while let Some(rel) = out[from..].find(pat) {
            let val_start = from + rel + pat.len();
            let val_end = out[val_start..]
                .find(ends_value)
                .map(|i| val_start + i)
                .unwrap_or(out.len());
            out.replace_range(val_start..val_end, "***");
            // Hinter das eingesetzte `***` weitersuchen — sonst Endlosschleife.
            from = val_start + 3;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::secrets;

    #[test]
    fn maskiert_query_token() {
        assert_eq!(
            secrets("rtmps://h:1936/live?pass=geheim"),
            "rtmps://h:1936/live?pass=***"
        );
    }

    #[test]
    fn maskiert_alle_vorkommen() {
        assert_eq!(
            secrets("open(rtmps://h/l?token=a) failed: rtmps://h/l?token=a"),
            "open(rtmps://h/l?token=***) failed: rtmps://h/l?token=***"
        );
    }

    #[test]
    fn behaelt_folgende_parameter() {
        assert_eq!(secrets("?pass=x&y=1"), "?pass=***&y=1");
    }

    #[test]
    fn maskiert_streamid_und_laesst_rest_unberuehrt() {
        assert_eq!(
            secrets("srt://h?streamid=publish:chan-1-2 rest"),
            "srt://h?streamid=publish:*** rest"
        );
    }

    /// Der reale Leck-Pfad: `open_output` hängt die URL als anyhow-Kontext an,
    /// eingefasst in Klammern. Die Klammer muss stehen bleiben.
    #[test]
    fn laesst_umschliessende_klammer_stehen() {
        assert_eq!(
            secrets("format::output(rtmps://h:1936/live?pass=abc123): Fehler"),
            "format::output(rtmps://h:1936/live?pass=***): Fehler"
        );
    }

    #[test]
    fn base64_key_wird_ganz_maskiert() {
        // `/`, `+`, `=` sind gültige Key-Zeichen und dürfen nicht abschneiden.
        assert_eq!(secrets("?token=aB+c/d=="), "?token=***");
    }

    #[test]
    fn zeilenumbruch_beendet_den_wert() {
        assert_eq!(secrets("?pass=abc\nnaechste Zeile"), "?pass=***\nnaechste Zeile");
    }

    #[test]
    fn ohne_treffer_unveraendert() {
        assert_eq!(secrets("rtmps://h/live"), "rtmps://h/live");
    }
}
