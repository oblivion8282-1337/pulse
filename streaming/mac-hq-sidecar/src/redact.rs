//! Token aus einer Push-URL entfernen, bevor sie in eine Meldung geht.
//!
//! **Hier stand nichts — die Funktion lag bis zum 2026-08-20 ZWEIMAL im
//! Sidecar** (`ops/start.rs` und `encode/mod.rs`), beide Male gleich. Mit dem
//! eigenen Sendeweg waere eine dritte Kopie dazugekommen. Windows und Linux
//! fuehren dafuer laengst ein eigenes Modul; dieses zieht nach.
//!
//! Der Name `redact_url` ist von der Linux-Fassung uebernommen, damit die
//! kopierten Sendeweg-Dateien unveraendert bleiben koennen.

/// Mask a token in a push URL for logging (never log the raw stream key).
pub fn redact_url(url: &str) -> String {
    let mut s = url.to_string();
    for pat in ["pass=", "token=", "streamid=publish:"] {
        if let Some(idx) = s.find(pat) {
            let start = idx + pat.len();
            let end = s[start..]
                .find(|c: char| c == '&' || c == ' ')
                .map(|i| start + i)
                .unwrap_or(s.len());
            s.replace_range(start..end, "***");
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ein Token darf unter keinen Umstaenden in einer Meldung landen — nicht
    /// im Log, nicht in einer Fehlermeldung, nirgends.
    #[test]
    fn token_verschwindet() {
        let roh = "https://howispulse.com/whep/channel-1-2/whip?token=geheim123";
        let sauber = redact_url(roh);
        assert!(!sauber.contains("geheim123"), "Token steht noch drin: {sauber}");
        assert!(sauber.contains("howispulse.com"), "Host soll lesbar bleiben: {sauber}");
    }

    /// Eine URL ohne Token bleibt brauchbar — sonst nuetzt die Meldung nichts.
    #[test]
    fn ohne_token_bleibt_lesbar() {
        let roh = "rtmps://howispulse.com:1936/channel-1-2";
        assert!(redact_url(roh).contains("howispulse.com"));
    }
}
