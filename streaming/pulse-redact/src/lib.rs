//! Maskierung von Stream-Keys in Strings, die den Prozess verlassen.
//!
//! **Seit dem 2026-08-20 gemeinsam fuer alle drei Sidecars.** Vorher lag diese
//! Funktion dreimal vor, mit drei verschiedenen VERHALTEN: Windows kannte die
//! meisten Abschlusszeichen, aber keine Gross-/Kleinschreibungs-Toleranz;
//! Linux umgekehrt; macOS maskierte nur das erste Vorkommen je Praefix. Es gab
//! also Adressen, bei denen ein Schluessel auf einer Plattform maskiert wurde
//! und auf einer anderen im Klartext im Protokoll landete.
//!
//! Diese Fassung setzt die Staerken zusammen und faengt damit strikt mehr als
//! jede der drei. Welcher Test welche alte Luecke schliesst, steht am Test.
//!
//! Push-URLs tragen den Key als `pass=…`, `token=…` oder `streamid=publish:…`.
//! Über anyhow-Fehlerketten landet die volle URL sonst in Antworten und Events
//! (`encode::output::open_output` hängt sie als Kontext an), und
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
pub fn ends_value(c: char) -> bool {
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
/// Sucht gross-/kleinschreibungsunempfindlich (Praefixe wie `Token=` werden
/// genauso gefasst wie `token=`), ersetzt aber im Original. Die Suche laeuft
/// auf einer per `to_ascii_lowercase()` erzeugten Kopie — ASCII-Kleinschreibung
/// erhaelt die Byte-Abstaende, deshalb stimmen die Positionen im Original.
/// Bewusst NICHT `to_lowercase()`: das kann bei nicht-ASCII-Zeichen die Laenge
/// aendern und die Positionen verschieben.
///
/// NICHT idempotent: ein zweiter Lauf über bereits maskierten Text sucht
/// hinter dem eingesetzten `***` weiter und kann dabei zu viel wegfressen.
/// Jede Ausgabestelle redigiert deshalb genau einmal — beim Verketten von
/// Pfaden darauf achten.
/// `pub`, damit alle drei Sidecars und das Labor dieselbe Maskierung benutzen
/// statt je einer eigenen. Mehrere Fassungen davon wären die Sorte Doppelung,
/// die irgendwann einen Stream-Key ins Log schreibt.
pub fn redact_url(url: &str) -> String {
    let mut out = url.to_string();
    for pat in ["pass=", "token=", "streamid=publish:"] {
        let mut from = 0;
        // Alle Vorkommen, nicht nur das erste: eine Fehlermeldung kann die URL
        // mehrfach enthalten (verschachtelte anyhow-Kontexte).
        while let Some(rel) = out[from..].to_ascii_lowercase().find(pat) {
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
    use super::*;

    /// Der Grundfall, den alle drei alten Fassungen konnten.
    #[test]
    fn token_wird_maskiert() {
        let roh = "https://howispulse.com/whep/kanal/whip?token=geheim123";
        let s = redact_url(roh);
        assert!(!s.contains("geheim123"), "Token steht noch drin: {s}");
        assert!(s.contains("howispulse.com"), "Host soll lesbar bleiben: {s}");
    }

    /// **Konnte vorher NUR Linux.** Windows und macOS suchten
    /// gross-/kleinschreibungsempfindlich und haetten den Schluessel
    /// durchgelassen.
    #[test]
    fn grossgeschriebener_parametername_wird_auch_gefasst() {
        let s = redact_url("rtmps://h/p?Token=geheim123&x=1");
        assert!(!s.contains("geheim123"), "Token= mit grossem T durchgerutscht: {s}");
    }

    /// **Konnte vorher NUR Windows.** Linux und macOS kannten als Ende nur
    /// `&` und Leerzeichen, fanden hier keins und maskierten deshalb bis zum
    /// Ende der Meldung — der Schluessel war zwar weg, der Rest der Meldung
    /// aber auch.
    #[test]
    fn url_in_klammern_endet_an_der_klammer() {
        let s = redact_url("Fehler (url=rtmps://h/p?pass=geheim123) beim Oeffnen");
        assert!(!s.contains("geheim123"), "Schluessel steht noch drin: {s}");
        assert!(s.contains(") beim Oeffnen"), "Rest der Meldung gefressen: {s}");
    }

    /// **Konnte vorher NICHT macOS.** Verschachtelte anyhow-Kontexte
    /// enthalten dieselbe URL mehrfach; macOS maskierte nur das erste
    /// Vorkommen und liess die folgenden im Klartext stehen.
    #[test]
    fn alle_vorkommen_werden_gefasst() {
        let s = redact_url("open (rtmps://h?pass=eins): failed rtmps://h?pass=zwei");
        assert!(!s.contains("eins"), "erstes Vorkommen: {s}");
        assert!(!s.contains("zwei"), "zweites Vorkommen durchgerutscht: {s}");
    }

    /// Base64-Schluessel enthalten `/`, `+`, `=` — die duerfen NICHT als Ende
    /// gelten, sonst bliebe ein Rest des Schluessels stehen.
    #[test]
    fn base64_schluessel_wird_ganz_gefasst() {
        let s = redact_url("?token=aGVsbG8+d29ybGQ/Zm9v=");
        assert!(!s.contains("aGVsbG8"), "Anfang steht noch da: {s}");
        assert!(!s.contains("Zm9v"), "Rest des Schluessels steht noch da: {s}");
    }

    /// Alle drei bekannten Praefixe, je einer pro Sendeweg.
    #[test]
    fn alle_drei_sendewege() {
        for (roh, geheim) in [
            ("?token=abc123", "abc123"),        // WHIP
            ("?pass=abc123", "abc123"),         // RTMPS
            ("?streamid=publish:abc123", "abc123"), // SRT
        ] {
            let s = redact_url(roh);
            assert!(!s.contains(geheim), "{roh} nicht maskiert: {s}");
        }
    }

    /// Ohne Schluessel bleibt die Meldung unveraendert brauchbar.
    #[test]
    fn ohne_schluessel_unveraendert() {
        let roh = "rtmps://howispulse.com:1936/kanal";
        assert_eq!(redact_url(roh), roh);
    }
}
