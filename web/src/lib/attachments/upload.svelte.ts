/**
 * Composer-side two-phase upload helper — **der KLARTEXT-Weg**. Der
 * verschluesselte Gegenpart steht in `uploadVerschluesselt.ts` und teilt sich
 * mit dieser Datei `vorschaubild.ts` und `putMitFortschritt.ts`.
 *
 * Each picked/pasted/dropped File becomes a `PendingAttachment` whose
 * state machine walks through queued → uploading → done | error. The
 * machine handles:
 *
 *  - client-side webp thumbnail generation for image/* (`vorschaubild.ts`),
 *  - presigned-URL request to chat-gateway,
 *  - XHR PUT to MinIO (`putMitFortschritt.ts`),
 *  - cancellation via XHR abort,
 *  - cleanup of object URLs created for the preview thumbnail.
 *
 * Lives outside MessageInput.svelte so the component itself stays
 * presentational and under the 250-line cap.
 */

import { chatApi } from '$lib/api/chat';
import { erzeugeVorschaubild } from './vorschaubild';
import { putMitFortschritt } from './putMitFortschritt';
import type { AnhangAngabe } from '$lib/krypto/nachrichtNutzlast';

export type PendingAttachment = {
  /** Stable local id (different from the server-assigned attachment.id). */
  localId: string;
  file: File;
  /** Object URL for the in-composer preview; revoke on cleanup. */
  previewUrl: string | null;
  state: 'queued' | 'uploading' | 'done' | 'error';
  progress: number; // 0-100
  /** Set when state transitions to 'done'. */
  attachmentId: string | null;
  errorMessage: string | null;
  /** Nur im VERSCHLUESSELTEN Weg gesetzt (`uploadVerschluesselt.ts`): alles,
   *  was in die verschluesselte Nachricht mitmuss — Dateischluessel, Name,
   *  Typ, Maße. Im Klartext-Weg bleibt es `null`, dort kennt der Server das
   *  alles selbst. */
  anhang: AnhangAngabe | null;
};

let _idCounter = 0;
/** Stabile lokale Zeilen-ID. Exportiert, weil der verschluesselte Weg
 *  (`uploadVerschluesselt.ts`) dieselbe Zeilenform fuellt — zwei Zaehler
 *  koennten dieselbe ID zweimal vergeben, und `pending` sucht darueber. */
export function nextLocalId(): string {
  return `pa-${Date.now().toString(36)}-${(_idCounter++).toString(36)}`;
}

/**
 * Drive an attachment all the way from "file picked" to "server-bound id".
 * `onChange` is called whenever the row's state mutates so the caller's
 * Svelte rune updates re-render the preview strip.
 *
 * Returns an `abort` function the caller can call to cancel in-flight
 * uploads (X-button on the preview tile).
 */
export function startUpload(
  channelId: string,
  file: File,
  onChange: (next: PendingAttachment) => void
): { row: PendingAttachment; abort: () => void } {
  const localId = nextLocalId();
  const previewUrl =
    file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
  const row: PendingAttachment = {
    localId,
    file,
    previewUrl,
    state: 'queued',
    progress: 0,
    attachmentId: null,
    errorMessage: null,
    anhang: null
  };

  let abortCurrent: (() => void) | null = null;
  let cancelled = false;

  const emit = () => onChange({ ...row });

  const run = async () => {
    try {
      // 1. (image only) build the thumbnail + capture original dimensions.
      const thumb = await erzeugeVorschaubild(file);
      if (cancelled) return;

      // 2. Ask the server for an upload URL (+ optional thumb URL).
      const presign = await chatApi.requestAttachmentUploadUrl(channelId, {
        filename: file.name,
        mime: file.type || 'application/octet-stream',
        size: file.size,
        width: thumb?.origWidth,
        height: thumb?.origHeight,
        has_thumb: thumb !== null,
        thumb_size: thumb?.blob.size,
        thumb_width: thumb?.thumbWidth,
        thumb_height: thumb?.thumbHeight
      });
      if (cancelled) return;

      row.attachmentId = presign.id;
      row.state = 'uploading';
      emit();

      // 3. PUT the bytes — main file first, then the thumb in parallel
      //    isn't worth the bookkeeping; serial keeps the progress meter
      //    monotonic and simple.
      await putMitFortschritt(
        presign.upload_url,
        file,
        file.type || 'application/octet-stream',
        (pct) => {
          row.progress = pct;
          emit();
        },
        (a) => {
          abortCurrent = a;
        }
      );
      if (cancelled) return;

      if (thumb && presign.thumb_upload_url) {
        await putMitFortschritt(
          presign.thumb_upload_url,
          thumb.blob,
          'image/webp',
          () => {
            /* thumbs are small; ignore intermediate progress */
          },
          (a) => {
            abortCurrent = a;
          }
        );
      }

      if (cancelled) return;
      row.state = 'done';
      row.progress = 100;
      emit();
    } catch (err) {
      if (cancelled) return;
      row.state = 'error';
      row.errorMessage = err instanceof Error ? err.message : String(err);
      emit();
    }
  };

  void run();

  return {
    row,
    abort: () => {
      cancelled = true;
      abortCurrent?.();
      if (row.previewUrl) URL.revokeObjectURL(row.previewUrl);
    }
  };
}

export function cleanupRow(row: PendingAttachment): void {
  if (row.previewUrl) URL.revokeObjectURL(row.previewUrl);
}
