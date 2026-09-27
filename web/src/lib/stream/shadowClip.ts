/**
 * ShadowPlay-Auslöser — Knopf je Slot (StreamStatusBar) und Tastenkürzel
 * (ShortcutHost, Aktion `stream.highlightClip`) teilen sich diese Logik.
 *
 * Der Kürzel-Fall sichert ALLE laufenden Slots (wer zwei Bildschirme
 * streamt, will vermutlich beide Momente); der Knopf bleibt eindeutig bei
 * seinem Slot. Meldung gibt es IMMER — auch bei Fehlern und erst-recent
 * gestarteten Streams, sonst hieße es wieder „passiert nichts".
 */

import { toast } from 'svelte-sonner';
import { m } from '$lib/paraglide/messages.js';
import { runningStreamSlots } from './state.svelte';

/** Einen Slot sichern; Toast mit Pfad oder Grund. */
export async function schattenClipSichern(slot: number): Promise<void> {
  try {
    const r = (await window.pulse?.sidecar?.saveClip?.(slot, 90)) as
      | { ok?: boolean; path?: unknown; error?: unknown }
      | undefined;
    if (r?.ok) {
      toast.success(m.shadow_clip_saved(), {
        description: typeof r.path === 'string' ? r.path : undefined,
      });
    } else {
      toast.error(m.shadow_clip_failed(), {
        description: typeof r?.error === 'string' ? r.error : undefined,
      });
    }
  } catch (e) {
    toast.error(m.shadow_clip_failed(), {
      description: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Alle laufenden Slots sichern (Tastenkürzel). Ohne Stream: ein Hinweis. */
export async function schattenClipsSichern(): Promise<void> {
  const slots = runningStreamSlots();
  if (slots.length === 0) {
    toast.info(m.shadow_clip_no_stream());
    return;
  }
  for (const slot of slots) {
    await schattenClipSichern(slot);
  }
}
