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
//!
//! **Bewusst nicht mitgezogen: `streaming/gsr-sidecar/redact.py`.** Vierte
//! Fassung, im Python-Sidecar (Linux-Auffangnetz), regexbasiert und faengt
//! strikt weniger (verlangt ein `[?&]` vor dem Praefix, maskiert beim
//! SRT-Streamid nur das letzte Segment statt alles ab `publish:`). Bleibt
//! trotzdem eigenstaendig: der Python-Sidecar hat keine Rust-Abhaengigkeiten
//! und soll keine bekommen.
//!
//! **Reichweite: dies ist der EINZIGE Filter zwischen einer Push-URL und
//! allem, was ein Sidecar hinausschreibt** — Antworten, Events, den eigenen
//! Sendeweg eingeschlossen. Wer diese Funktion anfasst, misst sich an dieser
//! Reichweite. Sie trifft ausserdem nur die drei unten genannten Praefixe;
//! eine URL mit einem Token unter anderem Namen geht ungefiltert durch.
//! **Kommt ein vierter Sendeweg dazu, gehoert sein Praefix hier in die Liste
//! nachgetragen** (`["pass=", "token=", "streamid=publish:"]` in
//! `redact_url`) — sonst faengt die Maskierung ihn nicht.

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
        assert_eq!(
            redact_url(roh),
            "https://howispulse.com/whep/kanal/whip?token=***"
        );
    }

    /// **Konnte vorher NUR Linux.** Windows und macOS suchten
    /// gross-/kleinschreibungsempfindlich und haetten den Schluessel
    /// durchgelassen.
    #[test]
    fn grossgeschriebener_parametername_wird_auch_gefasst() {
        assert_eq!(
            redact_url("rtmps://h/p?Token=geheim123&x=1"),
            "rtmps://h/p?Token=***&x=1"
        );
    }

    /// **Konnte vorher NUR Windows.** Linux und macOS kannten als Ende nur
    /// `&` und Leerzeichen. Hier gibt es zwar ein Leerzeichen (nach der
    /// schliessenden Klammer), aber keins VOR ihr — Linux/macOS haetten
    /// deshalb erst dort geschnitten und die schliessende Klammer mit
    /// aufgefressen (`"...pass=*** beim Oeffnen"`), nicht die ganze
    /// restliche Meldung. Diese Fassung kennt zusaetzlich `)` als Ende und
    /// erhaelt die Klammer.
    #[test]
    fn url_in_klammern_endet_an_der_klammer() {
        assert_eq!(
            redact_url("Fehler (url=rtmps://h/p?pass=geheim123) beim Oeffnen"),
            "Fehler (url=rtmps://h/p?pass=***) beim Oeffnen"
        );
    }

    /// **Konnte vorher NICHT macOS.** Verschachtelte anyhow-Kontexte
    /// enthalten dieselbe URL mehrfach; macOS maskierte nur das erste
    /// Vorkommen und liess die folgenden im Klartext stehen. Zugleich belegt
    /// das die schliessende Klammer gefolgt von `: ` — auch dahinter bleibt
    /// der Rest der Meldung erhalten.
    #[test]
    fn alle_vorkommen_werden_gefasst() {
        assert_eq!(
            redact_url("open (rtmps://h?pass=eins): failed rtmps://h?pass=zwei"),
            "open (rtmps://h?pass=***): failed rtmps://h?pass=***"
        );
    }

    /// Base64-Schluessel enthalten `/`, `+`, `=` — die duerfen NICHT als Ende
    /// gelten, sonst bliebe ein Rest des Schluessels stehen. Deckt alle drei
    /// ab, inklusive eines Schluessels, der selbst auf `==` endet.
    #[test]
    fn base64_schluessel_wird_ganz_gefasst() {
        assert_eq!(redact_url("?token=aB+c/d=="), "?token=***");
    }

    /// Alle drei bekannten Praefixe, je einer pro Sendeweg. Der SRT-Fall
    /// belegt zugleich, dass ein Leerzeichen nach dem Schluessel den Rest
    /// der Meldung stehen laesst statt ihn mit aufzufressen.
    #[test]
    fn alle_drei_sendewege() {
        for (roh, erwartet) in [
            ("?token=abc123", "?token=***"),                     // WHIP
            ("?pass=abc123", "?pass=***"),                       // RTMPS
            ("?streamid=publish:abc123", "?streamid=publish:***"), // SRT
        ] {
            assert_eq!(redact_url(roh), erwartet, "bei Eingabe {roh}");
        }
    }

    /// Ohne Schluessel bleibt die Meldung unveraendert brauchbar.
    #[test]
    fn ohne_schluessel_unveraendert() {
        let roh = "rtmps://howispulse.com:1936/kanal";
        assert_eq!(redact_url(roh), roh);
    }

    /// `&` schneidet ab, der Rest der Query bleibt stehen.
    #[test]
    fn endet_am_kaufmannsund_rest_bleibt() {
        assert_eq!(redact_url("?pass=x&y=1"), "?pass=***&y=1");
    }

    /// Ein Zeilenumbruch zaehlt als Whitespace und damit als Ende — mehrzeilige
    /// Logmeldungen sollen nicht ueber die Zeile hinaus mitgerissen werden.
    #[test]
    fn zeilenumbruch_ist_ein_endezeichen() {
        assert_eq!(
            redact_url("token=geheim123\nrest der meldung"),
            "token=***\nrest der meldung"
        );
    }

    /// `streamid=publish:…` endet wie jeder andere Praefix an einem
    /// Leerzeichen — der Rest der Meldung nach dem Schluessel bleibt lesbar.
    #[test]
    fn streamid_rest_der_meldung_bleibt() {
        assert_eq!(
            redact_url("streamid=publish:abc123 rest der meldung"),
            "streamid=publish:*** rest der meldung"
        );
    }

    /// `)` gefolgt von `: ` — die schliessende Klammer UND das Folgende
    /// bleiben erhalten, nicht nur eins von beidem.
    #[test]
    fn schliessende_klammer_gefolgt_von_doppelpunkt_bleibt() {
        assert_eq!(redact_url("(pass=geheim): Fehler"), "(pass=***): Fehler");
    }

    /// `ends_value` ist `pub` und wird ausserhalb dieser Datei aufgerufen
    /// (`find(ends_value)`) — ohne einen Test dafuer stuende die eigentliche
    /// Substanz der Funktion (welche Zeichen ein Ende markieren, welche
    /// bewusst nicht) nur im Fliesstext ihres Doc-Kommentars. Haelt die
    /// Zeichenmenge direkt fest, unabhaengig von `redact_url`.
    #[test]
    fn ends_value_deckt_erwartete_zeichen_ab() {
        for c in [' ', '\n', '\t', '&', '"', '\'', '(', ')', '[', ']', '{', '}', ',', ';', '<', '>', '|', '`'] {
            assert!(ends_value(c), "{c:?} soll als Ende gelten");
        }
        // URL-taugliche Zeichen: Base64-Schluessel enthalten sie, sie duerfen
        // deshalb NICHT als Ende gelten.
        for c in ['/', '+', '=', '%', ':', '-', '_', '.'] {
            assert!(!ends_value(c), "{c:?} soll NICHT als Ende gelten");
        }
    }
}
