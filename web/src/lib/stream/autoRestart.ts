/**
 * Auto-Neustart eines HQ-Streams nach einer Quellgrößen-Änderung.
 *
 * Der Windows-Sidecar beendet den Stream kontrolliert, wenn die Capture-Quelle
 * ihre Auflösung dauerhaft ändert (Spiel schaltet in echtes 4:3-Vollbild,
 * DPI-/Modus-Wechsel) — die Aufnahme-Pipeline ist fest auf die Startgröße
 * allokiert. Das error-Event trägt dann `code: 'capture_size_changed'`
 * (`state.svelte.ts` ruft daraufhin `maybeAutoRestart`). Statt den Streamer
 * mit einer Fehlermeldung stehen zu lassen, starten wir denselben Stream
 * automatisch neu — der Neustart richtet die Pipeline auf die neue Auflösung
 * ein, für den Zuschauer bleibt ein kurzer Aussetzer.
 *
 * **Neu gestartet wird über den gemeinsamen Weg** (`streamStarten`), nicht über
 * einen zweiten Nachbau daneben. Der Nachbau stand hier bis 2026-08-16 und hat
 * genau den Fehler gemacht, vor dem eine Doppelung immer warnt: er kannte das
 * Standplatz-Profil nicht und baute die Argumente aus den Einstellungen des
 * Besitzers. Ein ferngeweckter Rechner wechselte damit mitten im Betrieb still
 * Codec, Sendeweg und Aufnahmequelle — ausgelöst von aussen, ohne dass jemand
 * davorsass. Was der Neustart dafür wissen muss, liegt im
 * `neustartGedaechtnis`; kein Eintrag → kein Auto-Neustart.
 *
 * Schleifen-Schutz: maximal 2 automatische Neustarts pro Slot innerhalb von
 * 60 s. Wechselt die Auflösung im Minutentakt (User probiert Settings durch)
 * oder schlägt der Neustart selbst wiederholt fehl, bleibt es beim normalen
 * Fehlerzustand mit manuellem Start-Button.
 */
import { toast } from 'svelte-sonner';
import { m } from '$lib/paraglide/messages.js';
import { gemerkterStart } from './neustartGedaechtnis';
import { streamStarten } from './starten';
import { streamForSlot, markStarting } from './state.svelte';

const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS_PER_WINDOW = 2;
/** Kurze Pause vor dem Neustart: der alte Sidecar-Prozess beendet sich nach
 *  dem error-Event selbst; ein sofortiger `gsr.start` könnte noch den
 *  sterbenden Prozess treffen und in dessen Exit-Aufräumen laufen. */
const RESTART_DELAY_MS = 500;

/** Pro Slot: Zeitstempel der letzten Auto-Neustarts (Sliding Window). */
const attempts: Record<number, number[]> = {};

/**
 * Startet den Stream eines Slots neu, wenn der Schleifen-Schutz es erlaubt.
 * Läuft fire-and-forget aus dem Event-Reducer; Fehler landen im Slot-State.
 */
export function maybeAutoRestart(slot: number): void {
  const merk = gemerkterStart(slot);
  if (!merk) return;

  const now = Date.now();
  const recent = (attempts[slot] ?? []).filter((t) => now - t < RESTART_WINDOW_MS);
  attempts[slot] = recent;
  if (recent.length >= MAX_RESTARTS_PER_WINDOW) return;
  recent.push(now);

  markStarting(slot);
  toast.info(m.stream_auto_restart_toast());

  void (async () => {
    await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));
    const session = streamForSlot(slot);
    const erg = await streamStarten(merk.channelId, slot, merk.standplatz);
    if (erg.ok) return;
    // Alle drei Stufen enden hier gleich: der Slot geht in den Fehlerzustand
    // mit manuellem Start-Knopf. Getrennt meldet sie nur der Knopf selbst.
    const roh = erg.fehler;
    session.state = 'error';
    session.error =
      roh instanceof Error
        ? roh.message
        : typeof roh === 'string' && roh
          ? roh
          : m.stream_controls_error_start_failed();
    toast.error(m.stream_auto_restart_failed(), { description: session.error });
  })();
}
