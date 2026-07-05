/**
 * Shared "open one of a user's HQ streams" logic for the per-user LIVE badges
 * (voice participant tile, member list, member-activity header). Mirrors
 * {@link `$lib/watch/openParty.svelte`}::`watchPartyPicker` 1:1.
 *
 * A user may run several HQ streams at once (slots 0, 1, …). The LIVE badges
 * feed their candidate streams into {@link StreamPicker.choose}: exactly one →
 * open it directly; several → pop a small chooser dialog so the viewer picks
 * which to open. The dialog (`StreamPickerDialog`) is mounted once globally in
 * the app layout, so the badges stay plain spans — no per-badge floating menu
 * that nested popovers / overflow-hidden rails would clip.
 *
 * "Alle ansehen" (open every stream at once) is handled by the dialog iterating
 * the entries' `open()` callbacks — no separate mode needed here.
 */
export type StreamPickEntry = {
  /** 0-based slot this entry opens. */
  slot: number;
  /** Human-readable label from `stream_state` (e.g. "Monitor 1", "Chrome");
   *  falls back to `Stream <N>` when the streamer's platform couldn't name it. */
  label: string;
  /** Open just this one stream's tile (or focus its detached popup). */
  open: () => void;
};

class StreamPicker {
  /** Non-null while the chooser dialog is showing. */
  entries = $state<StreamPickEntry[] | null>(null);
  title = $state('');

  /** One candidate → open it straight away. Several → show the chooser. */
  choose(entries: StreamPickEntry[], title: string): void {
    if (entries.length === 0) return;
    if (entries.length === 1) {
      entries[0].open();
      return;
    }
    this.title = title;
    this.entries = entries;
  }

  close(): void {
    this.entries = null;
  }
}

export const streamPicker = new StreamPicker();
