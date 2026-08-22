//! Zaehlt eine Zeigerlage als gewollte Bewegung des Hosts?
//!
//! Die reine Haelfte der Wache: der Weg zur vorigen Lage summiert sich ueber
//! ein Zeitfenster, und erst die Schwelle loest aus. Ohne Betriebssystem
//! pruefbar — die Haken (Windows) bzw. der Ereignis-Abgriff (macOS) liegen
//! bei der jeweiligen Plattform und reichen nur Zahlen herein.

/// Wie weit der Zeiger des Hosts wandern muss, damit es als Absicht zaehlt.
///
/// Ohne Schwelle genuegte ein angestossener Tisch oder ein Handballen auf dem
/// Touchpad, um den Steuernden fuenf Sekunden auszusperren. Knopf und Taste
/// tragen keine solche Schwelle — die drueckt niemand versehentlich.
pub const SCHWELLE_PX: u32 = 8;

/// In welchem Zeitfenster sich die Schwelle summieren darf. Danach beginnt die
/// Summe von vorn, damit ein ueber Minuten kriechender Zeiger (Sensorrauschen)
/// sie nie erreicht.
pub const FENSTER_MS: u64 = 250;

#[derive(Clone, Copy)]
pub struct Bewegung {
    /// Zuletzt gesehene Zeigerlage, `None` = noch keine.
    lage: Option<(i32, i32)>,
    /// Summierter Weg im laufenden Fenster.
    summe: u32,
    /// Wann das Fenster begann.
    seit_ms: u64,
}

impl Bewegung {
    pub const fn neu() -> Self {
        Self { lage: None, summe: 0, seit_ms: 0 }
    }
}

impl Default for Bewegung {
    fn default() -> Self {
        Self::neu()
    }
}

/// Zählt diese Zeigerlage als gewollte Bewegung des Hosts?
///
/// Reine Rechnung, damit sie ohne Windows und ohne Hook prüfbar ist: der Weg
/// zur vorigen Lage summiert sich über ein Zeitfenster, und erst die Schwelle
/// löst aus. Nach dem Auslösen beginnt die Summe von vorn — sonst zählte jede
/// weitere Regung derselben Bewegung noch einmal.
///
/// **`eigen` trägt die Lage nach, ohne zu zählen — und daran hing die ganze
/// Schwelle** (Bughunt 2026-08-14). Die gemeldete Zeigerlage ist absolut.
/// Wurde die eigene Injektion einfach übersprungen, blieb die
/// Vergleichslage dort stehen, wo der Host seinen Zeiger zuletzt hatte,
/// während der Steuernde ihn quer über den Schirm führte. Die nächste echte
/// Regung des Hosts — auch ein 2-px-Zittern — maß dann den Abstand zwischen
/// beiden Zeigern, also hunderte Pixel, und löste sofort aus. Die Schwelle war
/// damit genau in der Lage wirkungslos, für die sie geschrieben wurde.
///
/// Die Summe bleibt dabei ausdrücklich **unangetastet**: eine dazwischen
/// gefunkte Injektion darf dem Host nicht den Weg löschen, den er schon
/// zurückgelegt hat. Der Irrtum geht so zu seinen Gunsten.
pub fn zaehlt(b: &mut Bewegung, jetzt_ms: u64, x: i32, y: i32, eigen: bool) -> bool {
    let vorige = b.lage.replace((x, y));
    if eigen {
        return false;
    }
    let Some((vx, vy)) = vorige else {
        // Die erste gesehene Lage ist der Nullpunkt, keine Bewegung: beim
        // Aufstellen der Wache steht der Zeiger irgendwo, und das ist kein
        // Zutun des Hosts.
        b.seit_ms = jetzt_ms;
        return false;
    };
    if jetzt_ms.saturating_sub(b.seit_ms) > FENSTER_MS {
        b.summe = 0;
        b.seit_ms = jetzt_ms;
    }
    let weg = x.abs_diff(vx) + y.abs_diff(vy);
    b.summe = b.summe.saturating_add(weg);
    if b.summe < SCHWELLE_PX {
        return false;
    }
    b.summe = 0;
    b.seit_ms = jetzt_ms;
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frisch() -> Bewegung {
        Bewegung::neu()
    }

    /// Die erste Lage ist der Nullpunkt — beim Aufstellen der Wache steht der
    /// Zeiger irgendwo, und das ist keine Regung des Hosts.
    #[test]
    fn erste_lage_zaehlt_nicht() {
        let mut b = frisch();
        assert!(!zaehlt(&mut b, 0, 500, 500, false));
    }

    /// Ein Ruckeln unterhalb der Schwelle löst nichts aus — der Fall, für den
    /// die Schwelle da ist (angestoßener Tisch, Handballen auf dem Touchpad).
    #[test]
    fn zittern_unter_der_schwelle_loest_nicht_aus() {
        let mut b = frisch();
        zaehlt(&mut b, 0, 500, 500, false);
        for (i, (x, y)) in [(501, 500), (500, 501), (501, 501), (500, 500)].iter().enumerate() {
            assert!(
                !zaehlt(&mut b, i as u64 * 10, *x, *y, false),
                "({x},{y}) hätte nicht auslösen dürfen"
            );
        }
    }

    /// Eine gewollte Bewegung löst aus, sobald der Weg die Schwelle erreicht —
    /// auch über mehrere Ereignisse hinweg, denn eine Maus meldet in kleinen
    /// Schritten.
    #[test]
    fn gewollte_bewegung_loest_aus() {
        let mut b = frisch();
        zaehlt(&mut b, 0, 500, 500, false);
        assert!(!zaehlt(&mut b, 10, 503, 500, false));
        assert!(!zaehlt(&mut b, 20, 506, 500, false));
        assert!(zaehlt(&mut b, 30, 509, 500, false), "9 px müssen reichen");
    }

    /// Ein Sprung über die Schwelle löst sofort aus.
    #[test]
    fn sprung_loest_sofort_aus() {
        let mut b = frisch();
        zaehlt(&mut b, 0, 500, 500, false);
        assert!(zaehlt(&mut b, 10, 900, 200, false));
    }

    /// **Der Grund für das Zeitfenster:** ein über Minuten kriechender Zeiger
    /// (Sensorrauschen, schräger Tisch) darf die Schwelle nie erreichen. Jeder
    /// Schritt für sich ist winzig, und zwischen ihnen verfällt die Summe.
    #[test]
    fn kriechen_ueber_die_zeit_erreicht_die_schwelle_nie() {
        let mut b = frisch();
        zaehlt(&mut b, 0, 0, 0, false);
        for i in 1..200u64 {
            let t = i * (FENSTER_MS + 50);
            assert!(
                !zaehlt(&mut b, t, i as i32, 0, false),
                "Schritt {i} (1 px je {}ms) hätte nicht auslösen dürfen",
                FENSTER_MS + 50
            );
        }
    }

    /// Nach dem Auslösen beginnt die Summe von vorn — sonst löste jede weitere
    /// Regung derselben Bewegung erneut aus und die Schwelle wäre wirkungslos.
    #[test]
    fn nach_dem_ausloesen_beginnt_die_summe_von_vorn() {
        let mut b = frisch();
        zaehlt(&mut b, 0, 0, 0, false);
        assert!(zaehlt(&mut b, 10, 20, 0, false));
        assert!(!zaehlt(&mut b, 20, 21, 0, false), "1 px nach dem Auslösen");
    }

    /// **Der Fund (Bughunt 2026-08-14):** die eigene Injektion darf die
    /// Vergleichslage nicht stehen lassen. Die gemeldete Zeigerlage ist
    /// absolut — führt der Steuernde den Zeiger quer über den Schirm, während
    /// die Wache noch die Lage des Hosts merkt, misst das nächste 2-px-Zittern
    /// des Hosts den Abstand zwischen beiden Zeigern und löst sofort aus. Die
    /// Schwelle wäre damit ausgerechnet während einer laufenden Fernsteuerung
    /// wirkungslos.
    #[test]
    fn eigene_injektion_traegt_die_lage_nach_ohne_zu_zaehlen() {
        let mut b = frisch();
        zaehlt(&mut b, 0, 500, 500, false); // Host: Nullpunkt
        // Der Steuernde führt den Zeiger weit weg — zählt nicht.
        assert!(!zaehlt(&mut b, 10, 1900, 100, true));
        // Und jetzt das Zittern des Hosts, gemessen ab der NEUEN Lage.
        assert!(
            !zaehlt(&mut b, 20, 1902, 100, false),
            "2 px nach einer eigenen Bewegung dürfen nicht auslösen"
        );
        // Eine echte Bewegung löst weiter aus.
        assert!(zaehlt(&mut b, 30, 1912, 100, false));
    }

    /// Die Summe des Hosts überlebt eine dazwischenfunkende Injektion — der
    /// Irrtum geht zu seinen Gunsten, nicht zu denen des Steuernden.
    #[test]
    fn eigene_injektion_loescht_den_weg_des_hosts_nicht() {
        let mut b = frisch();
        zaehlt(&mut b, 0, 500, 500, false);
        assert!(!zaehlt(&mut b, 10, 505, 500, false), "5 px");
        zaehlt(&mut b, 15, 900, 900, true); // Injektion dazwischen
        assert!(
            zaehlt(&mut b, 20, 903, 900, false),
            "5 + 3 px müssen zusammen weiter reichen"
        );
    }
}
