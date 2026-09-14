//! Hat der Decoder-Bau des Flatpak jeden Codec, den der Player aushandeln kann?
//!
//! **Warum es diesen Test gibt.** Das ffmpeg-Modul des Flatpak-Manifests baut
//! mit `--disable-decoders --enable-decoder=…` — eine Liste von Hand. Der
//! Player sucht seinen Decoder zur Laufzeit ueber Namen (`decode.rs`,
//! `candidates`); fehlt JEDES Namensschild eines Codecs in der Liste,
//! scheitern alle seine Kandidaten mit „Decoder nicht vorhanden", und die
//! Kachel faellt auf den `<video>`-Rueckfall — auf einer Maschine mit
//! tadelloser GPU genauso wie ohne.
//!
//! Genau das ist am 2026-09-14 passiert: der HEVC-Merge (6a82c7a3) ergaenzte
//! die Kandidaten `hevc`/`hevc_cuvid` im Player, aber nicht diese Zeile im
//! Manifest. Windows (laedt komplette BtbN-DLLs) und macOS (baut ohne
//! Whitelist) fielen nicht auf — der Ausfall existierte allein im Flatpak und
//! erst beim Zuschauer. Dessen Meldung nannte zudem nur den LETZTEN Kandidaten
//! (`hevc_qsv`, Intel-only), nicht den fehlenden.
//!
//! **Was hier geprueft wird.** Fuer jeden Codec der Wire-Aushandlung
//! (`whep.rs`, `as_str`) muss die Whitelist mindestens einen Decoder der
//! Familie enthalten: den Namen selbst oder ein `{name}_…` (der native Name
//! traegt VAAPI auf AMD/Intel, `_cuvid` ist NVIDIA). Die `*_qsv`-Namen sind
//! bewusst NICHT Pflicht: das Flatpak baut ohne oneVPL, Intel und AMD gehen
//! ueber VAAPI.
//!
//! **Zur Laufzeit gelesen, nicht per `include_str!`** — dieselbe Begruendung
//! wie in `flatpak_kisten.rs`: ein neuer Codec in `whep.rs` soll diesen Test
//! automatisch erreichen, nicht von Hand nachgetragen werden muessen.

use std::fs;
use zwillinge::wurzel;

/// Die Decoder-Namen aus der `--enable-decoder=`-Zeile des ffmpeg-Moduls.
///
/// Zeilenweise statt YAML-Parser (s. `flatpak_kisten.rs`): diese Crate bleibt
/// abhaengigkeitsfrei, und `lines()` streift auch CRLF (`core.autocrlf` unter
/// Windows). Die Zeile muss GENAU EINMAL vorkommen — ist sie gesplittet oder
/// verschoben, ist das selbst ein Befund.
fn whitelist(manifest: &str) -> Vec<String> {
    let treffer: Vec<&str> = manifest
        .lines()
        .filter(|z| z.contains("--enable-decoder="))
        .collect();
    assert_eq!(
        treffer.len(),
        1,
        "erwartet genau eine --enable-decoder-Zeile im Manifest, gefunden: {}",
        treffer.len()
    );
    treffer[0]
        .split_once("--enable-decoder=")
        .expect("Trenner eben noch enthalten")
        .1
        .trim()
        .split(',')
        .map(|d| d.trim().to_string())
        .collect()
}

/// Je Codec der Wire-Aushandlung der FFmpeg-Decoder-Stamm (`H264` → "h264",
/// `H265` → "hevc"), gelesen aus `as_str` in `whep.rs`.
///
/// Nur dieser Ort kennt die Zuordnung Codec→Name — im Test hartkodiert muesste
/// sie bei jedem neuen Codec nachgezogen werden, und genau dieses Nachtragen
/// ist der Handgriff, der schon einmal unterging.
fn codec_staemme() -> Vec<(String, String)> {
    let pfad = wurzel().join("streaming/pulse-player/src/whep.rs");
    let text = fs::read_to_string(&pfad)
        .unwrap_or_else(|e| panic!("{} nicht lesbar: {e}", pfad.display()));
    let mut staemme = Vec::new();
    let mut in_as_str = false;
    for zeile in text.lines() {
        let z = zeile.trim();
        if z.starts_with("pub fn as_str") {
            in_as_str = true;
            continue;
        }
        if !in_as_str {
            continue;
        }
        // Ende des Match-Blocks — die Arme stehen alle davor.
        if z == "}" {
            break;
        }
        if let Some(rest) = z.strip_prefix("Self::") {
            if let Some((variant, wert)) = rest.split_once("=> ") {
                let wert = wert.trim().trim_end_matches(',').trim().trim_matches('"');
                if !wert.is_empty() && !wert.contains(' ') {
                    staemme.push((variant.trim().to_string(), wert.to_string()));
                }
            }
        }
    }
    staemme
}

#[test]
fn jeder_codec_der_aushandlung_hat_einen_decoder_im_flatpak() {
    let manifest_pfad = wurzel().join("packaging/com.howispulse.Pulse.yml");
    let manifest = fs::read_to_string(&manifest_pfad)
        .unwrap_or_else(|e| panic!("{} nicht lesbar: {e}", manifest_pfad.display()));
    let liste = whitelist(&manifest);

    // Gegenprobe: die Auswertung muss die echte Liste finden, sonst waere
    // unten „leer gegen leer" gruen (s. flatpak_kisten.rs, dieselbe Lehre).
    assert!(
        liste.iter().any(|d| d == "h264"),
        "Whitelist-Auswertung greift nicht — Manifest umgebaut? Gefunden: {liste:?}"
    );

    let staemme = codec_staemme();
    assert!(
        staemme.len() >= 3,
        "as_str-Auswertung findet nur {} Codec(s) — whep.rs umgebaut?",
        staemme.len()
    );

    let fehlt: Vec<String> = staemme
        .iter()
        .filter(|(_, stamm)| {
            !liste.iter().any(|d| d == stamm || d.starts_with(&format!("{stamm}_")))
        })
        .map(|(codec, stamm)| format!("{codec} („{stamm}…“)"))
        .collect();

    assert!(
        fehlt.is_empty(),
        "packaging/com.howispulse.Pulse.yml: dem Codec(s) {} fehlt jeder Decoder in \
         der --enable-decoder-Zeile.\n\n\
         Der Player sucht seine Decoder zur Laufzeit ueber Namen; ohne jeden Treffer \
         scheitern alle Kandidaten dieses Codecs mit „Decoder nicht vorhanden“, und \
         jeder Zuschauer faellt auf <video> zurueck. Fix: den nativen Namen und (bei \
         Video) die _cuvid-Variante in die Zeile aufnehmen — so geschehen am \
         2026-09-14 fuer hevc/hevc_cuvid.",
        fehlt.join(", ")
    );
}
