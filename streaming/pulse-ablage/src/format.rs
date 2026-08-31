//! Das Rahmenformat der geteilten Zwischenablage — vier Rahmen, beide
//! Richtungen, und die zwei Zahlen, gegen die gerechnet wird.

use serde_json::{Value, json};

/// Groesster Text, den eine Ablage-Uebertragung traegt.
///
/// 64 KiB sind rund zwoelf Stuecke (s. [`MAX_STUECK_ROH`]) und damit bei der
/// Selbstdrosselung auf 30 Stuecke/s rund 0,4 s vom Einfuegen bis zum Inhalt.
/// Die Grenze ist nicht der Speicher, sondern die WARTEZEIT: auf Windows und
/// macOS blockiert das einfuegende Programm, solange wir liefern.
pub const MAX_TEXT_BYTE: usize = 64 * 1024;

/// Groesste ROHE Nutzlast eines Stuecks, vor Base64.
///
/// Zurueckgerechnet aus dem Deckel des Gateways (8192 Byte kompaktes JSON,
/// `ws_remote_handlers.py:98`): 5900 rohe Byte werden zu 7868 Base64-Zeichen,
/// dazu hoechstens 77 Byte Huelle (`{"t":"stueck","id":…,"i":…,"n":…,"d":""}`
/// mit maximalen Zahlen) — zusammen 7945. Der Abstand zum Deckel ist Absicht
/// und hat einen Zwilling: `pulse-zeigerbild::MAX_LAEUFE_BYTE` (5900) ist aus
/// derselben Rechnung entstanden.
pub const MAX_STUECK_ROH: usize = 5900;

/// Warum nichts geliefert wird.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Grund {
    /// Die angeforderte Generation ist nicht mehr die aktuelle. **Es wird nie
    /// ein anderer Inhalt geliefert als der angekuendigte.**
    Veraltet,
    /// Der Inhalt ueberschreitet [`MAX_TEXT_BYTE`].
    ZuGross,
    /// Es gibt gar nichts (mehr) zu liefern — Sitzung vorbei, Ablage leer.
    Weg,
    /// Die Abruf-Frist ist abgelaufen.
    Frist,
}

impl Grund {
    pub fn als_str(&self) -> &'static str {
        match self {
            Grund::Veraltet => "veraltet",
            Grund::ZuGross => "zu_gross",
            Grund::Weg => "weg",
            Grund::Frist => "frist",
        }
    }

    pub fn aus_str(s: &str) -> Option<Grund> {
        match s {
            "veraltet" => Some(Grund::Veraltet),
            "zu_gross" => Some(Grund::ZuGross),
            "weg" => Some(Grund::Weg),
            "frist" => Some(Grund::Frist),
            _ => None,
        }
    }
}

/// Was angekuendigt wird.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Inhaltstyp {
    Text,
    /// Alles, was diese Fassung nicht kennt — Stufe 2 wird hier `dateien`
    /// schicken. Ein Rahmen damit ist **kein Fehler**: er wird gelesen und
    /// dann ignoriert. Wuerde er als Fehler gelten, risse eine neuere
    /// Gegenstelle die Sitzung ab.
    Anderes(String),
}

impl Inhaltstyp {
    fn als_str(&self) -> &str {
        match self {
            Inhaltstyp::Text => "text",
            Inhaltstyp::Anderes(s) => s,
        }
    }

    fn aus_str(s: &str) -> Inhaltstyp {
        if s == "text" { Inhaltstyp::Text } else { Inhaltstyp::Anderes(s.to_string()) }
    }
}

/// Ein Rahmen auf der Leitung. Reist als `data` einer `remote_signal`-Nachricht
/// mit `kind: "ablage"`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rahmen {
    /// Meine Ablage hat sich geaendert. **Sonst nichts.**
    Neu { generation: u64, typ: Inhaltstyp },
    /// Bei mir wird eingefuegt — gib Generation `gen` her.
    Hol { generation: u64, id: u64 },
    /// Stueck `i` von `n`, `d` ist Base64.
    Stueck { id: u64, i: u32, n: u32, d: String },
    /// Kann nicht liefern.
    Leer { id: u64, grund: Grund },
}

impl Rahmen {
    pub fn nach_json(&self) -> Value {
        match self {
            Rahmen::Neu { generation, typ } => json!({ "t": "neu", "gen": generation, "typ": typ.als_str() }),
            Rahmen::Hol { generation, id } => json!({ "t": "hol", "gen": generation, "id": id }),
            Rahmen::Stueck { id, i, n, d } => {
                json!({ "t": "stueck", "id": id, "i": i, "n": n, "d": d })
            }
            Rahmen::Leer { id, grund } => {
                json!({ "t": "leer", "id": id, "grund": grund.als_str() })
            }
        }
    }

    pub fn aus_json(v: &Value) -> Result<Rahmen, String> {
        let zahl = |feld: &str| -> Result<u64, String> {
            v.get(feld).and_then(Value::as_u64).ok_or_else(|| format!("{feld} fehlt"))
        };
        let klein = |feld: &str| -> Result<u32, String> {
            let n = zahl(feld)?;
            u32::try_from(n).map_err(|_| format!("{feld} zu gross"))
        };
        match v.get("t").and_then(Value::as_str) {
            Some("neu") => Ok(Rahmen::Neu {
                generation: zahl("gen")?,
                // Ein fehlendes `typ` als Text zu lesen waere geraten. Eine
                // Fassung, die `neu` schickt, schickt auch `typ` — sie steht
                // im selben `nach_json` daneben.
                typ: Inhaltstyp::aus_str(
                    v.get("typ").and_then(Value::as_str).ok_or("typ fehlt")?,
                ),
            }),
            Some("hol") => Ok(Rahmen::Hol { generation: zahl("gen")?, id: zahl("id")? }),
            Some("stueck") => Ok(Rahmen::Stueck {
                id: zahl("id")?,
                i: klein("i")?,
                n: klein("n")?,
                d: v.get("d").and_then(Value::as_str).ok_or("d fehlt")?.to_string(),
            }),
            Some("leer") => Ok(Rahmen::Leer {
                id: zahl("id")?,
                grund: v
                    .get("grund")
                    .and_then(Value::as_str)
                    .and_then(Grund::aus_str)
                    .ok_or("grund fehlt oder unbekannt")?,
            }),
            Some(andere) => Err(format!("unbekannte Rahmenart: {andere}")),
            None => Err("t fehlt".to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hin_und_zurueck(r: Rahmen) {
        let j = r.nach_json();
        let zurueck = Rahmen::aus_json(&j).expect("muss lesbar sein");
        assert_eq!(r, zurueck, "Rundlauf verliert etwas: {j}");
    }

    #[test]
    fn alle_vier_rahmen_ueberstehen_den_rundlauf() {
        hin_und_zurueck(Rahmen::Neu { generation: 7, typ: Inhaltstyp::Text });
        hin_und_zurueck(Rahmen::Hol { generation: 7, id: 3 });
        hin_und_zurueck(Rahmen::Stueck { id: 3, i: 0, n: 2, d: "aGFsbG8=".into() });
        hin_und_zurueck(Rahmen::Leer { id: 3, grund: Grund::Veraltet });
        hin_und_zurueck(Rahmen::Leer { id: 3, grund: Grund::ZuGross });
        hin_und_zurueck(Rahmen::Leer { id: 3, grund: Grund::Weg });
        hin_und_zurueck(Rahmen::Leer { id: 3, grund: Grund::Frist });
    }

    #[test]
    fn unbekannte_art_ist_ein_fehler() {
        let j = serde_json::json!({ "t": "erfunden", "gen": 1 });
        assert!(Rahmen::aus_json(&j).is_err());
    }

    #[test]
    fn fehlendes_feld_ist_ein_fehler() {
        // `hol` ohne `id` — fail-closed, nicht mit einer 0 auffuellen: eine
        // erfundene Anfragenummer beantwortete spaeter einen fremden Abruf.
        let j = serde_json::json!({ "t": "hol", "gen": 1 });
        assert!(Rahmen::aus_json(&j).is_err());
    }

    #[test]
    fn unbekannter_inhaltstyp_ist_kein_fehler() {
        // Stufe 2 wird `dateien` schicken. Eine aeltere Fassung muss den Rahmen
        // LESEN koennen und ihn dann ignorieren — wuerde sie ihn als Fehler
        // behandeln, risse eine neuere Gegenstelle die Sitzung ab. Das
        // Ignorieren entscheidet `sitzung.rs`, nicht diese Ebene.
        let j = serde_json::json!({ "t": "neu", "gen": 1, "typ": "dateien" });
        let r = Rahmen::aus_json(&j).expect("muss lesbar bleiben");
        assert_eq!(r, Rahmen::Neu { generation: 1, typ: Inhaltstyp::Anderes("dateien".into()) });
    }

    #[test]
    fn groesstes_stueck_bleibt_unter_dem_gateway_deckel() {
        // **Die wichtigste Zahl der Kiste.** Der Weiterleiter des Gateways misst
        // `len(json.dumps(data, separators=(",",":")))` gegen 8192
        // (`ws_remote_handlers.py:98,423`) und verwirft Groesseres — beim
        // Ratendeckel sogar STILL. Ein zu grosses Stueck saehe vom Sender aus
        // wie ein Erfolg aus und kaeme nie an.
        let roh = vec![b'x'; MAX_STUECK_ROH];
        let d = pulse_fernsteuerung::base64::kodiere(&roh);
        let r = Rahmen::Stueck { id: u64::MAX, i: u32::MAX, n: u32::MAX, d };
        let kompakt = serde_json::to_string(&r.nach_json()).expect("serialisierbar");
        assert!(
            kompakt.len() <= 8192,
            "Stueck ist {} Byte kompakt — ueber dem 8192-Deckel des Gateways",
            kompakt.len()
        );
    }
}
