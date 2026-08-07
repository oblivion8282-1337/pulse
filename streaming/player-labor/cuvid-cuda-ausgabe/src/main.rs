//! Probe: gibt `av1_cuvid` seine Bilder als CUDA-Speicher heraus?
//!
//! Die Frage entscheidet, ob der Zero-Copy-Umbau im `pulse-player` ueberhaupt
//! ankommen kann. Nachbarproben haben belegt, dass CUDA in ein exportiertes
//! Vulkan-Bild schreiben kann und wgpu 29 so ein Bild uebernimmt
//! (`../cuda-vulkan-import`, `../wgpu-cuda-import`). Was fehlt, ist der
//! Anfang der Kette: liegt das dekodierte Bild ueberhaupt auf der Karte?
//!
//! Heute steht im Modulkopf von `pulse-player/src/decode.rs`, die
//! cuvid-Decoder lieferten ihre Bilder in den Hauptspeicher — und die
//! Kostenmessung `player-2026-08-06-bildweg-kosten.json` hat das bestaetigt,
//! ohne die Ursache zu klaeren.
//!
//! **Was die Probe absichert.** Jede Kontrolle faengt eine Fehlerklasse, die in
//! diesem Labor schon einen falschen Befund erzeugt hat:
//!
//! * **Kontrolle A** (`cuda::selbsttest`): der Zeigertest muss echten
//!   Grafikspeicher von gewoehnlichem Hauptspeicher unterscheiden koennen.
//!   Sonst waere „liegt im Hauptspeicher" nicht von „der Test erkennt nichts"
//!   zu trennen.
//! * **Kontrolle B** (`SPIKE_VERGLEICH=1`): die Bilder beider Arme muessen
//!   Bild fuer Bild denselben Inhalt haben. Eine Adresse auf der Karte, hinter
//!   der kein Bild steht, waere kein Ergebnis.
//! * **Kontrolle C**: ein absichtlich verfaelschtes Byte muss den
//!   Fingerabdruck aendern. Ohne sie waere „alle Abdruecke gleich" nicht von
//!   „der Abdruck vergleicht nichts" zu unterscheiden.
//! * **Kopfzeile je Lauf**: jeder Durchgang gibt aus, mit welcher
//!   Schalterstellung er TATSAECHLICH lief und was dabei herauskam. In diesem
//!   Labor haben zweimal drei Zeilen einer Matrix dasselbe gemessen, weil ein
//!   Schalter still nicht griff; aufgefallen ist es nur an einer
//!   mitprotokollierten Groesse, die sich haette aendern MUESSEN.
//! * **Querprobe Name gegen Treiber**: sagt das Pixelformat `cuda`, der
//!   Treiber aber „Hauptspeicher" (oder umgekehrt), bricht die Probe ab.
//!   Zwei unabhaengige Quellen, die sich widersprechen, sind kein Befund.

mod cuda;
mod formatwahl;
mod lauf;
mod pruefungen;

use anyhow::{bail, Result};
use formatwahl::{format_name, Formatwahl};
use lauf::Konfig;

fn env_text(name: &str, vorgabe: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| vorgabe.to_string())
}

fn env_zahl(name: &str, vorgabe: usize) -> Result<usize> {
    match std::env::var(name) {
        Ok(v) => Ok(v.parse()?),
        Err(_) => Ok(vorgabe),
    }
}

fn env_schalter(name: &str, vorgabe: bool) -> bool {
    match std::env::var(name).as_deref() {
        Ok("1") => true,
        Ok("0") => false,
        _ => vorgabe,
    }
}

fn main() -> Result<()> {
    let datei = match std::env::var("SPIKE_DATEI") {
        Ok(d) => d,
        Err(_) => bail!(
            "SPIKE_DATEI fehlt. Beispiel:\n  \
             SPIKE_DATEI=/pfad/1440p10.mkv ./target/release/cuvid-cuda-ausgabe"
        ),
    };
    let k = Konfig {
        datei,
        decoder: std::env::var("SPIKE_DECODER").ok(),
        bilder: env_zahl("SPIKE_BILDER", 600)?,
        aufwaermen: env_zahl("SPIKE_AUFWAERMEN", 120)?,
        low_delay: env_schalter("SPIKE_LOW_DELAY", true),
        abdruecke: env_zahl("SPIKE_ABDRUECKE", 8)?,
        abholen: env_schalter("SPIKE_ABHOLEN", false),
        cuda_flags: env_zahl("SPIKE_CUDA_FLAGS", 0)? as i32,
        halten: env_zahl("SPIKE_HALTEN", 0)?,
    };
    let hwctx = env_schalter("SPIKE_HWCTX", true);
    let formatwahl = Formatwahl::aus_text(&env_text("SPIKE_FORMATWAHL", "roh"))?;
    let vergleich = env_schalter("SPIKE_VERGLEICH", false);

    let treiber = cuda::Treiber::oeffnen()?;
    let (a_karte, a_wirt) = cuda::selbsttest(&treiber)?;
    println!("Kontrolle A (Zeigertest): cuMemAlloc -> {a_karte} | Vec<u8> -> {a_wirt}");
    kontrolle_c()?;

    if vergleich {
        return vergleichen(&k, &treiber);
    }

    let e = lauf::fahren(&k, hwctx, formatwahl, &treiber)?;
    bericht(&e, &k)?;
    println!("ERGEBNIS {}", json(&e, &k));
    Ok(())
}

/// **Kontrolle C** — ein verfaelschtes Byte muss auffallen.
fn kontrolle_c() -> Result<()> {
    let mut a = vec![7u8; 4096];
    for (i, b) in a.iter_mut().enumerate() {
        *b = (i % 251) as u8;
    }
    let mut b = a.clone();
    let h1 = probe_abdruck(&a);
    b[2000] ^= 1;
    let h2 = probe_abdruck(&b);
    if h1 == h2 {
        bail!("Kontrolle C: ein gekipptes Bit aendert den Fingerabdruck nicht — er vergleicht nichts");
    }
    println!("Kontrolle C (Fingerabdruck): ein gekipptes Bit aendert ihn ({h1:016x} -> {h2:016x})");
    Ok(())
}

/// Dieselbe Rechnung wie `lauf::abdruck`, hier nur fuer die Kontrolle
/// zugaenglich gemacht.
fn probe_abdruck(daten: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for y in 0..(daten.len() / 64) {
        for (x, b) in daten[y * 64..y * 64 + 64].iter().enumerate() {
            h ^= (*b as u64).wrapping_mul((x as u64) ^ ((y as u64) << 17) ^ 0x9e3779b9);
            h = h.wrapping_mul(0x100000001b3);
        }
    }
    h
}

/// **Kontrolle B** — beide Arme, dieselben Bilder, Inhalt verglichen.
fn vergleichen(k: &Konfig, treiber: &cuda::Treiber) -> Result<()> {
    println!("\n--- Kontrolle B: Inhaltsvergleich beider Arme ---");
    let ohne = lauf::fahren(k, false, Formatwahl::Roh, treiber)?;
    bericht(&ohne, k)?;
    let mit = lauf::fahren(k, true, Formatwahl::Cuda, treiber)?;
    bericht(&mit, k)?;

    if ohne.abdruecke.is_empty() || mit.abdruecke.is_empty() {
        bail!("Kontrolle B: keine Abdruecke — nichts zu vergleichen");
    }
    let n = ohne.abdruecke.len().min(mit.abdruecke.len());
    let gleich = (0..n).filter(|i| ohne.abdruecke[*i] == mit.abdruecke[*i]).count();
    println!("Kontrolle B: {gleich} von {n} Bildern inhaltsgleich");
    for i in 0..n {
        println!(
            "  Bild {i}: ohne {:016x} | mit {:016x} {}",
            ohne.abdruecke[i],
            mit.abdruecke[i],
            if ohne.abdruecke[i] == mit.abdruecke[i] { "gleich" } else { "ABWEICHEND" }
        );
    }
    if gleich != n {
        bail!("Kontrolle B gescheitert: die Arme liefern verschiedene Bilder");
    }
    println!("ERGEBNIS_VERGLEICH {{\"bilder\":{n},\"gleich\":{gleich}}}");
    Ok(())
}

fn bericht(e: &lauf::Ergebnis, k: &Konfig) -> Result<()> {
    // Kopfzeile: was dieser Lauf TATSAECHLICH war. Nicht die Beschriftung von
    // aussen, sondern die Beobachtung von innen.
    println!(
        "\n--- Lauf: {} | hw_device_ctx={} | Formatwahl={} | {}x{} | LOW_DELAY={} | abholen={} ---",
        e.decoder,
        if e.hwctx {
            match k.cuda_flags {
                1 => "CUDA (primaerer Kontext)",
                2 => "CUDA (aktueller Kontext)",
                _ => "CUDA (eigener Kontext)",
            }
        } else {
            "keiner"
        },
        e.formatwahl.schluessel(),
        e.breite,
        e.hoehe,
        k.low_delay,
        k.abholen
    );
    if e.angeboten.is_empty() {
        println!("  angebotene Formate: (kein eigener Rueckruf, deshalb nicht sichtbar)");
    } else {
        let namen: Vec<String> = e.angeboten.iter().map(|f| format_name(*f)).collect();
        println!("  angebotene Formate: {}", namen.join(", "));
        println!("  gewaehlt: {}", format_name(e.gewaehlt));
    }
    println!("  Bildformat: {}", format_name(e.bildformat));
    for (i, eb) in e.ebenen.iter().enumerate() {
        println!(
            "  Ebene {i}: Adresse 0x{:x}  Zeilenabstand {}  -> {}",
            eb.adresse,
            eb.zeilenabstand,
            eb.lage.text()
        );
    }

    // Querprobe: Formatname und Treiberauskunft muessen dasselbe sagen.
    let name_sagt_cuda = format_name(e.bildformat) == "cuda";
    if name_sagt_cuda != e.im_grafikspeicher() {
        bail!(
            "Widerspruch: Pixelformat ist '{}', der Treiber sagt zu den Ebenen aber '{}'. \
             Zwei Quellen, die sich widersprechen, sind kein Befund.",
            format_name(e.bildformat),
            e.ebenen.first().map(|x| x.lage.text()).unwrap_or_default()
        );
    }

    if e.sw_format >= 0 && e.sw_format != e.bildformat {
        println!("  Format hinter cuda (sw_format): {}", format_name(e.sw_format));
    }
    match e.zeilenkopie_gleich {
        Some(true) => println!(
            "  Nagelprobe: cuMemcpyDtoH ueber data[0]/linesize[0] liefert dieselbe Y-Ebene \
             wie av_hwframe_transfer_data"
        ),
        Some(false) => bail!(
            "Nagelprobe gescheitert: die Y-Ebene ueber den CUDA-Zeiger weicht von der ueber \
             av_hwframe_transfer_data ab — Adresse oder Zeilenabstand stimmen nicht"
        ),
        None => {}
    }
    println!(
        "  BEFUND: die Bilder liegen {}",
        if e.im_grafikspeicher() { "im GRAFIKSPEICHER" } else { "im HAUPTSPEICHER" }
    );
    println!(
        "  {} Bilder | send_packet {:.0} us (Median {:.0}, p95 {:.0}) | receive_frame {:.1} us",
        e.bilder,
        e.send.mittel_us(),
        e.send.median_us(),
        e.send.p95_us(),
        e.receive.mittel_us()
    );
    if k.abholen {
        println!(
            "  abholen (av_hwframe_transfer_data): {:.0} us je Bild",
            e.abholen.mittel_us()
        );
    }
    println!(
        "  Durchsatz {:.1} Bilder/s | Prozessorzeit {:.2} Kerne | Wanduhr {:.2} s",
        e.fps(),
        e.kerne(),
        e.wanduhr_s
    );
    Ok(())
}

/// `Option<bool>` als JSON-Literal — von `json()` gebraucht, weil `None` dort
/// `null` heisst und nicht `false`.
fn json_bool_opt(v: Option<bool>) -> &'static str {
    match v {
        Some(true) => "true",
        Some(false) => "false",
        None => "null",
    }
}

fn json(e: &lauf::Ergebnis, k: &Konfig) -> String {
    let ebenen: Vec<String> = e
        .ebenen
        .iter()
        .map(|x| {
            format!(
                "{{\"zeilenabstand\":{},\"lage\":\"{}\"}}",
                x.zeilenabstand,
                x.lage.schluessel()
            )
        })
        .collect();
    let angeboten: Vec<String> =
        e.angeboten.iter().map(|f| format!("\"{}\"", format_name(*f))).collect();
    format!(
        "{{\"datei\":\"{}\",\"decoder\":\"{}\",\"hwctx\":{},\"formatwahl\":\"{}\",\
         \"breite\":{},\"hoehe\":{},\"bildformat\":\"{}\",\"angeboten\":[{}],\
         \"gewaehlt\":\"{}\",\"sw_format\":\"{}\",\"ebenen\":[{}],\
         \"im_grafikspeicher\":{},\"zeilenkopie_gleich\":{},\
         \"bilder\":{},\"send_us\":{:.1},\"send_median_us\":{:.1},\"send_p95_us\":{:.1},\
         \"receive_us\":{:.2},\"abholen\":{},\"abholen_us\":{:.1},\
         \"fps\":{:.2},\"kerne\":{:.3},\"wanduhr_s\":{:.2}}}",
        k.datei,
        e.decoder,
        e.hwctx,
        e.formatwahl.schluessel(),
        e.breite,
        e.hoehe,
        format_name(e.bildformat),
        angeboten.join(","),
        if e.gewaehlt >= 0 { format_name(e.gewaehlt) } else { "-".into() },
        if e.sw_format >= 0 { format_name(e.sw_format) } else { "-".into() },
        ebenen.join(","),
        e.im_grafikspeicher(),
        json_bool_opt(e.zeilenkopie_gleich),
        e.bilder,
        e.send.mittel_us(),
        e.send.median_us(),
        e.send.p95_us(),
        e.receive.mittel_us(),
        k.abholen,
        e.abholen.mittel_us(),
        e.fps(),
        e.kerne(),
        e.wanduhr_s
    )
}
