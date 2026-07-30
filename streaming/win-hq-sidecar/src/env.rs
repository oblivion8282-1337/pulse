//! Umgebungsvariablen als Schalter — eine Auslegung für alle.
//!
//! Der Sidecar wird über ein gutes Dutzend `PULSE_*`-Variablen gesteuert, und
//! die Schalter darunter wurden über die Zeit in vier verschiedenen
//! Schreibweisen gelesen: `.is_ok()`, `== Ok("1")`, `!= Ok("0")` und
//! `.map(|v| !v.is_empty() && v != "0").unwrap_or(false)`. Vier Schreibweisen
//! heißen vier Auslegungen: bei der einen schaltete `=0` ein, bei der nächsten
//! aus, bei der dritten tat `=true` nichts. Wer die Doku las und `=true`
//! setzte, bekam je nach Variable etwas anderes — und nichts davon war
//! irgendwo aufgeschrieben.
//!
//! Ab hier gilt überall dieselbe Regel:
//!
//! - **nicht gesetzt** → der Vorgabewert der jeweiligen Funktion
//! - **leer oder `0`** → aus
//! - **alles andere** (`1`, `true`, `yes`, `ja`, …) → an
//!
//! Damit funktionieren die dokumentierten Formen (`=1`, `=0`) unverändert
//! weiter; zusätzlich tut jetzt das, was Leute ohnehin tippen, das Erwartbare.
//!
//! Werte, die keine Schalter sind (Pfade, Zahlen, Optionslisten), werden
//! bewusst weiter an ihrer Stelle geparst — die tragen ihre eigene Prüfung
//! (Wertebereich, erlaubte Größen) und gehören nicht hierher.

/// Der gesetzte Wert einer Variablen als Schalter gelesen.
fn an(wert: &str) -> bool {
    !wert.is_empty() && wert != "0"
}

/// Der Schalter, **falls gesetzt** — `None` heißt „nicht gesetzt".
///
/// Für die Fälle, in denen die Vorgabe nicht konstant ist, sondern erst zur
/// Laufzeit feststeht (z.B. abhängig vom GPU-Hersteller, s.
/// `encode/hwctx.rs`): `flag_opt(..).unwrap_or_else(|| berechnet())`. Mit
/// `flag`/`flag_default_on` allein ließe sich das nicht ausdrücken, ohne die
/// Variable zweimal zu lesen — und zweimal lesen heißt zwei Auslegungen.
pub fn flag_opt(name: &str) -> Option<bool> {
    std::env::var(name).ok().map(|v| an(&v))
}

/// Schalter, der **aus** ist, solange ihn niemand setzt.
///
/// Für alles, was vom Regelbetrieb abweicht: Kill-Switches, Messschalter,
/// Diagnose-Ausgaben.
pub fn flag(name: &str) -> bool {
    flag_opt(name).unwrap_or(false)
}

/// Schalter, der **an** ist, solange ihn niemand setzt.
///
/// Für Verhalten, das der Regelbetrieb ist und das man nur zum Gegenmessen
/// abschaltet (`PULSE_TCP_NODELAY=0`).
pub fn flag_default_on(name: &str) -> bool {
    flag_opt(name).unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::an;

    #[test]
    fn leer_und_null_sind_aus() {
        assert!(!an(""));
        assert!(!an("0"));
    }

    /// Die dokumentierten Formen müssen weiter gelten — `=1` schaltet ein,
    /// `=0` aus. Alles andere gilt als „gesetzt, also gemeint".
    #[test]
    fn alles_andere_ist_an() {
        for v in ["1", "true", "yes", "ja", "on", "2"] {
            assert!(an(v), "{v} sollte einschalten");
        }
    }
}
