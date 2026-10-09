//! Ziel-URL der Brücke — die EINZIGE Stelle, an der aus einem Pfad vom
//! DataChannel eine Backend-Adresse wird (HTTP-Kanal und `ws:<pfad>` gleich).
//!
//! **Warum es diese Stelle gibt:** Der Pfad kommt ungeprüft von der
//! Gegenstelle, und den DataChannel öffnen darf jedes Cloud-Konto (gewollt —
//! die Schranke ist Caddy samt Anmeldung DAHINTER). Früher wurde schlicht
//! `format!("{base}{pfad}")` gebaut. Ein Pfad `@127.0.0.1:9997/…` machte
//! daraus `http://127.0.0.1:8080@127.0.0.1:9997/…` — nach URL-Standard ist
//! alles vor dem `@` Userinfo, die Anfrage ging also an die MediaMTX-API statt
//! an Caddy, und mit `@192.168.178.1/` ins Heimnetz. Belegt im Test
//! `alter_aufbau_zeigte_auf_fremden_host`.
//!
//! Zwei Riegel, beide fail-closed: (1) die Form des Pfades, (2) nach dem
//! Zusammensetzen müssen Schema, Host und Port exakt die der Backend-Basis
//! sein. (2) allein genügte; (1) gibt eine verständliche Absage und hält
//! Eingaben fern, die ein späterer Umbau wieder durchrutschen lassen könnte.

use reqwest::Url;

#[derive(Debug, PartialEq, Eq)]
pub enum ZielFehler {
    /// Pfad hat nicht die erlaubte Form (siehe `pfad_pruefen`).
    Pfad,
    /// Basis (`PULSE_DIRECT_BACKEND`) ist keine brauchbare URL.
    Basis,
    /// Zusammengesetzte URL zeigt auf einen anderen Ursprung als die Basis.
    Ursprung,
}

/// Erlaubt ist ausschließlich ein Pfad, der mit GENAU einem `/` beginnt und
/// weder Steuer- noch Leerzeichen noch `\` enthält. `@` ist nur in der Query
/// zulässig: dort kann es keine Userinfo mehr bilden (die Autorität endet am
/// ersten `/`), und Suchanfragen mit E-Mail-Adressen tragen es legitim. Ein
/// prozentkodiertes `%40` im Pfad bleibt erlaubt — es ist Pfadinhalt, kein
/// Trennzeichen.
fn pfad_pruefen(pfad: &str) -> Result<(), ZielFehler> {
    if !pfad.starts_with('/') || pfad.starts_with("//") {
        return Err(ZielFehler::Pfad);
    }
    if pfad.chars().any(|c| c.is_control() || c.is_whitespace() || c == '\\') {
        return Err(ZielFehler::Pfad);
    }
    let nur_pfad = pfad.split(['?', '#']).next().unwrap_or("");
    if nur_pfad.contains('@') {
        return Err(ZielFehler::Pfad);
    }
    Ok(())
}

/// Baut die Backend-URL für `pfad`. `ws = true` wechselt das Schema auf
/// `ws`/`wss` (für den WebSocket-Kanal). Prüft danach, dass Schema, Host und
/// Port der Ergebnis-URL denen der Basis entsprechen und keine Userinfo
/// entstanden ist.
pub fn backend_url(basis: &str, pfad: &str, ws: bool) -> Result<Url, ZielFehler> {
    pfad_pruefen(pfad)?;
    let mut basis_url = Url::parse(basis).map_err(|_| ZielFehler::Basis)?;
    if !matches!(basis_url.scheme(), "http" | "https") || basis_url.host_str().is_none() {
        return Err(ZielFehler::Basis);
    }
    if ws {
        let neu = if basis_url.scheme() == "https" { "wss" } else { "ws" };
        basis_url.set_scheme(neu).map_err(|_| ZielFehler::Basis)?;
    }
    // Basis ohne Pfadanteil: `join` mit einem absoluten Pfad ersetzt ihn
    // ohnehin, die Ursprungsprüfung unten ist die eigentliche Schranke.
    let url = basis_url.join(pfad).map_err(|_| ZielFehler::Pfad)?;
    let gleicher_ursprung = url.scheme() == basis_url.scheme()
        && url.host_str() == basis_url.host_str()
        && url.port_or_known_default() == basis_url.port_or_known_default()
        && url.username().is_empty()
        && url.password().is_none();
    if !gleicher_ursprung {
        return Err(ZielFehler::Ursprung);
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASIS: &str = "http://127.0.0.1:8080";

    /// Gegenprobe: der frühere Aufbau `format!("{base}{pfad}")` zeigte
    /// tatsächlich auf einen fremden Host/Port. Ohne diesen Test wäre der
    /// Befund nur behauptet.
    #[test]
    fn alter_aufbau_zeigte_auf_fremden_host() {
        let alt = Url::parse(&format!("{BASIS}{}", "@127.0.0.1:9997/v3/config/global/patch")).unwrap();
        assert_eq!(alt.host_str(), Some("127.0.0.1"));
        assert_eq!(alt.port(), Some(9997));
        assert_eq!(alt.username(), "127.0.0.1");
        assert_eq!(alt.password(), Some("8080"));

        let heimnetz = Url::parse(&format!("{BASIS}{}", "@192.168.178.1/")).unwrap();
        assert_eq!(heimnetz.host_str(), Some("192.168.178.1"));
        assert_eq!(heimnetz.port_or_known_default(), Some(80));

        // Dasselbe für den WS-Kanal mit dem früheren `replacen("http","ws")`.
        let ws_basis = BASIS.replacen("http", "ws", 1);
        let alt_ws = Url::parse(&format!("{ws_basis}{}", "@10.0.0.1:22/")).unwrap();
        assert_eq!(alt_ws.host_str(), Some("10.0.0.1"));
    }

    #[test]
    fn angriffspfade_werden_abgewiesen() {
        for pfad in [
            "@127.0.0.1:9997/v3/config/global/patch",
            "@192.168.178.1/",
            ":9997/v3/paths/list",
            "//evil.example/",
            "/\\evil.example/",
            "\\\\evil.example/",
            "/api@evil/",
            "/a b",
            "/a\tb",
            "/a\r\nHost: evil",
            "",
            "api/auth/health",
            ".evil.example/",
        ] {
            assert!(backend_url(BASIS, pfad, false).is_err(), "durchgelassen: {pfad:?}");
            assert!(backend_url(BASIS, pfad, true).is_err(), "WS durchgelassen: {pfad:?}");
        }
    }

    #[test]
    fn normale_pfade_bleiben_beim_backend() {
        let u = backend_url(BASIS, "/api/auth/health", false).unwrap();
        assert_eq!(u.as_str(), "http://127.0.0.1:8080/api/auth/health");

        let q = backend_url(BASIS, "/api/chat/search?q=a@b.de&limit=20", false).unwrap();
        assert_eq!(q.host_str(), Some("127.0.0.1"));
        assert_eq!(q.port(), Some(8080));
        assert_eq!(q.path(), "/api/chat/search");
        assert_eq!(q.query(), Some("q=a@b.de&limit=20"));

        // Prozentkodiertes @ ist Pfadinhalt, kein Trenner.
        let p = backend_url(BASIS, "/%40127.0.0.1:9997/x", false).unwrap();
        assert_eq!(p.port(), Some(8080));
        assert_eq!(p.path(), "/%40127.0.0.1:9997/x");
    }

    #[test]
    fn ws_kanal_wechselt_nur_das_schema() {
        let u = backend_url(BASIS, "/api/ws/ws?token=abc", true).unwrap();
        assert_eq!(u.scheme(), "ws");
        assert_eq!(u.host_str(), Some("127.0.0.1"));
        assert_eq!(u.port(), Some(8080));
        let s = backend_url("https://pulse.example", "/ws", true).unwrap();
        assert_eq!(s.as_str(), "wss://pulse.example/ws");
    }

    #[test]
    fn kaputte_basis_ist_fail_closed() {
        assert_eq!(backend_url("kein-url", "/x", false), Err(ZielFehler::Basis));
        assert_eq!(backend_url("file:///etc", "/x", false), Err(ZielFehler::Basis));
    }
}
