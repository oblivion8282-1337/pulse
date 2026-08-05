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
 * Der Neustart braucht die channelId des laufenden Streams; die kennt nur der
 * manuelle Start-Pfad (`StreamControls.onStart`), der sie deshalb pro Slot via
 * `recordStreamStart` hier hinterlegt. Kein Eintrag → kein Auto-Neustart.
 *
 * Schleifen-Schutz: maximal 2 automatische Neustarts pro Slot innerhalb von
 * 60 s. Wechselt die Auflösung im Minutentakt (User probiert Settings durch)
 * oder schlägt der Neustart selbst wiederholt fehl, bleibt es beim normalen
 * Fehlerzustand mit manuellem Start-Button.
 */
import { toast } from 'svelte-sonner';
import { m } from '$lib/paraglide/messages.js';
import { chatApi } from '$lib/api/chat';
import { gsr } from './gsr';
import { buildStartArgs, pushProtokoll, tenBitPossible } from './settings.svelte';
import { streamForSlot, markStarting } from './state.svelte';
import { resolveSlotLabel } from './label';

const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS_PER_WINDOW = 2;
/** Kurze Pause vor dem Neustart: der alte Sidecar-Prozess beendet sich nach
 *  dem error-Event selbst; ein sofortiger `gsr.start` könnte noch den
 *  sterbenden Prozess treffen und in dessen Exit-Aufräumen laufen. */
const RESTART_DELAY_MS = 500;

/** Pro Slot: channelId des zuletzt manuell gestarteten Streams. */
const lastChannel: Record<number, string> = {};
/** Pro Slot: Zeitstempel der letzten Auto-Neustarts (Sliding Window). */
const attempts: Record<number, number[]> = {};

/** Vom manuellen Start-Pfad nach erfolgreichem `gsr.start` aufgerufen. */
export function recordStreamStart(slot: number, channelId: string): void {
  lastChannel[slot] = channelId;
}

/**
 * Startet den Stream eines Slots neu, wenn der Schleifen-Schutz es erlaubt.
 * Läuft fire-and-forget aus dem Event-Reducer; Fehler landen im Slot-State.
 */
export function maybeAutoRestart(slot: number): void {
  const channelId = lastChannel[slot];
  if (!channelId) return;

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
    try {
      const label = resolveSlotLabel(slot).label;
      // Denselben Weg wie beim Start von Hand waehlen — warum die Betriebsart
      // den Transport mitentscheidet und was das harte `'rtmp'` hier anrichtete:
      // s. `pushProtokoll`.
      const tok = await chatApi.getStreamToken(
        channelId,
        pushProtokoll(),
        slot,
        label,
        tenBitPossible()
      );
      const args = buildStartArgs({ channelId, token: tok.token, pushUrl: tok.push_url }, slot);
      const r = await gsr.start(args, slot);
      if (r && !r.ok) throw new Error(r.error ?? m.stream_controls_error_start_failed());
    } catch (e) {
      session.state = 'error';
      session.error = e instanceof Error ? e.message : String(e);
      toast.error(m.stream_auto_restart_failed(), { description: session.error });
    }
  })();
}
