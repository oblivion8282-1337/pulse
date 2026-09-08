/**
 * Sprachnachricht-Aufnahme (P0.3): getUserMedia + MediaRecorder, Audio-only.
 *
 * Der kleinste Weg: am Ende steht eine `File`, die in den BESTEHENDEN
 * Anhang-Weg geschoben wird (`MessageInput.addFiles` → Klartext-Upload bzw.
 * verschlüsselter DM-Weg) — keine zweite Pipeline. Der MIME wird bereinigt
 * (`audioMimeBereinigen`), weil die Server-Allowlist ohne Parameter-Tail
 * matcht; Safari liefert `audio/mp4`, Chrome/WebView `audio/webm`.
 *
 * Chunk-Sammlung und `onstop` hängen an `starteAufnahme` — der 300-s-Wecker
 * ruft denselben Stop-Pfad auf wie das Loslassen und darf nichts verlieren
 * (Simplifier-Befund: handlerloses `stop()` verschluckte die 5-Minuten-
 * Aufnahme). Der Wiedereinstieg nach Ablehnung: `getUserMedia` wirft, der
 * Composer zeigt einen Toast; ein zweites Halten fragt erneut.
 */
import { AUFGABE_MAX_SEKUNDEN, audioMimeBereinigen, aufnahmeDateiname } from './aufnahmeKern';

/** Der beste vom Browser angebotene Aufnahme-Container, parametrisch. */
function besterMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const kandidaten = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return kandidaten.find((m) => MediaRecorder.isTypeSupported(m));
}

export interface LaufendeAufnahme {
  recorder: MediaRecorder;
  stream: MediaStream;
  gestartetAm: number;
  teile: Blob[];
  wecker: ReturnType<typeof setTimeout>;
  /** Stoppt die Aufnahme — derselbe Pfad für Loslassen und 300-s-Wecker. */
  stoppen: () => void;
}

export async function starteAufnahme(): Promise<LaufendeAufnahme> {
  const mime = besterMime();
  if (!mime) throw new Error('AUDIO_RECORDING_UNSUPPORTED');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream, { mimeType: mime });
  const lauf: LaufendeAufnahme = {
    recorder,
    stream,
    gestartetAm: Date.now(),
    teile: [],
    wecker: setTimeout(() => lauf.stoppen(), AUFGABE_MAX_SEKUNDEN * 1000),
    stoppen: () => {
      if (lauf.recorder.state !== 'inactive') lauf.recorder.stop();
    }
  };
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) lauf.teile.push(e.data);
  };
  recorder.start();
  return lauf;
}

/** Stoppt und liefert die fertige Datei — `null`, wenn nichts Brauchbares
 *  aufgezeichnet wurde (sofortiges Loslassen, abgebrochener Recorder). */
export function beendeAufnahme(lauf: LaufendeAufnahme): Promise<File | null> {
  clearTimeout(lauf.wecker);
  const mime = audioMimeBereinigen(lauf.recorder.mimeType);
  const gestartet = lauf.gestartetAm;
  return new Promise((resolve) => {
    lauf.recorder.onstop = () => {
      lauf.stream.getTracks().forEach((t) => t.stop());
      const dauerSek = (Date.now() - gestartet) / 1000;
      if (lauf.teile.length === 0 || dauerSek < 0.5) {
        resolve(null);
        return;
      }
      resolve(
        new File([new Blob(lauf.teile, { type: mime })], aufnahmeDateiname(mime), { type: mime })
      );
    };
    lauf.stoppen();
  });
}

/** Verwirft: Wecker + Tracks stoppen, keine Datei. */
export function brichAufnahmeAb(lauf: LaufendeAufnahme): void {
  clearTimeout(lauf.wecker);
  lauf.recorder.onstop = null;
  lauf.stoppen();
  lauf.stream.getTracks().forEach((t) => t.stop());
}
