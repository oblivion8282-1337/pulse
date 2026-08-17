//! Welche Grafikkarte Aufnahme und Encoder bekommen.
//!
//! **Warum es dieses Modul gibt.** Bis hierher hat Pulse die Karte nie
//! gewählt, sondern zugeteilt bekommen: `windows-capture` baut sein
//! D3D11-Gerät mit `D3D11CreateDevice(None, …)`, und was Windows daraufhin
//! herausgibt, bestimmt danach alles — `pipeline_hw` liest den Hersteller aus
//! genau diesem Gerät, und `VideoCodec::ffmpeg_name` macht daraus den Encoder.
//! Auf einem Rechner mit eingebauter und eingesteckter Grafik ist das die
//! Karte, die gerade den Bildschirm versorgt, also oft die eingebaute. Gemeldet
//! am 2026-08-17 von einem Nutzer mit RTX 2070 SUPER **und** Intel UHD 630:
//! `h264_qsv` statt `h264_nvenc`, und weil QSV den D3D11-Weg nicht betreten
//! kann, brach der Start ab.
//!
//! **Warum die Regel hier steht und nicht bei den DXGI-Aufrufen.** Sie ist der
//! Teil, der falsch sein kann, und sie ist der einzige Teil dieses
//! Zusammenhangs, der sich ohne Windows prüfen lässt. Deshalb kennt dieses
//! Modul weder `windows`- noch FFmpeg-Typen: es rechnet auf [`Karte`], einer
//! reinen Beschreibung, die `system::dxgi` aus dem Adapter füllt. Die Tests am
//! Dateiende laufen damit auf jeder Maschine.

/// Eine Grafikkarte, so weit die Auswahl sie kennen muss.
///
/// Abschrift aus `system::dxgi::Adapter` statt einer Anleihe darauf, damit
/// dieses Modul frei von `windows`-Typen bleibt (Begründung im Modulkopf).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Karte {
    /// Anzeigename aus `DXGI_ADAPTER_DESC1::Description`, z. B.
    /// „NVIDIA GeForce RTX 2070 SUPER". Nur für Log-Zeilen und die Oberfläche.
    pub beschreibung: String,
    pub vendor_id: u32,
    pub device_id: u32,
    /// Hersteller-Kurzname (`"nvidia"`/`"amd"`/`"intel"`/`"other"`).
    pub vendor: String,
    /// **Eigener** Videospeicher (`DedicatedVideoMemory`), nicht der geliehene.
    ///
    /// **Kein verlässliches Merkmal für „eingebaut oder eingesteckt"** — bei
    /// AMD ist der Wert der im BIOS eingestellte UMA-Ausschnitt und kann eine
    /// eingesteckte Karte übertreffen. Die Automatik zieht ihn deshalb nur
    /// heran, wenn es keine Rangfolge gibt (Herleitung an [`automatisch`]).
    /// Ansonsten dient er der Anzeige, damit man im Auswahlfeld die Karten
    /// auseinanderhalten kann.
    pub vram_mb: u64,
}

/// Was die `start`-Anfrage über die Karte sagt.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Wunsch {
    /// Kein Feld in der Anfrage, oder ausdrücklich „automatisch" — die Regel
    /// aus [`automatisch`] entscheidet. Der Regelfall, und deshalb auch der
    /// Vorgabewert: eine Anfrage ganz ohne `overrides`-Block landet hier.
    #[default]
    Automatisch,
    /// Eine bestimmte Karte, benannt über das Paar aus Hersteller- und
    /// Gerätekennung. Dasselbe Paar, über das `dxgi::list_adapters` Dubletten
    /// aussortiert — und damit dieselbe Schwäche: zwei **gleiche** Karten im
    /// selben Rechner sind darüber nicht auseinanderzuhalten. Die zweite fällt
    /// schon bei der Aufzählung weg, also gibt es hier nichts zu unterscheiden.
    Genau { vendor_id: u32, device_id: u32 },
}

/// Warum es diese Karte geworden ist. Geht wörtlich in die Log-Zeile, an der
/// eine Rückmeldung vom betroffenen Rechner hängt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Grund {
    /// Die Anfrage nannte diese Karte, und sie ist da.
    Gewuenscht,
    /// Automatik: von den Karten, deren Hersteller den schnellen Weg trägt,
    /// die stärkste (Herleitung an [`automatisch`]).
    SchnellsterWeg,
    /// Automatik, aber **keine** Karte trägt den schnellen Weg — dann die
    /// erste aus Windows' Reihenfolge, wie vor dieser Änderung auch.
    ErsteAusReihenfolge,
}

/// Das Ergebnis der Auswahl.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entscheidung {
    /// Stelle in der übergebenen Liste — also in der Reihenfolge, die
    /// `dxgi::list_adapters` geliefert hat.
    pub index: usize,
    pub grund: Grund,
    /// Die Anfrage nannte eine Karte, die nicht (mehr) im Rechner steckt.
    /// Der Index kommt dann aus der Automatik.
    ///
    /// **Kein Abbruch, sondern eine Warnung.** Eine gespeicherte Einstellung
    /// überlebt den Ausbau einer Karte, und wer die alte Karte verkauft hat,
    /// soll nicht vor einem Sidecar stehen, der den Dienst verweigert, bis er
    /// die richtige Stelle in den Einstellungen findet.
    pub wunsch_verfehlt: bool,
}

/// Die Karte für Aufnahme und Encoder bestimmen.
///
/// `karten` kommt aus `dxgi::list_adapters()`.
/// `traegt_schnellen_weg` beantwortet, ob ein Hersteller den D3D11-Zero-Copy-Weg
/// bedienen kann; die Antwort gehört zu `encode::codec` und wird von dort
/// hereingereicht, damit die Zuordnung nicht in zwei Fassungen existiert.
///
/// `nach_leistung_sortiert` sagt, ob `karten` in Windows' Leistungsreihenfolge
/// steht (`dxgi::sortiert_nach_leistung`). Davon hängt ab, woran sich die
/// Automatik festhält — Begründung an [`automatisch`].
///
/// `None` nur bei leerer Liste — dann gibt es nichts zu wählen, und der
/// Aufrufer hat ein anderes Problem als die Auswahl.
pub fn waehlen(
    karten: &[Karte],
    wunsch: &Wunsch,
    traegt_schnellen_weg: impl Fn(&str) -> bool,
    nach_leistung_sortiert: bool,
) -> Option<Entscheidung> {
    if karten.is_empty() {
        return None;
    }
    if let Wunsch::Genau { vendor_id, device_id } = *wunsch
        && let Some(index) = karten
            .iter()
            .position(|k| k.vendor_id == vendor_id && k.device_id == device_id)
    {
        return Some(Entscheidung { index, grund: Grund::Gewuenscht, wunsch_verfehlt: false });
    }
    let mut entscheidung = automatisch(karten, traegt_schnellen_weg, nach_leistung_sortiert);
    entscheidung.wunsch_verfehlt = matches!(wunsch, Wunsch::Genau { .. });
    Some(entscheidung)
}

/// Die Automatik: **eingesteckte Karte vor eingebauter Grafik.**
///
/// 1. **Trägt der Hersteller den schnellen Weg?** Intel scheidet damit aus —
///    nicht weil die Karte schlecht wäre, sondern weil `h264_qsv` den
///    D3D11-Zero-Copy-Weg nicht betreten kann und Pulse jeden Stream über den
///    eigenen WebRTC-Sendeweg schickt, den nur dieser Weg bedient.
/// 2. **Unter denen die erste aus Windows' Leistungsreihenfolge** —
///    `IDXGIFactory6::EnumAdapterByGpuPreference(HIGH_PERFORMANCE)`, die
///    `list_adapters` schon liefert. Das ist Microsofts eigene Antwort auf
///    genau diese Frage, und sie kennt den Unterschied zwischen eingebauter und
///    eingesteckter Grafik auch dann, wenn beide vom selben Hersteller sind.
///
/// **Hier stand am 2026-08-17 zwischenzeitlich „wer hat den meisten eigenen
/// Videospeicher", und das war falsch.** Die Annahme dahinter — eine im
/// Prozessor eingebaute Grafik melde nur ein paar hundert Megabyte — gilt für
/// Intel, aber nicht für AMD: dort ist `DedicatedVideoMemory` der im BIOS
/// eingestellte UMA-Ausschnitt und liegt auf Handhelds und vielen
/// Ryzen-Notebooks bei 4 bis 8 GB, einstellbar bis 16. Neben einer
/// eingesteckten RTX 4050 mit 6 GB hätte die Regel damit die **eingebaute**
/// Grafik gewählt — auf genau der Rechnerklasse, für die sie gebaut wurde, und
/// schlechter als die Wahl davor.
///
/// Der Videospeicher bleibt trotzdem im Spiel, aber nur da, wo es keine
/// Rangfolge gibt: fehlt `IDXGIFactory6` (Windows 10 vor 1803), fällt
/// `list_adapters` auf `EnumAdapters1` zurück, und dessen Reihenfolge sagt
/// über Leistung nichts aus. Dann ist „mehr eigener Videospeicher" das beste
/// verbliebene Merkmal — mitsamt der AMD-Schwäche von oben, die dort in Kauf zu
/// nehmen ist, weil es keine Alternative gibt.
///
/// Trägt **keine** Karte den schnellen Weg (reine Intel-Grafik), bleibt es bei
/// der ersten aus der Reihenfolge. Das ist dieselbe Karte wie vor dieser
/// Änderung; dass Intel danach nicht streamen kann, ist ein eigener Mangel und
/// wird nicht hier geheilt.
fn automatisch(
    karten: &[Karte],
    traegt_schnellen_weg: impl Fn(&str) -> bool,
    nach_leistung_sortiert: bool,
) -> Entscheidung {
    let mut tragende = karten
        .iter()
        .enumerate()
        .filter(|(_, k)| traegt_schnellen_weg(&k.vendor));
    let bester = if nach_leistung_sortiert {
        tragende.next()
    } else {
        // `max_by_key` nimmt bei Gleichstand den LETZTEN Größten — `Reverse`
        // dreht das um, damit die ursprüngliche Reihenfolge stehen bleibt.
        tragende.max_by_key(|(index, k)| (k.vram_mb, std::cmp::Reverse(*index)))
    };
    match bester {
        Some((index, _)) => {
            Entscheidung { index, grund: Grund::SchnellsterWeg, wunsch_verfehlt: false }
        }
        None => {
            Entscheidung { index: 0, grund: Grund::ErsteAusReihenfolge, wunsch_verfehlt: false }
        }
    }
}

/// Welche Karte **ohne Zutun des Nutzers** genommen würde.
///
/// Für `health` und `gpu_info`, die je eine Karte als „die eine" melden —
/// Hersteller und Codec-Angebot hängen daran, und damit im Renderer, welche
/// Codecs überhaupt zur Wahl stehen.
///
/// **Bis zum 2026-08-17 stand dort schlicht „die erste".** Solange niemand
/// wählen konnte, war das dieselbe Karte; seit der Auswahl ist es das nicht
/// mehr, und dann meldete `gpu_info` das Codec-Angebot einer Karte, auf der gar
/// nicht encodiert wird. Die Antwort hier ist trotzdem nur die der Automatik —
/// was der Nutzer eingestellt hat, weiß der Sidecar erst beim `start`, denn die
/// Einstellung lebt im Renderer.
pub fn vorgabe<'a>(
    karten: &'a [Karte],
    traegt_schnellen_weg: impl Fn(&str) -> bool,
    nach_leistung_sortiert: bool,
) -> Option<&'a Karte> {
    let wahl = waehlen(karten, &Wunsch::Automatisch, traegt_schnellen_weg, nach_leistung_sortiert)?;
    karten.get(wahl.index)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Wie `encode::codec::vendor_traegt_zero_copy` es beantwortet — hier
    /// nachgebildet, damit die Tests ohne FFmpeg auskommen.
    fn schnell(vendor: &str) -> bool {
        matches!(vendor, "nvidia" | "amd")
    }

    /// Die Regel im Regelfall: Windows hat nach Leistung sortiert.
    fn sortiert(karten: &[Karte]) -> usize {
        waehlen(karten, &Wunsch::Automatisch, schnell, true).unwrap().index
    }
    /// Der Rückfall auf `EnumAdapters1` — keine Rangfolge, nur Videospeicher.
    fn unsortiert(karten: &[Karte]) -> usize {
        waehlen(karten, &Wunsch::Automatisch, schnell, false).unwrap().index
    }

    /// Gerätekennungen werden **ausdrücklich** vergeben, nicht aus der
    /// Beschreibung abgeleitet: eine abgeleitete Kennung kann für zwei
    /// verschiedene Karten zufällig gleich ausfallen, und der Test prüfte dann
    /// still etwas anderes als gemeint.
    fn karte(beschreibung: &str, vendor: &str, vendor_id: u32, device_id: u32, vram_mb: u64) -> Karte {
        Karte {
            beschreibung: beschreibung.to_string(),
            vendor_id,
            device_id,
            vendor: vendor.to_string(),
            vram_mb,
        }
    }

    fn nvidia_2070() -> Karte {
        karte("NVIDIA GeForce RTX 2070 SUPER", "nvidia", 0x10DE, 0x1E84, 8192)
    }
    fn intel_uhd630() -> Karte {
        karte("Intel(R) UHD Graphics 630", "intel", 0x8086, 0x3E92, 128)
    }
    /// Eine im Prozessor eingebaute Radeon-Grafik **mit großem UMA-Ausschnitt**
    /// — 8 GB, im BIOS einstellbar. Genau der Wert, an dem eine Regel nach
    /// Videospeicher scheitert.
    fn amd_apu_gross() -> Karte {
        karte("AMD Radeon(TM) 780M Graphics", "amd", 0x1002, 0x15BF, 8192)
    }
    /// Eine eingesteckte Karte mit WENIGER eigenem Speicher als die APU oben.
    fn nvidia_4050_mobil() -> Karte {
        karte("NVIDIA GeForce RTX 4050 Laptop GPU", "nvidia", 0x10DE, 0x28A1, 6144)
    }

    /// Der gemeldete Fall: eingebaute Intel-Grafik neben einer NVIDIA-Karte.
    /// Windows stellt die NVIDIA in seiner Leistungsreihenfolge nach vorn.
    #[test]
    fn nvidia_schlaegt_eingebaute_intel_grafik() {
        let karten = vec![nvidia_2070(), intel_uhd630()];
        assert_eq!(karten[sortiert(&karten)].vendor, "nvidia");
        // Auch ohne Rangfolge, dann über den Videospeicher.
        let karten = vec![intel_uhd630(), nvidia_2070()];
        assert_eq!(karten[unsortiert(&karten)].vendor, "nvidia");
    }

    /// **Der Fall, an dem die erste Fassung dieser Regel gescheitert wäre.**
    /// Die eingebaute Radeon-Grafik meldet 8 GB (UMA-Ausschnitt), die
    /// eingesteckte RTX 4050 nur 6 — nach Videospeicher gewönne die
    /// eingebaute. Windows' Rangfolge weiß es besser.
    #[test]
    fn eingesteckte_karte_gewinnt_auch_mit_weniger_speicher() {
        let karten = vec![nvidia_4050_mobil(), amd_apu_gross()];
        let gewaehlt = &karten[sortiert(&karten)];
        assert_eq!(gewaehlt.vendor_id, 0x10DE, "die eingesteckte Karte muss es sein");
        assert!(gewaehlt.vram_mb < karten[1].vram_mb, "und zwar trotz weniger Speicher");
    }

    /// Ohne Rangfolge (altes Windows, `EnumAdapters1`) bleibt nur der
    /// Videospeicher — mitsamt seiner bekannten Schwäche. Der Test hält fest,
    /// dass das eine bewusste Inkaufnahme ist und kein Versehen.
    #[test]
    fn ohne_rangfolge_entscheidet_der_speicher() {
        let karten = vec![amd_apu_gross(), nvidia_4050_mobil()];
        assert_eq!(karten[unsortiert(&karten)].vendor_id, 0x1002);
        // Zwei AMD mit klarem Abstand — dort trifft der Speicher richtig.
        let karten = vec![
            karte("AMD Radeon(TM) Graphics", "amd", 0x1002, 0x164E, 512),
            karte("AMD Radeon RX 7900 XTX", "amd", 0x1002, 0x744C, 24576),
        ];
        assert_eq!(karten[unsortiert(&karten)].vram_mb, 24576);
    }

    /// Reine Intel-Grafik: nichts trägt den schnellen Weg. Dann bleibt es bei
    /// der ersten Karte — dieselbe Wahl wie vor dieser Änderung.
    #[test]
    fn ohne_schnellen_weg_bleibt_die_erste() {
        let karten = vec![intel_uhd630()];
        let e = waehlen(&karten, &Wunsch::Automatisch, schnell, true).unwrap();
        assert_eq!(e.index, 0);
        assert_eq!(e.grund, Grund::ErsteAusReihenfolge);
    }

    /// Ein ausdrücklicher Wunsch schlägt die Automatik — auch der auf die
    /// eingebaute Grafik. Wer sie bewusst wählt, bekommt sie.
    #[test]
    fn wunsch_schlaegt_automatik() {
        let karten = vec![nvidia_2070(), intel_uhd630()];
        let wunsch = Wunsch::Genau { vendor_id: 0x8086, device_id: 0x3E92 };
        let e = waehlen(&karten, &wunsch, schnell, true).unwrap();
        assert_eq!(e.index, 1);
        assert_eq!(e.grund, Grund::Gewuenscht);
        assert!(!e.wunsch_verfehlt);
    }

    /// Eine gespeicherte Einstellung überlebt den Ausbau der Karte. Dann greift
    /// die Automatik, und der Aufrufer bekommt etwas zu melden — aber der
    /// Stream läuft.
    #[test]
    fn verfehlter_wunsch_faellt_auf_die_automatik_zurueck() {
        let karten = vec![nvidia_2070(), intel_uhd630()];
        let wunsch = Wunsch::Genau { vendor_id: 0x1002, device_id: 0x7448 };
        let e = waehlen(&karten, &wunsch, schnell, true).unwrap();
        assert_eq!(karten[e.index].vendor, "nvidia");
        assert!(e.wunsch_verfehlt);
    }

    /// Ohne Karten gibt es nichts zu wählen — und keinen Index, der auf etwas
    /// zeigt. Der Aufrufer muss den Fall selbst benennen.
    #[test]
    fn leere_liste_ergibt_keine_wahl() {
        assert!(waehlen(&[], &Wunsch::Automatisch, schnell, true).is_none());
        assert!(vorgabe(&[], schnell, true).is_none());
    }

    /// `vorgabe` muss dieselbe Karte melden, die ein Start ohne Einstellung
    /// nähme — sonst zeigte die Oberfläche das Codec-Angebot einer Karte, auf
    /// der gar nicht encodiert wird.
    #[test]
    fn vorgabe_meldet_dieselbe_karte_wie_die_automatik() {
        let karten = vec![intel_uhd630(), nvidia_2070()];
        assert_eq!(vorgabe(&karten, schnell, true), Some(&karten[sortiert(&karten)]));
        assert_eq!(vorgabe(&karten, schnell, true).unwrap().vendor, "nvidia");
    }

    /// Ohne Rangfolge und bei gleichem Videospeicher bleibt die ursprüngliche
    /// Reihenfolge stehen. `max_by_key` nähme sonst den LETZTEN Größten — der
    /// `Reverse`-Anteil im Schlüssel dreht das um, und ohne ihn wäre die Regel
    /// unbemerkt eine andere.
    #[test]
    fn gleichstand_behaelt_die_reihenfolge() {
        let karten = vec![
            karte("Erste Karte", "nvidia", 0x10DE, 0x0001, 8192),
            karte("Zweite Karte", "amd", 0x1002, 0x0002, 8192),
        ];
        assert_eq!(unsortiert(&karten), 0);
    }
}
