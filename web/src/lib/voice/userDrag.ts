/**
 * Drag-and-drop payload for moving a user into a voice channel.
 *
 * Uses a dedicated MIME type so it cannot collide with the channel-reorder
 * DnD in ``ChannelList`` (which carries the channel id as ``text/plain``):
 * drag sources (member rows, voice tiles, voice-rail rows) call
 * ``startUserDrag`` on ``dragstart``; the voice-channel drop target reads it
 * back via ``droppedUserId``. ``carriesUser`` is usable already during
 * ``dragover`` — ``dataTransfer.types`` is exposed before the drop, the data
 * itself only on ``drop``.
 */
export const USER_DRAG_MIME = 'application/x-pulse-user';

/** Seed the dataTransfer with the dragged user id. No-op without one. */
export function startUserDrag(e: DragEvent, userId: string): void {
  if (!e.dataTransfer) return;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData(USER_DRAG_MIME, userId);
}

/** True while a user is being dragged over the target (dragover-safe). */
export function carriesUser(e: DragEvent): boolean {
  return !!e.dataTransfer && e.dataTransfer.types.includes(USER_DRAG_MIME);
}

/** The dragged user id at drop time, or ``null`` if this isn't a user drop. */
export function droppedUserId(e: DragEvent): string | null {
  return e.dataTransfer?.getData(USER_DRAG_MIME) || null;
}
