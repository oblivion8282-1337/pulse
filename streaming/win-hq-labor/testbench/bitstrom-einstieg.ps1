# Bitstrom-Leser + Einstiegsprobe -- gemeinsam genutzt von den Nachweis-
# Skripten. Mit `. .\bitstrom-einstieg.ps1` einbinden.
#
# Diese Datei ist bewusst REIN ASCII (s. Kopf der aufrufenden Skripte).
#
# ## Wozu getrennt
#
# Zwei verschiedene Fragen: das Messskript stempelt Zeiten, hier wird ein
# fertiger Mitschnitt gelesen. Und der Leser ist nicht an eine Messung
# gebunden -- "ist das ein echtes Vollbild mit Kopf, und kann ein Einsteiger
# ab dort lesen" ist die Frage jedes Rueckkanal-Nachweises.

# --- Bitstrom-Pruefer -------------------------------------------------------
#
# In C#, nicht in PowerShell: ein Mitschnitt wiegt hier ~30 MB, und eine
# Byte-Schleife in PowerShell braucht dafuer Minuten. `trace_headers` waere die
# andere Moeglichkeit, schreibt aber je Bild hunderte Zeilen -- fuer 1500
# Bilder ist das keine Datei mehr, die man durchsieht.
if (-not ([System.Management.Automation.PSTypeName]'Bitstrom').Type) {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;

public static class Bitstrom {
    // Ein Eintrag je Bild: "index;schluessel;kopf;versatz"
    //   schluessel = 1 -> IDR (H.264) bzw. KEY_FRAME (AV1)
    //   kopf       = 1 -> Parametersaetze (SPS+PPS) bzw. Sequenzkopf lagen
    //                     VOR diesem Bild und nach dem vorigen
    //   versatz    = Byte-Stelle, ab der ein Einsteiger lesen muesste (Beginn
    //                der Zugriffseinheit, also VOR den Parametersaetzen)
    // Beide Leser schreiben durch diese eine Stelle, damit das Satzformat oben
    // nicht an zwei Orten gepflegt werden muss.
    static string Eintrag(int idx, bool schluessel, bool kopf, int auStart) {
        return idx + ";" + (schluessel ? 1 : 0) + ";" + (kopf ? 1 : 0) + ";" + auStart;
    }

    public static string[] H264(string pfad) {
        byte[] d = File.ReadAllBytes(pfad);
        var raus = new List<string>();
        bool sps = false, pps = false; int idx = 0;
        int auStart = 0; bool neuesAu = true;
        for (int i = 0; i + 3 < d.Length; i++) {
            if (d[i] != 0 || d[i+1] != 0) continue;
            int p;
            if (d[i+2] == 1) p = i + 3;
            else if (d[i+2] == 0 && d[i+3] == 1) p = i + 4;
            else continue;
            if (p >= d.Length) break;
            int t = d[p] & 0x1F;
            // Beginn der Zugriffseinheit ist die erste NICHT-Slice-NAL nach
            // dem letzten Bild (AUD/SEI/SPS). Auf die naechste NAL ueberhaupt
            // zu zeigen waere falsch: NVENC schreibt hier mehrere Slices je
            // Bild, und die zweite Slice des VORIGEN Bildes stuende dann noch
            // vor den Parametersaetzen. Genau so gemessen -- der abgeschnittene
            // Mitschnitt begann mit drei Fehlern ("non-existing PPS 0
            // referenced"), obwohl das Vollbild selbst einwandfrei war.
            if (neuesAu && (t < 1 || t > 5)) { auStart = i; neuesAu = false; }
            if (t == 7) sps = true;
            else if (t == 8) pps = true;
            else if (t == 1 || t == 5) {
                // **Ein Bild ist nicht eine NAL.** NVENC schreibt hier rund
                // zwei Slices je Bild; wer jede Slice-NAL als Bild zaehlt,
                // bekommt 1552 statt 796 und haelt die zweite Slice eines IDR
                // fuer ein Vollbild OHNE Parametersaetze -- die Kopf-Pruefung
                // meldete dann einen Fehlbefund, den es nicht gibt.
                // `first_mb_in_slice` ist das erste ue(v) im Slice-Kopf; der
                // Wert 0 ist genau das Bitmuster "1", also das oberste Bit des
                // Bytes hinter dem NAL-Kopf.
                if (p + 1 < d.Length && (d[p+1] & 0x80) != 0) {
                    raus.Add(Eintrag(idx, t == 5, sps && pps, auStart));
                    idx++; sps = false; pps = false; neuesAu = true;
                }
            }
            i = p - 1;
        }
        return raus.ToArray();
    }

    public static string[] Av1(string pfad) {
        byte[] d = File.ReadAllBytes(pfad);
        var raus = new List<string>();
        bool seq = false; int idx = 0; int i = 0;
        int auStart = 0; bool neuesAu = true;
        while (i < d.Length) {
            int typ = (d[i] >> 3) & 0xF;
            // Nur ein Zeitabschnitts-Trenner (2) oder ein Sequenzkopf (1)
            // beginnt eine Zugriffseinheit. Dieselbe Falle wie bei H.264: ein
            // Bild kann als FRAME_HEADER (3) + TILE_GROUP (4) kommen, und die
            // Kachelgruppe waere dann faelschlich der Anfang. Gemessen: der so
            // geschnittene Mitschnitt begann bei 0x22 (TILE_GROUP), ffmpeg
            // meldete "Missing Temporal Delimiter" und "No sequence header
            // available" -- an einem Vollbild, das einwandfrei war.
            if (neuesAu && (typ == 1 || typ == 2)) { auStart = i; neuesAu = false; }
            bool ext = (d[i] & 0x04) != 0;
            bool hatGroesse = (d[i] & 0x02) != 0;
            int p = i + 1 + (ext ? 1 : 0);
            if (!hatGroesse) throw new Exception("OBU ohne Groessenfeld bei " + i);
            long groesse = 0; int schub = 0;
            while (p < d.Length) {
                byte b = d[p++];
                groesse |= (long)(b & 0x7F) << schub; schub += 7;
                if ((b & 0x80) == 0) break;
            }
            if (typ == 1) seq = true;
            else if ((typ == 3 || typ == 6) && p < d.Length) {
                // show_existing_frame (1 bit), dann frame_type (2 bit).
                int b0 = d[p];
                int zeigeVorhandenes = (b0 >> 7) & 1;
                int art = (b0 >> 5) & 3;
                if (zeigeVorhandenes == 0) {
                    raus.Add(Eintrag(idx, art == 0, seq, auStart));
                    idx++; seq = false; neuesAu = true;
                }
            }
            i = (int)(p + groesse);
            if (groesse <= 0 && typ != 2) break;
        }
        return raus.ToArray();
    }
}
'@
}

# --- Die Einstiegsprobe -----------------------------------------------------
#
# Die eigentliche Frage lautet nicht "wann kam das Bild", sondern "kann der
# Zuschauer damit wieder sehen". Also wird der Mitschnitt AB dem angeforderten
# Vollbild abgeschnitten und von vorn dekodiert -- genau die Lage eines
# Einsteigers. Ein Intra-Only-Bild ohne Sequenzkopf faellt hier durch; ein
# echtes IDR nicht. Das ist der Fall, der auf AMD am 2026-08-02 durchgerutscht
# ist (`rueckkanal-2026-08-02-windows.json`).
function Test-Einstieg {
  param([string]$Datei, [long]$Versatz, [string]$Codec, [string]$FfBin, [int]$Bilder = 180)
  # Dateiendung und ffmpeg-Formatname sind hier dasselbe Wort ('obu' bzw.
  # 'h264'), deshalb steht die Fallunterscheidung nur einmal da. Ohne `-f`
  # geht es NICHT: der abgeschnittene Mitschnitt hat keinen Container, und
  # ffmpeg soll nicht raten.
  $ext  = if ($Codec -eq 'av1') { 'obu' } else { 'h264' }
  $teil = "$Datei.einstieg.$ext"
  $ein = [System.IO.File]::OpenRead($Datei)
  try {
    $ein.Position = $Versatz
    $aus = [System.IO.File]::Create($teil)
    try { $ein.CopyTo($aus) } finally { $aus.Close() }
  } finally { $ein.Close() }

  $log = "$teil.log"
  $arg = @('-hide_banner','-v','error','-nostdin','-f',$ext,'-i',$teil,'-frames:v',$Bilder,'-f','null','-')
  $pr = Start-Process -FilePath (Join-Path $FfBin 'ffmpeg.exe') -ArgumentList $arg -NoNewWindow -PassThru `
          -RedirectStandardError $log -RedirectStandardOutput "$teil.out"
  if (-not $pr.WaitForExit(120000)) { try { $pr.Kill() } catch {}; throw "ffmpeg haengt" }
  $fehler = @(Get-Content $log -ErrorAction SilentlyContinue | Where-Object { $_ })

  $n = & (Join-Path $FfBin 'ffprobe.exe') -v error -f $ext -count_frames -select_streams v `
         -show_entries stream=nb_read_frames -of csv=p=0 $teil
  New-Object psobject -Property @{ Dekodiert = [int]("$n".Trim()); Fehler = $fehler.Count; ErsteZeile = ($fehler | Select-Object -First 1) }
}
