//! `pulse-player --robustheit` — haelt der Bildweg einen UNSAUBEREN Strom aus?
//!
//! Der Prüfstand beantwortet die Frage bis hierher nur am Decoder: `obu-schnitt.py`
//! verwirft Zugriffseinheiten, `ffmpeg` dekodiert, `heilung.py` wertet aus
//! (Messakte `decoder-2026-07-29-intra-refresh.json`, am 2026-08-21 zusammen
//! mit der Betriebsart gelöscht). Das misst die
//! Decoder-Bibliothek — **nicht diesen Player**. Der Unterschied stand in
//! derselben Akte unter `uebertragbarkeit/unterschiede_zum_player`: der Player
//! speist Zugriffseinheiten EINZELN über [`VideoDecoder::decode`] ein statt über
//! den `obu`-Demuxer, er setzt `AV_CODEC_FLAG_LOW_DELAY`, und vor allem hängt an
//! ihm ein ganzes Rettungswerk — Anzeigesperre nach einer Lücke
//! ([`VideoDecoder::on_gap`]), Einfrier-Wächter ([`crate::einfrieren`]),
//! Neuaufbau ([`crate::neuaufbau`]). Die dortige Empfehlung lautet wörtlich:
//! „wer eine feinere Aussage braucht, sollte den Weg im Player selbst
//! nachbauen". Das ist diese Datei.
//!
//! **Wofür sie am 2026-08-11 gebaut wurde.** Auf einer NVIDIA-Karte gewinnt
//! `av1_cuvid` die Kandidatenliste, und damit bleibt die Zero-Copy-Brücke
//! ungefragt (`profiles/player-2026-08-11-zerocopy-nvidia.json`). Der D3D11VA-Weg
//! ist rund 2,8 bis 5,15 ms je Bild billiger — nur trägt `decode.rs` für cuvid
//! mehrere hart erarbeitete Sonderbehandlungen, und für D3D11VA war keine davon
//! geprüft. Ein schnellerer Weg, der bei schlechter Leitung schlechter aussieht,
//! wäre kein Fortschritt.
//!
//! Es wird **kein Fenster** aufgebaut und **kein Netz** angefasst; gemessen wird
//! der Decoder-Weg samt Rettungswerk, nicht der Renderer.
//!
//! **Hier stand zuerst „damit läuft auch die Zero-Copy-Brücke nicht mit (sie
//! braucht das wgpu-Gerät des Fensters)". Unter Windows ist das falsch** und am
//! 2026-08-11 im ersten Lauf widerlegt worden: die Brücke steht auch hier, denn
//! NT-Handles lassen sich auf jedem D3D12-Gerät öffnen — nur die LINUX-Brücke
//! braucht das Gerät des Fensters (s. `decode::VideoDecoder::geraet`). Sie
//! schaltet sich nach rund zwei Sekunden selbst ab („es kommen keine
//! Fingerabdrücke zurück"), weil ohne Renderer niemand welche zurückschickt, und
//! fällt aufs Rücklesen zurück. Für die Zahlen heißt das: die ersten Bilder
//! kommen über die Brücke (`bilder_auf_gpu`), der Rest über den Hauptspeicher.
//! Die Brücke UNTER LAST beurteilt das nicht — dafür braucht es den echten
//! Player mit Fenster.
//!
//! ## Aufruf
//!
//! ```text
//! pulse-player --robustheit einheiten.dump [--ab N] [--weg 40,41] [--takt 16]
//!              [--vollbild N] [--abdruck datei] [--codec av1|h264]
//! ```
//!
//! Die Eingabe ist das Format aus [`crate::dump`] (u32 LE Länge, ein Byte,
//! Nutzlast) — dasselbe, das `depacket::tests` schreibt und der vorhandene
//! Diagnose-Test `einheiten_durch_den_echten_decoder_weg` liest. Der Arm wird
//! über `PULSE_PLAYER_DECODER` gewählt (s. [`crate::decoderwahl`]).
//!
//! Ausgegeben wird eine JSON-Zeile auf stdout; Diagnose geht nach stderr.
//!
//! **`--takt` ist nicht Zierde.** Der Einfrier-Wächter bindet an ZWEI Schwellen,
//! Bilder UND Millisekunden ([`crate::einfrieren`]); ein Durchlauf in
//! Höchstgeschwindigkeit lässt die Uhr stillstehen und der Wächter schlüge nie
//! an. Die Vorgabe von 16 ms ist der 60-Hz-Takt des Senders.

use anyhow::{bail, Context, Result};
use std::io::Write;
use std::path::PathBuf;

use crate::decode::VideoDecoder;
use crate::whep::Codec;

/// Wie oft höchstens ein Vollbild eingespielt wird, wenn der Player eines
/// anfordert.
///
/// Es MUSS eine Grenze geben: fordert der Decoder nach jedem Bild erneut an
/// (genau das Verhalten, das hier zur Debatte steht), liefe der Lauf sonst
/// gegen eine Einspeisung je Bild und die Zahlen sagten nichts mehr über den
/// Strom, sondern nur noch über diese Schleife.
const MAX_VOLLBILDER: usize = 8;

/// Um wieviel die Bildfläche für den Abdruck verkleinert wird.
///
/// Der Abdruck dient dem Vergleich ZWEIER Läufe, nicht der Bildbewertung —
/// dafür genügt ein Achtel je Kante (1920x1080 -> 240x135). Voll aufgelöst
/// wären es 2 MB je Bild und bei 600 Bildern über ein Gigabyte je Arm.
const ABDRUCK_TEILER: usize = 8;

struct Args {
    einheiten: PathBuf,
    abdruck: Option<PathBuf>,
    ab: usize,
    weg: Vec<usize>,
    takt_ms: u64,
    vollbild: Option<usize>,
    codec: Codec,
}

fn args_lesen(argv: &[String]) -> Result<Args> {
    let mut a = Args {
        einheiten: PathBuf::new(),
        abdruck: None,
        ab: 0,
        weg: Vec::new(),
        takt_ms: 16,
        vollbild: None,
        codec: Codec::Av1,
    };
    let mut i = 0;
    while i < argv.len() {
        let hol = |i: usize| -> Result<String> {
            argv.get(i + 1).cloned().ok_or_else(|| anyhow::anyhow!("{} braucht einen Wert", argv[i]))
        };
        match argv[i].as_str() {
            "--ab" => {
                a.ab = hol(i)?.parse()?;
                i += 2;
            }
            "--takt" => {
                a.takt_ms = hol(i)?.parse()?;
                i += 2;
            }
            "--vollbild" => {
                a.vollbild = Some(hol(i)?.parse()?);
                i += 2;
            }
            "--abdruck" => {
                a.abdruck = Some(PathBuf::from(hol(i)?));
                i += 2;
            }
            "--weg" => {
                a.weg = hol(i)?
                    .split(',')
                    .filter(|s| !s.trim().is_empty())
                    .map(|s| s.trim().parse::<usize>())
                    .collect::<Result<_, _>>()?;
                i += 2;
            }
            "--codec" => {
                a.codec = match hol(i)?.as_str() {
                    "av1" => Codec::Av1,
                    "h264" => Codec::H264,
                    x => bail!("unbekannter Codec {x}"),
                };
                i += 2;
            }
            x if x.starts_with("--") => bail!("unbekannte Option {x}"),
            _ => {
                a.einheiten = PathBuf::from(&argv[i]);
                i += 1;
            }
        }
    }
    if a.einheiten.as_os_str().is_empty() {
        bail!("Einheiten-Datei fehlt");
    }
    Ok(a)
}

/// Was der Lauf am Ende meldet.
///
/// Bewusst flach und als JSON von Hand geschrieben: der Player zieht `serde`
/// zwar ohnehin, aber ein eigener Typ mit `Serialize` wäre hier mehr Gerüst als
/// Aussage — es sind zwölf Zahlen.
#[derive(Default)]
struct Zaehler {
    eingespeist: usize,
    verworfen_vor_einstieg: usize,
    bilder: usize,
    erstes_bild_bei: Option<usize>,
    erstes_bild_ms: Option<u128>,
    luecken_gemeldet: usize,
    einfrier_meldungen: usize,
    vollbild_angefordert: usize,
    vollbild_eingespielt: usize,
    unsaubere_bilder: usize,
    /// Bilder, die im Grafikspeicher ankamen (Zero-Copy-Bruecke stand).
    bilder_auf_gpu: usize,
    fehler_beim_einspeisen: usize,
    abbruch: Option<String>,
}

/// Ein Achtel je Kante aus der Luma-Ebene, als ein Byte je Bildpunkt.
///
/// Bei zehn Bit wird das obere Byte genommen — der Abdruck vergleicht zwei
/// Läufe miteinander, und beide Arme liefern dieselbe Bittiefe.
///
/// **`None`, solange das Bild im Grafikspeicher liegt** (`gpu` gesetzt, dann
/// sind `planes` und `strides` leer — s. [`crate::decode::DecodedFrame::gpu`]).
/// Hier stand zuerst ein blinder Zugriff auf `planes[0]`, und der hat den
/// D3D11VA-Arm bei jedem Lauf mit einem Panik-Abbruch beendet: die
/// Zero-Copy-Brücke steht unter Windows **auch ohne Fenster** (NT-Handles
/// brauchen das wgpu-Gerät nicht). Das sah nach einem Fehler im Player aus und
/// war einer im Messwerkzeug — dieselbe Sorte Falle wie Falle 1 in
/// `player-2026-08-11-zerocopy-nvidia.json`. Wer Abdrücke über beide Arme
/// vergleichen will, setzt `PULSE_PLAYER_ZEROCOPY=0`.
fn abdruck_von(bild: &crate::decode::DecodedFrame) -> Option<Vec<u8>> {
    if bild.gpu.is_some() || bild.planes.is_empty() {
        return None;
    }
    let breite = bild.width as usize / ABDRUCK_TEILER;
    let hoehe = bild.height as usize / ABDRUCK_TEILER;
    let stride = bild.strides[0];
    let luma = &bild.planes[0];
    let bpp = if bild.ten_bit { 2 } else { 1 };
    let mut aus = Vec::with_capacity(breite * hoehe);
    for y in 0..hoehe {
        for x in 0..breite {
            let p = (y * ABDRUCK_TEILER) * stride + (x * ABDRUCK_TEILER) * bpp;
            // Bei zehn Bit steht das höherwertige Byte hinten (little endian).
            aus.push(luma.get(p + bpp - 1).copied().unwrap_or(0));
        }
    }
    Some(aus)
}

pub fn ausfuehren(argv: &[String]) -> Result<()> {
    let a = args_lesen(argv)?;
    let roh = std::fs::read(&a.einheiten)
        .with_context(|| format!("Einheiten {} lesbar", a.einheiten.display()))?;
    let einheiten = crate::dump::read_dump(&roh);
    if einheiten.is_empty() {
        bail!("keine Einheiten in {}", a.einheiten.display());
    }
    let weg: std::collections::HashSet<usize> = a.weg.iter().copied().collect();

    let mut d = VideoDecoder::new(a.codec, Some(true), None)?;
    let decoder_name = d.name.clone();
    let hardware = d.hardware;
    eprintln!("robustheit: Decoder {decoder_name} (Hardware {hardware})");

    let mut abdruck_datei = match &a.abdruck {
        Some(p) => Some(std::io::BufWriter::new(std::fs::File::create(p)?)),
        None => None,
    };

    let mut z = Zaehler::default();
    let start = std::time::Instant::now();
    let takt = std::time::Duration::from_millis(a.takt_ms);
    // Das Vollbild, das auf Anforderung eingespielt wird. Im
    // Intra-Refresh-Betrieb (bis zum 2026-08-21) war das der einzige Weg zurück
    // ins Bild — der Sender schickte von sich aus keines mehr. Seither schickt
    // er wieder welche, aber nur alle 60 s; für die Dauer dieser Messung
    // ändert das nichts.
    let vollbild = a.vollbild.and_then(|i| einheiten.get(i).map(|t| t.0.clone()));
    let mut anfordern = false;

    for (i, (einheit, _)) in einheiten.iter().enumerate().skip(a.ab) {
        let takt_bis = std::time::Instant::now() + takt;

        if weg.contains(&i) {
            // Was der Zusammensetzer bei Paketverlust tut: die Einheit ist weg,
            // und der Jitter-Puffer meldet die Lücke (`session.rs`, Zweig
            // `Release::Gap`). Beides gehört zusammen — nur das Verwerfen ohne
            // die Meldung wäre ein anderer, milderer Fall.
            d.on_gap();
            z.luecken_gemeldet += 1;
            anfordern = true;
            std::thread::sleep(takt_bis.saturating_duration_since(std::time::Instant::now()));
            continue;
        }

        // Ein angefordertes Vollbild trifft ein. In der Wirklichkeit vergeht
        // dafür eine Umlaufzeit; hier kommt es mit der nächsten Einheit, was
        // dem Player gegenüber WOHLWOLLEND ist. Wer die Verzögerung braucht,
        // misst am echten Sender.
        if anfordern {
            z.vollbild_angefordert += 1;
            anfordern = false;
            if let Some(v) = &vollbild {
                if z.vollbild_eingespielt < MAX_VOLLBILDER {
                    z.vollbild_eingespielt += 1;
                    if let Err(e) = einspeisen(&mut d, v, &mut z, &mut abdruck_datei, start) {
                        z.abbruch = Some(e.to_string());
                        break;
                    }
                }
            }
        }

        let vorher = d.wartet_auf_einstieg();
        match einspeisen(&mut d, einheit, &mut z, &mut abdruck_datei, start) {
            Ok(neu) => {
                if vorher && neu == 0 {
                    z.verworfen_vor_einstieg += 1;
                }
                if z.erstes_bild_bei.is_none() && neu > 0 {
                    z.erstes_bild_bei = Some(i);
                    z.erstes_bild_ms = Some(start.elapsed().as_millis());
                }
            }
            Err(e) => {
                z.abbruch = Some(e.to_string());
                break;
            }
        }

        // Genau die Reihenfolge aus `session.rs`: erst der Einfrier-Wächter,
        // dann das Nachfordern, solange kein Einstiegspunkt da ist.
        if d.eingefroren() {
            d.wegen_einfrieren_neu();
            z.einfrier_meldungen += 1;
            anfordern = true;
        }
        if d.wartet_auf_einstieg() {
            anfordern = true;
        }

        std::thread::sleep(takt_bis.saturating_duration_since(std::time::Instant::now()));
    }

    if let Some(f) = &mut abdruck_datei {
        f.flush()?;
    }
    println!(
        "{{\"decoder\":\"{}\",\"hardware\":{},\"eingespeist\":{},\"bilder\":{},\
         \"erstes_bild_bei\":{},\"erstes_bild_ms\":{},\"verworfen_vor_einstieg\":{},\
         \"luecken_gemeldet\":{},\"einfrier_meldungen\":{},\"vollbild_angefordert\":{},\
         \"vollbild_eingespielt\":{},\"unsaubere_bilder\":{},\"bilder_auf_gpu\":{},\
         \"fehler_beim_einspeisen\":{},\"abbruch\":{}}}",
        decoder_name,
        hardware,
        z.eingespeist,
        z.bilder,
        z.erstes_bild_bei.map_or("null".into(), |v| v.to_string()),
        z.erstes_bild_ms.map_or("null".into(), |v| v.to_string()),
        z.verworfen_vor_einstieg,
        z.luecken_gemeldet,
        z.einfrier_meldungen,
        z.vollbild_angefordert,
        z.vollbild_eingespielt,
        z.unsaubere_bilder,
        z.bilder_auf_gpu,
        z.fehler_beim_einspeisen,
        z.abbruch.map_or("null".into(), |e| format!("{:?}", e)),
    );
    Ok(())
}

/// Eine Einheit hineingeben und die herausfallenden Bilder verbuchen.
///
/// Gibt zurück, wieviele Bilder herauskamen. `Err` heisst, was es auch im
/// Player heisst: der Decoder ist endgültig hin, die Sitzung wäre vorbei.
fn einspeisen(
    d: &mut VideoDecoder,
    einheit: &[u8],
    z: &mut Zaehler,
    abdruck: &mut Option<std::io::BufWriter<std::fs::File>>,
    start: std::time::Instant,
) -> Result<usize> {
    z.eingespeist += 1;
    let bilder = d.decode(einheit)?;
    // Die Anzeigesperre nach einer Lücke wird EINMAL je Durchgang abgefragt,
    // genau wie im Player (`session.rs`, `dec.ist_sauber()`).
    let vorzeigbar = d.ist_sauber();
    let _ = start;
    for bild in &bilder {
        z.bilder += 1;
        if !vorzeigbar {
            z.unsaubere_bilder += 1;
        }
        match abdruck_von(bild) {
            Some(a) => {
                if let Some(f) = abdruck {
                    f.write_all(&a)?;
                }
            }
            // Bild im Grafikspeicher — kein Abdruck moeglich, aber die Zahl
            // gehoert gemeldet: sie belegt, dass die Bruecke wirklich stand.
            None => z.bilder_auf_gpu += 1,
        }
    }
    Ok(bilder.len())
}
